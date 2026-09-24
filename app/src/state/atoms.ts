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
import type { Session, WebappMessage } from '../../../src/protocol/Schema.ts'
import { TraceStore } from '../trace/TraceStore.ts'

/** Where the collector listens. Matches the default in the spec. */
export const COLLECTOR_URL = 'ws://localhost:34437'

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
export const sessionsAtom = Atom.make<ReadonlyArray<Session>>([])

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

    /** Subscribes to whichever session is selected, unsubscribing from the old one. */
    const syncSubscription = (): void => {
      const next = ctx.get(selectedSessionIdAtom)
      if (next === subscribed) return
      if (subscribed !== undefined) send({ _tag: 'Unsubscribe', sessionId: subscribed })
      subscribed = next
      // The store is shared across sessions, so it must be emptied before the
      // new session's backlog lands or the two traces would interleave.
      traceStore.clear()
      scheduleRepaint()
      if (next !== undefined) send({ _tag: 'Subscribe', sessionId: next })
    }

    const handle = (message: WebappMessage): void => {
      switch (message._tag) {
        case 'SessionList': {
          // Newest first, so a fresh program run lands at the top of the list.
          const sessions = [...message.sessions].sort(
            (a, b) => b.clock.wallClockEpochMillis - a.clock.wallClockEpochMillis,
          )
          ctx.set(sessionsAtom, sessions)
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
        case 'SessionEnded': {
          ctx.set(
            sessionsAtom,
            ctx
              .get(sessionsAtom)
              .map((session) =>
                session.sessionId === message.sessionId
                  ? { ...session, active: false, endedAtEpochMillis: message.endedAtEpochMillis }
                  : session,
              ),
          )
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
        // A reconnect has no subscription on the new socket, so re-send it.
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
        subscribed = undefined
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
