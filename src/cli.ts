#!/usr/bin/env node
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
// NodeHttpServer needs a native server constructor to own the HTTP and upgrade listeners.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Schema } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { Command } from 'effect/unstable/cli'
import { collectorConfig } from './collector/Config.ts'
import { run } from './collector/Server.ts'
import { layer as storeLayer } from './collector/Store.ts'
import { loadWebApp } from './collector/WebApp.ts'

const start = Command.make('start', {}, () =>
  Effect.gen(function* () {
    const { capacity, port } = yield* collectorConfig
    const fetch = yield* loadWebApp
    yield* Effect.logInfo(`effect-inspect listening at http://localhost:${port}`)
    return yield* Effect.provide(
      run(fetch),
      Layer.mergeAll(storeLayer({ capacity }), NodeHttpServer.layer(createServer, { port })),
    )
  }),
).pipe(
  Command.withDescription(
    'Start the collector and web UI (configured by EFFECT_INSPECT_PORT and EFFECT_INSPECT_CAPACITY)',
  ),
)

export const cli = Command.make('effect-inspect').pipe(
  Command.withDescription('Inspect Effect programs'),
  Command.withSubcommands([start]),
)

const main = Effect.gen(function* () {
  const fs = yield* FileSystem
  const packageJson = yield* fs.readFileString(
    fileURLToPath(new URL('../package.json', import.meta.url)),
  )
  const { version } = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
  )(packageJson)
  return yield* Command.run(cli, { version })
})

NodeRuntime.runMain(main.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
