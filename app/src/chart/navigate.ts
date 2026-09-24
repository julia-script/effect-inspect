/**
 * Span-tree traversal for the arrow keys.
 *
 * Kept separate from the key handler and from the renderer because it is the
 * only part with interesting behaviour: it is pure over {@link TraceStore}, so
 * it is testable against the committed fixture without a browser.
 *
 * Direction follows Chrome DevTools' flame chart: up/down move between a span
 * and its parent/child (visually, one row up or down), left/right move between
 * siblings (visually, along a row).
 *
 * Siblings are ordered by **start time**, not by `children` arrival order. Two
 * concurrent children race to the wire, so arrival order is nondeterministic —
 * a left/right walk keyed on it would visit spans in an order that does not
 * match what the eye sees on the row.
 */
import type { TraceSpan, TraceStore } from '../trace/TraceStore.ts'

/** Which way an arrow key moves through the tree. */
export type Direction = 'parent' | 'child' | 'previous' | 'next'

const byStart = (store: TraceStore, ids: ReadonlyArray<string>): Array<TraceSpan> => {
  const spans: Array<TraceSpan> = []
  for (const id of ids) {
    const span = store.spans.get(id)
    if (span !== undefined) spans.push(span)
  }
  // Ties broken by id so the walk is deterministic when two spans start in the
  // same millisecond — without it, left then right could land somewhere new.
  spans.sort((a, b) => a.start - b.start || (a.spanId < b.spanId ? -1 : 1))
  return spans
}

/**
 * The span's siblings in visual order, including itself.
 *
 * A root's siblings are the other roots: at depth 0 there is no parent to ask,
 * but left/right must still walk the top row.
 *
 * An **orphan** (parent id seen, parent span not yet arrived) is the case worth
 * knowing about: `TraceStore` parks it in `pendingChildren` rather than pushing
 * it to `roots`, so it is drawn at depth 0 but is in nobody's child list. Left
 * and right would dead-end on it — the span is visible and unreachable. So it
 * is grouped with the roots it is drawn beside, which is what the eye expects.
 */
const siblingsOf = (store: TraceStore, span: TraceSpan): Array<TraceSpan> => {
  const parent = span.parentId === undefined ? undefined : store.spans.get(span.parentId)
  if (parent !== undefined) return byStart(store, parent.children)
  const rootRow = span.orphaned ? [...store.roots, span.spanId] : store.roots
  return byStart(store, rootRow)
}

/**
 * The next span in `direction` from `spanId`, or `undefined` at the edge.
 *
 * Returning `undefined` rather than wrapping or clamping is deliberate: the
 * caller leaves the selection where it is, so holding an arrow key at the end
 * of a row does nothing instead of teleporting to the other end.
 */
export const step = (
  store: TraceStore,
  spanId: string,
  direction: Direction,
): string | undefined => {
  const span = store.spans.get(spanId)
  if (span === undefined) return undefined

  if (direction === 'parent') {
    // An orphan's parent id points at a span that has not arrived; there is
    // nothing to select, so the selection stays put.
    return span.parentId === undefined ? undefined : store.spans.get(span.parentId)?.spanId
  }

  if (direction === 'child') {
    // The earliest child, so down-then-up returns to where you started.
    return byStart(store, span.children)[0]?.spanId
  }

  const siblings = siblingsOf(store, span)
  const index = siblings.findIndex((candidate) => candidate.spanId === spanId)
  if (index === -1) return undefined
  return siblings[direction === 'previous' ? index - 1 : index + 1]?.spanId
}

/**
 * A sensible span to select when nothing is selected yet and an arrow is
 * pressed: the earliest root, so the first keystroke lands somewhere visible
 * rather than doing nothing.
 */
export const firstSpan = (store: TraceStore): string | undefined =>
  byStart(store, store.roots)[0]?.spanId

/**
 * True when a keystroke's target is somewhere it means text, not a command.
 *
 * This is the rule that actually bites: typing `w` in the filter box must type
 * a `w`, not zoom the chart. Checked by element kind rather than by a flag the
 * filter box sets, so every input the app grows — the aggregation tabs' own
 * filters included — is covered without touching the key handler.
 *
 * `isContentEditable` covers rich-text hosts; `closest` catches a keystroke
 * that lands on a child of one. Lives here rather than beside the handler so a
 * plain `bun test` can exercise it without mounting React.
 */
export const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable || target.closest('[contenteditable="true"]') !== null
}
