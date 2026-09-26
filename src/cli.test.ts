import { describe, expect, it } from 'bun:test'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
// Exercise the same native server constructor used by the installed CLI.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer } from 'node:http'
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { mkdtempSync, readFileSync } from 'node:fs'
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { tmpdir } from 'node:os'
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { join } from 'node:path'
import { Effect, type Scope } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServer } from 'effect/unstable/http'
import * as Inspect from './client/Inspect.ts'
import { run as serve } from './collector/Server.ts'
import { make as makeStore, Store } from './collector/Store.ts'

const cliPath = new URL('./cli.ts', import.meta.url).pathname

const run = (...args: ReadonlyArray<string>) =>
  Bun.spawnSync({ cmd: [process.execPath, cliPath, ...args], stdout: 'pipe', stderr: 'pipe' })

// oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- test reads arbitrary CLI JSON
const parse = (stdout: string): any => JSON.parse(stdout)

/** Runs the CLI asynchronously, so an in-process collector keeps serving meanwhile. */
const cli = (...args: ReadonlyArray<string>) =>
  Effect.promise(() => {
    const child = Bun.spawn({
      cmd: [process.execPath, cliPath, ...args],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
  }).pipe(
    Effect.map(([stdout, stderr, exitCode]) => ({ exitCode, stdout, stderr, json: parse(stdout) })),
  )

const startCollector = Effect.fnUntraced(function* () {
  const store = yield* makeStore()
  const server = yield* NodeHttpServer.make(createServer, { port: 0 })
  yield* Effect.forkScoped(
    serve().pipe(
      Effect.provideService(Store, store),
      Effect.provideService(HttpServer.HttpServer, server),
    ),
  )
  const port = server.address._tag === 'UnixPathAddress' ? 0 : server.address.port
  return { port, url: `http://127.0.0.1:${port}` }
})

const instrumented = <A, E>(port: number, sessionId: string, program: Effect.Effect<A, E>) =>
  program.pipe(
    Effect.delay('50 millis'),
    Effect.provide(Inspect.layer({ url: `ws://127.0.0.1:${port}`, sessionId })),
    // Let the collector ingest the final messages before querying.
    Effect.andThen(Effect.sleep('200 millis')),
  )

const failing = Effect.gen(function* () {
  yield* Effect.logWarning('charging card')
  return yield* Effect.fail('declined')
}).pipe(Effect.withSpan('checkout.charge'), Effect.ignore, Effect.withSpan('checkout'))

/** 500 logs of ~2 KB: a 500-item page is over the 1 MiB response bound. */
const noisy = Effect.forEach(
  Array.from({ length: 500 }, (_, i) => i),
  (i) => Effect.logInfo(`${i} ${'x'.repeat(2100)}`),
).pipe(Effect.withSpan('noisy'))

/**
 * The final verifier's fixture: 500 Warn logs with 3000-character messages and
 * 32 annotations of 600 "é". At 28 items compact JSON (~1.02 MB) fits the bound
 * but the pretty rendering (~1.11 MB) does not; 29 items exceed it even compact.
 */
const annotated = Effect.forEach(
  Array.from({ length: 500 }, (_, i) => i),
  (i) =>
    Effect.logWarning(`${i} ${'m'.repeat(3000)}`).pipe(
      Effect.annotateLogs(
        Object.fromEntries(Array.from({ length: 32 }, (_, k) => [`key${k}`, 'é'.repeat(600)])),
      ),
    ),
).pipe(Effect.withSpan('annotated'))

const stdoutBytes = (stdout: string) => Buffer.byteLength(stdout, 'utf8')

const runTest = <E>(effect: Effect.Effect<void, E, HttpClient.HttpClient | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(FetchHttpClient.layer)))

const tempFile = (name: string) => join(mkdtempSync(join(tmpdir(), 'effect-inspect-cli-')), name)

describe('effect-inspect CLI help', () => {
  it('shows the command tree and investigation workflow in root help', () => {
    const result = run('--help')
    expect(result.exitCode).toBe(0)
    const help = result.stdout.toString()
    expect(help).toContain('effect-inspect <subcommand>')
    for (const command of ['start', 'summary', 'spans', 'span', 'logs', 'export', 'sessions']) {
      expect(help).toContain(command)
    }
    expect(help).toContain('EFFECT_INSPECT_SESSION_ID')
    expect(help).toContain('Inspect.layer()')
    expect(help).not.toContain('--wizard')
  })

  it('shows help for the start command', () => {
    const result = run('start', '--help')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('effect-inspect start')
    expect(result.stdout.toString()).toContain('EFFECT_INSPECT_PORT')
  })

  it('documents source, output and exit codes for every query command without a collector', () => {
    for (const command of ['sessions', 'summary', 'spans', 'span', 'logs', 'export']) {
      const result = run(command, '--help')
      expect(result.exitCode).toBe(0)
      expect(result.stderr.toString()).toBe('')
      const help = result.stdout.toString()
      expect(help).toContain(`effect-inspect ${command}`)
      expect(help).toContain('EXIT CODES')
      expect(help).toContain('stdout')
      expect(help).toContain('--json')
    }
  })
})

describe('effect-inspect CLI queries', () => {
  it('rejects a query without a source, offline and as JSON, exit 2', () =>
    runTest(
      Effect.gen(function* () {
        const result = yield* cli('summary', '--json', '--url', 'http://127.0.0.1:1')
        expect(result.exitCode).toBe(2)
        expect(result.json.error._tag).toBe('InvalidRequest')
        expect(result.stderr).toContain('InvalidRequest (exit 2)')
      }),
    ))

  it('turns flag parse errors into one InvalidRequest JSON on stdout, exit 2', () =>
    runTest(
      Effect.gen(function* () {
        const result = yield* cli('spans', '--session', 'x', '--bogus', '--json')
        expect(result.exitCode).toBe(2)
        expect(result.json).toMatchObject({ ok: false, op: 'spans' })
        expect(result.json.error._tag).toBe('InvalidRequest')
        expect(result.stdout.trim().split('\n')).toHaveLength(1)
      }),
    ))

  it('reports an unreachable collector as CollectorUnavailable, exit 8', () =>
    runTest(
      Effect.gen(function* () {
        const result = yield* cli('summary', '--session', 'x', '--url', 'http://127.0.0.1:1')
        expect(result.exitCode).toBe(8)
        expect(result.json.error._tag).toBe('CollectorUnavailable')
      }),
    ))

  it('reports an unreadable file as TraceFileError, exit 7', () =>
    runTest(
      Effect.gen(function* () {
        const result = yield* cli('summary', '--file', '/nonexistent/x.eitrace', '--json')
        expect(result.exitCode).toBe(7)
        expect(result.json.error).toMatchObject({
          _tag: 'TraceFileError',
          file: '/nonexistent/x.eitrace',
        })
      }),
    ))

  it('answers exact IDs live and from an export, with distinct errors', () =>
    runTest(
      Effect.gen(function* () {
        const { port, url } = yield* startCollector()
        yield* Effect.all(
          [
            instrumented(port, 'cli-a-001', failing),
            instrumented(port, 'cli-b-001', Effect.void.pipe(Effect.withSpan('b.only'))),
          ],
          { concurrency: 'unbounded' },
        )

        const summary = yield* cli('summary', '--session', 'cli-a-001', '--url', url, '--json')
        expect(summary.exitCode).toBe(0)
        expect(summary.stderr).toBe('')
        expect(summary.json.source.sessionId).toBe('cli-a-001')
        // Root help's JSON SHAPE names every top-level key a real summary has.
        const shape = run('--help').stdout.toString().split('JSON SHAPE')[1]!.split('EVIDENCE')[0]!
        for (const key of Object.keys(summary.json))
          expect(shape).toMatch(new RegExp(`\\b${key}\\b`))
        expect(summary.json.result.failures.items.map((s: { name: string }) => s.name)).toEqual([
          'checkout.charge',
        ])

        const other = yield* cli('spans', '--session', 'cli-b-001', '--url', url, '--json')
        expect(other.json.result.items.map((s: { name: string }) => s.name)).toEqual(['b.only'])

        const failed = yield* cli(
          'spans',
          '--session',
          'cli-a-001',
          '--status',
          'failed',
          '--url',
          url,
        )
        const spanId: string = failed.json.result.items[0].spanId
        const logs = yield* cli('logs', '--session', 'cli-a-001', '--span', spanId, '--url', url)
        expect(logs.exitCode).toBe(0)
        // Pretty-printed without --json.
        expect(logs.stdout).toContain('\n  "ok": true')
        expect(logs.json.result.items.map((l: { message: string }) => l.message)).toEqual([
          'charging card',
        ])

        const empty = yield* cli('spans', '--session', 'cli-a-001', '--name', 'zzz', '--url', url)
        expect(empty.exitCode).toBe(0)
        expect(empty.json.result.total).toBe(0)

        const unknown = yield* cli('summary', '--session', 'cli-c-001', '--url', url, '--json')
        expect(unknown.exitCode).toBe(3)
        expect(unknown.json.error).toMatchObject({
          _tag: 'SessionNotFound',
          sessionId: 'cli-c-001',
        })

        const missingSpan = yield* cli(
          'span',
          '--session',
          'cli-a-001',
          '--span',
          'nope',
          '--url',
          url,
        )
        expect(missingSpan.exitCode).toBe(4)

        const out = tempFile('a.eitrace')
        const exported = yield* cli('export', '--session', 'cli-a-001', '--out', out, '--url', url)
        expect(exported.exitCode).toBe(0)
        expect(exported.json.result).toMatchObject({ sessionId: 'cli-a-001', file: out })
        expect(exported.json.result.bytes).toBe(Buffer.byteLength(readFileSync(out, 'utf8')))
        const again = yield* cli('export', '--session', 'cli-a-001', '--out', out, '--url', url)
        expect(again.exitCode).toBe(10)
        expect(again.json.error._tag).toBe('OutputError')

        const offline = yield* cli('summary', '--file', out, '--session', 'cli-a-001', '--json')
        expect(offline.exitCode).toBe(0)
        expect(offline.json.result).toEqual(summary.json.result)
        expect(offline.json.source).toMatchObject({ kind: 'file', file: out })
        const wrongId = yield* cli('summary', '--file', out, '--session', 'cli-b-001', '--json')
        expect(wrongId.exitCode).toBe(3)
        expect(wrongId.json.error.fileSessionId).toBe('cli-a-001')
      }),
    ))

  it('refuses a reused ID live and from its export with SessionConflict, exit 5', () =>
    runTest(
      Effect.gen(function* () {
        const { port, url } = yield* startCollector()
        yield* instrumented(port, 'cli-dup-001', failing)
        yield* instrumented(port, 'cli-dup-001', failing)
        const live = yield* cli('summary', '--session', 'cli-dup-001', '--url', url, '--json')
        expect(live.exitCode).toBe(5)
        expect(live.json.error).toMatchObject({ _tag: 'SessionConflict', conflicts: 1 })
        const out = tempFile('dup.eitrace')
        const exported = yield* cli(
          'export',
          '--session',
          'cli-dup-001',
          '--out',
          out,
          '--url',
          url,
        )
        expect(exported.exitCode).toBe(0)
        expect((yield* cli('summary', '--file', out, '--json')).exitCode).toBe(5)
      }),
    ))

  it('reports a real HTTP 413 as ResponseTooLarge, exit 6, and a smaller page succeeds', () =>
    runTest(
      Effect.gen(function* () {
        const { port, url } = yield* startCollector()
        yield* instrumented(port, 'cli-big-001', noisy)
        // The transport itself answers 413 for this request.
        const client = yield* HttpClient.HttpClient
        const http = yield* client.execute(
          HttpClientRequest.post(`${url}/api/v1/query`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ op: 'logs', sessionId: 'cli-big-001', limit: 500 }),
          ),
        )
        expect(http.status).toBe(413)

        const big = yield* cli('logs', '--session', 'cli-big-001', '--limit', '500', '--url', url)
        expect(big.exitCode).toBe(6)
        expect(big.json.error).toMatchObject({
          _tag: 'ResponseTooLarge',
          limitBytes: 1_048_576,
          originalOutcome: 'ok',
        })
        expect(big.json.error.bytes).toBeGreaterThan(1_048_576)
        expect(big.stderr).toContain('ResponseTooLarge (exit 6)')

        const small = yield* cli('logs', '--session', 'cli-big-001', '--limit', '100', '--url', url)
        expect(small.exitCode).toBe(0)
        expect(small.json.result).toMatchObject({ total: 500, nextOffset: 100 })
      }),
    ))

  it('holds the complete printed stdout to 1 MiB in pretty and compact modes, and recovers', () =>
    runTest(
      Effect.gen(function* () {
        const { port, url } = yield* startCollector()
        yield* instrumented(port, 'cli-pretty-001', annotated)
        const page = (limit: string, ...mode: ReadonlyArray<string>) =>
          cli('logs', '--session', 'cli-pretty-001', '--limit', limit, '--url', url, ...mode)

        const pretty = yield* page('28')
        expect(pretty.exitCode).toBe(6)
        expect(stdoutBytes(pretty.stdout)).toBeLessThan(2000)
        expect(pretty.json.error).toMatchObject({
          _tag: 'ResponseTooLarge',
          output: 'pretty',
          originalOutcome: 'ok',
          limitBytes: 1_048_576,
        })
        expect(pretty.json.error.bytes).toBeGreaterThan(1_048_576)
        expect(pretty.json.error.hint).toContain('--json')
        expect(pretty.stderr).toContain('ResponseTooLarge (exit 6)')

        const compact = yield* page('28', '--json')
        expect(compact.exitCode).toBe(0)
        expect(stdoutBytes(compact.stdout)).toBeLessThanOrEqual(1_048_576)
        expect(compact.json.result.items).toHaveLength(28)

        const smaller = yield* page('25')
        expect(smaller.exitCode).toBe(0)
        expect(stdoutBytes(smaller.stdout)).toBeLessThanOrEqual(1_048_576)
        expect(smaller.json.result.nextOffset).toBe(25)

        // Over the bound even compact: the collector's own 413.
        const tooMany = yield* page('29', '--json')
        expect(tooMany.exitCode).toBe(6)
        expect(tooMany.json.error.output).toBeUndefined()
      }),
    ))
})
