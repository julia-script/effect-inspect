/**
 * The memory track: a filled `heapUsed` curve drawn above the flame bars.
 *
 * It lives **inside the flame chart's canvas**, drawn by the same renderer from
 * the same `timeToX`, rather than as a second canvas stacked above it. That is
 * the whole design: x-alignment with the bars is not something two components
 * have to keep agreeing about across a pan, it is a consequence of there being
 * one viewport and one coordinate function. A separate canvas is where the
 * obvious failure mode — a track that drifts half a pixel per zoom step — comes
 * from, and this cannot have it.
 *
 * Absent, not empty: a session with no samples reserves no height at all (see
 * {@link trackHeight}), so a program in a runtime without `process.memoryUsage`
 * shows a chart identical to the one it showed before this existed.
 */
import type { TraceMemorySample } from '../trace/TraceStore.ts'

/** Height of the track when a session has samples. Zero when it has none. */
export const MEMORY_TRACK_HEIGHT = 40

/** Grayscale, per the visual direction: the curve is light, its fill is faint. */
const COLOR_CURVE = '#d4d4d4'
/** The secondary `rss` line: dimmer than the heap, because it is secondary. */
const COLOR_RSS = '#525252'
const COLOR_FILL = 'rgba(212,212,212,0.16)'
const COLOR_LABEL = '#525252'
const COLOR_BASE = '#1c1c1c'
const COLOR_BG = '#0a0a0a'

/** Width of the clickable label that collapses and expands the track. */
export const MEMORY_LABEL_WIDTH = 260

/**
 * Height of the collapsed handle — the strip left behind so the track can be
 * brought back. Zero when the session has no samples at all: an absent track
 * has nothing to expand, and reserving a row for it would be exactly the empty
 * box the task forbids.
 */
export const MEMORY_HANDLE_HEIGHT = 11

/** The height a track takes: full, collapsed to its handle, or nothing at all. */
export const trackHeight = (
  samples: ReadonlyArray<TraceMemorySample>,
  collapsed: boolean,
): number => {
  if (samples.length === 0) return 0
  return collapsed ? MEMORY_HANDLE_HEIGHT : MEMORY_TRACK_HEIGHT
}

/** Bytes as the shortest readable unit — the track's only text. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Index of the sample at or just before `time`, or `-1` when `time` predates
 * the series.
 *
 * Binary search rather than a scan: this runs per pointer move, and a long
 * trace's series is thousands of entries.
 */
export const sampleAt = (
  samples: ReadonlyArray<TraceMemorySample>,
  time: number,
): TraceMemorySample | undefined => {
  let lo = 0
  let hi = samples.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (samples[mid]!.time <= time) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  // Before the first sample, the nearest reading is still the first one — the
  // alternative is a readout that blanks at the very left edge of the trace.
  return samples[found === -1 ? 0 : found]
}

export interface MemoryTrackDraw {
  readonly ctx: CanvasRenderingContext2D
  readonly samples: ReadonlyArray<TraceMemorySample>
  readonly collapsed: boolean
  /** Top of the track band, in CSS pixels. */
  readonly top: number
  readonly height: number
  readonly width: number
  /** The renderer's own time→x — the reason this cannot drift from the bars. */
  readonly timeToX: (time: number) => number
  /**
   * Largest `heapUsed` across the whole trace — the y-axis top.
   *
   * Deliberately the heap peak, not the `rss` peak: heap is the headline series
   * and on a typical Bun program `rss` is an order of magnitude larger, so
   * scaling to `rss` flattens the heap curve into the baseline and the track
   * shows nothing at all.
   */
  readonly peak: number
  /** Smallest `heapUsed` across the trace — the y-axis floor. */
  readonly trough: number
  /** Largest `rss`, for the secondary line's own scale. */
  readonly rssPeak: number
  /** Right edge of the whole trace, so the series is held flat out to it. */
  readonly traceEnd: number
  /** Time under the cursor, if any, so the readout marks it. */
  readonly cursorTime: number | undefined
}

/**
 * Draws the heap curve across the full track width.
 *
 * The y-scale is the **whole trace's** peak rather than the visible window's,
 * so zooming in does not silently re-scale the curve under the user and make a
 * flat stretch look like a spike. Chrome does the same.
 *
 * Samples are drawn as a step-then-line polyline over the visible range only,
 * with one sample of overshoot on each side so the curve enters and leaves the
 * viewport rather than starting at its edge.
 */
