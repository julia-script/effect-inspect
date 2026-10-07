import { Option } from 'effect'
import type { Document } from 'foldkit/html'
import { Message } from '../state/message.ts'
import { type Model, selectedSession, sessions } from '../state/model.ts'
import { COLLECTOR_URL, traceStore } from '../state/trace.ts'
import { isLoadedSession, traceFileExtension } from '../trace/TraceFile.ts'
import { button, collapse, empty, icon, panelHeader, pill, rail, type H } from './Panel.ts'
import { spanDetail } from './SpanDetail.ts'
import { flameChart } from './FlameChart.ts'
import { drawer } from './Drawer.ts'
import { formatDuration } from './format.ts'

const formatTime = (millis: number) => new Date(millis).toLocaleTimeString([], { hour12: false })
const programLabel = (program: string) => program.split(/[/\\]/).pop() || program
const themeToggle = (model: Model, h: H) => {
  const options = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ] as const
  return h.div(
    [
      h.Role('radiogroup'),
      h.AriaLabel('Colour theme'),
      h.Class('flex items-center gap-0.5 rounded-control bg-inset p-0.5 shadow-hairline'),
      h.OnKeyDownFocus((key) => {
        const delta = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[key]
        if (delta === undefined) return Option.none()
        const theme =
          options[
            (options.findIndex((option) => option.value === model.theme) + delta + options.length) %
              options.length
          ]!.value
        return Option.some({
          focusSelector: `[data-theme="${theme}"]`,
          message: Message.ChangedTheme({ theme }),
        })
      }),
    ],
    options.map(({ value, label }) =>
      h.button(
        [
          h.Key(value),
          h.Type('button'),
          h.Role('radio'),
          h.AriaChecked(value === model.theme),
          h.AriaLabel(label),
          h.Title(label),
          h.DataAttribute('theme', value),
          h.Tabindex(value === model.theme ? 0 : -1),
          h.OnClick(Message.ChangedTheme({ theme: value })),
          h.Class(
            `flex size-6 items-center justify-center rounded-chip transition-colors ${value === model.theme ? 'bg-surface text-ink shadow-btn' : 'text-ink-3 hover:text-ink-2'}`,
          ),
        ],
        [icon(h, label)],
      ),
    ),
  )
}
const stats = (model: Model, h: H) => {
  const stat = traceStore.stats()
  const session = selectedSession(model)
  const values: Array<readonly [string, string]> = []
  if (session !== undefined && traceStore.origin !== undefined)
    values.push([
      't0',
      formatTime(
        session.clock.wallClockEpochMillis +
          Number((traceStore.origin - session.clock.startTime) / 1_000_000n),
      ),
    ])
  values.push(
    ['spans', String(stat.spans)],
    ['open', String(stat.openSpans)],
    ['logs', String(stat.logs)],
    ['events', String(stat.events)],
    ['dur', formatDuration(stat.duration)],
  )
  return h.div(
    [h.Class('flex items-center gap-4 text-xs')],
    [
      ...values.map(([label, value]) =>
        h.div(
          [h.Class('flex items-baseline gap-1.5')],
          [
            h.span([h.Class('text-ink-3')], [label]),
            h.span([h.Class('tabular-nums text-ink')], [value]),
          ],
        ),
      ),
      stat.errors > 0 ? pill(h, `${stat.errors} errors`, true) : null,
    ],
  )
}
const fileControls = (model: Model, h: H) =>
  h.div(
    [h.Class('flex items-center gap-1.5')],
    [
      button(h, 'save', Message.ClickedSave(), [
        h.Disabled(selectedSession(model) === undefined || traceStore.stats().spans === 0),
        h.DataAttribute('testid', 'save-trace'),
      ]),
      button(h, 'open', Message.ClickedOpen(), [h.DataAttribute('testid', 'open-trace')]),
      h.input([
        h.Type('file'),
        h.Accept(traceFileExtension),
        h.DataAttribute('testid', 'trace-file-input'),
        h.Class('hidden'),
        h.OnFileChange((files) => Message.ChoseFile({ file: files[0] })),
      ]),
    ],
  )
