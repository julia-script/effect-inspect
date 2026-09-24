/**
 * The outbound half of the inspect layer: a bounded queue plus the fiber that
 * drains it to the collector.
 *
 * The guarantee that shapes this module is that instrumenting a program must
 * never break or slow it. So the producer side is a synchronous, non-blocking
 * {@link InspectClient} `sendUnsafe` onto a sliding queue, and every transport
 * concern — no collector listening, a mid-run disconnect, a consumer slower
 * than the program — is confined to a background fiber whose failures are
 * swallowed and retried. When the program outruns the socket the queue drops
 * its oldest messages and reports the count, rather than growing without bound
 * or pushing backpressure into the fibers being traced.
 */
import { Context, Duration, Effect, Latch, Queue, Schedule, type Scope } from 'effect'
import type { Socket } from 'effect/unstable/socket'
import { Socket as SocketService } from 'effect/unstable/socket'
import { clientCodec } from '../protocol/Codec.ts'
import * as Protocol from '../protocol/Schema.ts'

/** How many messages may be buffered before the oldest are dropped. */
const defaultBufferSize = 8192

/** How often a `Ping` is sent, so the collector can see a quiet program is alive. */
const pingInterval = Duration.seconds(3)

/** How often `process.memoryUsage()` is sampled, unless told otherwise. */
const defaultMemoryIntervalMillis = 100

/**
 * How long shutdown waits for queued messages to reach the collector.
 *
 * Bounded because the alternative to a lost tail is a program that will not
 * exit, and that is the worse failure.
 */
const flushTimeout = Duration.millis(250)

/** Reconnect backoff: doubling from 250ms, capped so a late collector is still found. */
const reconnectSchedule = Schedule.exponential(Duration.millis(250)).pipe(
  Schedule.modifyDelay(({ output }) => Effect.succeed(Duration.min(output, Duration.seconds(5)))),
)

/**
 * The sink the tracer and logger push telemetry into.
 *
 * `sendUnsafe` is deliberately synchronous and total: it is called from inside
 * `Tracer.span`, `span.end` and a `Logger`, none of which can suspend or fail.
 */
export class InspectClient extends Context.Service<
  InspectClient,
  {
    readonly sessionId: Protocol.SessionId
    readonly sendUnsafe: (message: Protocol.ClientMessage) => void
  }
>()('effect-inspect/client/InspectClient') {}

/** Options accepted by the inspect layers. */
export interface Options {
  /** Name shown for this program in the webapp. Defaults to the entry script's file name. */
  readonly programName?: string | undefined
  /** Outbound queue capacity, in messages. Defaults to 8192. */
  readonly bufferSize?: number | undefined
  /**
   * How often to sample `process.memoryUsage()`, in milliseconds. Defaults to
   * 100. Set to `0` to record no memory at all.
   *
   * Ignored in a runtime without `process.memoryUsage` — a browser or an edge
   * worker records nothing and says nothing about it.
   */
  readonly memoryIntervalMillis?: number | undefined
}

/**
 * The name this program lists as.
 *
 * The entry script's **file name**, not its path: `argv[1]` is absolute, so the
 * default used to list a program as `/Users/.../examples/webapp.ts` and fill
 * the session list with the same prefix over and over.
 */
const programName = (options: Options | undefined): string => {
  if (options?.programName !== undefined) return options.programName
  const script = globalThis.process?.argv?.[1]
  if (script === undefined || script === '') return 'effect'
  return script.split(/[/\\]/).pop() || script
}

const runtimeName = (): string => {
  const versions = globalThis.process?.versions
  if (versions?.bun !== undefined) return `bun ${versions.bun}`
  if (versions?.node !== undefined) return `node ${versions.node}`
  return 'unknown'
}

/**
 * `process.memoryUsage`, or `undefined` in a runtime that has no such thing.
 *
 * Resolved once, at layer construction: the check is a property read, but doing
 * it per sample would be a property read on the host program's hot path for a
 * value that cannot change. A browser, Deno without `--allow-*`, or a Workers
 * runtime lands on `undefined` and simply never samples — silently, forever,
 * which is the whole contract here.
 */
