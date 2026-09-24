/**
 * The chart's horizontal time window.
 *
 * Kept as a plain value with pure transitions so pan/zoom is testable without
 * a canvas, and so the overview strip and the chart can be driven from exactly
 * the same numbers.
 */

/** A visible time window, in millis relative to the trace origin. */
export interface Viewport {
  readonly from: number
  readonly to: number
}

/** Never zoom in past this window width; below it float maths gets noisy. */
const MIN_SPAN = 0.001

/**
 * Clamps a window to `[0, total]` while preserving its width where possible.
 *
 * Preserving width matters for panning: dragging past the left edge should
 * stop at the edge, not squash the window.
 */
export const clamp = (view: Viewport, total: number): Viewport => {
  const limit = Math.max(total, MIN_SPAN)
  const width = Math.min(Math.max(view.to - view.from, MIN_SPAN), limit)
  let from = view.from
  if (from < 0) from = 0
  if (from + width > limit) from = limit - width
  return { from, to: from + width }
}

/** Zooms by `factor` (>1 zooms out) keeping the time under `anchor` fixed. */
export const zoom = (view: Viewport, anchor: number, factor: number, total: number): Viewport => {
  const width = (view.to - view.from) * factor
  const ratio = (anchor - view.from) / (view.to - view.from)
  return clamp({ from: anchor - width * ratio, to: anchor + width * (1 - ratio) }, total)
}

/** Slides the window by `delta` millis. */
export const pan = (view: Viewport, delta: number, total: number): Viewport =>
  clamp({ from: view.from + delta, to: view.to + delta }, total)

/** True when the window covers the whole trace, i.e. live mode should follow. */
export const isFull = (view: Viewport, total: number): boolean =>
  view.from <= 0 && view.to >= Math.max(total, MIN_SPAN) - MIN_SPAN
