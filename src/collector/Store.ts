/**
 * In-memory, bounded store of every session the collector has seen.
 *
 * Each session keeps its telemetry in a bounded ring (oldest dropped first,
 * drops counted) plus a sliding `PubSub` that webapp clients subscribe to for
 * the live tail. Nothing is persisted: M1 is live-only.
 *
 * Ingest never blocks on a consumer. The ring drops its oldest message when
 * full and the live `PubSub` is sliding, so neither a long-running program nor
 * a stalled webapp client can apply backpressure to the instrumented program.
 *
 * A session belongs to the first client instance that announced its ID. Only
 * that instance's current connection may write to it or end it; a different
 * instance reusing the ID is refused and counted in `Session.conflicts`, so a
 * collision can never merge two runs or overwrite the original trace.
 */
import { Clock, Context, Effect, Layer, PubSub } from 'effect'
import * as Protocol from '../protocol/Schema.ts'

/** Messages a single session retains before dropping its oldest. */
export const defaultCapacity = 200_000

/** Live messages buffered per webapp subscriber before the oldest is dropped. */
const liveBufferSize = 4096

/** A session's retained telemetry plus the counters describing what was lost. */
export interface SessionSnapshot {
  readonly session: Protocol.Session
  readonly messages: ReadonlyArray<Protocol.ClientMessage>
  /** Messages evicted by the capacity bound. */
  readonly droppedMessages: number
  /** Lines received for this session that could not be decoded. */
  readonly skippedLines: number
}

/**
 * One client connection, as the store knows it: an identity token only.
 *
 * Passed with every write so the store can tell the owning connection from a
 * stale one (a reconnect already replaced it) or a refused one (an ID
 * collision).
 */
export type Connection = symbol

interface SessionState {
  session: Protocol.Session
  /** The owning client instance; `undefined` for an older client that sends none. */
  readonly instanceId: string | undefined
  /** The owner's current connection: the only one allowed to append or end. */
  connection: Connection
  /**
   * Ring buffer of retained messages: `ring[head]` is the oldest once full.
   *
   * ponytail: one array with a head index. Shifting a 200k array per message is
   * the only part that would actually hurt; a chunked deque is the upgrade if a
   * cap ever needs to be large enough that one array is a problem.
   */
  ring: Array<Protocol.ClientMessage>
  head: number
  droppedMessages: number
  skippedLines: number
  readonly live: PubSub.PubSub<Protocol.ClientMessage>
}

/**
 * The collector's session store.
 *
 * @see {@link layer} for the live implementation and {@link make} to build one
 * with a smaller capacity in tests.
 */
export class Store extends Context.Service<
  Store,
  {
    /**
     * Opens a session for `connection`, or resumes it when the same client
     * instance reconnects. A different instance announcing a known ID is a
     * collision: it is refused and counted, and the session is left untouched.
     */
    readonly hello: (message: Protocol.Hello, connection: Connection) => Effect.Effect<void>
    /**
     * Records one decoded message and fans it out to live subscribers — only
     * when `connection` owns the message's session.
     */
    readonly append: (
      message: Protocol.ClientMessage,
      connection: Connection,
    ) => Effect.Effect<void>
    /** Counts one line that could not be decoded, if `connection` owns the session. */
    readonly skipLine: (
      sessionId: Protocol.SessionId | undefined,
      connection: Connection,
    ) => Effect.Effect<void>
    /**
     * Marks a session ended because `connection` closed. A no-op unless it is
     * the owner's current connection, so neither a refused collision nor a
     * connection a reconnect already replaced can end the owner's run.
     */
    readonly end: (sessionId: Protocol.SessionId, connection: Connection) => Effect.Effect<void>
    /** Every known session, in the order they first said `Hello`. */
    readonly sessions: Effect.Effect<ReadonlyArray<Protocol.Session>>
    /** One session's retained messages and loss counters. */
    readonly snapshot: (sessionId: Protocol.SessionId) => Effect.Effect<SessionSnapshot | undefined>
    /**
     * A session's live-tail `PubSub`, or `undefined` when it is unknown.
     *
     * Subscribe to it before reading the snapshot: an overlapping message is
     * deduplicated downstream by span id, a missed one is a hole in the trace.
     */
    readonly live: (
      sessionId: Protocol.SessionId,
    ) => Effect.Effect<PubSub.PubSub<Protocol.ClientMessage> | undefined>
    /** Published whenever the session list changes, so clients can re-send it. */
    readonly changes: PubSub.PubSub<void>
  }
