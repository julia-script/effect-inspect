/**
 * End-to-end collector tests: a real server on an ephemeral port, driven by
 * stub programs and a stub webapp client over real WebSockets.
 *
 * Going through the socket rather than calling handlers directly is the point —
 * framing, routing by path, and what happens when a peer disappears mid-stream
 * are exactly the parts that break.
 */
import { describe, expect, it } from 'bun:test'
import { Effect, Scope } from 'effect'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
// Exercise the same native server constructor used by the installed CLI.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer } from 'node:http'
import { HttpServer } from 'effect/unstable/http'
import { clientCodec, webappCodec, webappRequestCodec } from '../protocol/Codec.ts'
import type * as Protocol from '../protocol/Schema.ts'
import { protocolVersion } from '../protocol/Schema.ts'
import { run, webappPath } from './Server.ts'
import { make as makeStore, Store } from './Store.ts'

const clock = { startTime: 1_000n, wallClockEpochMillis: 1_700_000_000_000 }

const hello = (
  sessionId: string,
  program: string,
  instanceId?: string,
): Protocol.ClientMessage => ({
  _tag: 'Hello',
  sessionId,
  program,
  pid: 4242,
  runtime: 'bun',
  protocolVersion,
  clock,
  ...(instanceId === undefined ? {} : { instanceId }),
})

const spanStart = (sessionId: string, spanId: string): Protocol.ClientMessage => ({
  _tag: 'SpanStart',
  sessionId,
  spanId,
  traceId: 'trace-1',
  name: spanId,
  kind: 'internal',
  startTime: 1_000n,
  attributes: {},
  sampled: true,
})

/** The span ids of a run of client messages, for readable assertions. */
const spanIds = (messages: ReadonlyArray<Protocol.ClientMessage> | undefined) =>
  messages?.map((message) => (message._tag === 'SpanStart' ? message.spanId : message._tag))

type StoreService = Store['Service']

/** A collector running on an ephemeral port for the current scope. */
interface Collector {
  readonly port: number
  readonly store: StoreService
}

/** Starts a collector on an ephemeral port, stopped when the scope closes. */
const startCollector = Effect.fnUntraced(function* (options?: { readonly capacity?: number }) {
  const store = yield* makeStore(options)
  const server = yield* NodeHttpServer.make(createServer, { port: 0 })
  yield* Effect.forkScoped(
    run().pipe(
      Effect.provideService(Store, store),
      Effect.provideService(HttpServer.HttpServer, server),
    ),
  )
  return {
    port: server.address._tag === 'UnixPathAddress' ? 0 : server.address.port,
    store,
  } satisfies Collector
})

/** A stub peer: an open WebSocket plus everything it has received. */
interface Peer {
  readonly send: (line: string) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
  /** Every webapp message received so far, decoded. */
  readonly received: () => ReadonlyArray<Protocol.WebappMessage>
}

/** Opens a WebSocket to the collector, closed when the scope closes. */
const connect = Effect.fnUntraced(function* (port: number, path = '/') {
  const received: Array<Protocol.WebappMessage> = []

  const socket = yield* Effect.acquireRelease(
    Effect.callback<WebSocket>((resume) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
      ws.addEventListener('message', (event) => {
        for (const line of String(event.data).split('\n')) {
          if (line.trim() === '') continue
          const decoded = webappCodec.decode(line)
          if (decoded._tag === 'Success') received.push(decoded.success)
        }
      })
      ws.addEventListener('open', () => resume(Effect.succeed(ws)), { once: true })
    }),
    (ws) => Effect.sync(() => ws.close()),
  )

  return {
    send: (line: string) => Effect.sync(() => socket.send(line)),
    close: Effect.sync(() => socket.close()),
    received: () => received,
  } satisfies Peer
})

/**
 * Polls `condition` until it holds, so a test never races the event loop.
 *
 * Everything here crosses a real socket, so the collector's view of the world
 * is always a few ticks behind the `send` that caused it.
 */
const until = (condition: Effect.Effect<boolean>, label: string): Effect.Effect<void> =>
  Effect.flatMap(condition, (met) =>
    met ? Effect.void : Effect.flatMap(Effect.sleep('5 millis'), () => until(condition, label)),
  ).pipe(
    Effect.timeoutOrElse({
      duration: '5 seconds',
      orElse: () => Effect.die(new Error(`timed out waiting for ${label}`)),
    }),
  )

