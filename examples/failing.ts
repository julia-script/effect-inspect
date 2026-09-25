/**
 * Every failure shape in one run, for checking error rendering end to end.
 *
 * A typed error, a defect, an interruption, and a retry that succeeds on the
 * third attempt. Each arrives as a `SpanEnd` outcome of kind `Fail`, `Die` or
 * `Interrupt`, with the cause already flattened to a rendered message.
 *
 * The program itself succeeds — every failure is caught after the span that
 * records it has closed.
 *
 * `bun run example:failing`
 */
import { Data, Effect, Schedule } from 'effect'
import { main } from './run.ts'

// `message` matters: the tracer renders the cause to a string, and a tagged
// error without one shows up in the UI as a bare tag with nothing after it.
class PaymentDeclined extends Data.TaggedError('PaymentDeclined')<{ readonly card: string }> {
  override get message(): string {
    return `card ${this.card} was declined`
  }
}

class UpstreamUnavailable extends Data.TaggedError('UpstreamUnavailable')<{
  readonly attempt: number
}> {
  override get message(): string {
    return `upstream returned 503 on attempt ${this.attempt}`
  }
}

/** Kind `Fail`: an error the program's type says can happen. */
const typedFailure = Effect.gen(function* () {
  yield* Effect.logInfo('charging card **** 4242')
  yield* Effect.sleep('20 millis')
  return yield* new PaymentDeclined({ card: '**** 4242' })
}).pipe(Effect.withSpan('charge.card'), Effect.ignore, Effect.withSpan('typed-error'))

/** Kind `Die`: a defect, thrown from code that did not declare it. */
const defect = Effect.sync(() => {
  throw new TypeError("cannot read properties of undefined (reading 'total')")
}).pipe(
  Effect.delay('15 millis'),
  Effect.withSpan('cart.total'),
  Effect.ignoreCause,
  Effect.withSpan('defect'),
)

/** Kind `Interrupt`: work cut short by a timeout. */
const interrupted = Effect.sleep('10 seconds').pipe(
  Effect.withSpan('report.generate'),
  Effect.timeout('60 millis'),
  Effect.ignore,
  Effect.withSpan('interrupted'),
)

/** Two red attempts then a green one — the classic retry shape in the chart. */
const flaky = Effect.gen(function* () {
  let attempts = 0
  return yield* Effect.suspend(() => {
    attempts += 1
    return Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan('attempt', attempts)
      yield* Effect.sleep('25 millis')
      if (attempts < 3) return yield* new UpstreamUnavailable({ attempt: attempts })
      yield* Effect.logInfo(`succeeded on attempt ${attempts}`)
    }).pipe(Effect.withSpan(`fetch.attempt-${attempts}`))
  }).pipe(
    Effect.retry(Schedule.recurs(3).pipe(Schedule.addDelay(() => Effect.succeed('30 millis')))),
    Effect.ignore,
    Effect.withSpan('retry'),
  )
})

const program = Effect.gen(function* () {
  yield* typedFailure
  yield* defect
  yield* interrupted
  yield* flaky
  yield* Effect.logWarning('four failure modes emitted; the program itself succeeded')
}).pipe(Effect.withSpan('failures'))

main('example:failing', program)
