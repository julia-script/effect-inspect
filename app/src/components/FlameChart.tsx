/**
 * The canvas flame chart, plus the DOM chrome that floats over it.
 *
 * The canvas itself is owned entirely by {@link FlameRenderer}; this component
 * mounts it, hands it the atom registry, and otherwise does not re-render when
 * the chart repaints. The only DOM here is the hover tooltip and the toolbar,
 * both of which are cheap and genuinely better as DOM than as canvas text.
 */
import { RegistryContext, useAtom, useAtomValue } from '@effect/atom-react'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { FlameRenderer } from '../chart/Renderer.ts'
import { Shortcuts } from './Shortcuts.tsx'
import { Button } from './atoms/Button.tsx'
import { useKeyboard } from './useKeyboard.ts'
import type { Viewport } from '../chart/Viewport.ts'
import { filterAtom, filterHidesAtom, hoveredSpanIdAtom } from '../chart/selection.ts'
import { timings } from '../chart/metrics.ts'
import { traceStore } from '../state/atoms.ts'
import { formatDuration, formatValue } from './format.ts'

/**
 * Floating hover tooltip.
 *
 * Reads the hovered span **id** from the shared selection model and resolves
 * it against the store, so it cannot show a stale span; position comes from
 * the renderer, which is the only thing that knows where the bar landed.
 */
