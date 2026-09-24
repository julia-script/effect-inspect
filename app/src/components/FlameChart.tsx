/**
 * The canvas flame chart, plus the DOM chrome that floats over it.
 *
 * The canvas itself is owned entirely by {@link FlameRenderer}; this component
 * mounts it, hands it the atom registry, and otherwise does not re-render when
 * the chart repaints. The only DOM here is the hover tooltip and the toolbar,
 * both of which are cheap and genuinely better as DOM than as canvas text.
 */
import { RegistryContext, useAtom, useAtomValue } from '@effect/atom-react'
import { useContext, useEffect, useRef, useState } from 'react'
import { FlameRenderer } from '../chart/Renderer.ts'
import { filterAtom, filterHidesAtom, hoveredSpanIdAtom } from '../chart/selection.ts'
import { spanEnd } from '../chart/Layout.ts'
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
  const now = traceStore.stats().duration
  const total = spanEnd(span, now) - span.start
  const childTime = span.children.reduce((sum, id) => {
    const child = traceStore.spans.get(id)
    if (child === undefined) return sum
    return sum + (spanEnd(child, now) - child.start)
  }, 0)
  const attributes = Object.entries(span.attributes).slice(0, 6)

  // Flip to the left of the cursor when a right-edge bar would overflow.
  const left = Math.min(Math.max(hit.x, 4), Math.max(containerWidth - 264, 4))

  return (
    <div
      className="pointer-events-none absolute z-10 w-64 rounded border border-neutral-800 bg-neutral-950/95 p-2 text-[11px] shadow-lg"
      style={{ left, top: hit.y + 20 }}
    >
      <div className="truncate text-neutral-200">{span.name}</div>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-neutral-500">
        <dt>total</dt>
        <dd className="text-right tabular-nums text-neutral-300">{formatDuration(total)}</dd>
        <dt>self</dt>
        <dd className="text-right tabular-nums text-neutral-300">
          {formatDuration(Math.max(total - childTime, 0))}
        </dd>
        <dt>start</dt>
        <dd className="text-right tabular-nums text-neutral-400">{formatDuration(span.start)}</dd>
      </dl>
      {span.outcome?._tag === 'Failure' && (
        <p className="mt-1.5 line-clamp-3 border-t border-neutral-800 pt-1.5 text-red-400">
          {span.outcome.error}
        </p>
      )}
      {attributes.length > 0 && (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t border-neutral-800 pt-1.5 text-neutral-600">
          {attributes.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="truncate">{key}</dt>
              <dd className="truncate text-right text-neutral-400">{formatValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

/** Filter box and view controls; writes the shared filter atoms. */
const Toolbar = ({ onReset }: { readonly onReset: () => void }) => {
  const [filter, setFilter] = useAtom(filterAtom)
  const [hides, setHides] = useAtom(filterHidesAtom)

  return (
    <div className="flex items-center gap-2 border-b border-neutral-900 px-3 py-1.5">
      <input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter spans…"
        aria-label="Filter spans"
        className="w-56 rounded-sm border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
      />
      <label className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <input
          type="checkbox"
          checked={hides}
          onChange={(event) => setHides(event.target.checked)}
          className="accent-neutral-500"
        />
        hide non-matching
      </label>
      <button
        type="button"
        onClick={onReset}
        className="ml-auto rounded-sm px-2 py-1 text-[11px] text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
      >
        reset zoom
      </button>
      <span className="text-[11px] text-neutral-700">
        drag to pan · wheel to zoom · alt-wheel to scroll rows
      </span>
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar onReset={() => renderer?.resetView()} />
      <div ref={containerRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0 size-full touch-none" />
        <Tooltip renderer={renderer} containerWidth={width} />
      </div>
    </div>
  )
}

/** The mounted chart, if any — see the comment at its assignment. */
let activeRenderer: FlameRenderer | undefined

/** Centres the chart on a span. No-op when the chart is not mounted. */
export const revealSpan = (spanId: string): void => activeRenderer?.revealSpan(spanId)
