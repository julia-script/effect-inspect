/**
 * The flame chart's spatial index.
 *
 * The renderer must answer "which spans intersect this time window, on this
 * row?" once per row per frame, for a trace that can hold 10k+ spans. Doing
 * that by scanning `TraceStore.rows[d]` would be O(spans) per frame; doing it
 * by rebuilding a layout per frame would be worse. So the index is built
 * **only when `store.version` moves** (i.e. when spans arrive), and reused
 * unchanged across every pan/zoom frame.
 *
 * Rows are **packed**, not keyed on tree depth: two siblings that run
 * concurrently share a depth, so a depth-keyed chart paints them on top of
 * each other and silently hides most of a concurrent trace. A span goes on the
 * first row where it does not overlap anything already placed, never above its
 * parent — what Chrome DevTools does. Depth is a lower bound on the row, not
 * the row.
 *
 * Rebuilding rather than patching is deliberate: a late-arriving parent
 * re-depths its whole subtree, so a span can move between rows at any time and
 * an incrementally-patched index would silently rot. A sort plus a packing
 * pass over 10k spans costs well under a frame and only happens when data
 * actually changed.
 */
import type { TraceSpan, TraceStore } from '../trace/TraceStore.ts'

/** One drawn row, its spans sorted by start time and guaranteed not to overlap. */
export interface LayoutRow {
  readonly spans: ReadonlyArray<TraceSpan>
  /** `maxEnd[i]` is the largest `end` among `spans[0..i]` — see {@link firstVisible}. */
  readonly maxEnd: Float64Array
}

export interface Layout {
  /** The `store.version` this was built from. */
  readonly version: number
  readonly rows: ReadonlyArray<LayoutRow>
  /** Row index a span was packed onto, by span id — the renderer's y lookup. */
  readonly rowOf: ReadonlyMap<string, number>
  /** Latest observed time in millis; the right edge of the whole trace. */
  readonly duration: number
  /** Every span in start order regardless of row — the event log's source. */
  readonly ordered: ReadonlyArray<TraceSpan>
}

const EMPTY: Layout = { version: -1, rows: [], rowOf: new Map(), duration: 0, ordered: [] }

/** Effective end of a span: open spans run to `now` (the trace's right edge). */
export const spanEnd = (span: TraceSpan, now: number): number => span.end ?? now

/**
 * Returns a layout for the store's current version, reusing `previous` when
 * nothing has changed.
 */
export const layout = (store: TraceStore, previous: Layout = EMPTY): Layout => {
  if (previous.version === store.version) return previous
  const duration = store.stats().duration

  // Start order, ties broken by depth. Two invariants ride on this order:
  // every row receives its spans already start-sorted (so `rowEnd` is the
  // whole occupancy test), and a parent is always packed before its children
  // (a child cannot start before its parent, and the depth tiebreak covers the
  // equal-start case), so `rowOf.get(parentId)` is populated when asked.
  const ordered: Array<TraceSpan> = []
  for (const ids of store.rows) {
    for (const id of ids) {
      const span = store.spans.get(id)
      if (span !== undefined) ordered.push(span)
    }
  }
  ordered.sort((a, b) => a.start - b.start || a.depth - b.depth)

  const spansByRow: Array<Array<TraceSpan>> = []
  // `rowEnd[r]` is the end of the last span placed on row r. Spans reach a row
  // in start order, so one number per row is the whole occupancy test.
  const rowEnd: Array<number> = []
  const rowOf = new Map<string, number>()

  for (const span of ordered) {
    const parentRow = span.parentId === undefined ? undefined : rowOf.get(span.parentId)
    // ponytail: linear scan from the first legal row. O(rows) per span, and
    // rows only grow with peak concurrency, not with span count — a 10k-span
    // trace 10 rows deep costs 100k comparisons. Swap in a per-row heap keyed
    // on rowEnd if a trace ever runs thousands of spans wide.
    let row = parentRow === undefined ? 0 : parentRow + 1
    while (row < rowEnd.length && rowEnd[row]! > span.start) row++
    if (row === spansByRow.length) {
      spansByRow.push([])
      rowEnd.push(Number.NEGATIVE_INFINITY)
    }
    spansByRow[row]!.push(span)
    rowEnd[row] = spanEnd(span, duration)
    rowOf.set(span.spanId, row)
  }

  const rows = spansByRow.map((spans) => {
    // Spans arrive here in start order within a row (they were packed that
    // way), so only the prefix maximum of end times is left to compute. A
    // start-sorted row is *not* end-sorted once open spans run to `now`, which
    // is what `firstVisible` binary-searches.
    const maxEnd = new Float64Array(spans.length)
    let running = Number.NEGATIVE_INFINITY
    for (let i = 0; i < spans.length; i++) {
      const end = spanEnd(spans[i]!, duration)
      if (end > running) running = end
      maxEnd[i] = running
    }
    return { spans, maxEnd }
  })

  return {
    version: store.version,
    rows,
    rowOf,
    duration,
    ordered,
  }
}

export const emptyLayout = (): Layout => EMPTY

/**
 * Index of the first span in `row` that can intersect `[from, to]`.
 *
 * Binary searches the prefix-maximum of end times: everything before the
 * result ends strictly before `from`, so it is safely skipped. Returns
 * `row.spans.length` when nothing intersects.
 */
export const firstVisible = (row: LayoutRow, from: number): number => {
  let lo = 0
  let hi = row.spans.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (row.maxEnd[mid]! < from) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Walks the spans of `row` intersecting `[from, to]`, in start order.
 *
 * Stops as soon as a span starts after `to` — the row is start-sorted, so
 * everything after it starts later still.
 */
export const forEachVisible = (
  row: LayoutRow,
  from: number,
  to: number,
  now: number,
  visit: (span: TraceSpan) => void,
): void => {
  for (let i = firstVisible(row, from); i < row.spans.length; i++) {
    const span = row.spans[i]!
    if (span.start > to) return
    if (spanEnd(span, now) >= from) visit(span)
  }
}