export const drawMemoryTrack = (draw: MemoryTrackDraw): void => {
  const { ctx, samples, collapsed, top, height, width, timeToX, peak, trough, rssPeak, traceEnd } =
    draw
  if (samples.length === 0 || height <= 0) return

  // Collapsed: just the handle, so the track can be brought back. Clicking
  // anywhere on it toggles — see `MEMORY_HANDLE_HEIGHT` and the renderer's
  // pointer-down.
  if (collapsed) {
    ctx.save()
    ctx.fillStyle = COLOR_BG
    ctx.fillRect(0, top, width, height)
    ctx.fillStyle = COLOR_LABEL
    ctx.textAlign = 'left'
    ctx.fillText(`+ memory · heap peak ${formatBytes(peak)}`, 4, top + height / 2)
    ctx.restore()
    return
  }

  const bottom = top + height
  const scale = height - 12

  // The axis spans the trace's own heap **range**, not `[0, peak]`.
  //
  // A long-lived program's heap floor is rarely near zero, so a zero-based axis
  // squeezes every real allocation into the top few pixels of a 40px band and
  // shows a flat line where there is a sawtooth. The range is taken over the
  // whole trace rather than the visible window so that zooming does not
  // re-scale the curve under the user — a flat stretch must stay flat when you
  // zoom into it.
  const floor = trough
  const span = peak - floor
  const yOf = (bytes: number): number =>
    span > 0 ? bottom - ((bytes - floor) / span) * scale - 2 : bottom - scale / 2

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, top, width, height)
  ctx.clip()

  // Clamped so a viewport zoomed far in does not hand the canvas coordinates in
  // the millions, which some GPU backends quietly refuse to draw.
  const xOf = (time: number): number => {
    const x = timeToX(time)
    if (x < -width) return -width
    return x > width * 2 ? width * 2 : x
  }

  // The series is held flat out to both edges of the trace rather than starting
  // at the first sample's x: the first reading lands one interval in (100ms by
  // default), and a fill that begins a third of the way across the track reads
  // as a broken renderer rather than as "we had not sampled yet".
  const first = samples[0]!
  const last = samples[samples.length - 1]!
  const leftX = xOf(0)
  const rightX = xOf(traceEnd)

  ctx.beginPath()
  ctx.moveTo(leftX, bottom)
  ctx.lineTo(leftX, yOf(first.heapUsed))
  for (const sample of samples) ctx.lineTo(xOf(sample.time), yOf(sample.heapUsed))
  ctx.lineTo(rightX, yOf(last.heapUsed))
  ctx.lineTo(rightX, bottom)
  ctx.closePath()
  ctx.fillStyle = COLOR_FILL
  ctx.fill()
  ctx.strokeStyle = COLOR_CURVE
  ctx.lineWidth = 1
  ctx.stroke()

  // `rss` on its own scale, as a dimmer line with no fill: it is the secondary
  // series, and sharing the heap's axis would either flatten the heap (rss is
  // typically 10x larger) or run the rss line off the top of the band.
  if (rssPeak > 0) {
    // `rss` gets its own `[0, peak]` axis: it is the secondary series, read for
    // its level rather than its shape, and it has no trough worth anchoring to.
    const yRss = (bytes: number): number => bottom - (bytes / rssPeak) * scale - 2
    ctx.beginPath()
    ctx.moveTo(leftX, yRss(first.rss))
    for (const sample of samples) ctx.lineTo(xOf(sample.time), yRss(sample.rss))
    ctx.lineTo(rightX, yRss(last.rss))
    ctx.strokeStyle = COLOR_RSS
    ctx.setLineDash([2, 2])
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Baseline, so an empty stretch still reads as a track rather than a gap.
  ctx.strokeStyle = COLOR_BASE
  ctx.beginPath()
  ctx.moveTo(0, bottom - 0.5)
  ctx.lineTo(width, bottom - 0.5)
  ctx.stroke()

  // On an opaque chip: the curve runs under it, and a half-legible label is
  // worse than no label at all.
  const label = `− memory · heap ${formatBytes(floor)}–${formatBytes(peak)} · rss ${formatBytes(rssPeak)}`
  ctx.textAlign = 'left'
  ctx.fillStyle = COLOR_BG
  ctx.fillRect(0, top, ctx.measureText(label).width + 8, 13)
  ctx.fillStyle = COLOR_LABEL
  ctx.fillText(label, 4, top + 7)

  ctx.restore()
}