/** Runs a scoped test effect to completion, tearing down sockets and servers. */
const runTest = <E>(effect: Effect.Effect<void, E, Scope.Scope>): Promise<void> =>
  Effect.runPromise(Effect.scoped(effect) as Effect.Effect<void, E>)

describe('collector', () => {
  it('serves two concurrent programs and a subscribed webapp client', () =>
    runTest(
      Effect.gen(function* () {
        const collector = yield* startCollector()

        const alpha = yield* connect(collector.port)
        const beta = yield* connect(collector.port)
        yield* alpha.send(clientCodec.encode(hello('session-alpha', 'alpha')))
        yield* beta.send(clientCodec.encode(hello('session-beta', 'beta')))

        yield* until(
          Effect.map(collector.store.sessions, (sessions) => sessions.length === 2),
          'both sessions registered',
        )

        const webapp = yield* connect(collector.port, webappPath)

        // The session list arrives unprompted on connect, listing both programs.
        yield* until(
          Effect.sync(() => webapp.received().some((message) => message._tag === 'SessionList')),
          'session list',
        )
        const list = webapp.received().findLast((message) => message._tag === 'SessionList')
        expect(
          list?._tag === 'SessionList'
            ? list.sessions.map((session) => session.program).sort()
            : [],
        ).toEqual(['alpha', 'beta'])

        // A span recorded before the webapp subscribes must still reach it.
        yield* alpha.send(clientCodec.encode(spanStart('session-alpha', 'before-subscribe')))
        yield* beta.send(clientCodec.encode(spanStart('session-beta', 'beta-only')))
        yield* until(
          Effect.map(
            collector.store.snapshot('session-alpha'),
            (snapshot) => snapshot?.messages.length === 1,
          ),
          'alpha span recorded',
        )

        yield* webapp.send(
          webappRequestCodec.encode({ _tag: 'Subscribe', sessionId: 'session-alpha' }),
        )
        yield* until(
          Effect.sync(() => webapp.received().some((message) => message._tag === 'Backlog')),
          'backlog',
        )
        const backlog = webapp.received().find((message) => message._tag === 'Backlog')
        expect(backlog?._tag === 'Backlog' ? backlog.sessionId : undefined).toBe('session-alpha')
        expect(backlog?._tag === 'Backlog' ? backlog.complete : undefined).toBe(true)
        expect(spanIds(backlog?._tag === 'Backlog' ? backlog.messages : [])).toEqual([
          'before-subscribe',
        ])

        // Live tail: only the subscribed session is forwarded.
        yield* alpha.send(clientCodec.encode(spanStart('session-alpha', 'after-subscribe')))
        yield* beta.send(clientCodec.encode(spanStart('session-beta', 'beta-unsubscribed')))
        yield* until(
          Effect.sync(() => webapp.received().some((message) => message._tag === 'Live')),
          'live message',
        )
        yield* Effect.sleep('50 millis')

        expect(
          webapp
            .received()
            .flatMap((message) =>
              message._tag === 'Live' && message.message._tag === 'SpanStart'
                ? [message.message.spanId]
                : [],
            ),
        ).toEqual(['after-subscribe'])
      }),
    ))

  it('drops the oldest messages past the cap and reports the count', () =>
    runTest(
      Effect.gen(function* () {
        const collector = yield* startCollector({ capacity: 3 })
        const program = yield* connect(collector.port)
        yield* program.send(clientCodec.encode(hello('session-capped', 'capped')))

        for (const spanId of ['a', 'b', 'c', 'd', 'e']) {
          yield* program.send(clientCodec.encode(spanStart('session-capped', spanId)))
        }

        yield* until(
          Effect.map(
            collector.store.snapshot('session-capped'),
            (snapshot) => snapshot?.droppedMessages === 2,
          ),
          'two messages dropped',
        )

        const snapshot = yield* collector.store.snapshot('session-capped')
        // Oldest dropped first, and the retained window stays in arrival order.
        expect(spanIds(snapshot?.messages)).toEqual(['c', 'd', 'e'])
        expect(snapshot?.droppedMessages).toBe(2)
      }),
    ))

  it('skips malformed lines without dropping the session or the connection', () =>
    runTest(
      Effect.gen(function* () {
        const collector = yield* startCollector()
        const program = yield* connect(collector.port)
        yield* program.send(clientCodec.encode(hello('session-noisy', 'noisy')))

        // Bad lines sharing a frame with good ones is the case `decodeAll` cannot
        // survive: everything but the bad lines must still be recorded.
        yield* program.send(
          clientCodec.encode(spanStart('session-noisy', 'before')) +
            'not json at all\n' +
            '{"_tag":"Nope"}\n' +
            clientCodec.encode(spanStart('session-noisy', 'after')),
        )

        yield* until(
          Effect.map(
            collector.store.snapshot('session-noisy'),
            (snapshot) => snapshot?.messages.length === 2,
          ),
          'both good spans recorded',
        )

        const snapshot = yield* collector.store.snapshot('session-noisy')
        expect(spanIds(snapshot?.messages)).toEqual(['before', 'after'])
        expect(snapshot?.skippedLines).toBe(2)

        // The connection survives, so telemetry after the bad lines still lands.
        yield* program.send(clientCodec.encode(spanStart('session-noisy', 'later')))
        yield* until(
          Effect.map(
            collector.store.snapshot('session-noisy'),
            (snapshot) => snapshot?.messages.length === 3,
          ),
          'connection still live after malformed input',
        )
      }),
    ))

  it('ends a session when its program dies and resumes it on reconnect', () =>
    runTest(
      Effect.gen(function* () {
        const collector = yield* startCollector()
        const first = yield* connect(collector.port)
        yield* first.send(clientCodec.encode(hello('session-restart', 'restarter')))
        yield* first.send(clientCodec.encode(spanStart('session-restart', 'first-run')))
        yield* until(
          Effect.map(
            collector.store.snapshot('session-restart'),
            (snapshot) => snapshot?.messages.length === 1,
          ),
          'first run recorded',
        )

        // Killing the program looks like an abrupt close to the collector.
        yield* first.close
        yield* until(
          Effect.map(collector.store.sessions, (sessions) => sessions[0]?.active === false),
          'session marked ended',
        )

        // The collector is still serving: a reconnect resumes the same session.
        const second = yield* connect(collector.port)
        yield* second.send(clientCodec.encode(hello('session-restart', 'restarter')))
        yield* second.send(clientCodec.encode(spanStart('session-restart', 'second-run')))
        yield* until(
          Effect.map(
            collector.store.snapshot('session-restart'),
            (snapshot) => snapshot?.messages.length === 2,
          ),
          'second run appended to the same session',
        )

        const sessions = yield* collector.store.sessions
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.active).toBe(true)
        const snapshot = yield* collector.store.snapshot('session-restart')
        expect(spanIds(snapshot?.messages)).toEqual(['first-run', 'second-run'])
      }),
    ))
})

