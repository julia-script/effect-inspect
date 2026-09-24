// An integration test like `Batching.test.ts`: it drives a real Bun WebSocket
// server, because the question this file answers — *which* messages survive an
// overflow — is only answerable from what actually arrives at a collector.
// The Effect-style rules below are about production code and do not apply.
// oxlint-disable effecttsgo/async-function
// oxlint-disable typescript/no-floating-promises
import { describe, expect, it } from 'bun:test'
import { Effect, Layer, Result } from 'effect'
import { Socket } from 'effect/unstable/socket'
import { clientCodec } from '../protocol/Codec.ts'
import type { ClientMessage, SessionId, SpanEnd, SpanStart } from '../protocol/Schema.ts'
import * as Client from './Client.ts'
import { InspectClient } from './Client.ts'

/** Runs `program` against a capturing collector and returns the decoded messages. */
const withMessages = async (
  program: Effect.Effect<void, never, InspectClient>,
  options?: Client.Options,
): Promise<ReadonlyArray<ClientMessage>> => {
  const frames: Array<string> = []
  const server = Bun.serve({
    port: 0,
    fetch: (request, self) => (self.upgrade(request) ? undefined : new Response('no')),
    websocket: { message: (_ws, message) => void frames.push(String(message)) },
  })

  try {
    const layer = Layer.effect(InspectClient)(Client.make(options)).pipe(
      Layer.provide(Socket.layerWebSocket(`ws://localhost:${server.port}`)),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
    )
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
    await quiet(() => frames.length)
    return frames.flatMap((frame) =>
      Result.getOrElse(clientCodec.decodeAll(frame), () => [] as ReadonlyArray<ClientMessage>),
    )
  } finally {
    server.stop(true)
  }
}

/** Resolves once no new frame has arrived for a short settling window. */
const quiet = async (count: () => number) => {
  for (let idle = 0, last = -1; idle < 4; idle++) {
    if (count() !== last) {
      last = count()
      idle = 0
    }
    await Bun.sleep(25)
  }
}

const spanStart = (sessionId: SessionId, name: string): SpanStart => ({
  _tag: 'SpanStart',
  sessionId,
  spanId: name,
  traceId: 'trace',
  name,
  kind: 'internal',
  startTime: 1n,
  attributes: {},
  sampled: true,
})

const spanEnd = (sessionId: SessionId, name: string): SpanEnd => ({
  _tag: 'SpanEnd',
  sessionId,
  spanId: name,
  endTime: 2n,
  outcome: { _tag: 'Success' },
  attributes: {},
})

/**
 * Offers messages in one synchronous burst, then lets the drain catch up.
 *
 * A plain loop inside one `Effect.sync` never yields to the pump, which is the
 * burst shape the buffer has to survive.
 */
const burst = (send: (client: InspectClient['Service']) => void) =>
  Effect.gen(function* () {
    const client = yield* InspectClient
    yield* Effect.sync(() => send(client))
    yield* Effect.sleep('400 millis')
  })

const names = (messages: ReadonlyArray<ClientMessage>, tag: 'SpanStart' | 'SpanEnd') =>
  messages
    .filter((message): message is SpanStart | SpanEnd => message._tag === tag)
    .map((span) => span.spanId)

describe('outbound buffer', () => {
  it('loses nothing on a burst far larger than the old 8192 bound', async () => {
    const count = 20000
    const messages = await withMessages(
      burst((client) => {
        for (let index = 0; index < count; index++) {
          client.sendUnsafe(spanStart(client.sessionId, `span-${index}`))
        }
      }),
      { memoryIntervalMillis: 0 },
    )

    // Every span arrives, in order, and no gap is reported: the default bound
    // is deep enough that a burst this size is not an overflow at all.
    expect(names(messages, 'SpanStart')).toStrictEqual(
      Array.from({ length: count }, (_, index) => `span-${index}`),
    )
    expect(messages.some((message) => message._tag === 'Hello')).toBe(true)
    expect(
      messages.some(
        (message) =>
          message._tag === 'Log' && message.annotations['effect_inspect.dropped'] !== undefined,
      ),
    ).toBe(false)
  })

  it('keeps the earliest messages and refuses the newest once the ceiling is hit', async () => {
    // A ceiling far below the burst, so overflow is forced and observable.
    const capacity = 64
    const count = 2000
    const messages = await withMessages(
      burst((client) => {
        for (let index = 0; index < count; index++) {
          client.sendUnsafe(spanStart(client.sessionId, `span-${index}`))
        }
      }),
      { bufferSize: capacity, memoryIntervalMillis: 0 },
    )

    const started = names(messages, 'SpanStart')
    // Bounded, as documented: nothing like the whole burst got through.
    expect(started.length).toBeLessThan(count)
    // And what survived is a *prefix* of the burst, not a window sliding off the
    // front of it. This is the failure the change exists to remove: a sliding
    // queue would have kept `span-1999` and thrown `span-0` away.
    expect(started.slice(0, capacity)).toStrictEqual(
      Array.from({ length: capacity }, (_, index) => `span-${index}`),
    )
    // The loss is still reported rather than silently swallowed.
    expect(
      messages.some(
        (message) =>
          message._tag === 'Log' && message.annotations['effect_inspect.dropped'] !== undefined,
      ),
    ).toBe(true)
  })

  it('never evicts Hello or an already-buffered SpanEnd', async () => {
    // The reference failure, in miniature: a long-lived span ends and *then* the
    // program floods the buffer. Under the old sliding queue both the `Hello`
    // and that `SpanEnd` were evicted by the flood behind them, and the span
    // rendered as never-ending.
    const messages = await withMessages(
      burst((client) => {
        client.sendUnsafe(spanStart(client.sessionId, 'long-lived'))
        client.sendUnsafe(spanEnd(client.sessionId, 'long-lived'))
        for (let index = 0; index < 5000; index++) {
          client.sendUnsafe(spanStart(client.sessionId, `noise-${index}`))
        }
      }),
      { bufferSize: 32, memoryIntervalMillis: 0 },
    )

    // `Hello` is the session's wall-clock anchor; losing it breaks `epochOrigin`.
    expect(messages.filter((message) => message._tag === 'Hello').length).toBeGreaterThan(0)
    // And the span closes: its end survived the flood that followed it.
    expect(names(messages, 'SpanStart')).toContain('long-lived')
    expect(names(messages, 'SpanEnd')).toStrictEqual(['long-lived'])
  })

  it('never throws, whatever is thrown at it', async () => {
    // `sendUnsafe` runs inside `Tracer.span`, `span.end` and a `Logger`, none of
    // which can fail — so a full queue, an unencodable message and a message
    // with a cyclic attribute all have to return normally.
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    await withMessages(
      burst((client) => {
        for (let index = 0; index < 500; index++) {
          expect(() =>
            client.sendUnsafe(spanStart(client.sessionId, `span-${index}`)),
          ).not.toThrow()
        }
        expect(() =>
          // `fiberId` is a `Natural`, so -1 is out of its domain: unencodable.
          client.sendUnsafe({ ...spanStart(client.sessionId, 'bad'), fiberId: -1 }),
        ).not.toThrow()
        expect(() =>
          client.sendUnsafe({
            ...spanStart(client.sessionId, 'cyclic'),
            attributes: cyclic as never,
          }),
        ).not.toThrow()
      }),
      { bufferSize: 8, memoryIntervalMillis: 0 },
    )
  })
})
