import { Schema } from 'effect'
import { Session } from '../../../src/protocol/Schema.ts'

export const Theme = Schema.Literals(['light', 'dark', 'system'])
export const Tab = Schema.Literals(['log', 'summary', 'bottom-up', 'call-tree'])
export const SortKey = Schema.Literals(['start', 'self', 'total', 'name', 'count', 'average'])
export const Panels = Schema.Struct({ sessions: Schema.Boolean, detail: Schema.Boolean })
export const Connection = Schema.Union([
  Schema.Struct({ _tag: Schema.tag('Connecting') }),
  Schema.Struct({ _tag: Schema.tag('Connected') }),
  Schema.Struct({ _tag: Schema.tag('Disconnected'), attempt: Schema.Finite }),
])
export const LoadedSession = Schema.Struct({ session: Session, truncatedLines: Schema.Finite })
export const Selection = Schema.Struct({
  selectedSpanId: Schema.UndefinedOr(Schema.String),
  hoveredSpanId: Schema.UndefinedOr(Schema.String),
  filter: Schema.String,
  filterHides: Schema.Boolean,
  memoryCollapsed: Schema.Boolean,
  resolvedTheme: Schema.Literals(['light', 'dark']),
})
export type Selection = typeof Selection.Type

/** UI state only. Dense span data stays in the canvas store and is sampled once per frame. */
export const Flags = Schema.Struct({ path: Schema.String })
export const Model = Schema.Struct({
  ...Flags.fields,
  ...Selection.fields,
  connection: Connection,
  liveSessions: Schema.Array(Session),
  loadedSessions: Schema.Array(LoadedSession),
  selectedSessionId: Schema.UndefinedOr(Schema.String),
  traceVersion: Schema.Finite,
  decodeErrors: Schema.Finite,
  theme: Theme,
  systemDark: Schema.Boolean,
  panels: Panels,
  helpOpen: Schema.Boolean,
  fileError: Schema.UndefinedOr(Schema.String),
  fileReadId: Schema.Finite,
  draggingFile: Schema.Boolean,
  drawerHeight: Schema.Finite,
  drawerCollapsed: Schema.Boolean,
  tab: Tab,
  logSort: Schema.Struct({ key: SortKey, desc: Schema.Boolean }),
  summarySort: Schema.Struct({ key: SortKey, desc: Schema.Boolean }),
  logScrollTop: Schema.Finite,
  logViewHeight: Schema.Finite,
  expanded: Schema.Array(Schema.String),
  viewport: Schema.Struct({ from: Schema.Finite, to: Schema.Finite }),
  tooltip: Schema.UndefinedOr(
    Schema.Struct({
      spanId: Schema.String,
      x: Schema.Finite,
      y: Schema.Finite,
      width: Schema.Finite,
    }),
  ),
})
export type Model = typeof Model.Type
export const sessions = (model: Model) => [
  ...model.loadedSessions.map((entry) => entry.session),
  ...model.liveSessions,
]
export const selectedSession = (model: Model) =>
  sessions(model).find((session) => session.sessionId === model.selectedSessionId)
export const initialModel: Model = {
  path: '/',
  connection: { _tag: 'Connecting' },
  liveSessions: [],
  loadedSessions: [],
  selectedSessionId: undefined,
  traceVersion: 0,
  decodeErrors: 0,
  selectedSpanId: undefined,
  hoveredSpanId: undefined,
  filter: '',
  filterHides: false,
  memoryCollapsed: false,
  theme: 'dark',
  resolvedTheme: 'dark',
  systemDark: false,
  panels: { sessions: false, detail: false },
  helpOpen: false,
  fileError: undefined,
  fileReadId: 0,
  draggingFile: false,
  drawerHeight: 220,
  drawerCollapsed: false,
  tab: 'log',
  logSort: { key: 'start', desc: false },
  summarySort: { key: 'self', desc: true },
  logScrollTop: 0,
  logViewHeight: 220,
  expanded: [],
  viewport: { from: 0, to: 1 },
  tooltip: undefined,
}

/** The renderer receives only the UI fields it draws. */
export const selectionOf = (model: Model): Selection => ({
  selectedSpanId: model.selectedSpanId,
  hoveredSpanId: model.hoveredSpanId,
  filter: model.filter,
  filterHides: model.filterHides,
  memoryCollapsed: model.memoryCollapsed,
  resolvedTheme: model.resolvedTheme,
})
