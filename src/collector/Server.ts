/**
 * The collector's WebSocket server.
 *
 * One `SocketServer` serves both sides on one port, routed by request path:
 * `/webapp` is a webapp client, anything else is an instrumented program. The
 * socket server forks and supervises each connection independently, so a
 * program that crashes mid-message, or a webapp client that disappears, cannot
 * take the collector down.
 */
import { Effect, Fiber, Option, PubSub, Result } from 'effect'
import { Socket, SocketServer } from 'effect/unstable/socket'
import { ConnectionRequest } from './BunWebSocketServer.ts'
import { clientCodec, collectorCodec, webappCodec, webappRequestCodec } from '../protocol/Codec.ts'
import type * as Protocol from '../protocol/Schema.ts'
import { Store } from './Store.ts'

/** Path a webapp client connects on; anything else is an instrumented program. */
export const webappPath = '/webapp'

/**
 * Splits a stream of arbitrary chunks into `\n`-terminated lines.
 *
 * A WebSocket frame is usually exactly one line, but nothing guarantees it, so
 * an unterminated remainder is carried across pulls.
 */
const lineSplitter = () => {
  let rest = ''
  return {
    push: (chunk: string): ReadonlyArray<string> => {
      const parts = (rest + chunk).split('\n')
      rest = parts.pop() ?? ''
      return parts
    },
    /** Trailing unterminated text, once the peer has stopped sending. */
    flush: (): string => {
      const last = rest
      rest = ''
      return last
    },
  }
}

/**
 * Reads NDJSON lines off a socket, skipping any line that will not decode.
 *
 * This is the line-level recovery the codec deliberately does not do:
 * `Codec.decodeAll` fails a whole chunk on one bad line, which would cost a
 * session every message that shared a frame with it. Here a bad line is counted
 * and dropped and the connection carries on — one malformed line must never
 * drop a session or kill the collector.
 *
 * Returns when the peer disconnects. A socket error ends the loop the same way
 * a clean close does: there is nothing left to read either way.
 */
