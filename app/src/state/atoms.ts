/**
 * Application state.
 *
 * The split here is the whole design: **atoms hold what React renders**
 * (connection status, the session list, which session is selected, a repaint
 * tick) and the {@link TraceStore} holds **what the canvas renders** (every
 * span). Nothing per-span is ever put in an atom — a 10k-span trace would mean
 * 10k subscriptions and a React render per arriving span, which is exactly the
 * stutter the spec forbids.
 *
 * The bridge between the two is {@link traceVersionAtom}: the socket writes
 * spans straight into the store and the store's version is sampled on an
 * animation frame, so the header counters stay live while the span data path
 * never touches React.
 */
import { Result } from 'effect'
import { Atom } from 'effect/unstable/reactivity'
import { webappCodec, webappRequestCodec } from '../../../src/protocol/Codec.ts'
import type { ClientMessage, Session, WebappMessage } from '../../../src/protocol/Schema.ts'
import { isLoadedSession, loadedSession, parseTraceFile } from '../trace/TraceFile.ts'
import { TraceStore } from '../trace/TraceStore.ts'

/**
 * Where the collector listens.
 *
 * The `/webapp` path matters: the collector routes both roles on one port by
 * request path, and anything that is not `/webapp` is treated as an
 * instrumented program — which would get no `SessionList` at all. See
 * `webappPath` in `src/collector/Server.ts`.
 *
 * `VITE_COLLECTOR_URL` overrides it, so a second collector on a non-default
 * `EFFECT_INSPECT_PORT` can be inspected without editing source.
 */
export const COLLECTOR_URL = import.meta.env.VITE_COLLECTOR_URL ?? 'ws://localhost:34437/webapp'

/** Connection lifecycle, as rendered in the header. */
export type ConnectionStatus =
  | { readonly _tag: 'Connecting' }
  | { readonly _tag: 'Connected' }
  /** `attempt` drives the retry backoff and the "retrying in Ns" message. */
  | { readonly _tag: 'Disconnected'; readonly reason: string; readonly attempt: number }

/**
 * The span store for the currently selected session.
 *
 * A single long-lived instance rather than one per session: switching sessions
 * calls `clear()`, so the renderer can hold one stable reference for the life
 * of the page instead of re-acquiring it whenever selection changes.
 */
export const traceStore = new TraceStore()

/** Current connection status. Written by {@link connectionAtom}. */
export const connectionStatusAtom = Atom.make<ConnectionStatus>({ _tag: 'Connecting' })

/** Every session the collector knows about, newest first. */
export const liveSessionsAtom = Atom.make<ReadonlyArray<Session>>([])

/** A trace read from a file: its session record plus the messages to replay. */
export interface LoadedSession {
  readonly session: Session
  readonly messages: ReadonlyArray<ClientMessage>
  /** Trailing lines the file lost to a truncated save; shown next to the session. */
  readonly truncatedLines: number
}

/**
 * Traces loaded from files this page load, newest first.
 *
 * Held in an atom rather than a module-level array because the session list
 * renders from it; the *messages* are not per-span React state — they are
 * replayed into {@link traceStore} in one `applyAll` on selection and never
 * read by React again.
 */
export const loadedSessionsAtom = Atom.make<ReadonlyArray<LoadedSession>>([])

/**
 * Live and loaded sessions in one list, loaded first.
 *
 * Loaded traces sort above live ones so a file you just opened is where you
 * are looking, rather than buried under whatever the collector is holding.
 */
export const sessionsAtom = Atom.readable((get): ReadonlyArray<Session> => [
  ...get(loadedSessionsAtom).map((loaded) => loaded.session),
  ...get(liveSessionsAtom),
])

/** The selected session id, or `undefined` when nothing is selected. */
export const selectedSessionIdAtom = Atom.make<string | undefined>(undefined)

/**
 * Sampled copy of `traceStore.version`, so components can re-render on trace
 * change without subscribing to the trace itself.
 *
 * Updated once per animation frame while data is arriving (see
 * {@link connectionAtom}), which caps the UI at one render per frame no matter
 * how many spans land in between.
 */
export const traceVersionAtom = Atom.make(0)

/** Count of protocol lines the webapp could not decode; surfaced in the header. */
export const decodeErrorsAtom = Atom.make(0)

/** The selected session's metadata, derived from the list and the selection. */
export const selectedSessionAtom = Atom.readable((get): Session | undefined => {
  const id = get(selectedSessionIdAtom)
  if (id === undefined) return undefined
  return get(sessionsAtom).find((session) => session.sessionId === id)
})

