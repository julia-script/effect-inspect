/**
 * The flame chart's canvas renderer.
 *
 * Owns the whole per-frame data path: it reads {@link traceStore} and the
 * selection atoms directly and never goes through React. A frame is
 * unconditionally cheap — it draws only the spans intersecting the viewport,
 * found by binary search into a {@link Layout} that is rebuilt only when spans
 * actually arrive. Panning a 10k-span trace touches a few hundred spans.
 *
 * React's only involvement is mounting this and passing the registry; the
 * component tree does not re-render when the chart redraws.
 */
import type { AtomRegistry } from 'effect/unstable/reactivity/AtomRegistry'
import type { TraceSpan } from '../trace/TraceStore.ts'
import { traceStore } from '../state/atoms.ts'
import { emptyLayout, forEachVisible, type Layout, layout, spanEnd } from './Layout.ts'
import {
  filterAtom,
  filterHidesAtom,
  hoveredSpanIdAtom,
  matches,
  selectedSpanIdAtom,
} from './selection.ts'
import { clamp, isFull, pan, type Viewport, zoom } from './Viewport.ts'
import {
  drawMemoryTrack,
  formatBytes,
  MEMORY_LABEL_WIDTH,
  sampleAt,
  trackHeight,
} from './MemoryTrack.ts'
import { memoryCollapsedAtom } from './selection.ts'

/** Height of the whole-trace overview strip, in CSS pixels. */
const OVERVIEW_HEIGHT = 34
/** Height of the time ruler below the overview. */
const RULER_HEIGHT = 18
/** Height of one depth row. Tight, per the visual direction. */
const ROW_HEIGHT = 16
/** Gap between a bar and the row below it. */
const BAR_GAP = 1
/** Bars narrower than this are drawn but never labelled — the text would not fit. */
const MIN_LABEL_WIDTH = 26

/** Near-black background, panels a hair lighter. */
const COLOR_BG = '#0a0a0a'
const COLOR_PANEL = '#111111'
const COLOR_GRID = '#1c1c1c'
const COLOR_RULER_TEXT = '#525252'
const COLOR_LABEL = '#e5e5e5'
const COLOR_LABEL_DIM = '#737373'
/** Red is reserved for errors — nothing else in the chart is saturated. */
const COLOR_ERROR = '#7f1d1d'
const COLOR_ERROR_HOT = '#b91c1c'
const COLOR_SELECTED = '#fafafa'

/**
 * Bar fill by depth: brightness carries nesting weight, as the visual
 * direction asks, and the cycle is short so a deep trace stays legible.
 */
const DEPTH_FILL = ['#3f3f46', '#52525b', '#34343a', '#45454d', '#2e2e33']

export interface RendererCallbacks {
  /** Called when the viewport changes, so the chrome can show the window. */
  readonly onViewportChange?: (view: Viewport) => void
}

/** Where a pointer landed, in chart coordinates. */
interface Hit {
  readonly span: TraceSpan
  /** Screen-space x/y of the bar's top-left, for positioning a tooltip. */
  readonly x: number
  readonly y: number
  readonly width: number
}

