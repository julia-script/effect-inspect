/**
 * The layer a user adds to an Effect program to stream it to effect-inspect.
 *
 * ```ts
 * import { Effect } from 'effect'
 * import { Inspect } from 'effect-inspect'
 *
 * program.pipe(Effect.provide(Inspect.layer()))
 * ```
 *
 * Adding this layer is safe in any environment: if no collector is listening
 * the program runs exactly as it would have, without hanging, erroring, or
 * waiting on a connection. See `Client.ts` for how that is kept true.
 */
import { Layer, Logger, Tracer } from 'effect'
import { Socket } from 'effect/unstable/socket'

import * as Client from './Client.ts'
import * as ClientTracer from './Tracer.ts'

export type { Options } from './Client.ts'
export { InspectClient } from './Client.ts'

// ponytail: no `FiberEvent` is emitted. The only public hook is
// `Metric.FiberRuntimeMetricsService`, whose `recordFiberStart`/`recordFiberEnd`
// receive a `Context` and an `Exit` but no fiber id — and it has nothing for
// Suspend/Resume at all. Emitting the protocol's `FiberEvent` from it would
// mean patching runtime internals for data M1 does not render anyway. Revisit
// when Effect exposes fiber ids on that service.

/** Where the collector listens unless told otherwise. */
export const defaultUrl = 'ws://localhost:34437'

/** Provides the queue and connection the tracer and logger both write into. */
const layerClient = (
  options?: Client.Options,
): Layer.Layer<Client.InspectClient, never, Socket.Socket> =>
  Layer.effect(Client.InspectClient)(Client.make(options))

/**
 * Installs the inspect tracer and logger over an existing `Socket`.
 *
 * Use when the transport is already established — a test harness, or a
 * collector reached over something other than a WebSocket.
 *
 * The logger is merged into the program's existing loggers rather than
 * replacing them, so console output is untouched.
 */
export const layerSocket = (options?: Client.Options): Layer.Layer<never, never, Socket.Socket> =>
  Layer.merge(
    Layer.effect(Tracer.Tracer)(Client.InspectClient.use(ClientTracer.make)),
    Logger.layer([Client.InspectClient.useSync(ClientTracer.makeLogger)], {
      mergeWithExisting: true,
    }),
  ).pipe(Layer.provide(layerClient(options)))

/**
 * Installs the inspect tracer and logger over a WebSocket to `url`.
 *
 * Requires a `Socket.WebSocketConstructor`; {@link layer} is the version that
 * supplies the global one for you.
 */
export const layerWebSocket = (
  options?: Client.Options & { readonly url?: string },
): Layer.Layer<never, never, Socket.WebSocketConstructor> =>
  layerSocket(options).pipe(Layer.provide(Socket.layerWebSocket(options?.url ?? defaultUrl)))

/**
 * Installs the inspect tracer and logger over a WebSocket, using the runtime's
 * global `WebSocket`.
 *
 * This is the entry point most programs want.
 */
export const layer = (options?: Client.Options & { readonly url?: string }): Layer.Layer<never> =>
  layerWebSocket(options).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
