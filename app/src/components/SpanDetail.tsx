/**
 * Detail panel for the selected span — the full record the tooltip truncates.
 *
 * Reads the shared `selectedSpanIdAtom` and resolves the id against the store
 * on each render, so a re-depthed or newly-ended span shows its current state
 * rather than a snapshot taken at click time.
 */
import { useAtom, useAtomValue } from '@effect/atom-react'
import type { CSSProperties } from 'react'
import { timings } from '../chart/metrics.ts'
import { selectedSpanIdAtom } from '../chart/selection.ts'
import { traceStore, traceVersionAtom } from '../state/atoms.ts'
import { Button } from './atoms/Button.tsx'
import { formatDuration, formatValue } from './format.ts'

const Field = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <>
    <dt className="truncate text-ink-3">{label}</dt>
    <dd className="truncate text-right tabular-nums text-ink">{value}</dd>
  </>
)

/** The panel's own chrome, matching the sidebar and drawer it sits beside. */
const PANEL = 'w-72 shrink-0 border-l border-line bg-surface text-[11px]'

/** Section rule, so every block in the panel divides the same way. */
const SECTION = 'border-b border-line p-3'

/** Small uppercase section label — the panel's only non-data type. */
const LABEL = 'mb-1.5 text-[10px] uppercase tracking-wider text-ink-3'

/**
 * The failure block's red wash, as a flat `background-image` over the panel's
 * opaque `bg-surface`.
 *
 * Foundation's `-tint` tokens are translucent in dark (`… / 0.14`), so using
 * one as a `background-color` here would let the chart behind the panel read
 * through in dark only. Same fix, same reason, as `tintWash` in `TraceFile`.
 */
const redWash: CSSProperties = {
  backgroundImage: 'linear-gradient(var(--red-tint), var(--red-tint))',
}

export const SpanDetail = () => {
  const [selectedId, setSelectedId] = useAtom(selectedSpanIdAtom)
  // The selected span mutates in place as its SpanEnd and events arrive, so
  // this panel must repaint on the sampled trace version, not only on click.
  useAtomValue(traceVersionAtom)

  if (selectedId === undefined) {
    return <aside className={`${PANEL} p-3 text-ink-3`}>Select a span.</aside>
  }

  const span = traceStore.spans.get(selectedId)
  if (span === undefined) {
    return <aside className={`${PANEL} p-3 text-ink-3`}>That span is no longer in the trace.</aside>
  }

  const now = traceStore.stats().duration
  const { total, self } = timings(traceStore, span, now)
  const attributes = Object.entries(span.attributes)
  const logs = traceStore.logs.filter((log) => log.spanId === span.spanId)

  return (
    <aside className={`flex flex-col overflow-y-auto ${PANEL}`}>
      <div className={`flex items-start justify-between gap-2 ${SECTION}`}>
        <div className="min-w-0">
          <p className="break-words text-ink">{span.name}</p>
          <p className="mt-0.5 text-ink-3">{span.kind}</p>
        </div>
        <Button
          type="button"
          variant="quiet"
          size="xs"
          onClick={() => setSelectedId(undefined)}
          aria-label="Clear selection"
          className="-mt-1 -mr-1 shrink-0 px-1.5 text-ink-3 hover:text-ink"
        >
          ✕
        </Button>
      </div>

      <dl className={`grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 ${SECTION}`}>
        <Field label="start" value={formatDuration(span.start)} />
        <Field label="total" value={formatDuration(total)} />
        <Field label="self" value={formatDuration(self)} />
        <Field label="depth" value={String(span.depth)} />
        <Field label="children" value={String(span.children.length)} />
        {span.fiberId !== undefined && <Field label="fiber" value={String(span.fiberId)} />}
        <Field label="state" value={span.end === undefined ? 'running' : 'ended'} />
      </dl>

      {span.outcome?._tag === 'Failure' && (
        <div className={SECTION} style={redWash}>
          <p className="text-ink-2">{span.outcome.kind}</p>
          <p className="mt-1 break-words text-red">{span.outcome.error}</p>
          {span.outcome.stack !== undefined && (
            <pre className="mt-1.5 overflow-x-auto rounded-chip bg-inset p-2 text-[10px] leading-[1.6] whitespace-pre-wrap text-ink-2">
              {span.outcome.stack}
            </pre>
          )}
        </div>
      )}

      {attributes.length > 0 && (
        <div className={SECTION}>
          <p className={LABEL}>Attributes</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {attributes.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="truncate text-ink-3">{key}</dt>
                <dd className="break-words text-right text-ink-2">{formatValue(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {span.events.length > 0 && (
        <div className={SECTION}>
          <p className={LABEL}>Events</p>
          {span.events.map((event, index) => (
            <div key={`${event.name}-${index}`} className="flex justify-between gap-2 py-0.5">
              <span className="truncate text-ink-2">{event.name}</span>
              <span className="shrink-0 tabular-nums text-ink-3">
                {formatDuration(event.time - span.start)}
              </span>
            </div>
          ))}
        </div>
      )}

      {logs.length > 0 && (
        <div className="p-3">
          <p className={LABEL}>Logs</p>
          {logs.map((log, index) => (
            <div key={index} className="py-0.5">
              <span className={log.level === 'Error' ? 'text-red' : 'text-ink-3'}>{log.level}</span>{' '}
              <span className="text-ink-2">{formatValue(log.message)}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
