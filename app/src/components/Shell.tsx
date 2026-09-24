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
import { Drawer } from './Drawer.tsx'
import { FlameChart } from './FlameChart.tsx'
import { SpanDetail } from './SpanDetail.tsx'
import { ThemeToggle } from './ThemeToggle.tsx'
import { ValuePill, type Tone } from './atoms/ValuePill.tsx'
import { TraceFileControls } from './TraceFile.tsx'
import { isLoadedSession } from '../trace/TraceFile.ts'
import {
  COLLECTOR_URL,
  type ConnectionStatus,
  connectionAtom,
  connectionStatusAtom,
  decodeErrorsAtom,
  selectedSessionAtom,
  selectedSessionIdAtom,
  sessionsAtom,
  traceStatsAtom,
  wallClockOriginAtom,
} from '../state/atoms.ts'

const formatTime = (epochMillis: number): string =>
  new Date(epochMillis).toLocaleTimeString([], { hour12: false })

const formatDuration = (millis: number): string => {
  if (millis < 1000) return `${millis.toFixed(1)}ms`
  return `${(millis / 1000).toFixed(2)}s`
}

/**
 * Connection states, as a pill tone and a dot colour.
 *
 * A dropped collector is an error, so it takes the red tone. A healthy socket
 * is deliberately the *neutral* pill with a green dot rather than a green
 * pill: the steady state is the one you see all day, and it should not shout.
 */
const CONNECTION: Record<
  ConnectionStatus['_tag'],
  { readonly label: string; readonly tone: Tone; readonly dot: string }
> = {
  Connected: { label: 'connected', tone: 'neutral', dot: 'bg-green' },
  Connecting: { label: 'connecting', tone: 'neutral', dot: 'bg-ink-3 animate-pulse' },
  Disconnected: { label: 'disconnected', tone: 'red', dot: 'bg-red' },
}

const ConnectionBadge = () => {
  const status = useAtomValue(connectionStatusAtom)
  const errors = useAtomValue(decodeErrorsAtom)

  const { label, tone, dot } = CONNECTION[status._tag]

  return (
    <div className="flex items-center gap-1.5">
      <ValuePill tone={tone} className="gap-1.5">
        <span className={`size-1.5 rounded-full ${dot}`} />
        {label}
      </ValuePill>
      {errors > 0 && <ValuePill tone="red">{errors} undecodable</ValuePill>}
    </div>
  )
}

const Stat = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <div className="flex items-baseline gap-1.5">
    <span className="text-ink-3">{label}</span>
    <span className="tabular-nums text-ink">{value}</span>
  </div>
)

const Stats = () => {
  const stats = useAtomValue(traceStatsAtom)
  // The trace's absolute start. `TraceStore.epochOrigin` is never set (the
  // collector does not retain `Hello`), so this comes from the session clock
  // via `wallClockOriginAtom` — see that atom for why.
  const wallClock = useAtomValue(wallClockOriginAtom)
  return (
    <div className="flex items-center gap-4 text-xs">
      {wallClock !== undefined && <Stat label="t0" value={formatTime(wallClock)} />}
      <Stat label="spans" value={String(stats.spans)} />
      <Stat label="open" value={String(stats.openSpans)} />
      <Stat label="logs" value={String(stats.logs)} />
      <Stat label="events" value={String(stats.events)} />
      <Stat label="dur" value={formatDuration(stats.duration)} />
      {stats.errors > 0 && (
        <div className="flex items-baseline gap-1.5">
          <span className="text-ink-3">errors</span>
          <ValuePill tone="red" className="tabular-nums">
            {stats.errors}
          </ValuePill>
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
        ? 'border-accent bg-hover text-ink'
        : 'border-transparent text-ink-2 hover:bg-hover hover:text-ink'
    }`}
  >
    <div className="flex items-center gap-2">
      <span
        className={`size-1.5 shrink-0 rounded-full ${
          session.active ? 'bg-green' : 'bg-line-strong'
        }`}
      />
      <span className="truncate text-xs">{programLabel(session.program)}</span>
    </div>
    <div className="mt-1 flex justify-between pl-3.5 text-[10px] text-ink-3">
      <span>{isLoadedSession(session.sessionId) ? 'file' : `pid ${session.pid}`}</span>
      <span className="tabular-nums">{formatTime(session.clock.wallClockEpochMillis)}</span>
    </div>
  </button>
)

const Sessions = () => {
  const sessions = useAtomValue(sessionsAtom)
  const [selectedId, setSelectedId] = useAtom(selectedSessionIdAtom)
  const status = useAtomValue(connectionStatusAtom)

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface">
      <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-ink-3">Sessions</div>
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <p className="px-3 py-2 text-xs leading-relaxed text-ink-3">
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
      <p className="text-sm text-ink">Collector unreachable</p>
      <p className="mt-2 text-xs leading-relaxed text-ink-2">
        Nothing is listening on <code className="text-ink-3">{COLLECTOR_URL}</code>. Start the
        collector; this page reconnects on its own. You can still open a saved trace file — drop one
        anywhere on this page.
      </p>
    </div>
  </div>
)

/** A session's program, without the absolute path a default `programName` carries. */
const programLabel = (program: string): string => program.split(/[/\\]/).pop() || program

/** The chart, drawer and detail panel, once a session is selected. */
const Workspace = () => {
  const session = useAtomValue(selectedSessionAtom)

  if (session === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-xs text-ink-3">Select a session.</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col border-t border-line">
        <FlameChart />
        <Drawer />
      </div>
      <SpanDetail />
    </div>
  )
}

export const Shell = () => {
  // Mounting the connection atom is what opens the socket; it closes when the
  // shell unmounts.
  useAtomMount(connectionAtom)
  const status = useAtomValue(connectionStatusAtom)
  const session = useAtomValue(selectedSessionAtom)
  // A trace read from a file needs no collector, so a dead socket must not
  // replace the chart it is already rendering.
  const loadedSelected = session !== undefined && isLoadedSession(session.sessionId)

  return (
    <div className="relative flex h-screen flex-col bg-page font-mono text-ink antialiased">
      <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm text-ink">effect-inspect</h1>
          {session !== undefined && (
            <span className="text-xs text-ink-3">
              {programLabel(session.program)} · {session.runtime}
            </span>
          )}
        </div>
        <div className="flex items-center gap-5">
          <Stats />
          <TraceFileControls />
          <ConnectionBadge />
          <ThemeToggle />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Sessions />
        <main className="flex min-w-0 flex-1 flex-col">
          {status._tag === 'Disconnected' && !loadedSelected ? <Offline /> : <Workspace />}
        </main>
      </div>
    </div>
  )
}
