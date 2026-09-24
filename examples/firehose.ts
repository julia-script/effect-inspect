/**
 * Synthetic load, for the 10k-span performance check.
 *
 * `bun run example:firehose`         — 10,000 spans
 * `bun run example:firehose 50000`   — as many as you ask for
 *
 * Spans are shallow and fast on purpose: the point is span count, not shape.
 * Note the client's outbound queue is 8192 by default, so a burst this size
 * will drop messages if the collector cannot keep up — that shows up as a
 * `Warn` log in the trace, which is itself worth seeing.
 */
import { Effect, Random } from 'effect'
import { main } from './run.ts'

const requested = Number(process.argv[2] ?? 10_000)
const total = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 10_000

/** A leaf with no sleep — a burst of these is what stresses the renderer. */
const leaf = (index: number) =>
  Effect.annotateCurrentSpan('index', index).pipe(Effect.withSpan(`leaf-${index % 64}`))

/** 100 leaves under one parent, so the chart is 3 deep and very wide. */
const batch = (batchIndex: number, size: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < size; i++) yield* leaf(batchIndex * 100 + i)
    // Two jobs: spread the spans across the timeline instead of piling them
    // into one pixel column, and let the client's drain fiber keep up. Emitting
    // 20k messages flat-out overruns the 8192 outbound queue and the 250ms
    // shutdown flush, and you get ~85% of the spans you asked for.
    yield* Effect.sleep(`${yield* Random.nextIntBetween(8, 16)} millis`)
  }).pipe(Effect.withSpan(`batch-${batchIndex}`))

const program = Effect.gen(function* () {
  yield* Effect.logInfo(`emitting ${total} spans`)
  let emitted = 0
  let batchIndex = 0
  while (emitted < total) {
    const size = Math.min(100, total - emitted)
    yield* batch(batchIndex++, size)
    emitted += size
  }
  yield* Effect.logInfo(`emitted ${emitted + batchIndex + 1} spans in ${batchIndex} batches`)
}).pipe(
  Effect.withSpan('firehose'),
  // Shutdown waits at most 250ms for the outbound queue to flush; at this
  // volume the tail would be cut off, so settle before the scope closes.
  Effect.andThen(Effect.sleep('1 second')),
)

main('example:firehose', program)
