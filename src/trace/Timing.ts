/**
 * Span timing derived the same way for the chart, the tooltip, the log, the
 * drawer and the headless query core.
 */
import type { TraceSpan, TraceStore } from './TraceStore.ts'

/** A span's end, or `now` while it is still open. */
const spanEnd = (span: TraceSpan, now: number): number => span.end ?? now

/**
 * Time covered by the union of `span`'s direct children, clipped to `[from, to]`.
 *
 * A **union**, not a sum: two children running concurrently for 10ms each
 * occupy 10ms of their parent, not 20ms. Summing would make a heavily
 * concurrent span's self time read as zero (or negative, and clamp to zero),
 * which is exactly the number the aggregation tabs are built to show.
 *
 * Children are sorted by start and swept once, so this is O(k log k) in the
 * number of direct children — not in the subtree, and never in the trace.
 */
const childUnion = (
  store: TraceStore,
  span: TraceSpan,
  now: number,
  from: number,
  to: number,
): number => {
  const intervals: Array<readonly [number, number]> = []
  for (const id of span.children) {
    const child = store.spans.get(id)
    if (child === undefined) continue
    const lo = Math.max(child.start, from)
    const hi = Math.min(spanEnd(child, now), to)
    if (hi > lo) intervals.push([lo, hi])
  }
  if (intervals.length === 0) return 0
  intervals.sort((a, b) => a[0] - b[0])

  let covered = 0
  let [runStart, runEnd] = intervals[0]!
  for (let i = 1; i < intervals.length; i++) {
    const [lo, hi] = intervals[i]!
    if (lo > runEnd) {
      covered += runEnd - runStart
      runStart = lo
      runEnd = hi
    } else if (hi > runEnd) runEnd = hi
  }
  return covered + (runEnd - runStart)
}

/**
 * Total and self time for a span, in millis.
 *
 * Self time is the span's own duration minus the time covered by its direct
 * children. `from`/`to` clip both to a time window, which is how the
 * aggregation tabs follow the viewport the way Chrome does: a span half inside
 * the window contributes only its visible half, and only the child time that
 * overlaps that half is subtracted.
 */
export const timings = (
  store: TraceStore,
  span: TraceSpan,
  now: number,
  from = -Infinity,
  to = Infinity,
): { readonly total: number; readonly self: number } => {
  const lo = Math.max(span.start, from)
  const hi = Math.min(spanEnd(span, now), to)
  if (hi <= lo) return { total: 0, self: 0 }
  return { total: hi - lo, self: Math.max(hi - lo - childUnion(store, span, now, lo, hi), 0) }
}