const memoryUsage = (): (() => NodeJS.MemoryUsage) | undefined => {
  const usage = globalThis.process?.memoryUsage
  return typeof usage === 'function' ? usage.bind(globalThis.process) : undefined
}

/**
 * Forks the fiber that samples process memory into the outbound queue.
 *
 * Deliberately the same shape as the `Ping` fiber: a delayed `forever` forked
 * into the client's scope, so it dies with the layer and cannot keep a program
 * alive past its own exit. Sampling rides `sendUnsafe` like everything else, so
 * a full queue drops a sample rather than pushing back on the host — a gap in a
 * memory curve is a far cheaper failure than a stalled program.
 *
 * Returns `void` and forks nothing when the runtime has no `process.memoryUsage`
 * or the interval is not a positive number.
 */
const forkMemorySampler = (deps: {
  readonly sendUnsafe: (message: Protocol.ClientMessage) => void
  readonly sessionId: Protocol.SessionId
  readonly intervalMillis: number
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.suspend(() => {
    const usage = memoryUsage()
    if (usage === undefined || !(deps.intervalMillis > 0)) return Effect.void
    const sample = Effect.clockWith((clock) =>
      Effect.sync(() => {
        const memory = usage()
        deps.sendUnsafe({
          _tag: 'MemorySample',
          sessionId: deps.sessionId,
          time: clock.currentTimeNanosUnsafe(),
          // Rounded because the protocol's `Natural` rejects a fraction, and
          // `rss` on some platforms is not an integer.
          heapUsed: Math.round(memory.heapUsed),
          heapTotal: Math.round(memory.heapTotal),
          rss: Math.round(memory.rss),
          external: Math.round(memory.external),
        })
      }),
    )
    return sample.pipe(
      Effect.delay(Duration.millis(deps.intervalMillis)),
      Effect.forever,
      Effect.forkScoped,
      Effect.asVoid,
    )
  })

/**
 * Builds the client service and forks the fiber that owns the connection.
 *
 * The returned effect never fails and never waits for the collector: if it is
 * unreachable the fiber retries in the background while `sendUnsafe` keeps
 * accepting (and dropping) messages, so the host program is unaffected.
 */
export const make = (
  options?: Options,
): Effect.Effect<InspectClient['Service'], never, Scope.Scope | Socket.Socket> =>
  Effect.gen(function* () {
    const socket = yield* SocketService.Socket
    const capacity = options?.bufferSize ?? defaultBufferSize
    const queue = yield* Queue.sliding<Protocol.ClientMessage>(capacity)
    // Effect's `Crypto` can fail with a PlatformError and nothing on this path
    // is allowed to fail; a session id needs uniqueness, not strength.
    // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect
    const sessionId = crypto.randomUUID()

    // Tracked here rather than inside the queue so a drop survives a
    // reconnect: it is reported on the next `Hello`, which every reconnect
    // re-sends. A sliding `offerUnsafe` always succeeds, so a full queue is
    // the only drop signal there is.
    // Open exactly while the queue is empty, so shutdown can ask "is everything
    // on the wire?" rather than guessing with a sleep.
    const flushed = Latch.makeUnsafe(true)

    let dropped = 0
    let reported = 0
    const sendUnsafe = (message: Protocol.ClientMessage): void => {
      if (Queue.sizeUnsafe(queue) >= capacity) dropped += 1
      Queue.offerUnsafe(queue, message)
      flushed.closeUnsafe()
    }

    const hello = Effect.clockWith((clock) =>
      Effect.succeed<Protocol.Hello>({
        _tag: 'Hello',
        sessionId,
        program: programName(options),
        pid: globalThis.process?.pid ?? 0,
        runtime: runtimeName(),
        protocolVersion: Protocol.protocolVersion,
        clock: {
          startTime: clock.currentTimeNanosUnsafe(),
          // Deliberately the wall clock: this is the anchor that maps the
          // monotonic span clock onto absolute time, which is precisely what
          // Effect's `Clock` is not.
          // oxlint-disable-next-line effecttsgo/global-date
          wallClockEpochMillis: Date.now(),
        },
      }),
    )

    // ponytail: drops are reported as a `Log`, not a dedicated protocol field.
    // `Hello` has no dropped-count and the schema is frozen; a Warn log rides
    // the same ordered stream the webapp already renders, so the gap is visible
    // in place. Promote to a real field if the UI needs to count it separately.
    const reportDropped = Effect.clockWith((clock) =>
      Effect.sync((): Protocol.Log | undefined => {
        if (dropped === reported) return undefined
        const gap = dropped - reported
        reported = dropped
        return {
          _tag: 'Log',
          sessionId,
          time: clock.currentTimeNanosUnsafe(),
          level: 'Warn',
          message: `effect-inspect dropped ${gap} messages: the collector is slower than this program`,
          annotations: { 'effect_inspect.dropped': gap, 'effect_inspect.droppedTotal': dropped },
        }
      }),
    )

    yield* connection({ socket, queue, sessionId, hello, reportDropped, flushed }).pipe(
      Effect.forkScoped,
    )

    yield* forkMemorySampler({
      sendUnsafe,
      sessionId,
      intervalMillis: options?.memoryIntervalMillis ?? defaultMemoryIntervalMillis,
    })

    // A short program can finish before the socket has even opened, and closing
    // the scope would otherwise interrupt the connection fiber mid-flight and
    // lose the whole trace. So wait for the queue to drain — but only briefly,
    // and never propagating a failure: a collector that has gone away must not
    // become a program that will not exit.
    yield* Effect.addFinalizer(() =>
      Latch.await(flushed).pipe(Effect.timeoutOption(flushTimeout), Effect.ignore),
    )

    return InspectClient.of({ sessionId, sendUnsafe })
  })

/**
 * Holds one connection open: sends `Hello`, then pumps the queue until the
 * socket fails, at which point the retry schedule dials again.
 */
const connection = (deps: {
  readonly socket: Socket.Socket
  readonly queue: Queue.Queue<Protocol.ClientMessage>
  readonly sessionId: Protocol.SessionId
  readonly hello: Effect.Effect<Protocol.Hello>
  readonly reportDropped: Effect.Effect<Protocol.Log | undefined>
  readonly flushed: Latch.Latch
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    // The reader is what actually dials: a WebSocket `Socket` only connects
    // when its reader is acquired, and until then every write parks waiting for
    // a connection that will never be made. Acquiring it also surfaces the
    // disconnect that drives the reconnect below.
    const reader = yield* deps.socket.reader
    const writer = yield* deps.socket.writer
    const write = (message: Protocol.ClientMessage) =>
      Effect.suspend(() => writer.write(clientCodec.encode(message)))

    yield* Effect.flatMap(deps.hello, write)

    // Keeps the connection warm and surfaces a half-open socket as a write
    // failure, which is what triggers the reconnect.
    yield* write({ _tag: 'Ping', sessionId: deps.sessionId }).pipe(
      Effect.delay(pingInterval),
      Effect.forever,
      Effect.forkScoped,
    )

    const pump = Effect.gen(function* () {
      const batch = yield* Queue.takeAll(deps.queue)
      // Announced before the batch, so the gap is ordered where it happened.
      const gap = yield* deps.reportDropped
      if (gap !== undefined) yield* write(gap)
      yield* Effect.forEach(batch, write)
      // Everything offered so far is on the wire. `sendUnsafe` closes the latch
      // again on the next message, so this tracks the queue rather than latching
      // permanently on the first quiet moment.
      if (Queue.sizeUnsafe(deps.queue) === 0) deps.flushed.openUnsafe()
    })

    // Raced rather than forked: a forked fiber's failure would not reach this
    // scope, so a collector that goes away mid-run would be noticed only if the
    // program happened to write again. Whichever side notices the disconnect
    // first ends the connection, and the retry below dials the next one.
    return yield* Effect.raceFirst(Effect.forever(pump), Effect.forever(reader.pull))
  }).pipe(
    Effect.scoped,
    // Every failure here is the collector's, never the host program's: retry
    // forever, and if the retry itself somehow gives up, stay silent.
    Effect.retry(reconnectSchedule),
    Effect.ignore,
  )
