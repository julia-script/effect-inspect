// These are integration tests: they drive a real Bun WebSocket server and
// assert on what arrives over the wire, so the harness is async and uses the
// wall clock on purpose. The Effect-style rules below are about production
// code and do not apply to it.
// oxlint-disable effecttsgo/async-function
// oxlint-disable effecttsgo/global-date
// oxlint-disable effecttsgo/global-error-in-effect-failure
// oxlint-disable effecttsgo/lazy-promise-in-effect-sync
// oxlint-disable typescript/no-floating-promises
import { describe, expect, it } from 'bun:test'
import { Effect, Exit, Result } from 'effect'
import { clientCodec } from '../protocol/Codec.ts'
import type { ClientMessage } from '../protocol/Schema.ts'
import * as Inspect from './Inspect.ts'

/**
 * Runs `program` with the layer pointed at a WebSocket server that captures
 * every line it receives, and returns the decoded messages.
 *
 * The server is real rather than a stubbed `Socket`, because most of what this
 * layer promises is about a socket's failure modes.
 */
const withCollector = async <A>(
  program: Effect.Effect<A, never, never>,
  options?: Inspect.Options,
): Promise<{ readonly value: A; readonly messages: ReadonlyArray<ClientMessage> }> => {
  const lines: Array<string> = []
  let received: (() => void) | undefined
  const server = Bun.serve({
    port: 0,
    fetch: (request, self) => (self.upgrade(request) ? undefined : new Response('no')),
    websocket: {
      message: (_ws, message) => {
        lines.push(String(message))
        received?.()
      },
    },
  })

  try {
    const value = await Effect.runPromise(
      program.pipe(
        Effect.provide(Inspect.layer({ ...options, url: `ws://localhost:${server.port}` })),
      ),
    )
    // The layer's scope closes with the program, but delivery is asynchronous:
    // wait for the socket to go quiet rather than for a fixed duration.
    await quiet(
      () => lines.length,
      (resume) => (received = resume),
    )
    const messages = lines.flatMap((line) =>
      Result.getOrElse(clientCodec.decodeAll(line), () => [] as ReadonlyArray<ClientMessage>),
    )
    return { value, messages }
  } finally {
    server.stop(true)
  }
}

/** Resolves once no new message has arrived for a short settling window. */
const quiet = async (count: () => number, onMessage: (resume: () => void) => void) => {
  onMessage(() => {})
  for (let idle = 0, last = -1; idle < 3; idle++) {
    if (count() !== last) {
      last = count()
      idle = 0
    }
    await Bun.sleep(25)
  }
}