/**
 * Wall-clock epoch millis corresponding to `traceStore.origin`.
 *
 * `TraceStore.epochOrigin` is permanently `undefined` in practice: the
 * collector does not append `Hello` to the session ring, so the store's `Hello`
 * case never fires. The anchor is plumbed from the `Session` record instead,
 * which carries the same `clock` and is already in hand — appending `Hello`
 * would change the collector's retention semantics for one timestamp.
 *
 * The store's origin is the first *observed* event, not the session start, so
 * the session clock has to be shifted by the gap between them.
 */
export const wallClockOriginAtom = Atom.readable((get): number | undefined => {
  get(traceVersionAtom)
  const session = get(selectedSessionAtom)
  if (session === undefined || traceStore.origin === undefined) return undefined
  const offsetNanos = traceStore.origin - session.clock.startTime
  return session.clock.wallClockEpochMillis + Number(offsetNanos / 1_000_000n)
})

/** Live counters for the header, recomputed only when the sampled version changes. */
export const traceStatsAtom = Atom.readable((get) => {
  get(traceVersionAtom)
  return traceStore.stats()
})

/** Backoff for reconnect attempts, capped so a long-down collector still retries. */
const retryDelay = (attempt: number): number => Math.min(1000 * 2 ** attempt, 10_000)

/**
 * Owns the collector WebSocket for as long as it is mounted.
 *
 * Written as a `keepAlive` atom rather than a `useEffect` so the connection
 * survives component remounts and React strict-mode double-invocation, and so
 * the socket's writes go through the registry — the same path a component
 * write takes — instead of a side channel.
 *
 * Reads as `void`: the value of this atom is its side effect. Components mount
 * it with `useAtomMount` and read status from {@link connectionStatusAtom}.
 */
export const connectionAtom = Atom.keepAlive(
  Atom.readable<void>((ctx) => {
    let socket: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let frame: number | undefined
    let attempt = 0
    let closed = false
    /** The session this socket is subscribed to, so we can unsubscribe on switch. */
    let subscribed: string | undefined

    /**
     * Mirrors the store's version into an atom on the next frame.
     *
     * Coalesced: many messages within one frame schedule a single write, so a
     * burst of a thousand spans costs one React render, not a thousand.
     */
    const scheduleRepaint = (): void => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        ctx.set(traceVersionAtom, traceStore.version)
      })
    }

    const send = (request: Parameters<typeof webappRequestCodec.encode>[0]): void => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(webappRequestCodec.encode(request))
    }

    /**
     * Points the store at whichever session is selected.
     *
     * A live session means subscribing to the collector; a loaded one means
     * replaying its file's messages straight into the store. Both paths clear
     * the store first, because it is shared across sessions.
     */
    const syncSubscription = (): void => {
      const next = ctx.get(selectedSessionIdAtom)
      if (next === subscribed) return
      if (subscribed !== undefined && !isLoadedSession(subscribed)) {
        send({ _tag: 'Unsubscribe', sessionId: subscribed })
      }
      subscribed = next
      traceStore.clear()
      scheduleRepaint()
      if (next === undefined) return
      if (isLoadedSession(next)) {
        const loaded = ctx.get(loadedSessionsAtom).find((entry) => entry.session.sessionId === next)
        if (loaded !== undefined) traceStore.applyAll(loaded.messages)
        scheduleRepaint()
        return
      }
      send({ _tag: 'Subscribe', sessionId: next })
    }

    const handle = (message: WebappMessage): void => {
      switch (message._tag) {
        case 'SessionList': {
          // Newest first, so a fresh program run lands at the top of the list.
          const sessions = [...message.sessions].sort(
            (a, b) => b.clock.wallClockEpochMillis - a.clock.wallClockEpochMillis,
          )
          ctx.set(liveSessionsAtom, sessions)
          // Auto-select the newest session on first sight, so the app is useful
          // without a click — Chrome likewise opens on the active recording.
          if (ctx.get(selectedSessionIdAtom) === undefined && sessions.length > 0) {
            ctx.set(selectedSessionIdAtom, sessions[0]!.sessionId)
          }
          break
        }
        case 'Backlog': {
          if (message.sessionId !== subscribed) return // Late backlog for a session we left.
          traceStore.applyAll(message.messages)
          scheduleRepaint()
          break
        }
        case 'Live': {
          // Live carries no top-level sessionId — it comes from the nested message.
          if (message.message.sessionId !== subscribed) return
          traceStore.apply(message.message)
          scheduleRepaint()
          break
        }
      }
    }

    const connect = (): void => {
      if (closed) return
      ctx.set(connectionStatusAtom, { _tag: 'Connecting' })

      const ws = new WebSocket(COLLECTOR_URL)
      socket = ws

      ws.onopen = () => {
        attempt = 0
        ctx.set(connectionStatusAtom, { _tag: 'Connected' })
        // A reconnect has no subscription on the new socket, so re-send it —
        // unless a loaded trace is selected, whose store contents a re-sync
        // would clear for nothing.
        if (subscribed !== undefined && isLoadedSession(subscribed)) return
        subscribed = undefined
        syncSubscription()
      }

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        const messages = decodeFrame(event.data)
        if (messages === undefined) {
          // One bad line must not drop the stream — count it and keep reading.
          ctx.set(decodeErrorsAtom, ctx.get(decodeErrorsAtom) + 1)
          return
        }
        for (const message of messages) handle(message)
      }

      ws.onerror = () => {
        // `onclose` always follows, and carries the usable reason; nothing to do
        // here beyond keeping the browser from logging an unhandled error.
      }

      ws.onclose = () => {
        if (closed) return
        socket = undefined
        if (subscribed === undefined || !isLoadedSession(subscribed)) subscribed = undefined
        const delay = retryDelay(attempt)
        ctx.set(connectionStatusAtom, {
          _tag: 'Disconnected',
          reason: `Cannot reach the collector at ${COLLECTOR_URL}`,
          attempt,
        })
        attempt++
        retry = setTimeout(connect, delay)
      }
    }

    // Re-subscribe whenever the selection changes. `subscribe` rather than
    // `get` so changing the selection does not tear down the socket.
    ctx.subscribe(selectedSessionIdAtom, () => syncSubscription())

    ctx.addFinalizer(() => {
      closed = true
      if (retry !== undefined) clearTimeout(retry)
      if (frame !== undefined) cancelAnimationFrame(frame)
      socket?.close()
      socket = undefined
    })

    connect()
  }),
)