>()('effect-inspect/collector/Store') {}

/** Builds a `Store`, retaining `capacity` messages per session. */
export const make = Effect.fnUntraced(function* (options?: { readonly capacity?: number }) {
  const capacity = options?.capacity ?? defaultCapacity
  const sessions = new Map<Protocol.SessionId, SessionState>()

  const changes = yield* PubSub.sliding<void>(1)
  const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid)

  const hello = (message: Protocol.Hello, connection: Connection) =>
    Effect.gen(function* () {
      const existing = sessions.get(message.sessionId)
      if (existing !== undefined) {
        // Same instance means the client's socket dropped and it dialled back:
        // resume, so one run keeps one continuous trace. Anything else is an
        // independent run that chose the same ID. Refusing it keeps the
        // original trace intact, and counting it lets a query report the
        // collision rather than serve this run's data as the newcomer's.
        if (existing.instanceId !== message.instanceId) {
          existing.session = {
            ...existing.session,
            conflicts: (existing.session.conflicts ?? 0) + 1,
          }
          yield* notify
          return
        }
        existing.connection = connection
        existing.session = { ...existing.session, active: true }
        delete (existing.session as { endedAtEpochMillis?: number }).endedAtEpochMillis
        yield* notify
        return
      }
      sessions.set(message.sessionId, {
        instanceId: message.instanceId,
        connection,
        session: {
          sessionId: message.sessionId,
          program: message.program,
          pid: message.pid,
          runtime: message.runtime,
          clock: message.clock,
          active: true,
        },
        ring: [],
        head: 0,
        droppedMessages: 0,
        skippedLines: 0,
        live: yield* PubSub.sliding<Protocol.ClientMessage>(liveBufferSize),
      })
      yield* notify
    })

  /** The session `connection` currently owns under `sessionId`, if any. */
  const owned = (sessionId: Protocol.SessionId | undefined, connection: Connection) => {
    const state = sessionId === undefined ? undefined : sessions.get(sessionId)
    return state?.connection === connection ? state : undefined
  }

  const append = (message: Protocol.ClientMessage, connection: Connection) =>
    Effect.suspend(() => {
      const state = owned(message.sessionId, connection)
      // A message for a session this connection does not own — it never said
      // Hello, or it was refused as a collision — has nowhere to go. It is not
      // a reason to drop the connection either.
      if (state === undefined) return Effect.void
      if (state.ring.length < capacity) {
        state.ring.push(message)
      } else {
        state.ring[state.head] = message
        state.head = (state.head + 1) % capacity
        state.droppedMessages += 1
      }
      return PubSub.publish(state.live, message).pipe(Effect.asVoid)
    })

  // A line from a connection that never sent a usable `Hello` has no session
  // to count it against, so it is skipped without a counter.
  const skipLine = (sessionId: Protocol.SessionId | undefined, connection: Connection) =>
    Effect.sync(() => {
      const state = owned(sessionId, connection)
      if (state !== undefined) state.skippedLines += 1
    })

  const end = (sessionId: Protocol.SessionId, connection: Connection) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      const state = owned(sessionId, connection)
      if (state === undefined || !state.session.active) return Effect.void
      state.session = {
        ...state.session,
        active: false,
        endedAtEpochMillis: now,
      }
      return notify
    })

  const snapshot = (sessionId: Protocol.SessionId) =>
    Effect.sync((): SessionSnapshot | undefined => {
      const state = sessions.get(sessionId)
      if (state === undefined) return undefined
      return {
        session: state.session,
        messages:
          state.head === 0
            ? state.ring.slice()
            : state.ring.slice(state.head).concat(state.ring.slice(0, state.head)),
        droppedMessages: state.droppedMessages,
        skippedLines: state.skippedLines,
      }
    })

  const live = (sessionId: Protocol.SessionId) => Effect.sync(() => sessions.get(sessionId)?.live)

  return Store.of({
    hello,
    append,
    skipLine,
    end,
    sessions: Effect.sync(() => Array.from(sessions.values(), (state) => state.session)),
    snapshot,
    live,
    changes,
  })
})

/** The live `Store`, retaining {@link defaultCapacity} messages per session. */
export const layer = (options?: { readonly capacity?: number }): Layer.Layer<Store> =>
  Layer.effect(Store)(make(options))
