import { Effect } from 'effect'

export const program = Effect.log('hello from effect-inspect')

if (import.meta.main) {
  Effect.runFork(program)
}
