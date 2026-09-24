/**
 * Detail panel for the selected span — the full record the tooltip truncates.
 *
 * Reads the shared `selectedSpanIdAtom` and resolves the id against the store
 * on each render, so a re-depthed or newly-ended span shows its current state
 * rather than a snapshot taken at click time.
 */
import { useAtom, useAtomValue } from '@effect/atom-react'
import { timings } from '../chart/metrics.ts'
import { selectedSpanIdAtom } from '../chart/selection.ts'
import { traceStore, traceVersionAtom } from '../state/atoms.ts'
import { formatDuration, formatValue } from './format.ts'

const Field = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <>
    <dt className="truncate text-neutral-600">{label}</dt>
    <dd className="truncate text-right tabular-nums text-neutral-300">{value}</dd>
  </>
)

export const SpanDetail = () => {
  const [selectedId, setSelectedId] = useAtom(selectedSpanIdAtom)
  // The selected span mutates in place as its SpanEnd and events arrive, so
  // this panel must repaint on the sampled trace version, not only on click.
  useAtomValue(traceVersionAtom)

  if (selectedId === undefined) {
    return (
      <aside className="w-72 shrink-0 border-l border-neutral-900 p-3 text-[11px] text-neutral-700">
        Select a span.
      </aside>
    )
  }

  const span = traceStore.spans.get(selectedId)
  if (span === undefined) {
    return (
      <aside className="w-72 shrink-0 border-l border-neutral-900 p-3 text-[11px] text-neutral-700">
        That span is no longer in the trace.
      </aside>
    )
  }

  const now = traceStore.stats().duration
  const { total, self } = timings(traceStore, span, now)
  const attributes = Object.entries(span.attributes)
  const logs = traceStore.logs.filter((log) => log.spanId === span.spanId)

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-neutral-900 text-[11px]">
      <div className="flex items-start justify-between gap-2 border-b border-neutral-900 p-3">
        <div className="min-w-0">
          <p className="break-words text-neutral-200">{span.name}</p>
          <p className="mt-0.5 text-neutral-700">{span.kind}</p>
        </div>
        <button
          type="button"
          onClick={() => setSelectedId(undefined)}
          aria-label="Clear selection"
          className="shrink-0 text-neutral-600 hover:text-neutral-300"
        >
          ✕
        </button>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-neutral-900 p-3">
        <Field label="start" value={formatDuration(span.start)} />
        <Field label="total" value={formatDuration(total)} />
        <Field label="self" value={formatDuration(self)} />
        <Field label="depth" value={String(span.depth)} />
        <Field label="children" value={String(span.children.length)} />
        {span.fiberId !== undefined && <Field label="fiber" value={String(span.fiberId)} />}
        <Field label="state" value={span.end === undefined ? 'running' : 'ended'} />
      </dl>

      {span.outcome?._tag === 'Failure' && (
        <div className="border-b border-neutral-900 p-3">
          <p className="text-neutral-600">{span.outcome.kind}</p>
          <p className="mt-1 break-words text-red-400">{span.outcome.error}</p>
          {span.outcome.stack !== undefined && (
            <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap text-[10px] text-neutral-600">
              {span.outcome.stack}
            </pre>
          )}
        </div>
      )}

      {attributes.length > 0 && (
        <div className="border-b border-neutral-900 p-3">
          <p className="mb-1.5 text-[10px] uppercase tracking-wider text-neutral-600">Attributes</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {attributes.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="truncate text-neutral-600">{key}</dt>
                <dd className="break-words text-right text-neutral-400">{formatValue(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {span.events.length > 0 && (
        <div className="border-b border-neutral-900 p-3">
          <p className="mb-1.5 text-[10px] uppercase tracking-wider text-neutral-600">Events</p>
          {span.events.map((event, index) => (
            <div key={`${event.name}-${index}`} className="flex justify-between gap-2 py-0.5">
              <span className="truncate text-neutral-400">{event.name}</span>
              <span className="shrink-0 tabular-nums text-neutral-600">
                {formatDuration(event.time - span.start)}
              </span>
            </div>
          ))}
        </div>
      )}

      {logs.length > 0 && (
        <div className="p-3">
          <p className="mb-1.5 text-[10px] uppercase tracking-wider text-neutral-600">Logs</p>
          {logs.map((log, index) => (
            <div key={index} className="py-0.5">
              <span className={log.level === 'Error' ? 'text-red-400' : 'text-neutral-600'}>
                {log.level}
              </span>{' '}
              <span className="text-neutral-400">{formatValue(log.message)}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