/**
 * Decodes one WebSocket frame, which may hold several NDJSON lines.
 *
 * Returns `undefined` rather than throwing on a bad frame: `decodeAll` is
 * strict by design (a bad line means the stream is out of sync), but the
 * webapp's job is to stay up and show the error count, not to die.
 */
const decodeFrame = (data: string): ReadonlyArray<WebappMessage> | undefined =>
  Result.getOrUndefined(webappCodec.decodeAll(data))

/**
 * The slice of the atom registry the file actions need.
 *
 * Typed structurally rather than against `AtomRegistry` so these stay callable
 * from a test with a two-line fake, which is what makes save/load testable
 * without a browser.
 */
export interface Registry {
  readonly get: <A>(atom: Atom.Atom<A>) => A
  readonly set: <A>(atom: Atom.Writable<A, A>, value: A) => void
}

/**
 * Adds a parsed trace file to the session list and selects it.
 *
 * Re-loading the same file replaces the existing entry rather than stacking a
 * duplicate — the session id is derived from the file's, so a second copy
 * would be indistinguishable in the list.
 */
export const addLoadedTrace = (
  registry: Registry,
  text: string,
): Result.Result<Session, string> => {
  const parsed = parseTraceFile(text)
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure.message)
  const { header, messages, truncatedLines } = parsed.success
  const session = loadedSession(header)
  const entry: LoadedSession = { session, messages, truncatedLines }
  registry.set(loadedSessionsAtom, [
    entry,
    ...registry
      .get(loadedSessionsAtom)
      .filter((existing) => existing.session.sessionId !== session.sessionId),
  ])
  registry.set(selectedSessionIdAtom, session.sessionId)
  return Result.succeed(session)
}

/**
 * The messages to write when saving the selected session.
 *
 * A loaded session is written back from the file's own messages rather than
 * from the store, so re-exporting a file is lossless even for message types
 * the chart does not draw.
 */
export const saveableMessages = (
  registry: Registry,
  sessionId: string,
): ReadonlyArray<ClientMessage> => {
  if (!isLoadedSession(sessionId)) return traceStore.raw
  const loaded = registry
    .get(loadedSessionsAtom)
    .find((entry) => entry.session.sessionId === sessionId)
  return loaded?.messages ?? traceStore.raw
}