const readLines = <A, R>(
  pull: Effect.Effect<ReadonlyArray<string>, Socket.SocketError>,
  decode: (line: string) => Result.Result<A, unknown>,
  onMessage: (message: A) => Effect.Effect<void, never, R>,
  onSkipped: (line: string) => Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R> =>
  Effect.suspend(() => {
    const splitter = lineSplitter()

    const handle = (line: string): Effect.Effect<void, never, R> =>
      line.trim() === ''
        ? Effect.void
        : Result.match(decode(line), { onSuccess: onMessage, onFailure: () => onSkipped(line) })

    return Effect.forever(
      Effect.flatMap(pull, (chunk) =>
        Effect.forEach(chunk.flatMap(splitter.push), handle, { discard: true }),
      ),
    ).pipe(
      Effect.catchTag('SocketError', () => Effect.void),
      Effect.ensuring(Effect.suspend(() => handle(splitter.flush()))),
    )
  })

/**
 * Acquires a socket's line reader for the current scope.
 *
 * The reader must be acquired before anything writes: a `Socket` writer blocks
 * until the reader has latched onto the underlying WebSocket, so a handler that
 * sends first and reads later would deadlock.
 */
const readerFor = (socket: Socket.Socket) =>
  Socket.readerString(socket).pipe(
    // An already-dead socket is a disconnect, not a collector error: hand back
    // a pull that reports the close so the read loop exits immediately.
    Effect.catchTag('SocketError', (error) => Effect.succeed(Effect.fail(error))),
  )

/** Handles one instrumented program's connection for its lifetime. */
const handleClient = Effect.fnUntraced(function* (socket: Socket.Socket) {
  const store = yield* Store
  const pull = yield* readerFor(socket)
  const writer = yield* socket.writer
  /** The session this connection belongs to, learned from its `Hello`. */
  let sessionId: Protocol.SessionId | undefined

  const onMessage = (message: Protocol.ClientMessage) =>
    Effect.gen(function* () {
      sessionId = message.sessionId
      switch (message._tag) {
        case 'Hello':
          yield* store.hello(message)
          return
        case 'Ping':
          // A failed write means the client is gone; the read loop notices.
          yield* Effect.ignore(
            writer.write(collectorCodec.encode({ _tag: 'Pong', sessionId: message.sessionId })),
          )
          return
        default:
          yield* store.append(message)
      }
    })

  yield* readLines(pull, clientCodec.decode, onMessage, () =>
    Effect.suspend(() => store.skipLine(sessionId)),
  ).pipe(
    // However the connection ends — clean close, crash, kill -9 — the session
    // is marked ended. A reconnect with the same id resumes it.
    Effect.ensuring(
      Effect.suspend(() => (sessionId === undefined ? Effect.void : store.end(sessionId))),
    ),
  )
})

/** Handles one webapp client's connection for its lifetime. */
const handleWebapp = Effect.fnUntraced(function* (socket: Socket.Socket) {
  const store = yield* Store
  const pull = yield* readerFor(socket)
  const writer = yield* socket.writer

  const send = (message: Protocol.WebappMessage) =>
    Effect.ignore(writer.write(webappCodec.encode(message)))

  const sendSessionList = Effect.flatMap(store.sessions, (sessions) =>
    send({ _tag: 'SessionList', sessions }),
  )

  /** One live-tail fiber per subscribed session, so `Unsubscribe` interrupts. */
  const tails = new Map<Protocol.SessionId, Fiber.Fiber<void>>()

  const unsubscribe = (sessionId: Protocol.SessionId) =>
    Effect.suspend(() => {
      const fiber = tails.get(sessionId)
      if (fiber === undefined) return Effect.void
      tails.delete(sessionId)
      return Effect.asVoid(Fiber.interrupt(fiber))
    })

  const subscribe = (sessionId: Protocol.SessionId) =>
    Effect.gen(function* () {
      if (tails.has(sessionId)) return
      const fiber = yield* Effect.forkScoped(
        Effect.scoped(
          Effect.gen(function* () {
            // Subscribe before snapshotting: an overlap is deduplicated by span
            // id downstream, a gap is a span the webapp never sees.
            const pubsub = yield* store.live(sessionId)
            if (pubsub === undefined) return
            const live = yield* PubSub.subscribe(pubsub)
            const snapshot = yield* store.snapshot(sessionId)
            yield* send({
              _tag: 'Backlog',
              sessionId,
              messages: snapshot?.messages ?? [],
              complete: true,
            })
            return yield* Effect.forever(
              Effect.flatMap(PubSub.take(live), (message) => send({ _tag: 'Live', message })),
            )
          }),
        ),
      )
      tails.set(sessionId, fiber)
    })

  yield* sendSessionList
  // Re-send the list whenever a session opens, resumes or ends.
  yield* Effect.forkScoped(
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(store.changes)
        return yield* Effect.forever(
          Effect.flatMap(PubSub.take(subscription), () => sendSessionList),
        )
      }),
    ),
  )

  yield* readLines(
    pull,
    webappRequestCodec.decode,
    (request) =>
      request._tag === 'Subscribe' ? subscribe(request.sessionId) : unsubscribe(request.sessionId),
    // A webapp sending garbage is a webapp bug: drop the line, keep the socket.
    () => Effect.void,
  )
})

/** The path a connection was opened on, or `undefined` when unavailable. */
const requestPath = Effect.map(
  Effect.serviceOption(ConnectionRequest),
  Option.match({
    onNone: () => undefined,
    onSome: (request) => new URL(request.url).pathname,
  }),
)

/**
 * Handles one accepted connection, routed by its request path.
 *
 * Scoped per connection: the writer and every fiber a handler forks are
 * released when that one connection ends, and nothing outlives it.
 */
export const handleConnection = (socket: Socket.Socket): Effect.Effect<void, never, Store> =>
  Effect.scoped(
    Effect.flatMap(requestPath, (path) =>
      path === webappPath ? handleWebapp(socket) : handleClient(socket),
    ),
  )

/** Runs the collector until interrupted. */
export const run: Effect.Effect<
  never,
  SocketServer.SocketServerError,
  Store | SocketServer.SocketServer
> = Effect.gen(function* () {
  const server = yield* SocketServer.SocketServer
  return yield* server.run(handleConnection)
})