const Tooltip = ({
  renderer,
  containerWidth,
}: {
  readonly renderer: FlameRenderer | undefined
  readonly containerWidth: number
}) => {
  const hoveredId = useAtomValue(hoveredSpanIdAtom)
  if (renderer === undefined || hoveredId === undefined) return null
  const hit = renderer.hovered()
  if (hit === undefined || hit.span.spanId !== hoveredId) return null

  const span = hit.span
  const { total, self } = timings(traceStore, span, traceStore.stats().duration)
  const attributes = Object.entries(span.attributes).slice(0, 6)

  // Flip to the left of the cursor when a right-edge bar would overflow.
  const left = Math.min(Math.max(hit.x, 4), Math.max(containerWidth - 264, 4))

  return (
    <div
      className="pointer-events-none absolute z-10 w-64 rounded-card border border-[var(--tooltip-border)] bg-[var(--tooltip-bg)] p-2 text-[11px] text-[var(--tooltip-fg)] shadow-overlay"
      style={{ left, top: hit.y + 20 }}
    >
      <div className="truncate">{span.name}</div>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[var(--tooltip-muted)]">
        <dt>total</dt>
        <dd className="text-right tabular-nums text-[var(--tooltip-fg)]">
          {formatDuration(total)}
        </dd>
        <dt>self</dt>
        <dd className="text-right tabular-nums text-[var(--tooltip-fg)]">{formatDuration(self)}</dd>
        <dt>start</dt>
        <dd className="text-right tabular-nums text-[var(--tooltip-fg)]">
          {formatDuration(span.start)}
        </dd>
      </dl>
      {span.outcome?._tag === 'Failure' && (
        <p className="mt-1.5 line-clamp-3 border-t border-[var(--tooltip-border)] pt-1.5 text-red">
          {span.outcome.error}
        </p>
      )}
      {attributes.length > 0 && (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t border-[var(--tooltip-border)] pt-1.5 text-[var(--tooltip-muted)]">
          {attributes.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="truncate">{key}</dt>
              <dd className="truncate text-right text-[var(--tooltip-fg)]">{formatValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

/** Filter box and view controls; writes the shared filter atoms. */
const Toolbar = ({
  onReset,
  onShowHelp,
}: {
  readonly onReset: () => void
  readonly onShowHelp: () => void
}) => {
  const [filter, setFilter] = useAtom(filterAtom)
  const [hides, setHides] = useAtom(filterHidesAtom)

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-surface px-2">
      <input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter spans…"
        aria-label="Filter spans"
        className="h-6 w-56 rounded-control bg-field px-2 text-xs text-ink shadow-hairline placeholder:text-ink-3"
      />
      <label className="flex items-center gap-1.5 text-[11px] text-ink-2">
        <input
          type="checkbox"
          checked={hides}
          onChange={(event) => setHides(event.target.checked)}
          className="accent-accent"
        />
        hide non-matching
      </label>
      <Button variant="quiet" size="xs" onClick={onReset} className="ml-auto text-ink-2">
        reset zoom
      </Button>
      <Button
        variant="quiet"
        size="xs"
        onClick={onShowHelp}
        aria-label="Keyboard shortcuts"
        className="text-ink-2"
      >
        ? keys
      </Button>
      <span className="text-[11px] text-ink-3">drag to pan · wheel to zoom · W/A/S/D</span>
    </div>
  )
}

export const FlameChart = () => {
  const registry = useContext(RegistryContext)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // The renderer instance is React state only so the tooltip can call
  // `hovered()` on it; the chart's draw path never reads React.
  const [renderer, setRenderer] = useState<FlameRenderer>()
  const [width, setWidth] = useState(0)
  const [helpOpen, setHelpOpen] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const instance = new FlameRenderer(canvas, registry)
    setRenderer(instance)
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0))
    if (containerRef.current !== null) observer.observe(containerRef.current)
    return () => {
      observer.disconnect()
      instance.dispose()
      setRenderer(undefined)
    }
  }, [registry])

  // Exposed so the event log can centre the chart on a row it selects. A
  // module-level handle rather than context: only one chart exists, and
  // threading a ref through the drawer would be more plumbing than value.
  //
  // It is also mirrored onto `globalThis` in dev, because a canvas has no DOM
  // for a browser test to assert against — reading `viewport()` is the only
  // way an end-to-end run can prove that a wheel or an overview drag actually
  // moved the window rather than merely repainting.
  useEffect(() => {
    activeRenderer = renderer
    if (import.meta.env.DEV) {
      ;(
        globalThis as {
          __flameChart?: FlameRenderer | undefined
          __traceStore?: typeof traceStore | undefined
        }
      ).__flameChart = renderer
      ;(globalThis as { __traceStore?: typeof traceStore | undefined }).__traceStore = traceStore
    }
    return () => {
      if (activeRenderer === renderer) activeRenderer = undefined
    }
  }, [renderer])

  // `useCallback` because the key hook takes it as a dependency; an inline
  // arrow would re-bind the listener on every render.
  const showHelp = useCallback(() => setHelpOpen(true), [])
  const closeHelp = useCallback(() => setHelpOpen(false), [])
  useKeyboard(showHelp, closeHelp, helpOpen)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar onReset={() => renderer?.resetView()} onShowHelp={showHelp} />
      <div ref={containerRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0 size-full touch-none" />
        <Tooltip renderer={renderer} containerWidth={width} />
        {helpOpen && <Shortcuts onClose={closeHelp} />}
      </div>
    </div>
  )
}

/** The mounted chart, if any — see the comment at its assignment. */
let activeRenderer: FlameRenderer | undefined

/** Centres the chart on a span. No-op when the chart is not mounted. */
export const revealSpan = (spanId: string): void => activeRenderer?.revealSpan(spanId)

/**
 * The mounted renderer, for the keyboard bindings.
 *
 * Same module-level handle `revealSpan` already uses, exposed because the key
 * handler needs several of the renderer's transitions rather than one, and
 * wrapping each in its own free function would be five of these.
 */
export const activeChart = (): FlameRenderer | undefined => activeRenderer

/**
 * The chart's current time window, or `undefined` when no chart is mounted.
 *
 * Read by the drawer's aggregation tabs, which follow the visible range the
 * way Chrome does. They **poll** this on a settle timer rather than being
 * pushed every viewport change: the viewport moves once per pan frame and
 * aggregating 13k spans at that rate would stutter, so the drawer samples a
 * settled window instead of subscribing to a moving one.
 */
export const chartViewport = (): Viewport | undefined => activeRenderer?.viewport()
