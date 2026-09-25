/**
 * The outbound half of the inspect layer: a bounded queue plus the fiber that
 * drains it to the collector.
 *
 * The guarantee that shapes this module is that instrumenting a program must
 * never break or slow it. So the producer side is a synchronous, non-blocking
 * {@link InspectClient} `sendUnsafe` onto a dropping queue, and every transport
 * concern — no collector listening, a mid-run disconnect, a consumer slower
 * than the program — is confined to a background fiber whose failures are
 * swallowed and retried. When the program outruns the socket the queue refuses
 * the newest messages and reports the count, rather than growing without bound
 * or pushing backpressure into the fibers being traced.
 *
 * Dropping rather than sliding, because *which* message is lost is the whole
 * problem. A sliding queue evicts its oldest entries, so a burst threw away the
 * `SpanEnd` of a span still running — and the session's `Hello`, the first
 * message there is — while keeping the unrelated messages that caused the
 * overrun. A span whose end was dropped renders as never-ending. Refusing at
 * the tail instead keeps every message already accepted, so loss is a suffix of
 * the burst rather than a hole punched through the session's history.
 *
 * The drain writes each dequeued batch as one newline-delimited frame rather
 * than one frame per message, because a per-message write is what made the
 * socket slow enough for a realistic burst to overrun the queue in the first
 * place.
 */
import {
  Config,
  Context,
  Duration,
  Effect,
  Latch,
  Option,
  Queue,
  Result,
  Schedule,
  type Scope,
} from 'effect'
import type { Socket } from 'effect/unstable/socket'
import { Socket as SocketService } from 'effect/unstable/socket'
import { clientCodec } from '../protocol/Codec.ts'
import * as Protocol from '../protocol/Schema.ts'

/**
 * How many messages may be buffered before new ones are refused.
 *
 * ponytail: the ceiling is counted in messages, not bytes. A message is a plain
 * object held un-encoded, and the honest unit would be its retained size — but
 * the only way to know that in `sendUnsafe` is to encode there, on the hot path
 * of every traced span, duplicating work the drain already does. Measured
 * instead: the reference workload's messages retain ~273 B each (and encode to
 * ~275 B), so this bound is ~34 MB of queued telemetry. That is the documented
 * ceiling — for *realistic* messages. Attribute values are user-supplied and
 * unbounded, so a program annotating spans with megabyte strings can exceed it;
 * the upgrade path is to track encoded bytes at the `writeBatch` boundary and
 * feed that back as a byte budget, which costs a shared counter and is worth it
 * only once someone actually hits it.
 *
 * 131,072 rather than the old 8,192 because batching the socket writes made the
 * drain ~2.4x faster, so a deeper queue is cheap: it holds the entire 115,310
 * message reference session at once, against a 31,563 msg/s peak that used to
 * overrun 8,192 in a fifth of a second.
 */
const defaultBufferSize = 131072

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

/**
 * How many encoded bytes may ride in one socket frame.
 *
 * The drain writes a whole `takeAll` batch as one newline-delimited frame,
 * which is the point — but a batch is unbounded, and the measured peak second
 * is ~8.5 MB, so one write could otherwise hand the WebSocket a single
 * multi-megabyte buffer to hold and copy. 256 KiB is roughly a thousand
 * messages at the measured ~275 B mean: large enough that the per-write cost
 * this change exists to remove is amortised away, small enough that the
 * transient copy stays a normal allocation rather than a heap spike. The
 * collector splits on newlines across chunk boundaries, so where a frame is
 * cut has no effect on what it parses.
 */
const maxFrameBytes = 256 * 1024

/**
 * How many messages may ride in one socket frame, whatever their size.
 *
 * A second bound for the pathological case the byte budget misses: a batch of
 * very small messages would otherwise build one enormous array of strings
 * before the join.
 */
const maxFrameMessages = 4096

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

/** Environment variable a launcher sets to choose the session ID. */
export const sessionIdEnv = 'EFFECT_INSPECT_SESSION_ID'

