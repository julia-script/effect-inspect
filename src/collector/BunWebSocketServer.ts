/**
 * A `SocketServer` backed by Bun's native `Bun.serve` WebSocket support.
 *
 * `@effect/platform-bun/BunSocketServer` re-exports `NodeSocketServer`, whose
 * `makeWebSocket` is built on the `ws` package and calls `conn.pause()` on
 * every accepted connection. Bun substitutes its own `BunWebSocketMocked` for
 * `ws`, which has no `pause()`, so that path throws on every handshake under
 * Bun. This module keeps the same `SocketServer.SocketServer` contract and
 * swaps only the transport underneath, so handlers are unaffected.
 *
 * ponytail: drop this module and go back to `BunSocketServer.layerWebSocket`
 * the day Bun's `ws` shim grows `pause()`/`resume()`.
 */
import { Context, Effect, Exit, Fiber, Layer, Scope } from 'effect'
import { NetAddress } from 'effect/unstable/net'
import { Socket, SocketServer } from 'effect/unstable/socket'

/** The request that opened the current connection, for path-based routing. */
export class ConnectionRequest extends Context.Service<ConnectionRequest, Request>()(
  'effect-inspect/collector/ConnectionRequest',
) {}

/** Per-connection state Bun hands back to us on every websocket callback. */
interface ConnectionData {
  readonly request: Request
  readonly listeners: Map<string, Set<(event: Socket.WebSocketEvent) => void>>
}

type BunSocket = Bun.ServerWebSocket<ConnectionData>

const emit = (ws: BunSocket, type: string, event: Socket.WebSocketEvent): void => {
  for (const listener of ws.data.listeners.get(type) ?? []) listener({ type, ...event })
}

/**
 * Presents a Bun `ServerWebSocket` as the `WebSocketLike` shape `Socket` wants.
 *
 * Bun delivers events through the server's callbacks rather than an event
 * target, so the callbacks fan out to listeners registered here.
 */
const asWebSocketLike = (ws: BunSocket): Socket.WebSocketLike => ({
  get readyState() {
    return ws.readyState
  },
  addEventListener: (type, listener) => {
    const existing = ws.data.listeners.get(type)
    if (existing === undefined) ws.data.listeners.set(type, new Set([listener]))
    else existing.add(listener)
  },
  removeEventListener: (type, listener) => {
    ws.data.listeners.get(type)?.delete(listener)
  },
  close: (code, reason) => ws.close(code, reason),
  send: (data) => {
    ws.send(data)
  },
})

/**
 * Creates a scoped WebSocket `SocketServer` on `port`, closed with the scope.
 *
 * Connections that arrive before `run` is called are held open and handed to
 * the handler once it is installed, matching `NodeSocketServer`'s behaviour.
 */
export const make = Effect.fnUntraced(function* (options: {
  readonly port: number
  readonly fetch?: (request: Request) => Response | Promise<Response>
}) {
  const pending: Array<BunSocket> = []
  let onConnection = (ws: BunSocket): void => {
    pending.push(ws)
  }

  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve<ConnectionData, never>({
        port: options.port,
        fetch: (request, server) => {
          if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
            return server.upgrade(request, { data: { request, listeners: new Map() } })
              ? undefined
              : new Response('WebSocket upgrade failed', { status: 400 })
          }
          return (
            options.fetch?.(request) ??
            new Response('effect-inspect collector: websocket only', { status: 426 })
          )
        },
        websocket: {
          open: (ws) => onConnection(ws),
          message: (ws, message) => emit(ws, 'message', { data: message }),
          close: (ws, code, reason) => emit(ws, 'close', { code, reason }),
        },
      }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  )

  const run = Effect.fnUntraced(function* <R, E, _>(
    handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>,
  ) {
    const scope = yield* Scope.make()
    const services = yield* Effect.context<R>()
    const trackFiber = Fiber.runIn(scope)

    const handle = (ws: BunSocket): void => {
      const context = Context.add(services, ConnectionRequest, ws.data.request)
      Socket.fromWebSocket(Effect.succeed(asWebSocketLike(ws))).pipe(
        Effect.flatMap(handler),
        // One connection's failure is that connection's problem. Letting it
        // escape would take the whole collector down with it.
        Effect.catchCause(() => Effect.void),
        Effect.runForkWith(context),
        trackFiber,
      )
      // `fromWebSocket` waits for `open`, which Bun has already fired.
      emit(ws, 'open', {})
    }

    onConnection = handle
    for (const ws of pending.splice(0)) handle(ws)

    return yield* Effect.never.pipe(Effect.ensuring(Scope.close(scope, Exit.void)))
  })

  return SocketServer.SocketServer.of({
    address: NetAddress.inetAddressFromIpStringUnsafe('127.0.0.1', server.port ?? options.port),
    run,
  })
})

/** Provides a WebSocket `SocketServer` bound to `port`. */
export const layer = (options: {
  readonly port: number
  readonly fetch?: (request: Request) => Response | Promise<Response>
}): Layer.Layer<SocketServer.SocketServer> => Layer.effect(SocketServer.SocketServer)(make(options))
