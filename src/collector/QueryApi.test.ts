/**
 * The query API end to end: a real collector on an ephemeral port, real
 * instrumented programs connecting through `Inspect.layer`, and queries sent
 * through the HTTP client the CLI will use.
 */
import { describe, expect, it } from 'bun:test'
import { Effect, Schedule, type Scope } from 'effect'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
// Exercise the same native server constructor used by the installed CLI.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer } from 'node:http'
import { FetchHttpClient, type HttpClient, HttpServer } from 'effect/unstable/http'
import * as Inspect from '../client/Inspect.ts'
import * as Client from '../query/Client.ts'
import * as Query from '../query/Query.ts'
import { run } from './Server.ts'
import { make as makeStore, Store } from './Store.ts'

const startCollector = Effect.fnUntraced(function* (options?: { readonly capacity?: number }) {
  const store = yield* makeStore(options)
  const server = yield* NodeHttpServer.make(createServer, { port: 0 })
  yield* Effect.forkScoped(
    run().pipe(
      Effect.provideService(Store, store),
      Effect.provideService(HttpServer.HttpServer, server),
    ),
  )
  const port = server.address._tag === 'UnixPathAddress' ? 0 : server.address.port
  return { port, url: `http://127.0.0.1:${port}` }
})

/** Runs `program` instrumented under `sessionId` against the collector on `port`. */
const instrumented = <A, E>(port: number, sessionId: string, program: Effect.Effect<A, E>) =>
  program.pipe(
    // Give the client a moment to connect so nothing is buffered past exit.
    Effect.delay('50 millis'),
    Effect.provide(Inspect.layer({ url: `ws://127.0.0.1:${port}`, sessionId })),
  )

const query = (url: string, request: object) => Client.query({ url }, request)

/** Polls a query until `done` holds, so tests never race socket delivery. */
const until = (url: string, request: object, done: (response: Query.QueryResponse) => boolean) =>
  query(url, request).pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced('10 millis') }),
    Effect.timeoutOrElse({
      duration: '5 seconds',
      orElse: () => Effect.die(new Error(`timed out waiting on ${JSON.stringify(request)}`)),
    }),
  )

const ended = (response: Query.QueryResponse) =>
  response.ok && response.op === 'summary' && !response.source.active

const runTest = <E>(effect: Effect.Effect<void, E, HttpClient.HttpClient | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(FetchHttpClient.layer)))

const programA = Effect.gen(function* () {
  yield* Effect.logInfo('charging')
  yield* Effect.fail('declined').pipe(Effect.withSpan('a.charge'), Effect.ignore)
  yield* Effect.sleep('30 millis').pipe(Effect.withSpan('a.wait'))
}).pipe(Effect.withSpan('a.root'))

const programB = Effect.gen(function* () {
  yield* Effect.sleep('10 millis').pipe(Effect.withSpan('b.step'))
  yield* Effect.logWarning('b is done')
}).pipe(Effect.withSpan('b.root'))