describe('Inspect.layer', () => {
  it('does not break or delay a program when no collector is listening', async () => {
    // Port 1 is reserved and never listening, so this is a genuine dial failure
    // rather than a mocked one.
    const layer = Inspect.layer({ url: 'ws://localhost:1' })
    const program = Effect.gen(function* () {
      yield* Effect.log('still running')
      return yield* Effect.succeed('finished').pipe(Effect.withSpan('unreachable-collector'))
    })

    const started = Date.now()
    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(layer)))

    expect(exit).toStrictEqual(Exit.succeed('finished'))
    // Generous enough not to flake, tight enough to catch a connect that blocks:
    // the reconnect backoff alone would push a waiting program past this.
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('survives a collector that disconnects mid-run', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request, self) => (self.upgrade(request) ? undefined : new Response('no')),
      websocket: { message: () => {} },
    })
    const layer = Inspect.layer({ url: `ws://localhost:${server.port}` })

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* Effect.succeed(1).pipe(Effect.withSpan('before-disconnect'))
        yield* Effect.sync(() => server.stop(true))
        yield* Effect.sleep('50 millis')
        return yield* Effect.succeed('finished').pipe(Effect.withSpan('after-disconnect'))
      }).pipe(Effect.provide(layer)),
    )

    expect(exit).toStrictEqual(Exit.succeed('finished'))
  })

  it('reconnects to a restarted collector and re-sends Hello for the same session', async () => {
    // A fixed port so the replacement collector is the same endpoint, which is
    // what a restarted collector looks like to a running program.
    const port = 39_411
    const serve = (lines: Array<string>) =>
      Bun.serve({
        port,
        fetch: (request, self) => (self.upgrade(request) ? undefined : new Response('no')),
        websocket: {
          message: (_ws, message) => {
            lines.push(String(message))
          },
        },
      })

    const before: Array<string> = []
    const after: Array<string> = []
    let server = serve(before)

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.void.pipe(Effect.withSpan('before-restart'))
          yield* Effect.sleep('150 millis')
          yield* Effect.sync(() => server.stop(true))
          yield* Effect.sleep('200 millis')
          yield* Effect.sync(() => {
            server = serve(after)
          })
          // Long enough for the capped backoff to dial again.
          yield* Effect.sleep('1500 millis')
          yield* Effect.void.pipe(Effect.withSpan('after-restart'))
          yield* Effect.sleep('300 millis')
        }).pipe(Effect.provide(Inspect.layer({ url: `ws://localhost:${port}` }))),
      )
    } finally {
      server.stop(true)
    }

    const decode = (lines: ReadonlyArray<string>) =>
      lines.flatMap((line) =>
        Result.getOrElse(clientCodec.decodeAll(line), () => [] as ReadonlyArray<ClientMessage>),
      )

    const first = decode(before)
    const second = decode(after)

    expect(first[0]?._tag).toBe('Hello')
    // The reconnect re-announces the session rather than starting a new one.
    expect(second[0]?._tag).toBe('Hello')
    expect(second[0]?.sessionId).toBe(first[0]!.sessionId)
    // And telemetry emitted after the restart reaches the new collector.
    expect(second.some((message) => message._tag === 'SpanStart')).toBe(true)
  }, 10_000)

  it('sends Hello first, then spans in order', async () => {
    const { messages, value } = await withCollector(
      Effect.succeed('ok').pipe(Effect.withSpan('child'), Effect.withSpan('parent')),
    )

    expect(value).toBe('ok')
    expect(messages[0]?._tag).toBe('Hello')

    const tags = messages.map((message) => message._tag)
    // Children start before and end before their parents.
    expect(tags.filter((tag) => tag === 'SpanStart' || tag === 'SpanEnd')).toStrictEqual([
      'SpanStart',
      'SpanStart',
      'SpanEnd',
      'SpanEnd',
    ])

    const starts = messages.filter((message) => message._tag === 'SpanStart')
    expect(starts.map((span) => span.name)).toStrictEqual(['parent', 'child'])
    const [parent, child] = starts
    expect(parent?.parent).toBeUndefined()
    expect(child?.parent).toStrictEqual({ _tag: 'LocalParent', spanId: parent!.spanId })
  })

  it('carries attributes, events and a flattened failure outcome', async () => {
    const { messages } = await withCollector(
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan('late', 'value')
        yield* Effect.currentSpan.pipe(
          Effect.flatMap((span) => Effect.sync(() => span.event('checkpoint', 1n, { at: 'here' }))),
          Effect.ignore,
        )
        return yield* Effect.fail(new Error('boom'))
      }).pipe(
        Effect.withSpan('failing', { attributes: { early: 'value', fn: () => 1 } }),
        Effect.ignore,
      ),
    )

    const event = messages.find((message) => message._tag === 'SpanEvent')
    expect(event?.name).toBe('checkpoint')
    expect(event?.attributes['at']).toBe('here')

    const end = messages.find((message) => message._tag === 'SpanEnd')
    if (end === undefined) throw new Error('expected a SpanEnd')
    const outcome = end.outcome
    expect(outcome).toMatchObject({ _tag: 'Failure', kind: 'Fail' })
    if (outcome._tag !== 'Failure') throw new Error('expected a failure outcome')
    expect(outcome.error).toInclude('boom')

    // Effect applies `withSpan`'s attributes after the tracer hands the span
    // back, so they ride on `SpanEnd` for the collector to merge — including
    // the ones added mid-span.
    expect(end.attributes['early']).toBe('value')
    expect(end.attributes['late']).toBe('value')
    // Outside the Json union, so stringified at the edge rather than failing
    // the encode.
    expect(typeof end.attributes['fn']).toBe('string')
  })

  it('forwards logs, correlated with the enclosing span', async () => {
    const { messages } = await withCollector(
      Effect.gen(function* () {
        yield* Effect.log('inside')
        yield* Effect.logWarning('annotated').pipe(Effect.annotateLogs('key', 'value'))
      }).pipe(Effect.withSpan('logged')),
    )

    const span = messages.find((message) => message._tag === 'SpanStart')
    const logs = messages.filter((message) => message._tag === 'Log')

    expect(logs.map((log) => log.message)).toStrictEqual(['inside', 'annotated'])
    expect(logs.every((log) => log.spanId === span?.spanId)).toBe(true)
    expect(logs[1]?.level).toBe('Warn')
    expect(logs[1]?.annotations['key']).toBe('value')
  })

  it('drops the oldest messages instead of growing without bound', async () => {
    const { messages } = await withCollector(
      // A queue far smaller than the burst, so the overflow path is forced.
      Effect.forEach(
        Array.from({ length: 200 }, (_, index) => index),
        (index) => Effect.void.pipe(Effect.withSpan(`span-${index}`)),
        { discard: true },
      ),
      { bufferSize: 4 },
    )

    const spans = messages.filter((message) => message._tag === 'SpanStart')
    // Bounded: nothing like the 200 spans emitted made it through.
    expect(spans.length).toBeLessThan(200)
    // And the gap is reported rather than silently swallowed.
    const dropped = messages.find(
      (message) =>
        message._tag === 'Log' && message.annotations['effect_inspect.dropped'] !== undefined,
    )
    expect(dropped).toBeDefined()
  })
})
