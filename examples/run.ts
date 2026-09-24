/**
 * Shared entry point for the examples: probe, instrument, run.
 *
 * `Inspect.layer()` is deliberately a no-op when no collector is listening —
 * right for production, confusing for a demo, where the program would run
 * perfectly and show you nothing. So every example calls {@link main}, which
 * checks the collector is there first and prints how to start it if it is not.
 */
import { Effect } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'
import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import * as Inspect from '../src/client/Inspect.ts'

/** Where the examples look for the collector. */
export const url = Inspect.defaultUrl

/**
 * True if something is listening.
 *
 * The collector answers a plain GET with 426 ("websocket only"), so any
 * response at all means it is up; a refused connection is an error.
 */
const collectorIsUp = HttpClient.get(url.replace(/^ws/, 'http')).pipe(
  Effect.timeout('1 second'),
  Effect.as(true),
  Effect.orElseSucceed(() => false),
  Effect.provide(FetchHttpClient.layer),
)

const hint = Effect.logWarning(
  `No collector at ${url} — this run will not be traced.\n` +
    `  Start one in another terminal:  bun run collector\n` +
    `  Then the webapp:                bun run dev:app\n` +
    `Running anyway: the inspect layer is a no-op when the collector is down.`,
)

/**
 * Runs `program` with the inspect layer attached, warning first if the trace
 * has nowhere to go.
 *
 * `name` is what the webapp's session list shows for this run.
 */
export const main = (name: string, program: Effect.Effect<void>): void => {
  BunRuntime.runMain(
    Effect.gen(function* () {
      // Untraced: the probe is scaffolding, and an `http.client GET` span at
      // the top of every example's trace is exactly the noise you don't want
      // when the trace *is* the thing you're looking at.
      if (yield* Effect.withTracerEnabled(collectorIsUp, false)) {
        yield* Effect.logInfo(`streaming to ${url} — open the webapp to watch "${name}"`)
      } else yield* hint
      yield* program
    }).pipe(Effect.provide(Inspect.layer({ programName: name, url }))),
  )
}
