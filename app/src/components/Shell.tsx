/**
 * The app shell: header, session sidebar, and the pane the flame chart will
 * fill.
 *
 * Every component here reads atoms. None of them touch `traceStore` except via
 * {@link traceStatsAtom}, which is derived from the sampled version — so a span
 * arriving never renders this tree directly.
 */
import { useAtom, useAtomMount, useAtomValue } from '@effect/atom-react'
import type { Session } from '../../../src/protocol/Schema.ts'
import {
  COLLECTOR_URL,
  connectionAtom,
  connectionStatusAtom,
  decodeErrorsAtom,
  selectedSessionAtom,
  selectedSessionIdAtom,
  sessionsAtom,
  traceStatsAtom,
} from '../state/atoms.ts'

const formatTime = (epochMillis: number): string =>
  new Date(epochMillis).toLocaleTimeString([], { hour12: false })

const formatDuration = (millis: number): string => {
  if (millis < 1000) return `${millis.toFixed(1)}ms`
  return `${(millis / 1000).toFixed(2)}s`
}

const ConnectionBadge = () => {
  const status = useAtomValue(connectionStatusAtom)
  const errors = useAtomValue(decodeErrorsAtom)

  // Red is reserved for errors; a dropped collector is an error state.
  const { label, dot } = {
    Connected: { label: 'connected', dot: 'bg-neutral-300' },
    Connecting: { label: 'connecting', dot: 'bg-neutral-500 animate-pulse' },
    Disconnected: { label: 'disconnected', dot: 'bg-red-500' },
  }[status._tag]

  return (
    <div className="flex items-center gap-2 text-xs text-neutral-500">
      <span className={`size-1.5 rounded-full ${dot}`} />
      <span>{label}</span>
      {errors > 0 && <span className="text-red-400">{errors} undecodable</span>}
    </div>
  )
}

const Stat = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <div className="flex items-baseline gap-1.5">
    <span className="text-neutral-600">{label}</span>
    <span className="tabular-nums text-neutral-300">{value}</span>
  </div>
)

const Stats = () => {
  const stats = useAtomValue(traceStatsAtom)
  return (
    <div className="flex items-center gap-4 text-xs">
      <Stat label="spans" value={String(stats.spans)} />
      <Stat label="open" value={String(stats.openSpans)} />
      <Stat label="logs" value={String(stats.logs)} />
      <Stat label="events" value={String(stats.events)} />
      <Stat label="dur" value={formatDuration(stats.duration)} />
      {stats.errors > 0 && (
        <div className="flex items-baseline gap-1.5">
          <span className="text-neutral-600">errors</span>
          <span className="tabular-nums text-red-400">{stats.errors}</span>
        </div>
      )}
    </div>
  )
}

const SessionRow = ({
  session,
  selected,
  onSelect,
}: {
  readonly session: Session
  readonly selected: boolean
  readonly onSelect: () => void
}) => (
  <button
    type="button"
    onClick={onSelect}
    className={`w-full border-l-2 px-3 py-2 text-left transition-colors ${
      selected
        ? 'border-neutral-300 bg-neutral-900 text-neutral-200'
        : 'border-transparent text-neutral-500 hover:bg-neutral-900/50 hover:text-neutral-300'
    }`}
  >
    <div className="flex items-center gap-2">
      <span
        className={`size-1.5 shrink-0 rounded-full ${
          session.active ? 'bg-neutral-300' : 'bg-neutral-700'
        }`}
      />
      <span className="truncate text-xs">{session.program}</span>
    </div>
    <div className="mt-1 flex justify-between pl-3.5 text-[10px] text-neutral-600">
      <span>pid {session.pid}</span>
      <span className="tabular-nums">{formatTime(session.clock.wallClockEpochMillis)}</span>
    </div>
  </button>
)

const Sessions = () => {
  const sessions = useAtomValue(sessionsAtom)
  const [selectedId, setSelectedId] = useAtom(selectedSessionIdAtom)
  const status = useAtomValue(connectionStatusAtom)

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-neutral-900">
      <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-neutral-600">
        Sessions
      </div>
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <p className="px-3 py-2 text-xs leading-relaxed text-neutral-600">
            {status._tag === 'Connected'
              ? 'No sessions yet. Run a program with the inspect layer.'
              : 'Waiting for the collector.'}
          </p>
        ) : (
          sessions.map((session) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              selected={session.sessionId === selectedId}
              onSelect={() => setSelectedId(session.sessionId)}
            />
          ))
        )}
      </div>
    </aside>
  )
}

/** Shown in place of the chart when the collector cannot be reached. */
const Offline = () => (
  <div className="flex flex-1 items-center justify-center">
    <div className="max-w-sm text-center">
      <p className="text-sm text-neutral-300">Collector unreachable</p>
      <p className="mt-2 text-xs leading-relaxed text-neutral-600">
        Nothing is listening on <code className="text-neutral-500">{COLLECTOR_URL}</code>. Start the
        collector; this page reconnects on its own.
      </p>
    </div>
  </div>
)

/**
 * Placeholder for the canvas flame chart, which is a separate task.
 *
 * It will mount a `<canvas>` here and read `traceStore` directly in its draw
 * loop — this component deliberately does not thread span data down as props.
 */
const ChartPlaceholder = () => {
  const stats = useAtomValue(traceStatsAtom)
  const session = useAtomValue(selectedSessionAtom)

  if (session === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-xs text-neutral-600">Select a session.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-1 items-center justify-center border-t border-neutral-900">
      <p className="text-xs text-neutral-700">
        {stats.spans === 0
          ? 'Waiting for spans…'
          : `${stats.spans} spans ingested — flame chart lands in the next task.`}
      </p>
    </div>
  )
}

export const Shell = () => {
  // Mounting the connection atom is what opens the socket; it closes when the
  // shell unmounts.
  useAtomMount(connectionAtom)
  const status = useAtomValue(connectionStatusAtom)
  const session = useAtomValue(selectedSessionAtom)

  return (
    <div className="flex h-screen flex-col bg-neutral-950 font-mono text-neutral-200 antialiased">
      <header className="flex items-center justify-between border-b border-neutral-900 px-4 py-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm text-neutral-300">effect-inspect</h1>
          {session !== undefined && (
            <span className="text-xs text-neutral-600">
              {session.program} · {session.runtime}
            </span>
          )}
        </div>
        <div className="flex items-center gap-5">
          <Stats />
          <ConnectionBadge />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Sessions />
        <main className="flex min-w-0 flex-1 flex-col">
          {status._tag === 'Disconnected' ? <Offline /> : <ChartPlaceholder />}
        </main>
      </div>
    </div>
  )
}
