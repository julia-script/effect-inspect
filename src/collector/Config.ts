import { Config } from 'effect'
import { defaultCapacity } from './Store.ts'

/** Port instrumented programs and the webapp both dial. */
export const defaultPort = 34437

/** Shared settings for the standalone collector and the installed CLI. */
export const collectorConfig = Config.all({
  port: Config.Port('EFFECT_INSPECT_PORT').pipe(Config.withDefault(defaultPort)),
  capacity: Config.Int('EFFECT_INSPECT_CAPACITY').pipe(Config.withDefault(defaultCapacity)),
})