/** Options accepted by the inspect layers. */
export interface Options {
  /**
   * The session ID this run reports under, e.g. `checkout-before-1`, so it can
   * be queried by that exact name. Takes precedence over the
   * `EFFECT_INSPECT_SESSION_ID` environment variable; a random UUID is used
   * when neither is set. Must satisfy {@link Protocol.isValidSessionId}.
   *
   * Use one ID per run: a second client instance announcing an ID the
   * collector already holds is refused as a collision, and its telemetry is
   * discarded.
   */
  readonly sessionId?: string | undefined
  /** Name shown for this program in the webapp. Defaults to the entry script's file name. */
  readonly programName?: string | undefined
  /** Outbound queue capacity, in messages. Defaults to 131072 (~34 MB). */
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
 * Picks this client's session ID: the `sessionId` option, else
 * `EFFECT_INSPECT_SESSION_ID`, else a random UUID.
 *
 * Read through Effect's `ConfigProvider`, which defaults to the process
 * environment and is simply empty in a runtime without one. An empty variable
 * counts as unset. Fails with a diagnostic, rather than falling back to
 * another ID, when the chosen value is invalid or the environment cannot be
 * read — a silently substituted ID is a run nobody can find.
 */
const resolveSessionId = (
  options: Options | undefined,
): Effect.Effect<Protocol.SessionId, string> =>
  Effect.gen(function* () {
    const fromOption = options?.sessionId
    const [source, chosen] =
      fromOption === undefined
        ? [
            sessionIdEnv,
            yield* Config.option(Config.String(sessionIdEnv)).pipe(
              Effect.mapError((error) => `${sessionIdEnv} could not be read: ${error.message}`),
            ),
          ]
        : ['the sessionId option', Option.some(fromOption)]
    if (Option.isNone(chosen)) {
      // Effect's `Crypto` can fail with a PlatformError and nothing on this path
      // is allowed to fail; a session id needs uniqueness, not strength.
      // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect
      return crypto.randomUUID()
    }
    if (!Protocol.isValidSessionId(chosen.value)) {
      return yield* Effect.fail(
        `${source} is not a valid session ID "${chosen.value}": use ${Protocol.sessionIdRule}`,
      )
    }
    return chosen.value
  })

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
 *
 * The session ID is resolved once, here, and re-announced unchanged on every
 * reconnect. If the chosen ID is invalid the client logs a warning and records
 * nothing, rather than reporting under an ID nobody asked for.
 */
export const make = (
  options?: Options,
): Effect.Effect<InspectClient['Service'], never, Scope.Scope | Socket.Socket> =>
  Effect.gen(function* () {
    const resolved = yield* Effect.result(resolveSessionId(options))
    if (Result.isFailure(resolved)) {
      yield* Effect.logWarning(`effect-inspect disabled: ${resolved.failure}`)
      return InspectClient.of({ sessionId: '', sendUnsafe: () => {} })
    }
    const sessionId = resolved.success
    // Distinguishes this client from an independent run that chose the same
    // session ID; fixed for the client's lifetime so a reconnect still matches.
    // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect
    const instanceId = crypto.randomUUID()
    const socket = yield* SocketService.Socket
    const capacity = options?.bufferSize ?? defaultBufferSize
    const queue = yield* Queue.dropping<Protocol.ClientMessage>(capacity)

    // Tracked here rather than inside the queue so a drop survives a
    // reconnect: it is reported on the next `Hello`, which every reconnect
    // re-sends.
    // Open exactly while the queue is empty, so shutdown can ask "is everything
    // on the wire?" rather than guessing with a sleep.
    const flushed = Latch.makeUnsafe(true)

    let dropped = 0
    let reported = 0
    // Total and non-blocking by construction, and it has to stay that way: this
    // runs inside `Tracer.span`, `span.end` and a `Logger`, none of which can
    // suspend or fail. A dropping `offerUnsafe` returns `false` when the queue
    // is full instead of suspending, which is the entire reason the queue is
    // dropping rather than a backpressuring `bounded` — refusing a message is a
    // gap in a trace, whereas parking the fiber that emitted it is the traced
    // program running slower because it is being watched.
    const sendUnsafe = (message: Protocol.ClientMessage): void => {
      if (!Queue.offerUnsafe(queue, message)) {
        dropped += 1
        return
      }
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
        instanceId,
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

    /**
     * Writes a batch as newline-delimited frames instead of one frame each.
     *
     * The codec already terminates every line with `\n`, so a frame is just
     * the concatenation of its lines and the collector's line splitter carries
     * an unterminated remainder across frames — batching needs no protocol
     * change. Frames are cut at {@link maxFrameBytes} / {@link maxFrameMessages}
     * so one huge batch cannot become one unbounded write.
     *
     * `encodeResult` rather than `encode`: `encode` throws, and a throw here
     * would abandon the rest of an already-dequeued batch and tear down the
     * connection over one out-of-domain field. A message that will not encode
     * is dropped on its own and the batch carries on.
     */
    const writeBatch = (batch: ReadonlyArray<Protocol.ClientMessage>) =>
      Effect.suspend(() => {
        const frames: Array<string> = []
        let lines: Array<string> = []
        let bytes = 0
        for (const message of batch) {
          const encoded = Result.getOrUndefined(clientCodec.encodeResult(message))
          if (encoded === undefined) continue
          if (
            lines.length > 0 &&
            (bytes + encoded.length > maxFrameBytes || lines.length >= maxFrameMessages)
          ) {
            frames.push(lines.join(''))
            lines = []
            bytes = 0
          }
          lines.push(encoded)
          bytes += encoded.length
        }
        if (lines.length > 0) frames.push(lines.join(''))
        return Effect.forEach(frames, (frame) => writer.write(frame), { discard: true })
      })

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
      yield* writeBatch(batch)
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
