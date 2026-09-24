/**
 * The bottom drawer's Event log tab: every span as a sortable, filterable row.
 *
 * Selection is **not** synced with the flame chart — it is the same value.
 * Both read and write `selectedSpanIdAtom`, so a click here moves the chart
 * and a click there scrolls this table, with no effect wiring in between and
 * nothing that can drift.
 *
 * Rows are windowed rather than all mounted: a 10k-span trace is 10k table
 * rows, which is exactly the DOM-node-per-span cost the chart exists to avoid.
 * Only the ~40 rows in the scroll window are real elements; the rest is two
 * spacer heights.
 */
import { useAtom, useAtomValue } from '@effect/atom-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { timings } from '../chart/metrics.ts'
import {
  filterAtom,
  filterHidesAtom,
  hoveredSpanIdAtom,
  matches,
  selectedSpanIdAtom,
} from '../chart/selection.ts'
import type { TraceSpan } from '../trace/TraceStore.ts'
import { traceStore, traceVersionAtom } from '../state/atoms.ts'
import { revealSpan } from './FlameChart.tsx'
import { formatDuration } from './format.ts'

const ROW_HEIGHT = 22
/** Rows rendered beyond the scroll window, so fast scrolling does not flash. */
const OVERSCAN = 8

/**
 * The shared table chrome, lifted from the registry's `records-table` and
 * `filter-table`: a sticky header on the panel surface, a strong rule under
 * it, hover and selection as background changes on the row.
 *
 * `primitive-table-cell` is deliberately *not* used — it is 10px/12px padding
 * for a roomy demo grid, and these rows are a fixed 22px so the virtualizer
 * can multiply by them. The tokens are the part worth sharing, not the metric.
 */
export const TABLE_HEAD = 'flex shrink-0 border-b border-line-strong bg-surface px-2 text-ink-3'

/** Header cell: quiet until hovered, full ink once it is the sort key. */
export const headCellClass = (active: boolean): string =>
  `py-1 text-left transition-colors hover:text-ink ${active ? 'text-ink' : ''}`

/** Selected row wash — `records-table`'s accent mix over the panel surface. */
const SELECTED = 'color-mix(in srgb, var(--accent) 10%, var(--surface))'

/**
 * Row background, in precedence order: selected, hovered, then the zebra
 * stripe. The stripe is foundation's `--stripe` over `--stripe-bg`, which is
 * what makes a dense numeric table scannable across its columns.
 */
export const rowBackground = (
  selected: boolean,
  hovered: boolean,
  even: boolean,
): string | undefined => {
  if (selected) return SELECTED
  if (hovered) return 'var(--hover)'
  return even ? undefined : 'var(--stripe)'
}

type SortKey = 'start' | 'self' | 'total' | 'name'

interface Row {
  readonly span: TraceSpan
  readonly self: number
  readonly total: number
  readonly matched: boolean
}

const COLUMNS: ReadonlyArray<{ readonly key: SortKey; readonly label: string }> = [
  { key: 'start', label: 'Start' },
  { key: 'self', label: 'Self' },
  { key: 'total', label: 'Total' },
  { key: 'name', label: 'Name' },
]

const compare = (key: SortKey, a: Row, b: Row): number => {
  if (key === 'name') return a.span.name.localeCompare(b.span.name)
  if (key === 'start') return a.span.start - b.span.start
  return a[key] - b[key]
}

export const EventLog = () => {
  // Recompute when spans arrive — the sampled version, so a burst of a
  // thousand spans rebuilds this table once, not a thousand times.
  const version = useAtomValue(traceVersionAtom)
  const filter = useAtomValue(filterAtom)
  const hides = useAtomValue(filterHidesAtom)
  const [selectedId, setSelectedId] = useAtom(selectedSpanIdAtom)
  const [hoveredId, setHoveredId] = useAtom(hoveredSpanIdAtom)
  const [sort, setSort] = useState<{ readonly key: SortKey; readonly desc: boolean }>({
    key: 'start',
    desc: false,
  })
  const [scrollTop, setScrollTop] = useState(0)
  const [viewHeight, setViewHeight] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    void version
    const now = traceStore.stats().duration
    const needle = filter.toLowerCase()
    const list: Array<Row> = []
    for (const span of traceStore.spans.values()) {
      const matched = matches(span.name, needle)
      if (hides && !matched) continue
      list.push({ span, matched, ...timings(traceStore, span, now) })
    }
    list.sort((a, b) => (sort.desc ? -1 : 1) * compare(sort.key, a, b))
    return list
  }, [version, filter, hides, sort])

  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => setViewHeight(entry?.contentRect.height ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Scroll a chart-made selection into view. Only when the selected span is
  // outside the window, so clicking a visible row does not jump the table.
  useEffect(() => {
    const element = scrollRef.current
    if (element === null || selectedId === undefined) return
    const index = rows.findIndex((row) => row.span.spanId === selectedId)
    if (index === -1) return
    const top = index * ROW_HEIGHT
    if (top < element.scrollTop || top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top - element.clientHeight / 2
    }
  }, [selectedId, rows])

  const first = Math.max(Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN, 0)
  const last = Math.min(Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN, rows.length)
  const visible = rows.slice(first, last)

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[11px]">
      <div className={TABLE_HEAD}>
        {COLUMNS.map((column) => (
          <button
            key={column.key}
            type="button"
            onClick={() =>
              setSort((current) =>
                current.key === column.key
                  ? { key: column.key, desc: !current.desc }
                  : { key: column.key, desc: column.key !== 'name' && column.key !== 'start' },
              )
            }
            className={`${headCellClass(sort.key === column.key)} ${
              column.key === 'name' ? 'flex-1 pl-3' : 'w-24 pr-3 text-right'
            }`}
          >
            {column.label}
            {sort.key === column.key && (sort.desc ? ' ↓' : ' ↑')}
          </button>
        ))}
      </div>

      <div
        ref={scrollRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {rows.length === 0 ? (
          <p className="px-3 py-2 text-ink-3">No spans match.</p>
        ) : (
          <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
            <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
              {visible.map((row, index) => {
                const id = row.span.spanId
                const failed = row.span.outcome?._tag === 'Failure'
                const selected = id === selectedId
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setSelectedId(id)
                      revealSpan(id)
                    }}
                    onMouseEnter={() => setHoveredId(id)}
                    onMouseLeave={() => setHoveredId(undefined)}
                    style={{
                      height: ROW_HEIGHT,
                      // The stripe has to key off the row's absolute index, not
                      // its index in the window — the window slides by one row
                      // at a time, so a local parity would invert on every
                      // scroll step.
                      background: rowBackground(
                        selected,
                        id === hoveredId,
                        (first + index) % 2 === 0,
                      ),
                    }}
                    className={`flex w-full items-center px-2 text-left tabular-nums transition-colors ${
                      selected ? 'text-ink' : ''
                    } ${row.matched ? 'text-ink-2' : 'text-ink-3'}`}
                  >
                    <span className="w-24 pr-3 text-right">{formatDuration(row.span.start)}</span>
                    <span className="w-24 pr-3 text-right">{formatDuration(row.self)}</span>
                    <span className="w-24 pr-3 text-right">{formatDuration(row.total)}</span>
                    <span className={`flex-1 truncate pl-3 ${failed ? 'text-red' : 'text-ink'}`}>
                      {row.span.name}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