const notices = (model: Model, h: H) => {
  const truncated = model.loadedSessions.find(
    (entry) => entry.session.sessionId === model.selectedSessionId && entry.truncatedLines > 0,
  )
  const notice =
    'absolute inset-x-0 top-11 z-20 mx-auto flex w-fit max-w-xl items-baseline gap-3 rounded-card bg-surface px-3 py-2 text-xs shadow-overlay'
  return [
    model.fileError === undefined
      ? null
      : h.div(
          [
            h.DataAttribute('testid', 'trace-file-error'),
            h.Role('alert'),
            h.Class(`${notice} text-red`),
            h.Style({ backgroundImage: 'linear-gradient(var(--red-tint), var(--red-tint))' }),
          ],
          [model.fileError, button(h, 'dismiss', Message.DismissedFileError(), [], true)],
        ),
    truncated !== undefined && model.fileError === undefined
      ? h.div(
          [
            h.DataAttribute('testid', 'trace-file-truncated'),
            h.Class(`${notice} text-orange`),
            h.Style({ backgroundImage: 'linear-gradient(var(--orange-tint), var(--orange-tint))' }),
          ],
          ['This trace file was cut short mid-write; everything before the cut is shown.'],
        )
      : null,
    model.draggingFile
      ? h.div(
          [
            h.Class(
              'pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-page/80',
            ),
          ],
          [
            h.p(
              [
                h.Class(
                  'rounded-card border border-dashed border-line-strong bg-surface px-6 py-4 text-xs text-ink-2 shadow-overlay',
                ),
              ],
              [`Drop a ${traceFileExtension} file to load it`],
            ),
          ],
        )
      : null,
  ]
}
const sessionList = (model: Model, h: H) => {
  if (model.panels.sessions) return rail(h, 'sessions')
  const list = sessions(model)
  const connected = model.connection._tag === 'Connected'
  return h.aside(
    [
      h.Id('sessions-panel'),
      h.Class('flex w-56 shrink-0 flex-col border-r border-line bg-surface'),
    ],
    [
      panelHeader(h, 'Sessions', [collapse(h, 'sessions', false)]),
      h.div(
        [h.Class('min-h-0 flex-1 overflow-y-auto')],
        list.length === 0
          ? [
              empty(
                h,
                connected ? 'No sessions yet' : 'Waiting for the collector',
                connected
                  ? 'Run a program with the inspect layer attached, or drop a saved .eitrace file anywhere on this page.'
                  : 'Start it with bun run collector. This page reconnects on its own.',
                connected ? 'Radio' : 'Plug',
              ),
            ]
          : list.map((session) =>
              h.button(
                [
                  h.Key(session.sessionId),
                  h.Type('button'),
                  h.OnClick(Message.ClickedSession({ sessionId: session.sessionId })),
                  h.AriaPressed(String(session.sessionId === model.selectedSessionId)),
                  h.Class(
                    `w-full border-l-2 px-2 py-1.5 text-left transition-colors ${session.sessionId === model.selectedSessionId ? 'border-accent bg-hover text-ink' : 'border-transparent text-ink-2 hover:bg-hover hover:text-ink'}`,
                  ),
                ],
                [
                  h.div(
                    [h.Class('flex items-center gap-2')],
                    [
                      h.span(
                        [
                          h.Class(
                            `size-1.5 shrink-0 rounded-full ${session.active ? 'bg-green' : 'bg-line-strong'}`,
                          ),
                        ],
                        [],
                      ),
                      h.span([h.Class('truncate text-xs')], [programLabel(session.program)]),
                    ],
                  ),
                  h.div(
                    [h.Class('mt-0.5 flex justify-between pl-3.5 text-[10px] text-ink-3')],
                    [
                      h.span(
                        [],
                        [isLoadedSession(session.sessionId) ? 'file' : `pid ${session.pid}`],
                      ),
                      h.span(
                        [h.Class('tabular-nums')],
                        [formatTime(session.clock.wallClockEpochMillis)],
                      ),
                    ],
                  ),
                ],
              ),
            ),
      ),
    ],
  )
}
const workspace = (model: Model, h: H) => {
  const session = selectedSession(model)
  const loaded = session !== undefined && isLoadedSession(session.sessionId)
  if (model.connection._tag === 'Disconnected' && !loaded)
    return empty(
      h,
      'Collector unreachable',
      `Nothing is listening on ${COLLECTOR_URL}. Start it with bun run collector — this page reconnects on its own. You can still open a saved trace: drop one anywhere on this page.`,
      'Plug',
      'flex-1',
    )
  if (session === undefined)
    return empty(
      h,
      'No session selected',
      'Pick a program from the sessions list to see its flame chart, event log and span detail.',
      'Select',
      'flex-1',
    )
  return h.div(
    [h.Class('flex min-h-0 flex-1')],
    [
      spanDetail(model, h),
      h.div(
        [h.Class('order-first flex min-w-0 flex-1 flex-col')],
        [flameChart(model, h), drawer(model, h)],
      ),
    ],
  )
}
const connectionDot = (model: Model) => {
  if (model.connection._tag === 'Connected') return 'bg-green'
  if (model.connection._tag === 'Disconnected') return 'bg-red'
  return 'bg-ink-3 animate-pulse'
}

