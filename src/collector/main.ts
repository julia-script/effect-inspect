/**
 * Collector entry point — `bun run collector`.
 *
 * Long-lived: it outlives the programs it collects from, so an instrumented
 * program can be killed and restarted without losing its trace.
 */
import { Config, Effect, Layer } from 'effect'
import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import { layer as socketServerLayer } from './BunWebSocketServer.ts'
import { run } from './Server.ts'
import { defaultCapacity, layer as storeLayer } from './Store.ts'

/** Port instrumented programs and the webapp both dial. */
export const defaultPort = 34437

const config = Config.all({
  port: Config.Port('EFFECT_INSPECT_PORT').pipe(Config.withDefault(defaultPort)),
  capacity: Config.Int('EFFECT_INSPECT_CAPACITY').pipe(Config.withDefault(defaultCapacity)),
})

const main = Effect.gen(function* () {
  const { capacity, port } = yield* config
  yield* Effect.logInfo(`effect-inspect collector listening on ws://localhost:${port}`)
  return yield* Effect.provide(
    run,
    Layer.mergeAll(storeLayer({ capacity }), socketServerLayer({ port })),
  )
})

BunRuntime.runMain(main)
