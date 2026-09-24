/** Span timing derived the same way for the chart, the tooltip and the log. */
import { spanEnd } from './Layout.ts'
import type { TraceSpan, TraceStore } from '../trace/TraceStore.ts'

/**
 * Total and self time for a span, in millis.
 *
 * Self time is total minus the time covered by direct children. Children can
 * overlap each other (concurrent fibers), so this is a sum rather than a union
 * and can therefore under-report self time for a heavily concurrent span.
 * ponytail: sum of child durations, not a union of their intervals — swap for
 * an interval merge if concurrent spans make self time read as zero too often.
 */
export const timings = (
  store: TraceStore,
  span: TraceSpan,
  now: number,
): { readonly total: number; readonly self: number } => {
  const total = spanEnd(span, now) - span.start
  let childTime = 0
  for (const id of span.children) {
    const child = store.spans.get(id)
    if (child !== undefined) childTime += spanEnd(child, now) - child.start
  }
  return { total, self: Math.max(total - childTime, 0) }
}
