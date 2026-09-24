/**
 * A long-running program, for live tailing and reconnect.
 *
 * Emits a small burst of spans every ~600ms forever. Kill the collector and
 * restart it, or Ctrl-C this and start it again — the session resumes by id, so
 * the trace continues rather than starting over.
 *
 * `bun run example:slow`  (runs until you stop it)
 */
import { Effect, Random, Schedule } from 'effect'
import { main } from './run.ts'

let tick = 0

/**
 * The span name has to be built inside the effect, not in a `.pipe` on the
 * outside: the pipe runs once when this module loads, so every repeat would
 * otherwise be called `tick-1`.
 */
const beat = Effect.suspend(() => {
  const n = ++tick
  return Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan('tick', n)
    yield* Effect.sleep(`${yield* Random.nextIntBetween(20, 90)} millis`).pipe(
      Effect.withSpan('poll.upstream'),
    )
    yield* Effect.sleep(`${yield* Random.nextIntBetween(5, 40)} millis`).pipe(
      Effect.withSpan('poll.store'),
    )
    if (n % 10 === 0) yield* Effect.logInfo(`${n} ticks`)
  }).pipe(Effect.withSpan(`tick-${n}`))
})

// No enclosing root span: a minutes-long parent bar would swallow the whole
// viewport and tell you nothing. Each tick is its own root instead.
const program = beat.pipe(Effect.repeat(Schedule.spaced('600 millis')), Effect.asVoid)

main('example:slow', program)
