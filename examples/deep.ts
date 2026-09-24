/**
 * Vertical depth: 40 levels of recursion under one root.
 *
 * Exercises row layout at depth, label elision in narrow bars, and the nesting
 * rules — each level is strictly inside its parent and a hair shorter.
 *
 * `bun run example:deep`
 */
import { Effect } from 'effect'
import { main } from './run.ts'

const depth = 40

const descend = (level: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan('level', level)
    yield* Effect.sleep('2 millis')
    if (level < depth) yield* descend(level + 1)
    else yield* Effect.logInfo(`bottom reached at level ${level}`)
    yield* Effect.sleep('2 millis')
  }).pipe(Effect.withSpan(`level-${level}`))

// A second, shallower branch beside it, so the deep stack has something to be
// deep relative to.
const shallow = Effect.sleep('30 millis').pipe(
  Effect.withSpan('sibling.inner'),
  Effect.withSpan('sibling'),
)

const program = Effect.all([descend(1), shallow], { concurrency: 'unbounded' }).pipe(
  Effect.asVoid,
  Effect.withSpan('deep'),
)

main('example:deep', program)
