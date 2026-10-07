import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Session } from '../../../src/protocol/Schema.ts'
import { Connection, LoadedSession, Model, Panels, SortKey, Tab, Theme } from './model.ts'

export const Message = defineMessageUnion({
  StartedResources: {},
  GotConnection: { connection: Connection },
  GotSessions: { sessions: Schema.Array(Session) },
  SampledTrace: { sessionId: Schema.UndefinedOr(Schema.String), version: Schema.Finite },
  GotDecodeError: {},
  ClickedSession: { sessionId: Schema.String },
  SelectedSpan: { spanId: Schema.UndefinedOr(Schema.String), reveal: Schema.Boolean },
  HoveredSpan: { spanId: Schema.UndefinedOr(Schema.String) },
  ChangedFilter: { filter: Schema.String },
  ToggledFilterHides: {},
  ToggledMemory: {},
  ChangedTheme: { theme: Theme },
  GotSystemTheme: { dark: Schema.Boolean },
  GotPreferences: { theme: Theme, panels: Panels, systemDark: Schema.Boolean },
  ToggledPanel: { panel: Schema.Literals(['sessions', 'detail']) },
  ClickedHelp: {},
  ClosedHelp: {},
  PressedChartKey: { key: Schema.String },
  CompletedNavigation: { spanId: Schema.UndefinedOr(Schema.String) },
  SampledChart: { viewport: Model.fields.viewport, tooltip: Model.fields.tooltip },
  ChoseFile: { file: Schema.UndefinedOr(Schema.instanceOf(File)) },
  LoadedTrace: { entry: LoadedSession, readId: Schema.Finite },
  FailedReadTrace: { error: Schema.String, readId: Schema.Finite },
  ChangedFileDrag: { dragging: Schema.Boolean },
  ClickedOpen: {},
  ClickedSave: {},
  DismissedFileError: {},
  ChangedTab: { tab: Tab },
  ToggledDrawer: {},
  ResizedDrawer: { height: Schema.Finite },
  SortedTable: { table: Schema.Literals(['log', 'summary']), key: SortKey },
  ScrolledLog: { top: Schema.Finite },
  MeasuredLog: { height: Schema.Finite },
  ToggledTree: { id: Schema.String, spanId: Schema.String },
  AppliedPreferences: {},
  CompletedBrowserAction: {},
})
export type Message = typeof Message.Type