export class FlameRenderer {
  private readonly ctx: CanvasRenderingContext2D
  private layout: Layout = emptyLayout()
  private view: Viewport = { from: 0, to: 1 }
  /** True while the viewport still covers the whole trace, so live data follows. */
  private following = true
  private scrollY = 0
  private width = 0
  private height = 0
  private dpr = 1
  private frame: number | undefined
  private dirty = true
  private lastVersion = -1
  private hover: Hit | undefined
  /** Last pointer x while the cursor is over the canvas — the keyboard zoom anchor. */
  private cursorX: number | undefined
  private drag: { readonly x: number; readonly view: Viewport } | undefined
  private overviewDrag: 'window' | 'edge' | undefined
  private overviewGrab = 0
  private readonly unsubscribes: Array<() => void> = []
  private readonly observer: ResizeObserver

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly registry: AtomRegistry,
    private readonly callbacks: RendererCallbacks = {},
  ) {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (ctx === null) throw new Error('2d canvas context unavailable')
    this.ctx = ctx

    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(canvas)
    this.resize()

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })

    // A selection or filter change repaints but does not rebuild layout.
    const repaint = (): void => this.invalidate()
    this.unsubscribes.push(
      registry.subscribe(selectedSpanIdAtom, repaint),
      registry.subscribe(hoveredSpanIdAtom, repaint),
      registry.subscribe(filterAtom, repaint),
      registry.subscribe(filterHidesAtom, repaint),
      registry.subscribe(memoryCollapsedAtom, repaint),
    )

    this.loop()
  }

  dispose(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    this.observer.disconnect()
    for (const off of this.unsubscribes) off()
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave)
    this.canvas.removeEventListener('wheel', this.onWheel)
  }

  /** Frames the whole trace and resumes following live data. */
  resetView(): void {
    this.following = true
    this.invalidate()
  }

  /** Scrolls the given span into view and centres the viewport on it. */
  revealSpan(spanId: string): void {
    const span = traceStore.spans.get(spanId)
    if (span === undefined) return
    const total = this.total()
    const end = spanEnd(span, total)
    const width = Math.max(this.view.to - this.view.from, (end - span.start) * 1.4, 0.01)
    const centre = (span.start + end) / 2
    this.following = false
    this.setView(clamp({ from: centre - width / 2, to: centre + width / 2 }, total))

    // Bring the span's row into the vertical window too, or "reveal" only
    // half-works on a deep trace. Rows are packed, so the row is the layout's
    // answer, not the span's depth.
    const top = (this.layout.rowOf.get(span.spanId) ?? span.depth) * ROW_HEIGHT
    const viewTop = this.chartTop()
    const visible = this.height - viewTop
    if (top < this.scrollY) this.scrollY = top
    else if (top + ROW_HEIGHT > this.scrollY + visible) {
      this.scrollY = top + ROW_HEIGHT - visible
    }
    this.invalidate()
  }

  /** The current time window — the overview strip and the ruler both read it. */
  viewport(): Viewport {
    return this.view
  }

  /**
   * Zooms by `factor` (>1 out) around the keyboard anchor — W/S.
   *
   * The anchor is the cursor while it is over the chart, else the selected
   * span's midpoint, else the window centre. That is Chrome's rule, and it is
   * what makes W/S usable without a mouse at all: with a span selected, zooming
   * keeps that span under the eye rather than drifting off screen.
   */
  zoomBy(factor: number): void {
    this.setView(zoom(this.view, this.keyboardAnchor(), factor, this.total()))
  }

  /** Pans by a fraction of the window width — A/D. */
  panBy(fraction: number): void {
    this.setView(pan(this.view, (this.view.to - this.view.from) * fraction, this.total()))
  }

  /** Scrolls the rows vertically by `delta` CSS pixels, clamped to the content. */
  scrollRows(delta: number): void {
    const rows = this.layout.rows.length * ROW_HEIGHT
    const visible = this.height - this.chartTop()
    this.scrollY = Math.max(0, Math.min(this.scrollY + delta, Math.max(rows - visible, 0)))
    this.invalidate()
  }

  /**
   * Where a keyboard zoom pivots. The pointer position is remembered on every
   * move and dropped on leave, so "cursor is over the chart" is a real test
   * rather than a guess.
   */
  private keyboardAnchor(): number {
    if (this.cursorX !== undefined) return this.xToTime(this.cursorX)
    const selected = this.registry.get(selectedSpanIdAtom)
    const span = selected === undefined ? undefined : traceStore.spans.get(selected)
    if (span !== undefined) return (span.start + spanEnd(span, this.total())) / 2
    return (this.view.from + this.view.to) / 2
  }

  /** The span the cursor is over, with its screen rect, for the tooltip. */
  hovered(): Hit | undefined {
    return this.hover
  }

  private invalidate(): void {
    this.dirty = true
  }

  private total(): number {
    return Math.max(this.layout.duration, 0.001)
  }

  /**
   * Height the memory track occupies right now.
   *
   * Zero when the session has no samples, so a trace recorded in a runtime
   * without `process.memoryUsage` gets no empty band — and zero when collapsed.
   */
  private memoryHeight(): number {
    return trackHeight(traceStore.memory, this.registry.get(memoryCollapsedAtom))
  }

  /**
   * Top of the bar area — below the overview, the ruler and the memory track.
   *
   * Everything vertical in this class routes through here: hit testing, row
   * scrolling, gridlines and `revealSpan`. So the memory track pushing the bars
   * down is one number, and nothing else has to know it moved.
   */
  private chartTop(): number {
    return OVERVIEW_HEIGHT + RULER_HEIGHT + this.memoryHeight()
  }

  private setView(next: Viewport): void {
    this.view = next
    this.following = isFull(next, this.total())
    this.callbacks.onViewportChange?.(next)
    this.invalidate()
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    this.dpr = Math.min(globalThis.devicePixelRatio || 1, 2)
    this.width = rect.width
    this.height = rect.height
    this.canvas.width = Math.round(rect.width * this.dpr)
    this.canvas.height = Math.round(rect.height * this.dpr)
    this.invalidate()
  }

  private loop = (): void => {
    this.frame = requestAnimationFrame(this.loop)
    // Rebuild the spatial index only when spans actually arrived; a pan or
    // zoom frame reuses it untouched, which is what keeps 10k spans smooth.
    if (traceStore.version !== this.lastVersion) {
      this.lastVersion = traceStore.version
      this.layout = layout(traceStore, this.layout)
      this.dirty = true
    }
    // Live mode: the window grows with the trace instead of freezing, but only
    // while the user has not zoomed in. Chrome does the same.
    if (this.following) {
      const total = this.total()
      if (this.view.from !== 0 || this.view.to !== total) {
        this.view = { from: 0, to: total }
        this.callbacks.onViewportChange?.(this.view)
        this.dirty = true
      }
    }
    if (!this.dirty) return
    this.dirty = false
    this.draw()
  }

  // ---------------------------------------------------------------- geometry

  private timeToX(time: number): number {
    return ((time - this.view.from) / (this.view.to - this.view.from)) * this.width
  }

  private xToTime(x: number): number {
    return this.view.from + (x / this.width) * (this.view.to - this.view.from)
  }

  private pointer(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  /**
   * Finds the span under a point.
   *
   * Sub-pixel spans are the reason this searches by time rather than by drawn
   * rect: at a wide zoom a span can be a fraction of a pixel, and testing
   * against its *rendered* width would make it unhittable. Instead the cursor
   * x is converted to a time and the row is searched for a span containing it,
   * with a small pixel-width tolerance so a zero-width span still has a
   * grabbable target.
   */
  private hitTest(x: number, y: number): Hit | undefined {
    const top = this.chartTop()
    if (y < top) return undefined
    const rowIndex = Math.floor((y - top + this.scrollY) / ROW_HEIGHT)
    const row = this.layout.rows[rowIndex]
    if (row === undefined) return undefined

    const total = this.total()
    const tolerance = ((this.view.to - this.view.from) / this.width) * 2
    const time = this.xToTime(x)
    let found: TraceSpan | undefined
    // Last match wins. Packed rows never overlap, so at most one span really
    // contains the cursor; the tolerance window is what can match twice, and
    // the later (rightward) span is the one the cursor is closer to.
    forEachVisible(row, time - tolerance, time + tolerance, total, (span) => {
      if (span.start - tolerance <= time && spanEnd(span, total) + tolerance >= time) found = span
    })
    if (found === undefined) return undefined

    const x0 = this.timeToX(found.start)
    const x1 = this.timeToX(spanEnd(found, total))
    return {
      span: found,
      x: x0,
      y: top + rowIndex * ROW_HEIGHT - this.scrollY,
      width: Math.max(x1 - x0, 1),
    }
  }

  // ---------------------------------------------------------------- pointers

  private onPointerDown = (event: PointerEvent): void => {
    const { x, y } = this.pointer(event)
    this.canvas.setPointerCapture(event.pointerId)

    if (y < OVERVIEW_HEIGHT) {
      const total = this.total()
      const left = (this.view.from / total) * this.width
      const right = (this.view.to / total) * this.width
      // Clicking inside the window drags it; clicking outside jumps to that
      // point, keeping the window width — same as Chrome's overview.
      if (x >= left && x <= right) {
        this.overviewDrag = 'window'
        this.overviewGrab = x - left
      } else {
        const width = this.view.to - this.view.from
        const centre = (x / this.width) * total
        this.overviewDrag = 'window'
        this.overviewGrab = ((width / total) * this.width) / 2
        this.setView(clamp({ from: centre - width / 2, to: centre + width / 2 }, total))
      }
      return
    }

    // The track's label is its own collapse toggle: the track is canvas, so a
    // DOM control for it would mean the chart's React tree owning a piece of
    // chart chrome it otherwise knows nothing about.
    const memoryHeight = this.memoryHeight()
    const memoryTop = OVERVIEW_HEIGHT + RULER_HEIGHT
    if (
      memoryHeight > 0 &&
      y >= memoryTop &&
      y < memoryTop + memoryHeight &&
      x < MEMORY_LABEL_WIDTH
    ) {
      this.registry.set(memoryCollapsedAtom, !this.registry.get(memoryCollapsedAtom))
      this.invalidate()
      return
    }

    const hit = this.hitTest(x, y)
    this.registry.set(selectedSpanIdAtom, hit?.span.spanId)
    this.drag = { x, view: this.view }
  }

  private onPointerMove = (event: PointerEvent): void => {
    const { x, y } = this.pointer(event)
    this.cursorX = x

    if (this.overviewDrag !== undefined) {
      const total = this.total()
      const width = this.view.to - this.view.from
      const from = ((x - this.overviewGrab) / this.width) * total
      this.setView(clamp({ from, to: from + width }, total))
      return
    }

    if (this.drag !== undefined) {
      const perPixel = (this.drag.view.to - this.drag.view.from) / this.width
      this.setView(pan(this.drag.view, (this.drag.x - x) * perPixel, this.total()))
      return
    }

    const hit = this.hitTest(x, y)
    if (hit?.span.spanId !== this.hover?.span.spanId) {
      this.registry.set(hoveredSpanIdAtom, hit?.span.spanId)
    }
    this.hover = hit
    this.canvas.style.cursor = hit === undefined ? 'default' : 'pointer'
    this.invalidate()
  }

  private onPointerUp = (event: PointerEvent): void => {
    this.canvas.releasePointerCapture(event.pointerId)
    this.drag = undefined
    this.overviewDrag = undefined
  }

  private onPointerLeave = (): void => {
    this.hover = undefined
    this.cursorX = undefined
    this.registry.set(hoveredSpanIdAtom, undefined)
    this.invalidate()
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const { x } = this.pointer(event)
    const total = this.total()

    // Wheel zooms around the cursor, which is what the spec asks for and what
    // Chrome's performance panel does. A trackpad pinch arrives as
    // ctrl+wheel, so it lands here too and zooms as well.
    // Alt scrolls the rows vertically; shift pans horizontally. Zoom is on the
    // bare gesture because it is the one used constantly.
    if (event.altKey) {
      this.scrollRows(event.deltaY)
      return
    }

    if (event.shiftKey) {
      const perPixel = (this.view.to - this.view.from) / this.width
      this.setView(pan(this.view, event.deltaY * perPixel, total))
      return
    }

    // A trackpad's horizontal component pans, so a two-finger sideways swipe
    // scrubs the timeline while the vertical component still zooms.
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      const perPixel = (this.view.to - this.view.from) / this.width
      this.setView(pan(this.view, event.deltaX * perPixel, total))
      return
    }

    const factor = Math.exp(event.deltaY * 0.002)
    this.setView(zoom(this.view, this.xToTime(x), factor, total))
  }

  // ----------------------------------------------------------------- drawing

  private draw(): void {
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.fillStyle = COLOR_BG
    ctx.fillRect(0, 0, this.width, this.height)
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'

    const filter = this.registry.get(filterAtom).toLowerCase()
    const hides = this.registry.get(filterHidesAtom)
    const selected = this.registry.get(selectedSpanIdAtom)

    this.drawOverview(filter)
    const ticks = this.drawRuler()
    this.drawMemory()
    this.drawBars(filter, hides, selected, ticks)
  }

  /** The whole-trace strip, with the viewport drawn as a window over it. */
  private drawOverview(filter: string): void {
    const ctx = this.ctx
    const total = this.total()
    ctx.fillStyle = COLOR_PANEL
    ctx.fillRect(0, 0, this.width, OVERVIEW_HEIGHT)

    // A miniature of the trace: every row squashed into the strip's height, so
    // the shape of the trace is recognisable at a glance. Sampled by pixel
    // column rather than per span — at 10k spans most bars are sub-pixel and
    // drawing each one would cost more than the whole chart.
    const rows = this.layout.rows.length
    if (rows > 0) {
      const rowHeight = Math.max((OVERVIEW_HEIGHT - 4) / rows, 0.5)
      for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
        const row = this.layout.rows[rowIndex]!
        const y = 2 + rowIndex * rowHeight
        for (const span of row.spans) {
          const x0 = (span.start / total) * this.width
          const x1 = (spanEnd(span, total) / total) * this.width
          if (filter !== '' && !matches(span.name, filter)) continue
          ctx.fillStyle = DEPTH_FILL[span.depth % DEPTH_FILL.length]!
          ctx.fillRect(x0, y, Math.max(x1 - x0, 0.5), Math.max(rowHeight - 0.5, 0.5))
        }
      }
    }

    const left = (this.view.from / total) * this.width
    const right = (this.view.to / total) * this.width
    ctx.fillStyle = 'rgba(10,10,10,0.72)'
    ctx.fillRect(0, 0, left, OVERVIEW_HEIGHT)
    ctx.fillRect(right, 0, this.width - right, OVERVIEW_HEIGHT)
    ctx.strokeStyle = '#525252'
    ctx.lineWidth = 1
    ctx.strokeRect(left + 0.5, 0.5, Math.max(right - left - 1, 1), OVERVIEW_HEIGHT - 1)
  }

  /** The time ruler; returns the tick times so the gridlines can reuse them. */
  private drawRuler(): Array<number> {
    const ctx = this.ctx
    const y = OVERVIEW_HEIGHT
    ctx.fillStyle = COLOR_BG
    ctx.fillRect(0, y, this.width, RULER_HEIGHT)

    const ticks = tickTimes(this.view.from, this.view.to, this.width)
    ctx.fillStyle = COLOR_RULER_TEXT
    ctx.textAlign = 'left'
    for (const time of ticks) {
      const x = this.timeToX(time)
      ctx.fillText(formatTick(time, ticks), x + 3, y + RULER_HEIGHT / 2)
    }
    ctx.strokeStyle = COLOR_GRID
    ctx.beginPath()
    ctx.moveTo(0, y + RULER_HEIGHT - 0.5)
    ctx.lineTo(this.width, y + RULER_HEIGHT - 0.5)
    ctx.stroke()
    return ticks
  }

  /**
   * The memory track, drawn with this renderer's own `timeToX`.
   *
   * Sharing the coordinate function rather than the numbers is what makes the
   * track x-aligned with the bars at every zoom level: there is no second
   * viewport to keep in sync, so there is nothing to drift.
   */
  private drawMemory(): void {
    const height = this.memoryHeight()
    if (height === 0) return
    const top = OVERVIEW_HEIGHT + RULER_HEIGHT
    // `cursorX` is the pointer position the renderer already tracks for the
    // keyboard zoom anchor; reusing it means the readout follows the cursor
    // with no second piece of pointer state to keep in sync.
    const cursorTime = this.cursorX === undefined ? undefined : this.xToTime(this.cursorX)

    const collapsed = this.registry.get(memoryCollapsedAtom)
    drawMemoryTrack({
      ctx: this.ctx,
      samples: traceStore.memory,
      collapsed,
      top,
      height,
      width: this.width,
      timeToX: (time) => this.timeToX(time),
      peak: traceStore.memoryPeak,
      trough: traceStore.memoryTrough,
      rssPeak: traceStore.memoryRssPeak,
      traceEnd: this.total(),
      cursorTime,
    })

    // Readout at the cursor: the value at that instant, drawn on the canvas
    // rather than in the DOM tooltip, so the track owns its whole surface and
    // does not need the flame chart's React tree to know it exists.
    if (collapsed || cursorTime === undefined) return
    const sample = sampleAt(traceStore.memory, cursorTime)
    if (sample === undefined) return
    const ctx = this.ctx
    ctx.save()
    const x = Math.round(this.timeToX(sample.time)) + 0.5
    ctx.strokeStyle = '#737373'
    ctx.beginPath()
    ctx.moveTo(x, top)
    ctx.lineTo(x, top + height)
    ctx.stroke()

    const label = `heap ${formatBytes(sample.heapUsed)} · rss ${formatBytes(sample.rss)}`
    ctx.textAlign = 'left'
    const textWidth = ctx.measureText(label).width
    // Flip left of the cursor near the right edge, so the readout never runs
    // off the canvas on the last few percent of a trace.
    const labelX = x + 6 + textWidth > this.width ? x - 6 - textWidth : x + 6
    ctx.fillStyle = 'rgba(10,10,10,0.85)'
    ctx.fillRect(labelX - 3, top + height - 16, textWidth + 6, 12)
    ctx.fillStyle = '#d4d4d4'
    ctx.fillText(label, labelX, top + height - 10)
    ctx.restore()
  }

  private drawBars(
    filter: string,
    hides: boolean,
    selected: string | undefined,
    ticks: ReadonlyArray<number>,
  ): void {
    const ctx = this.ctx
    const top = this.chartTop()
    const total = this.total()
    const hovered = this.hover?.span.spanId

    ctx.save()
    ctx.beginPath()
    ctx.rect(0, top, this.width, this.height - top)
    ctx.clip()

    // Faint full-height gridlines, aligned to the ruler's ticks.
    ctx.strokeStyle = COLOR_GRID
    ctx.beginPath()
    for (const time of ticks) {
      const x = Math.round(this.timeToX(time)) + 0.5
      ctx.moveTo(x, top)
      ctx.lineTo(x, this.height)
    }
    ctx.stroke()

    const firstRow = Math.max(Math.floor(this.scrollY / ROW_HEIGHT), 0)
    const lastRow = Math.min(
      Math.ceil((this.scrollY + this.height - top) / ROW_HEIGHT),
      this.layout.rows.length - 1,
    )

    ctx.textAlign = 'left'
    for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex++) {
      const row = this.layout.rows[rowIndex]
      if (row === undefined) continue
      const y = top + rowIndex * ROW_HEIGHT - this.scrollY

      forEachVisible(row, this.view.from, this.view.to, total, (span) => {
        const matched = matches(span.name, filter)
        if (hides && !matched) return

        const x0 = this.timeToX(span.start)
        // Sub-pixel spans still get a 1px bar: at 10k spans most bars are
        // narrower than a pixel and dropping them would erase the trace.
        const width = Math.max(this.timeToX(spanEnd(span, total)) - x0, 1)
        const failed = span.outcome?._tag === 'Failure'
        const hot = span.spanId === hovered

        ctx.globalAlpha = matched ? 1 : 0.22
        if (failed) ctx.fillStyle = hot ? COLOR_ERROR_HOT : COLOR_ERROR
        // Brightness carries *nesting* weight, so the fill keys on the span's
        // depth, not on the packed row it happened to land in.
        else ctx.fillStyle = hot ? COLOR_LABEL_DIM : DEPTH_FILL[span.depth % DEPTH_FILL.length]!
        ctx.fillRect(x0, y, width, ROW_HEIGHT - BAR_GAP)

        if (span.spanId === selected) {
          ctx.strokeStyle = COLOR_SELECTED
          ctx.lineWidth = 1
          ctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(width - 1, 1), ROW_HEIGHT - BAR_GAP - 1)
        }

        if (width >= MIN_LABEL_WIDTH) {
          ctx.save()
          ctx.beginPath()
          ctx.rect(x0, y, width - 3, ROW_HEIGHT - BAR_GAP)
          ctx.clip()
          ctx.fillStyle = matched ? COLOR_LABEL : COLOR_LABEL_DIM
          ctx.fillText(span.name, x0 + 3, y + (ROW_HEIGHT - BAR_GAP) / 2)
          ctx.restore()
        }
      })
      ctx.globalAlpha = 1
    }
    ctx.restore()
  }
}