export const view = (model: Model, h: H): Document => {
  if (model.path !== '/')
    return {
      title: 'No such page · effect-inspect',
      body: h.div(
        [
          h.Class(
            'flex h-screen flex-col items-center justify-center bg-page font-mono text-ink antialiased',
          ),
        ],
        [
          empty(h, 'No such page', 'effect-inspect is a single page.'),
          h.a(
            [h.Attribute('href', '/'), h.Class('text-accent underline underline-offset-2')],
            ['Back to the inspector'],
          ),
        ],
      ),
    }
  const session = selectedSession(model)
  const label = model.connection._tag.toLowerCase()
  return {
    title: 'effect-inspect',
    body: h.div(
      [h.Class('relative flex h-screen flex-col bg-page font-mono text-ink antialiased')],
      [
        h.header(
          [
            h.Class(
              'flex h-11 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-3',
            ),
          ],
          [
            h.div(
              [h.Class('flex min-w-0 items-baseline gap-3')],
              [
                h.h1([h.Class('text-sm text-ink')], ['effect-inspect']),
                session === undefined
                  ? null
                  : h.span(
                      [h.Class('truncate text-xs text-ink-3')],
                      [`${programLabel(session.program)} · ${session.runtime}`],
                    ),
              ],
            ),
            h.div(
              [h.Class('flex shrink-0 items-center gap-4')],
              [
                stats(model, h),
                fileControls(model, h),
                h.div(
                  [h.Class('flex items-center gap-1.5')],
                  [
                    pill(
                      h,
                      [
                        h.span([h.Class(`size-1.5 rounded-full ${connectionDot(model)}`)], []),
                        label,
                      ],
                      model.connection._tag === 'Disconnected',
                    ),
                    model.decodeErrors > 0
                      ? pill(h, `${model.decodeErrors} undecodable`, true)
                      : null,
                  ],
                ),
                themeToggle(model, h),
              ],
            ),
          ],
        ),
        h.div(
          [h.Class('flex min-h-0 flex-1')],
          [
            sessionList(model, h),
            h.main([h.Class('flex min-w-0 flex-1 flex-col')], [workspace(model, h)]),
          ],
        ),
        ...notices(model, h),
      ],
    ),
  }
}
