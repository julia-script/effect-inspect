/**
 * The drawer's Summary, Bottom-up and Call tree tabs.
 *
 * All three read one {@link Aggregation}, built by `aggregate.ts`, so they
 * cannot disagree about a number. They are in one file because they are one
 * feature: a shared hook, a shared row chrome, and three ~30-line bodies.
 *
 * Selection is the *existing* model — `selectedSpanIdAtom` plus `revealSpan`,
 * exactly what the Event log uses. A row selects a representative span of its
 * group, which is what Chrome does when you click an aggregated row.
 */
import { useAtom, useAtomValue } from '@effect/atom-react'
import { useEffect, useMemo, useState } from 'react'
import { aggregate, type Aggregation, type SummaryRow, type TreeNode } from '../chart/aggregate.ts'
import { filterAtom, filterHidesAtom, matches, selectedSpanIdAtom } from '../chart/selection.ts'
import { traceStore, traceVersionAtom } from '../state/atoms.ts'
import { headCellClass, rowBackground, TABLE_HEAD } from './EventLog.tsx'
import { chartViewport } from './FlameChart.tsx'
import { formatDuration } from './format.ts'

/** How often the drawer samples the chart's viewport. Not a frame — a gesture. */
const VIEWPORT_POLL_MS = 150

/**
 * The chart's time window, sampled rather than subscribed.
 *
 * The viewport moves once per pan frame; aggregating 13k spans at that rate
 * would put the drawer in the chart's frame budget, which the task forbids. So
 * this polls on a coarse timer and only re-renders when the window actually
 * moved — a drag produces a handful of rebuilds, not one per frame.
 */
const useViewport = (): { readonly from: number; readonly to: number } => {
  const [view, setView] = useState(() => chartViewport() ?? { from: -Infinity, to: Infinity })
  useEffect(() => {
    const id = setInterval(() => {
      const next = chartViewport()
      if (next === undefined) return
      setView((current) => (current.from === next.from && current.to === next.to ? current : next))
    }, VIEWPORT_POLL_MS)
    return () => clearInterval(id)
  }, [])
  return view
}

/**
 * The aggregation for the current viewport, filter and trace version.
 *
 * Memoised on exactly those four inputs, so a repaint, a hover or a selection
 * change costs nothing and only real data or real navigation rebuilds it.
 */
const useAggregation = (): Aggregation => {
  const version = useAtomValue(traceVersionAtom)
  const filter = useAtomValue(filterAtom)
  const hides = useAtomValue(filterHidesAtom)
  const view = useViewport()
  return useMemo(
    () => aggregate(traceStore, view.from, view.to, filter, hides),
    [version, view.from, view.to, filter, hides],
  )
}

const Empty = () => <p className="px-3 py-2 text-[11px] text-ink-3">No spans in view.</p>

/** Right-aligned numeric cell, the same width in all three tabs. */
const Cell = ({ children }: { readonly children: React.ReactNode }) => (
  <span className="w-20 shrink-0 pr-3 text-right tabular-nums">{children}</span>
)

/** The Event log's header, plus the row padding the trees want. */
const HEAD = `${TABLE_HEAD} py-1 text-[11px]`
const SCROLL = 'min-h-0 flex-1 overflow-y-auto text-[11px]'

/**
 * Row chrome, shared with the Event log so the four tabs read as one table.
 *
 * These rows are not virtualized — the tree is small and already collapsed —
 * so unlike the Event log the zebra can key off the DOM with `even:`, and
 * hovering is a CSS state rather than the atom the chart also listens to.
 */
const rowClass = (selected: boolean, dimmed: boolean): string =>
  `flex w-full items-center px-2 text-left tabular-nums transition-colors odd:bg-[var(--stripe)] hover:bg-[var(--hover)] ${
    selected ? 'text-ink' : ''
  } ${dimmed ? 'text-ink-3' : 'text-ink-2'}`

/** Selected rows take the Event log's wash, which must beat the zebra. */
const rowStyle = (selected: boolean): React.CSSProperties =>
  selected ? { background: rowBackground(true, false, false) } : {}

type SummarySort = 'self' | 'total' | 'count' | 'average' | 'name'