/**
 * Chooses ruler tick times for a window, at a 1/2/5 step.
 *
 * Exported for testing — it is the only non-obvious arithmetic in the chart
 * and a wrong step makes the ruler lie at some zoom levels.
 */
/** Rounds a normalized (1..10) step up to the nearest 1/2/5/10. */
const niceStep = (normalized: number): number => {
  if (normalized > 5) return 10
  if (normalized > 2) return 5
  if (normalized > 1) return 2
  return 1
}

/** Decimal places that keep two ticks `step` apart visually distinct. */
const tickDecimals = (step: number): number => {
  if (step >= 10) return 0
  if (step >= 1) return 1
  if (step >= 0.1) return 2
  return 3
}

export const tickTimes = (from: number, to: number, width: number): Array<number> => {
  const target = Math.max(Math.floor(width / 90), 1)
  const rough = (to - from) / target
  if (!Number.isFinite(rough) || rough <= 0) return [from]
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  const step = niceStep(normalized) * magnitude
  const ticks: Array<number> = []
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) ticks.push(t)
  return ticks.length === 0 ? [from] : ticks
}

/** Formats a tick, with enough decimals to keep adjacent ticks distinct. */
export const formatTick = (time: number, ticks: ReadonlyArray<number>): string => {
  const step = ticks.length > 1 ? Math.abs(ticks[1]! - ticks[0]!) : Math.abs(time) || 1
  if (step >= 1000) return `${(time / 1000).toFixed(time % 1000 === 0 ? 0 : 1)}s`
  return `${time.toFixed(tickDecimals(step))}ms`
}
