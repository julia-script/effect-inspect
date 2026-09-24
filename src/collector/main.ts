/**
 * Collector entry point — `bun run collector`.
 *
 * Long-lived: it outlives the programs it collects from, so an instrumented
 * program can be killed and restarted without losing its trace.
 */
import { Effect, Layer } from 'effect'
import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import { layer as socketServerLayer } from './BunWebSocketServer.ts'
import { run } from './Server.ts'
import { layer as storeLayer } from './Store.ts'
import { collectorConfig } from './Config.ts'

export { defaultPort } from './Config.ts'

const main = Effect.gen(function* () {
  const { capacity, port } = yield* collectorConfig
  yield* Effect.logInfo(`effect-inspect collector listening on ws://localhost:${port}`)
  return yield* Effect.provide(
    run,
    Layer.mergeAll(storeLayer({ capacity }), socketServerLayer({ port })),
  )
})

BunRuntime.runMain(main)
