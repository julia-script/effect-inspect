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
 *
 * **A span's row is final once assigned.** `previous.rowOf` is carried over
 * verbatim and only spans the previous layout never saw are packed. A late
 * arrival that fits nowhere takes a new row rather than repacking what the
 * user is already looking at — under a live trace, rows never reshuffle.
 *
 * The cost is deliberate and one-directional: a trace watched live can end up
 * taller than the same trace loaded from scratch, because a gap that opens up
 * later is never reclaimed. Visual stability beats vertical compactness.
 */
export const layout = (store: TraceStore, previous: Layout = EMPTY): Layout => {
  if (previous.version === store.version) return previous
  const duration = store.stats().duration

  // Start order, ties broken by depth, so a parent is packed before its
  // children (a child cannot start before its parent; the depth tiebreak
  // covers the equal-start case) and `rowOf.get(parentId)` is populated when
  // a child asks for it.
  const ordered: Array<TraceSpan> = []
  for (const ids of store.rows) {
    for (const id of ids) {
      const span = store.spans.get(id)
      if (span !== undefined) ordered.push(span)
    }
  }
  ordered.sort((a, b) => a.start - b.start || a.depth - b.depth)

  // Rows carried over from the previous layout keep every span they had. New
  // spans are placed around them, so a row is no longer filled in start order
  // and one "last end" number cannot answer "is this row free at time t?".
  //
  // Occupancy is split in two so the common case stays O(1). New spans are
  // placed in start order, so for those a single frontier per row —
  // `freeFrom[r]`, the largest end among them — is exactly the test. Pinned
  // spans are claimed up front in arbitrary order relative to the frontier, so
  // they are the only ones that need an interval list, and it is short: it
  // holds one entry per pinned span on that row. On a cold build there are no
  // pinned spans and `pinned[r]` stays empty.
  const spansByRow: Array<Array<TraceSpan>> = []
  const freeFrom: Array<number> = []
  const pinned: Array<Array<{ readonly from: number; readonly to: number }>> = []
  const rowOf = new Map<string, number>()

  const claim = (row: number, span: TraceSpan, isPinned: boolean): void => {
    while (spansByRow.length <= row) {
      spansByRow.push([])
      freeFrom.push(Number.NEGATIVE_INFINITY)
      pinned.push([])
    }
    const to = spanEnd(span, duration)
    spansByRow[row]!.push(span)
    if (isPinned) pinned[row]!.push({ from: span.start, to })
    else if (to > freeFrom[row]!) freeFrom[row] = to
    rowOf.set(span.spanId, row)
  }

  /** True when a span spanning `[from, to)` can be drawn on `row` untouched. */
  const fits = (row: number, from: number, to: number): boolean => {
    if (row >= spansByRow.length) return true
    if (freeFrom[row]! > from) return false
    return !pinned[row]!.some((i) => i.from < to && from < i.to)
  }

  // A session switch calls `TraceStore.clear()`, which only bumps `version` —
  // so without this the next session's spans would be pinned to rows from the
  // last one, stranding a lone root halfway down an otherwise empty chart.
  // Spans are only ever added within a session, so losing one means a reset.
  const keepRows = ordered.length >= previous.ordered.length

  // Every pinned span claims its row up front. A new span placed later must
  // see the whole occupied picture, including spans that start after it — so
  // this cannot be folded into the placement loop, which runs in start order.
  if (keepRows) {
    for (const span of ordered) {
      const pinnedRow = previous.rowOf.get(span.spanId)
      if (pinnedRow !== undefined) claim(pinnedRow, span, true)
    }
  }

  const rowFor = (span: TraceSpan): number => {
    const parentRow = span.parentId === undefined ? undefined : rowOf.get(span.parentId)
    const from = span.start
    const to = spanEnd(span, duration)
    // ponytail: linear scan from the first legal row. Rows grow with peak
    // concurrency, not span count, and each row test is O(1) unless the row
    // holds pinned spans reaching past its frontier. A realistic 13k-span
    // trace is 10 rows and builds in ~5ms cold / ~1ms per live append; 13k
    // spans all running at once is 13k rows and ~96ms, ingest-only. Swap in a
    // row-index keyed on free-from time if a trace ever runs thousands wide.
    let row = parentRow === undefined ? 0 : parentRow + 1
    while (!fits(row, from, to)) row++
    return row
  }

  for (const span of ordered) {
    if (rowOf.has(span.spanId)) continue
    claim(rowFor(span), span, false)
  }

  const rows = spansByRow.map((spans) => {
    // A pinned span can be reached out of start order, so the row is sorted
    // here rather than relying on insertion order. `forEachVisible` binary
    // searches the prefix maximum of end times, which needs both: start order,
    // and the running max (a start-sorted row is *not* end-sorted, because a
    // wide span can contain several short ones).
    spans.sort((a, b) => a.start - b.start)
    const maxEnd = new Float64Array(spans.length)
    let running = Number.NEGATIVE_INFINITY
    for (let i = 0; i < spans.length; i++) {
      const end = spanEnd(spans[i]!, duration)
      if (end > running) running = end
      maxEnd[i] = running
    }
    return { spans, maxEnd }
  })

  return { version: store.version, rows, rowOf, duration, ordered }
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