describe('collector query API', () => {
  it('answers exact-session queries for two concurrent runs, isolated from each other', () =>
    runTest(
      Effect.gen(function* () {
        const { port, url } = yield* startCollector()
        yield* Effect.all(
          [
            instrumented(port, 'agent-a-run-001', programA),
            instrumented(port, 'agent-b-run-001', programB),
          ],
          { concurrency: 'unbounded' },
        )

        const summaryA = yield* until(url, { op: 'summary', sessionId: 'agent-a-run-001' }, ended)
        yield* until(url, { op: 'summary', sessionId: 'agent-b-run-001' }, ended)
        if (!summaryA.ok || summaryA.op !== 'summary') throw new Error('expected summary')
        expect(summaryA.source).toMatchObject({ kind: 'live', sessionId: 'agent-a-run-001' })
        expect(summaryA.result.spans).toMatchObject({ total: 3, error: 1, open: 0 })
        expect(summaryA.result.failures.items.map((item) => item.name)).toEqual(['a.charge'])
        expect(summaryA.completeness.status).toBe('noLossRecorded')
        expect(summaryA.conflict).toEqual({ count: 0, detection: 'enforced' })

        const spansB = yield* query(url, { op: 'spans', sessionId: 'agent-b-run-001' })
        if (!spansB.ok || spansB.op !== 'spans') throw new Error('expected spans')
        expect(spansB.result.items.map((item) => item.name).sort()).toEqual(['b.root', 'b.step'])

        const failed = yield* query(url, {
          op: 'spans',
          sessionId: 'agent-a-run-001',
          status: 'failed',
        })
        const charge = failed.ok && failed.op === 'spans' ? failed.result.items[0] : undefined
        expect(charge?.name).toBe('a.charge')
        const logs = yield* query(url, {
          op: 'logs',
          sessionId: 'agent-a-run-001',
          spanId: summaryA.result.longest.find((item) => item.name === 'a.root')?.spanId,
        })
        expect(
          logs.ok && logs.op === 'logs' && logs.result.items.map((item) => item.message),
        ).toEqual(['charging'])

        const unknown = yield* query(url, { op: 'summary', sessionId: 'agent-c-run-001' })
        expect(unknown.ok ? 'ok' : unknown.error._tag).toBe('SessionNotFound')
        const unnamed = yield* query(url, { op: 'summary' })
        expect(unnamed.ok ? 'ok' : unnamed.error._tag).toBe('InvalidRequest')

        const sessions = yield* query(url, { op: 'sessions' })
        expect(
          sessions.ok &&
            sessions.op === 'sessions' &&
            sessions.result.items.map((s) => s.sessionId).sort(),
        ).toEqual(['agent-a-run-001', 'agent-b-run-001'])
      }),
    ))

  it('refuses a session whose ID another run reused, live and exported', () =>
    runTest(
      Effect.gen(function* () {
        const { port, url } = yield* startCollector()
        yield* instrumented(port, 'shared-id', programA)
        yield* until(url, { op: 'summary', sessionId: 'shared-id' }, ended)
        // An independent run choosing the same ID.
        yield* instrumented(port, 'shared-id', programB)
        const conflicted = yield* until(
          url,
          { op: 'summary', sessionId: 'shared-id' },
          (response) => !response.ok,
        )
        expect(conflicted.ok ? undefined : conflicted.error).toMatchObject({
          _tag: 'SessionConflict',
          conflicts: 1,
        })
        const exported = yield* Client.exportTrace({ url }, 'shared-id')
        if (!exported.ok) throw new Error(exported.error.message)
        const offline = Query.queryFile(exported.text, 'shared.eitrace', { op: 'spans' })
        expect(offline.ok ? 'ok' : offline.error._tag).toBe('SessionConflict')
      }),
    ))

  it('exports a snapshot whose file answers exactly like the live query', () =>
    runTest(
      Effect.gen(function* () {
        const { port, url } = yield* startCollector()
        yield* instrumented(port, 'export-me', programA)
        yield* until(url, { op: 'summary', sessionId: 'export-me' }, ended)
        const exported = yield* Client.exportTrace({ url }, 'export-me')
        if (!exported.ok) throw new Error(exported.error.message)
        for (const request of [
          { op: 'summary' },
          { op: 'spans', sort: 'duration' },
          { op: 'logs', minLevel: 'Info' },
        ]) {
          const live = yield* query(url, { ...request, sessionId: 'export-me' })
          const file = Query.queryFile(exported.text, 'export-me.eitrace', request)
          const strip = (response: Query.QueryResponse) =>
            response.ok && 'time' in response
              ? {
                  ...response,
                  source: {
                    ...response.source,
                    kind: null,
                    file: null,
                    snapshotAtEpochMillis: null,
                  },
                }
              : response
          expect(strip(file)).toEqual(strip(live))
        }
        const missing = yield* Client.exportTrace({ url }, 'nope')
        expect(missing.ok ? 'ok' : missing.error._tag).toBe('SessionNotFound')
      }),
    ))

  it('reports capacity eviction as recorded loss', () =>
    runTest(
      Effect.gen(function* () {
        const { port, url } = yield* startCollector({ capacity: 4 })
        yield* instrumented(
          port,
          'tiny',
          Effect.forEach(
            Array.from({ length: 10 }, (_, i) => i),
            (i) => Effect.void.pipe(Effect.withSpan(`step-${i}`)),
          ),
        )
        const summary = yield* until(url, { op: 'summary', sessionId: 'tiny' }, ended)
        expect(summary.ok && summary.op === 'summary' && summary.completeness).toMatchObject({
          status: 'lossRecorded',
          collectorDroppedMessages: 16,
          retainedMessages: 4,
          messagesObserved: 20,
        })
      }),
    ))

  it('bounds live responses and rejects a logs scope without a span', () =>
    runTest(
      Effect.gen(function* () {
        const { port, url } = yield* startCollector()
        const huge = '界'.repeat(100_000)
        yield* instrumented(
          port,
          'huge-names',
          Effect.forEach(
            Array.from({ length: 60 }, (_, i) => i),
            (i) =>
              Effect.logInfo('in a huge span').pipe(
                Effect.withSpan(`${huge}${i}`, { attributes: { [huge]: huge } }),
              ),
          ),
        )
        yield* until(url, { op: 'summary', sessionId: 'huge-names' }, ended)
        const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
        for (const request of [
          { op: 'spans', limit: 200 },
          { op: 'summary', top: 50 },
          { op: 'logs', limit: 500 },
        ]) {
          const response = yield* query(url, { ...request, sessionId: 'huge-names' })
          expect(response.ok).toBe(true)
          expect(size(response)).toBeLessThanOrEqual(Query.limits.responseBytes)
        }
        const scoped = yield* query(url, { op: 'logs', sessionId: 'huge-names', scope: 'span' })
        expect(scoped.ok ? 'ok' : scoped.error._tag).toBe('InvalidRequest')
        const junk = yield* query(url, { op: 'x'.repeat(2_000_000) })
        expect(junk.ok ? 'ok' : junk.error._tag).toBe('InvalidRequest')
        expect(size(junk)).toBeLessThan(4_000)
      }),
    ))

  it('distinguishes an absent collector from a service that is not one', () =>
    runTest(
      Effect.gen(function* () {
        const absent = yield* Client.query({ url: 'http://127.0.0.1:1' }, { op: 'sessions' })
        expect(absent.ok ? 'ok' : absent.error._tag).toBe('CollectorUnavailable')

        const other = Bun.serve({ port: 0, fetch: () => new Response('<html></html>') })
        yield* Effect.addFinalizer(() => Effect.promise(() => other.stop(true)))
        const url = `http://127.0.0.1:${other.port}`
        const foreign = yield* Client.query({ url }, { op: 'sessions' })
        expect(foreign.ok ? 'ok' : foreign.error._tag).toBe('CollectorError')
        const exported = yield* Client.exportTrace({ url }, 'x')
        expect(exported.ok ? 'ok' : exported.error._tag).toBe('CollectorError')
      }),
    ))
})
