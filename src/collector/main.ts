/**
 * Collector entry point — `bun run collector`.
 *
 * Long-lived: it outlives the programs it collects from, so an instrumented
 * program can be killed and restarted without losing its trace.
 */
import { Effect, Layer } from 'effect'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
// NodeHttpServer needs a native server constructor to own the HTTP and upgrade listeners.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer } from 'node:http'
import { run } from './Server.ts'
import { layer as storeLayer } from './Store.ts'
import { collectorConfig } from './Config.ts'

export { defaultPort } from './Config.ts'

const main = Effect.gen(function* () {
  const { capacity, port } = yield* collectorConfig
  yield* Effect.logInfo(`effect-inspect collector listening on ws://localhost:${port}`)
  return yield* Effect.provide(
    run(),
    Layer.mergeAll(storeLayer({ capacity }), NodeHttpServer.layer(createServer, { port })),
  )
})

NodeRuntime.runMain(Effect.scoped(main))
