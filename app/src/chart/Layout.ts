/**
 * The flame chart's spatial index.
 *
 * The renderer must answer "which spans intersect this time window, at this
 * depth?" once per row per frame, for a trace that can hold 10k+ spans. Doing
 * that by scanning `TraceStore.rows[d]` would be O(spans) per frame; doing it
 * by rebuilding a layout per frame would be worse. So the index is a
 * start-sorted copy of each row, rebuilt **only when `store.version` moves**
 * (i.e. when spans arrive), and reused unchanged across every pan/zoom frame.
 *
 * Rebuilding rather than patching is deliberate: a late-arriving parent
 * re-depths its whole subtree, so a span can move between rows at any time and
 * an incrementally-patched index would silently rot. A sort of 10k ids costs
 * well under a frame and only happens when data actually changed.
 */
import type { TraceSpan, TraceStore } from '../trace/TraceStore.ts'

/** One depth level, its spans sorted by start time. */
export interface LayoutRow {
  readonly spans: ReadonlyArray<TraceSpan>
  /** `maxEnd[i]` is the largest `end` among `spans[0..i]` — see {@link visibleRange}. */
  readonly maxEnd: Float64Array
}

export interface Layout {
  /** The `store.version` this was built from. */
  readonly version: number
  readonly rows: ReadonlyArray<LayoutRow>
  /** Latest observed time in millis; the right edge of the whole trace. */
  readonly duration: number
  /** Every span in start order regardless of depth — the event log's source. */
  readonly ordered: ReadonlyArray<TraceSpan>
}

const EMPTY: Layout = { version: -1, rows: [], duration: 0, ordered: [] }

/** Effective end of a span: open spans run to `now` (the trace's right edge). */
export const spanEnd = (span: TraceSpan, now: number): number => span.end ?? now

const buildRow = (store: TraceStore, ids: ReadonlyArray<string>, now: number): LayoutRow => {
  const spans: Array<TraceSpan> = []
  for (const id of ids) {
    const span = store.spans.get(id)
    if (span !== undefined) spans.push(span)
  }
  spans.sort((a, b) => a.start - b.start)

  // Running maximum of end times. A span list sorted by start is *not* sorted
  // by end (a long span can contain several short ones), so a binary search on
  // start alone can miss a wide span that began off-screen to the left. The
  // prefix maximum makes that answerable in O(log n) instead of scanning back
  // to index 0.
  const maxEnd = new Float64Array(spans.length)
  let running = Number.NEGATIVE_INFINITY
  for (let i = 0; i < spans.length; i++) {
    const end = spanEnd(spans[i]!, now)
    if (end > running) running = end
    maxEnd[i] = running
  }
  return { spans, maxEnd }
}

/**
 * Returns a layout for the store's current version, reusing `previous` when
 * nothing has changed.
 */
export const layout = (store: TraceStore, previous: Layout = EMPTY): Layout => {
  if (previous.version === store.version) return previous
  const duration = store.stats().duration
  const rows = store.rows.map((ids) => buildRow(store, ids, duration))
  const ordered = rows.flatMap((row) => row.spans).sort((a, b) => a.start - b.start)
  return { version: store.version, rows, duration, ordered }
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
