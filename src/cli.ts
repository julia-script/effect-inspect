#!/usr/bin/env bun
import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import * as BunServices from '@effect/platform-bun/BunServices'
import { Effect, Layer } from 'effect'
import { Command } from 'effect/unstable/cli'
import { collectorConfig } from './collector/Config.ts'
import { layer as socketServerLayer } from './collector/BunWebSocketServer.ts'
import { run } from './collector/Server.ts'
import { layer as storeLayer } from './collector/Store.ts'
import { loadWebApp } from './collector/WebApp.ts'

const start = Command.make('start', {}, () =>
  Effect.gen(function* () {
    const { capacity, port } = yield* collectorConfig
    const fetch = yield* loadWebApp
    yield* Effect.logInfo(`effect-inspect listening at http://localhost:${port}`)
    return yield* Effect.provide(
      run,
      Layer.mergeAll(storeLayer({ capacity }), socketServerLayer({ port, fetch })),
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

if (import.meta.main) {
  const { version } = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as {
    readonly version?: string
  }
  BunRuntime.runMain(
    Command.run(cli, { version: version ?? '0.0.0' }).pipe(Effect.provide(BunServices.layer)),
  )
}
