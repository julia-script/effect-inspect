import { Runtime, Update } from 'foldkit'
import { Message } from './state/message.ts'
import { initialModel, Model, selectedSession, selectionOf, Flags } from './state/model.ts'
import {
  ApplyPreferences,
  NavigateChart,
  OpenTracePicker,
  ReadPreferences,
  ReadTrace,
  ReflectSelection,
  RevealSpan,
  ScrollLog,
  SaveTrace,
  SwitchTrace,
} from './state/browser.ts'
import { isLoadedSession } from './trace/TraceFile.ts'
import { view } from './components/Shell.ts'

export { Model, Message, view, Flags }
export { subscriptions } from './state/browser.ts'

const reflected = (model: Model, reveal = false, scroll = false): Update.Return<Model, Message> => {
  const commands: Array<
    | ReturnType<typeof ReflectSelection>
    | ReturnType<typeof RevealSpan>
    | ReturnType<typeof ScrollLog>
  > = [ReflectSelection(selectionOf(model))]
  if (reveal && model.selectedSpanId !== undefined)
    commands.push(RevealSpan({ spanId: model.selectedSpanId }))
  if (scroll)
    commands.push(
      ScrollLog({
        spanId: model.selectedSpanId,
        top: model.logScrollTop,
        traceVersion: model.traceVersion,
        filter: model.filter,
        filterHides: model.filterHides,
        logSort: model.logSort,
      }),
    )
  return { model, commands }
}
const preferences = (model: Model): Update.Return<Model, Message> => {
  let resolvedTheme: Model['resolvedTheme'] = model.systemDark ? 'dark' : 'light'
  if (model.theme !== 'system') resolvedTheme = model.theme
  const next = { ...model, resolvedTheme }
  return {
    model: next,
    commands: [
      ApplyPreferences({
        theme: next.theme,
        panels: next.panels,
        resolvedTheme: next.resolvedTheme,
      }),
    ],
  }
}
const selectSession = (model: Model, sessionId: string): Update.Return<Model, Message> => {
  const next = {
    ...model,
    selectedSessionId: sessionId,
    selectedSpanId: undefined,
    hoveredSpanId: undefined,
    tooltip: undefined,
    logScrollTop: 0,
    expanded: [],
  }
  return {
    model: next,
    commands: [
      SwitchTrace({ sessionId }),
      ReflectSelection(selectionOf(next)),
      ScrollLog({ spanId: undefined, top: 0, ...next }),
    ],
  }
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    StartedResources: () => {
      // A development reload preserves UI preferences, while browser resources start fresh.
      // File bytes belong to the previous resource lifetime, so discard their metadata too.
      const selectedSessionId =
        model.selectedSessionId !== undefined && isLoadedSession(model.selectedSessionId)
          ? undefined
          : model.selectedSessionId
      const next = {
        ...model,
        loadedSessions: [],
        selectedSessionId,
        selectedSpanId: undefined,
        hoveredSpanId: undefined,
        tooltip: undefined,
      }
      return {
        model: next,
        commands: [ReadPreferences(), SwitchTrace({ sessionId: selectedSessionId })],
      }
    },
    GotConnection: ({ connection }) => {
      const next = { ...model, connection }
      if (
        connection._tag === 'Connected' &&
        model.selectedSessionId !== undefined &&
        !isLoadedSession(model.selectedSessionId)
      ) {
        return { model: next, commands: [SwitchTrace({ sessionId: model.selectedSessionId })] }
      }
      return { model: next }
    },
    GotSessions: ({ sessions }) => {
      const liveSessions = [...sessions].sort(
        (a, b) => b.clock.wallClockEpochMillis - a.clock.wallClockEpochMillis,
      )
      const next = { ...model, liveSessions }
      if (model.selectedSessionId === undefined && liveSessions[0] !== undefined)
        return selectSession(next, liveSessions[0].sessionId)
      return { model: next }
    },
    SampledTrace: ({ sessionId, version }) => ({
      model:
        sessionId === model.selectedSessionId && version !== model.traceVersion
          ? { ...model, traceVersion: version }
          : model,
    }),
    GotDecodeError: () => ({ model: { ...model, decodeErrors: model.decodeErrors + 1 } }),
    ClickedSession: ({ sessionId }) =>
      model.selectedSessionId === sessionId ? { model } : selectSession(model, sessionId),
    SelectedSpan: ({ spanId, reveal }) =>
      reflected({ ...model, selectedSpanId: spanId }, reveal, true),
    HoveredSpan: ({ spanId }) => reflected({ ...model, hoveredSpanId: spanId }),
    ChangedFilter: ({ filter }) => reflected({ ...model, filter, logScrollTop: 0 }, false, true),
    ToggledFilterHides: () =>
      reflected({ ...model, filterHides: !model.filterHides, logScrollTop: 0 }, false, true),
    ToggledMemory: () => reflected({ ...model, memoryCollapsed: !model.memoryCollapsed }),
    ChangedTheme: ({ theme }) => preferences({ ...model, theme }),
    GotSystemTheme: ({ dark }) => preferences({ ...model, systemDark: dark }),
    GotPreferences: ({ theme, panels, systemDark }) =>
      preferences({ ...model, theme, panels, systemDark }),
    ToggledPanel: ({ panel }) =>
      preferences({ ...model, panels: { ...model.panels, [panel]: !model.panels[panel] } }),
    ClickedHelp: () => ({ model: { ...model, helpOpen: true } }),
    ClosedHelp: () => ({ model: { ...model, helpOpen: false } }),
    PressedChartKey: ({ key }) => {
      if (key === '?') return { model: { ...model, helpOpen: true } }
      if (key === 'Escape') {
        if (model.helpOpen) return { model: { ...model, helpOpen: false } }
        return reflected({ ...model, selectedSpanId: undefined })
      }
      if (model.helpOpen) return { model }
      return { model, commands: [NavigateChart({ key, selectedSpanId: model.selectedSpanId })] }
    },
    CompletedNavigation: ({ spanId }) =>
      reflected({ ...model, selectedSpanId: spanId }, false, true),
    SampledChart: ({ viewport, tooltip }) => {
      const previous = model.tooltip
      if (
        viewport.from === model.viewport.from &&
        viewport.to === model.viewport.to &&
        tooltip?.spanId === previous?.spanId &&
        tooltip?.x === previous?.x &&
        tooltip?.y === previous?.y &&
        tooltip?.width === previous?.width
      )
        return { model }
      return { model: { ...model, viewport, tooltip } }
    },
    ChoseFile: ({ file }) => {
      if (file === undefined) return { model }
      const readId = model.fileReadId + 1
      return {
        model: { ...model, fileError: undefined, fileReadId: readId },
        commands: [ReadTrace({ file, readId })],
      }
    },
    LoadedTrace: ({ entry, readId }) => {
      if (readId !== model.fileReadId) return { model }
      return selectSession(
        {
          ...model,
          loadedSessions: [
            entry,
            ...model.loadedSessions.filter(
              (loaded) => loaded.session.sessionId !== entry.session.sessionId,
            ),
          ],
        },
        entry.session.sessionId,
      )
    },
    FailedReadTrace: ({ error, readId }) => ({
      model: readId === model.fileReadId ? { ...model, fileError: error } : model,
    }),
    ChangedFileDrag: ({ dragging }) => ({ model: { ...model, draggingFile: dragging } }),
    ClickedOpen: () => ({ model, commands: [OpenTracePicker()] }),
    ClickedSave: () => {
      const session = selectedSession(model)
      return session === undefined ? { model } : { model, commands: [SaveTrace({ session })] }
    },
    DismissedFileError: () => ({ model: { ...model, fileError: undefined } }),
    ChangedTab: ({ tab }) => ({ model: { ...model, tab, expanded: [], logScrollTop: 0 } }),
    ToggledDrawer: () => ({ model: { ...model, drawerCollapsed: !model.drawerCollapsed } }),
    ResizedDrawer: ({ height }) => ({
      model: model.drawerCollapsed ? model : { ...model, drawerHeight: height },
    }),
    SortedTable: ({ table, key }) => {
      const field = table === 'log' ? 'logSort' : 'summarySort'
      const current = model[field]
      const desc = current.key === key ? !current.desc : key !== 'name' && key !== 'start'
      const next = { ...model, [field]: { key, desc }, logScrollTop: 0 }
      return { model: next, commands: [ScrollLog({ ...next, spanId: undefined, top: 0 })] }
    },
    ScrolledLog: ({ top }) => ({ model: { ...model, logScrollTop: top } }),
    MeasuredLog: ({ height }) => ({ model: { ...model, logViewHeight: height } }),
    ToggledTree: ({ id, spanId }) =>
      reflected({
        ...model,
        selectedSpanId: spanId,
        expanded: model.expanded.includes(id)
          ? model.expanded.filter((value) => value !== id)
          : [...model.expanded, id],
      }),
    AppliedPreferences: () => reflected(model),
    CompletedBrowserAction: () => ({ model }),
  })

export const init: Runtime.ApplicationInit<Model, Message, typeof Flags.Type> = ({ path }) => ({
  model: { ...initialModel, path },
})
