/**
 * Fan-out: wide sibling rows rather than a deep stack.
 *
 * Three waves of concurrent work with staggered starts and varied durations,
 * so the chart has a lot of horizontal neighbours at the same depth.
 *
 * `bun run example:concurrent`
 */
import { Array as Arr, Effect, Random } from 'effect'
import { main } from './run.ts'

const task = (wave: number, index: number) =>
  Effect.gen(function* () {
    // Staggered starts, so siblings are offset instead of all flush-left.
    yield* Effect.sleep(`${index * 4} millis`)
    yield* Effect.annotateCurrentSpan({ wave, index })
    const duration = yield* Random.nextIntBetween(10, 220)
    yield* Effect.sleep(`${duration} millis`)
    // A nested child on some tasks only, so the rows are ragged not uniform.
    if (index % 3 === 0) {
      yield* Effect.sleep(`${yield* Random.nextIntBetween(5, 40)} millis`).pipe(
        Effect.withSpan('task.flush'),
      )
    }
  }).pipe(Effect.withSpan(`task-${wave}.${index}`))

const runWave = (wave: number, width: number) =>
  Effect.forEach(Arr.range(0, width - 1), (index) => task(wave, index), {
    concurrency: 'unbounded',
  }).pipe(Effect.asVoid, Effect.withSpan(`wave-${wave}`, { attributes: { width } }))

const program = Effect.gen(function* () {
  yield* runWave(1, 24)
  yield* Effect.all([runWave(2, 40), runWave(3, 16)], { concurrency: 'unbounded' })
  yield* Effect.logInfo('all waves complete')
}).pipe(Effect.withSpan('fan-out'))

main('example:concurrent', program)