export const Summary = () => {
  const { summary } = useAggregation()
  const filter = useAtomValue(filterAtom)
  const [selectedId, setSelectedId] = useAtom(selectedSpanIdAtom)
  const [sort, setSort] = useState<{ readonly key: SummarySort; readonly desc: boolean }>({
    key: 'self',
    desc: true,
  })

  const rows = useMemo(() => {
    const compare = (a: SummaryRow, b: SummaryRow): number =>
      sort.key === 'name' ? a.name.localeCompare(b.name) : a[sort.key] - b[sort.key]
    return [...summary].sort((a, b) => (sort.desc ? -1 : 1) * compare(a, b))
  }, [summary, sort])

  if (rows.length === 0) return <Empty />

  const columns = [
    { key: 'count', label: 'Count' },
    { key: 'total', label: 'Total' },
    { key: 'self', label: 'Self' },
    { key: 'average', label: 'Avg' },
    { key: 'name', label: 'Name' },
  ] as const

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={HEAD}>
        {columns.map((column) => (
          <button
            key={column.key}
            type="button"
            onClick={() =>
              setSort((current) =>
                current.key === column.key
                  ? { key: column.key, desc: !current.desc }
                  : { key: column.key, desc: column.key !== 'name' },
              )
            }
            className={`${headCellClass(sort.key === column.key)} py-0 ${
              column.key === 'name' ? 'flex-1 pl-3' : 'w-20 pr-3 text-right'
            }`}
          >
            {column.label}
            {sort.key === column.key && (sort.desc ? ' ↓' : ' ↑')}
          </button>
        ))}
      </div>
      <div className={SCROLL}>
        {rows.map((row) => (
          <button
            key={row.name}
            type="button"
            onClick={() => setSelectedId(row.spanId)}
            className={rowClass(
              row.spanId === selectedId,
              !matches(row.name, filter.toLowerCase()),
            )}
            style={{ height: 22, ...rowStyle(row.spanId === selectedId) }}
          >
            <Cell>{row.count}</Cell>
            <Cell>{formatDuration(row.total)}</Cell>
            <Cell>{formatDuration(row.self)}</Cell>
            <Cell>{formatDuration(row.average)}</Cell>
            <span className={`flex-1 truncate pl-3 ${row.failed ? 'text-red' : ''}`}>
              {row.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * One node of either tree, plus its expanded descendants.
 *
 * Expansion state is a set of node ids held by the tree, not per-node state:
 * the tree is rebuilt whenever the viewport or the trace moves, so a node
 * component cannot hold anything across a rebuild. Node ids are name paths,
 * which survive a rebuild as long as the path still exists.
 */
/** Disclosure marker: nothing for a leaf, a caret for a node. */
const marker = (hasChildren: boolean, open: boolean): string => {
  if (!hasChildren) return ''
  return open ? '▾' : '▸'
}

const Row = ({
  node,
  depth,
  expanded,
  onToggle,
}: {
  readonly node: TreeNode
  readonly depth: number
  readonly expanded: ReadonlySet<string>
  readonly onToggle: (id: string) => void
}) => {
  const [selectedId, setSelectedId] = useAtom(selectedSpanIdAtom)
  const filter = useAtomValue(filterAtom)
  const open = expanded.has(node.id)
  const hasChildren = node.children.length > 0

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setSelectedId(node.spanId)
          if (hasChildren) onToggle(node.id)
        }}
        className={rowClass(node.spanId === selectedId, !matches(node.name, filter.toLowerCase()))}
        style={{ height: 22, ...rowStyle(node.spanId === selectedId) }}
      >
        <Cell>{node.count}</Cell>
        <Cell>{formatDuration(node.total)}</Cell>
        <Cell>{formatDuration(node.self)}</Cell>
        <span
          className={`flex-1 truncate pl-3 ${node.failed ? 'text-red' : ''}`}
          style={{ paddingLeft: depth * 12 + 12 }}
        >
          <span className="inline-block w-3 text-ink-3">{marker(hasChildren, open)}</span>
          {node.name}
        </span>
      </button>
      {open &&
        node.children.map((child) => (
          <Row
            key={child.id}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
          />
        ))}
    </>
  )
}

/** Shared body for the two trees; only the roots and the header differ. */
const Tree = ({
  roots,
  selfLabel,
}: {
  readonly roots: ReadonlyArray<TreeNode>
  readonly selfLabel: string
}) => {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })

  if (roots.length === 0) return <Empty />

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={HEAD}>
        <span className="w-20 pr-3 text-right">Count</span>
        <span className="w-20 pr-3 text-right">Total</span>
        <span className="w-20 pr-3 text-right">{selfLabel}</span>
        <span className="flex-1 pl-3">Name</span>
      </div>
      <div className={SCROLL}>
        {roots.map((node) => (
          <Row key={node.id} node={node} depth={0} expanded={expanded} onToggle={toggle} />
        ))}
      </div>
    </div>
  )
}

/** Root-first: expand a node to see what it called. */
export const CallTree = () => <Tree roots={useAggregation().callTree} selfLabel="Self" />

/** Leaf-first: expand a name to see who called it. */
export const BottomUp = () => <Tree roots={useAggregation().bottomUp} selfLabel="Self" />
