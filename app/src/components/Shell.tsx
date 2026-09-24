/**
 * The app shell: header, session sidebar, and the pane the flame chart will
 * fill.
 *
 * Every component here reads atoms. None of them touch `traceStore` except via
 * {@link traceStatsAtom}, which is derived from the sampled version — so a span
 * arriving never renders this tree directly.
 */
import { useAtom, useAtomMount, useAtomValue } from '@effect/atom-react'
import { MousePointerClick, PlugZap, Radio } from 'lucide-react'
import type { Session } from '../../../src/protocol/Schema.ts'
import { CollapseButton, CollapsedRail, Empty, PanelHeader, usePanel } from './Panel.tsx'
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
    className={`w-full border-l-2 px-2 py-1.5 text-left transition-colors ${
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
    <div className="mt-0.5 flex justify-between pl-3.5 text-[10px] text-ink-3">
      <span>{isLoadedSession(session.sessionId) ? 'file' : `pid ${session.pid}`}</span>
      <span className="tabular-nums">{formatTime(session.clock.wallClockEpochMillis)}</span>
    </div>
  </button>
)

/** Empty sessions list: waiting on the collector, or waiting on a program. */
const NoSessions = ({ connected }: { readonly connected: boolean }) =>
  connected ? (
    <Empty
      icon={Radio}
      title="No sessions yet"
      hint={
        <>
          Run a program with the inspect layer attached, or drop a saved{' '}
          <code className="text-ink-2">.eitrace</code> file anywhere on this page.
        </>
      }
    />
  ) : (
    <Empty
      icon={PlugZap}
      title="Waiting for the collector"
      hint={
        <>
          Start it with <code className="text-ink-2">bun run collector</code>. This page reconnects
          on its own.
        </>
      }
    />
  )

const Sessions = () => {
  const sessions = useAtomValue(sessionsAtom)
  const [selectedId, setSelectedId] = useAtom(selectedSessionIdAtom)
  const status = useAtomValue(connectionStatusAtom)
  const [collapsed, toggle] = usePanel('sessions')

  if (collapsed) {
    return <CollapsedRail edge="left" title="Sessions" onToggle={toggle} id="sessions-panel" />
  }

  return (
    <aside
      id="sessions-panel"
      className="flex w-56 shrink-0 flex-col border-r border-line bg-surface"
    >
      <PanelHeader title="Sessions">
        <CollapseButton
          edge="left"
          collapsed={false}
          onToggle={toggle}
          label="Hide sessions"
          controls="sessions-panel"
        />
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <NoSessions connected={status._tag === 'Connected'} />
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
  <Empty
    className="flex-1"
    icon={PlugZap}
    title="Collector unreachable"
    hint={
      <>
        Nothing is listening on <code className="text-ink-2">{COLLECTOR_URL}</code>. Start it with{' '}
        <code className="text-ink-2">bun run collector</code> — this page reconnects on its own. You
        can still open a saved trace: drop one anywhere on this page.
      </>
    }
  />
)

/** A session's program, without the absolute path a default `programName` carries. */
const programLabel = (program: string): string => program.split(/[/\\]/).pop() || program

/** The chart, drawer and detail panel, once a session is selected. */
const Workspace = () => {
  const session = useAtomValue(selectedSessionAtom)

  if (session === undefined) {
    return (
      <Empty
        className="flex-1"
        icon={MousePointerClick}
        title="No session selected"
        hint="Pick a program from the sessions list to see its flame chart, event log and span detail."
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/*
       * The detail panel is **first in the DOM and last on screen** (`order`).
       *
       * Source order is tab order, and the event log between the two is
       * virtualized *button* rows — on a 10k-span trace that is thousands of
       * tab stops. With the panel written last, its collapse control was
       * reachable only after tabbing through every mounted row, which is
       * "reachable" in the same sense a haystack is. Painting it on the right
       * while keeping it early in the document costs one `order` class.
       */}
      <SpanDetail />
      {/* No `border-t` here: the header already draws that rule, and a second
          one both doubles it and drops this column 1px below the side panels
          it should line up with. */}
      <div className="order-first flex min-w-0 flex-1 flex-col">
        <FlameChart />
        <Drawer />
      </div>
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
      <header className="flex h-11 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-sm text-ink">effect-inspect</h1>
          {session !== undefined && (
            <span className="truncate text-xs text-ink-3">
              {programLabel(session.program)} · {session.runtime}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-4">
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