describe('collector session identity', () => {
  const recorded = (collector: Collector, sessionId: string, count: number) =>
    until(
      Effect.map(
        collector.store.snapshot(sessionId),
        (snapshot) => snapshot?.messages.length === count,
      ),
      `${count} messages recorded for ${sessionId}`,
    )
  const conflicts = (collector: Collector, sessionId: string, count: number) =>
    until(
      Effect.map(
        collector.store.snapshot(sessionId),
        (snapshot) => snapshot?.session.conflicts === count,
      ),
      `${count} conflicts on ${sessionId}`,
    )

  it('refuses a second instance reusing an active ID without touching the owner', () =>
    runTest(
      Effect.gen(function* () {
        const collector = yield* startCollector()
        const owner = yield* connect(collector.port)
        yield* owner.send(clientCodec.encode(hello('shared-1', 'owner', 'instance-a')))
        yield* owner.send(clientCodec.encode(spanStart('shared-1', 'owner-1')))
        yield* recorded(collector, 'shared-1', 1)

        const intruder = yield* connect(collector.port)
        yield* intruder.send(clientCodec.encode(hello('shared-1', 'intruder', 'instance-b')))
        yield* conflicts(collector, 'shared-1', 1)
        yield* intruder.send(clientCodec.encode(spanStart('shared-1', 'intruder-1')) + 'not json\n')
        // Closing the refused connection must not end the owner's session.
        yield* intruder.close
        yield* Effect.sleep('50 millis')

        yield* owner.send(clientCodec.encode(spanStart('shared-1', 'owner-2')))
        yield* recorded(collector, 'shared-1', 2)
        const snapshot = yield* collector.store.snapshot('shared-1')
        expect(spanIds(snapshot?.messages)).toEqual(['owner-1', 'owner-2'])
        expect(snapshot?.skippedLines).toBe(0)
        expect(snapshot?.session).toMatchObject({ program: 'owner', active: true, conflicts: 1 })
        expect(yield* collector.store.sessions).toHaveLength(1)
      }),
    ))

  it('refuses reuse of an ended ID while its history is retained', () =>
    runTest(
      Effect.gen(function* () {
        const collector = yield* startCollector()
        const first = yield* connect(collector.port)
        yield* first.send(clientCodec.encode(hello('reused-1', 'first', 'instance-a')))
        yield* first.send(clientCodec.encode(spanStart('reused-1', 'first-run')))
        yield* recorded(collector, 'reused-1', 1)
        yield* first.close
        yield* until(
          Effect.map(collector.store.sessions, (sessions) => sessions[0]?.active === false),
          'first run ended',
        )

        const later = yield* connect(collector.port)
        yield* later.send(clientCodec.encode(hello('reused-1', 'later', 'instance-b')))
        yield* later.send(clientCodec.encode(spanStart('reused-1', 'later-run')))
        yield* conflicts(collector, 'reused-1', 1)
        yield* Effect.sleep('50 millis')

        // The original run is preserved as it was: ended, unmerged, flagged.
        const snapshot = yield* collector.store.snapshot('reused-1')
        expect(spanIds(snapshot?.messages)).toEqual(['first-run'])
        expect(snapshot?.session).toMatchObject({ program: 'first', active: false, conflicts: 1 })
      }),
    ))

  it('lets the same instance reconnect before its old connection is noticed closed', () =>
    runTest(
      Effect.gen(function* () {
        const collector = yield* startCollector()
        const stale = yield* connect(collector.port)
        yield* stale.send(clientCodec.encode(hello('flaky-1', 'flaky', 'instance-a')))
        yield* stale.send(clientCodec.encode(spanStart('flaky-1', 'before')))
        yield* recorded(collector, 'flaky-1', 1)

        const fresh = yield* connect(collector.port)
        yield* fresh.send(clientCodec.encode(hello('flaky-1', 'flaky', 'instance-a')))
        yield* fresh.send(clientCodec.encode(spanStart('flaky-1', 'after')))
        yield* recorded(collector, 'flaky-1', 2)

        // The replaced connection closing late must not end the resumed run.
        yield* stale.close
        yield* Effect.sleep('50 millis')
        const snapshot = yield* collector.store.snapshot('flaky-1')
        expect(spanIds(snapshot?.messages)).toEqual(['before', 'after'])
        expect(snapshot?.session.active).toBe(true)
        expect(snapshot?.session.conflicts).toBeUndefined()
      }),
    ))

  it(
    'keeps two concurrently launched programs apart by their chosen IDs',
    () =>
      runTest(
        Effect.gen(function* () {
          const collector = yield* startCollector()
          // Real child processes, so the ID genuinely arrives through the
          // environment variable an agent would set at launch.
          const inspect = new URL('../client/Inspect.ts', import.meta.url).pathname
          const script = (label: string) => `
          import { Effect } from 'effect'
          import * as Inspect from ${JSON.stringify(inspect)}
          const step = (i) => Effect.sleep('10 millis').pipe(Effect.withSpan('${label}-' + i))
          await Effect.runPromise(
            Effect.forEach([0, 1, 2, 3, 4], step, { discard: true }).pipe(
              Effect.provide(Inspect.layer({ url: 'ws://127.0.0.1:${collector.port}', memoryIntervalMillis: 0 })),
            ),
          )`
          const launch = (label: string, sessionId: string) =>
            Effect.promise(
              () =>
                Bun.spawn([process.execPath, '-e', script(label)], {
                  cwd: new URL('../..', import.meta.url).pathname,
                  env: { ...process.env, EFFECT_INSPECT_SESSION_ID: sessionId },
                  stdout: 'ignore',
                  stderr: 'inherit',
                }).exited,
            )
          const codes = yield* Effect.all(
            [launch('alpha', 'agent-a-run-001'), launch('beta', 'agent-b-run-001')],
            { concurrency: 'unbounded' },
          )
          expect(codes).toEqual([0, 0])

          for (const [sessionId, label] of [
            ['agent-a-run-001', 'alpha'],
            ['agent-b-run-001', 'beta'],
          ] as const) {
            yield* until(
              Effect.map(
                collector.store.snapshot(sessionId),
                (snapshot) => snapshot?.session.active === false,
              ),
              `${sessionId} ended`,
            )
            const snapshot = yield* collector.store.snapshot(sessionId)
            const names = snapshot?.messages.flatMap((message) =>
              message._tag === 'SpanStart' ? [message.name] : [],
            )
            expect(names).toEqual([0, 1, 2, 3, 4].map((i) => `${label}-${i}`))
            expect(snapshot?.session.conflicts).toBeUndefined()
          }
        }),
      ),
    15_000,
  )
})
