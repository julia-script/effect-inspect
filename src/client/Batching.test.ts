// An integration test like `Inspect.test.ts`: it drives a real Bun WebSocket
// server and asserts on the frames that arrive, which is the only place the
// difference between one write per message and one write per batch is visible.
// The Effect-style rules below are about production code and do not apply.
// oxlint-disable effecttsgo/async-function
// oxlint-disable typescript/no-floating-promises
import { describe, expect, it } from 'bun:test'
import { Effect, Layer, Result } from 'effect'
import { Socket } from 'effect/unstable/socket'
import { clientCodec } from '../protocol/Codec.ts'
import type { ClientMessage, SessionId } from '../protocol/Schema.ts'
import * as Client from './Client.ts'
import { InspectClient } from './Client.ts'

/**
 * Runs `program` against a capturing collector and returns the raw frames.
 *
 * Frames rather than messages: the whole point of the change under test is how
 * many `websocket.message` callbacks a batch produces, which is lost the moment
 * the lines are flattened.
 */
const withFrames = async (
  program: Effect.Effect<void, never, InspectClient>,
  options?: Client.Options,
): Promise<ReadonlyArray<string>> => {
  const frames: Array<string> = []
  let received: (() => void) | undefined
  const server = Bun.serve({
    port: 0,
    fetch: (request, self) => (self.upgrade(request) ? undefined : new Response('no')),
    websocket: {
      message: (_ws, message) => {
        frames.push(String(message))
        received?.()
      },
    },
  })

  try {
    // The client layer directly rather than `Inspect.layer`: these tests offer
    // messages through `InspectClient` themselves, so they need the service in
    // context and none of the tracer/logger wiring on top of it.
    const layer = Layer.effect(InspectClient)(Client.make(options)).pipe(
      Layer.provide(Socket.layerWebSocket(`ws://localhost:${server.port}`)),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
    )
    await Effect.runPromise(program.pipe(Effect.provide(layer)))
    await quiet(
      () => frames.length,
      (resume) => (received = resume),
    )
    return frames
  } finally {
    server.stop(true)
  }
}

/** Resolves once no new frame has arrived for a short settling window. */
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

const decode = (frames: ReadonlyArray<string>): ReadonlyArray<ClientMessage> =>
  frames.flatMap((frame) =>
    Result.getOrElse(clientCodec.decodeAll(frame), () => [] as ReadonlyArray<ClientMessage>),
  )

/** A `SpanStart` carrying `name`, or an unencodable one when `fiberId` is out of domain. */
const spanStart = (sessionId: SessionId, name: string, fiberId?: number): ClientMessage => ({
  _tag: 'SpanStart',
  sessionId,
  spanId: name,
  traceId: 'trace',
  name,
  kind: 'internal',
  startTime: 1n,
  attributes: {},
  sampled: true,
  ...(fiberId === undefined ? {} : { fiberId }),
})

/**
 * Offers `count` messages and lets the drain pick them up as one batch.
 *
 * `sendUnsafe` is synchronous, so a plain loop inside one `Effect.sync` fills
 * the queue without ever yielding to the pump — which is exactly the burst
 * shape this change exists to handle.
 */
const burst = (
  count: number,
  message: (client: InspectClient['Service'], index: number) => ClientMessage,
) =>
  Effect.gen(function* () {
    const client = yield* InspectClient
    yield* Effect.sync(() => {
      for (let index = 0; index < count; index++) client.sendUnsafe(message(client, index))
    })
    yield* Effect.sleep('200 millis')
  })

describe('batched socket writes', () => {
  it('writes a whole batch as one frame, in order', async () => {
    const frames = await withFrames(
      burst(500, (client, index) => spanStart(client.sessionId, `span-${index}`)),
      { bufferSize: 8192, memoryIntervalMillis: 0 },
    )

    const messages = decode(frames)
    const names = messages
      .filter((message) => message._tag === 'SpanStart')
      .map((span) => span.name)

    // Nothing lost, and the order the program emitted them in is the order they
    // arrive in.
    expect(names).toStrictEqual(Array.from({ length: 500 }, (_, index) => `span-${index}`))
    // 500 messages that used to cost 500 frames now cost a handful: `Hello` has
    // its own write, and the burst may straddle a drain, but nothing like 500.
    expect(frames.length).toBeLessThan(10)
    // And the frames really are multi-line, not 500 single-line writes.
    expect(frames.some((frame) => frame.trimEnd().includes('\n'))).toBe(true)
  })

  it('cuts a batch into several frames once it exceeds the size budget', async () => {
    // Each message carries ~4 KiB of attribute, so 500 of them is ~2 MB: well
    // past the 256 KiB frame budget, which must therefore produce several
    // frames rather than one enormous one.
    const padding = 'x'.repeat(4096)
    const frames = await withFrames(
      burst(500, (client, index) => ({
        ...spanStart(client.sessionId, `big-${index}`),
        attributes: { padding },
      })),
      { bufferSize: 8192, memoryIntervalMillis: 0 },
    )

    const messages = decode(frames)
    expect(messages.filter((message) => message._tag === 'SpanStart').length).toBe(500)

    // Every frame respects the budget, give or take the one message that
    // crosses it — a frame is never cut mid-message.
    for (const frame of frames) {
      expect(frame.length).toBeLessThan(256 * 1024 + 8192)
    }
    // Chunked, not written whole: at ~4 KiB each, 500 messages is ~2 MB, so the
    // 256 KiB budget forces at least several frames.
    const multiLine = frames.filter((frame) => frame.trimEnd().includes('\n'))
    expect(multiLine.length).toBeGreaterThan(4)
    // And chunking is what cut them, not the drain: each full frame is packed
    // to just under the budget rather than holding a message or two.
    expect(multiLine.filter((frame) => frame.length > 256 * 1024 - 8192).length).toBeGreaterThan(3)
  })

  it('drops only the message that will not encode, not the batch around it', async () => {
    const frames = await withFrames(
      burst(5, (client, index) =>
        // `fiberId` is a `Natural`, so -1 is out of its domain and the encode
        // fails — the producer bug this path has to survive.
        index === 2
          ? spanStart(client.sessionId, `span-${index}`, -1)
          : spanStart(client.sessionId, `span-${index}`),
      ),
      { bufferSize: 8192, memoryIntervalMillis: 0 },
    )

    const names = decode(frames)
      .filter((message) => message._tag === 'SpanStart')
      .map((span) => span.name)

    // The bad one is gone; every other message in its batch survived, in order.
    expect(names).toStrictEqual(['span-0', 'span-1', 'span-3', 'span-4'])
  })

  it('keeps the dropped-gap warning ahead of the batch it precedes', async () => {
    const frames = await withFrames(
      burst(200, (client, index) => spanStart(client.sessionId, `span-${index}`)),
      // Far smaller than the burst, so the queue overflows and the gap is
      // reported.
      { bufferSize: 4, memoryIntervalMillis: 0 },
    )

    const messages = decode(frames)
    const gapIndex = messages.findIndex(
      (message) =>
        message._tag === 'Log' && message.annotations['effect_inspect.dropped'] !== undefined,
    )
    expect(gapIndex).toBeGreaterThanOrEqual(0)
    // The warning is not appended after the batch it explains: at least one
    // span follows it.
    expect(messages.slice(gapIndex + 1).some((message) => message._tag === 'SpanStart')).toBe(true)
  })
})
