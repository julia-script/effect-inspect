import { describe, expect, it } from 'bun:test'
import { Effect } from 'effect'
import { update, view } from './main.ts'
import { initialModel, type Model } from './state/model.ts'
import { Message } from './state/message.ts'
import { ReadTrace, SwitchTrace } from './state/browser.ts'
import { loadedMessages, traceStore } from './state/trace.ts'
import { serializeTraceFile } from './trace/TraceFile.ts'
import type { Session } from '../../src/protocol/Schema.ts'
import { scene, given, expect as expectView, role, testId, text } from 'foldkit/scene'

const session: Session = {
  sessionId: 'test',
  program: 'test-program',
  pid: 1,
  runtime: 'bun',
  clock: { startTime: 0n, wallClockEpochMillis: 1 },
  active: true,
}
const commandNames = (result: ReturnType<typeof update>) =>
  result.commands?.map((command) => command.name) ?? []

describe('Foldkit inspector transitions', () => {
  it('selects the newest session once and keeps subsequent collector lists from replacing a user selection', () => {
    const older = {
      ...session,
      sessionId: 'older',
      clock: { ...session.clock, wallClockEpochMillis: 0 },
    }
    const result = update(initialModel, Message.GotSessions({ sessions: [older, session] }))
    expect(result.model.selectedSessionId).toBe('test')
    expect(commandNames(result)).toContain('SwitchTrace')
    const next = update(
      { ...result.model, selectedSessionId: 'older' },
      Message.GotSessions({ sessions: [session, older] }),
    )
    expect(next.model.selectedSessionId).toBe('older')
    expect(commandNames(next)).toEqual([])
    expect(initialModel.selectedSessionId).toBeUndefined()
  })
  it('resubscribes live sessions on reconnect while leaving a loaded trace intact', () => {
    expect(
      commandNames(
        update(
          { ...initialModel, selectedSessionId: 'test' },
          Message.GotConnection({ connection: { _tag: 'Connected' } }),
        ),
      ),
    ).toContain('SwitchTrace')
    expect(
      commandNames(
        update(
          { ...initialModel, selectedSessionId: 'loaded:test' },
          Message.GotConnection({ connection: { _tag: 'Connected' } }),
        ),
      ),
    ).toEqual([])
  })
  it('ignores sampled frames from a session that was left and accepts current-session changes', () => {
    const model = { ...initialModel, selectedSessionId: 'test', traceVersion: 2 }
    expect(update(model, Message.SampledTrace({ sessionId: 'other', version: 8 })).model).toBe(
      model,
    )
    expect(
      update(model, Message.SampledTrace({ sessionId: 'test', version: 8 })).model.traceVersion,
    ).toBe(8)
  })
  it('closes keyboard help before clearing span selection', () => {
    const model = { ...initialModel, selectedSpanId: 'a', helpOpen: true }
    const closed = update(model, Message.PressedChartKey({ key: 'Escape' })).model
    expect(closed.helpOpen).toBe(false)
    expect(closed.selectedSpanId).toBe('a')
    expect(
      update(closed, Message.PressedChartKey({ key: 'Escape' })).model.selectedSpanId,
    ).toBeUndefined()
  })
  it('ignores out-of-order file completions and replaces repeated imports instead of duplicating sessions', () => {
    const entry = { session: { ...session, sessionId: 'loaded:test' }, truncatedLines: 0 }
    const model = { ...initialModel, fileReadId: 2 }
    expect(update(model, Message.LoadedTrace({ entry, readId: 1 })).model).toBe(model)
    const loaded = update(model, Message.LoadedTrace({ entry, readId: 2 })).model
    expect(
      update(loaded, Message.LoadedTrace({ entry, readId: 2 })).model.loadedSessions,
    ).toHaveLength(1)
    expect(
      update(model, Message.FailedReadTrace({ error: 'stale', readId: 1 })).model.fileError,
    ).toBeUndefined()
  })
  it('resolves system theme changes and sequences canvas reflection after applying CSS', () => {
    const result = update(
      { ...initialModel, theme: 'system' },
      Message.GotSystemTheme({ dark: false }),
    )
    expect(result.model.resolvedTheme).toBe('light')
    expect(commandNames(result)).toEqual(['ApplyPreferences'])
    expect(commandNames(update(result.model, Message.AppliedPreferences()))).toEqual([
      'ReflectSelection',
    ])
  })
  it('clears resource-backed file metadata on development reload', () => {
    const model: Model = {
      ...initialModel,
      selectedSessionId: 'loaded:test',
      loadedSessions: [{ session: { ...session, sessionId: 'loaded:test' }, truncatedLines: 0 }],
    }
    const next = update(model, Message.StartedResources()).model
    expect(next.loadedSessions).toEqual([])
    expect(next.selectedSessionId).toBeUndefined()
  })
  it('reads and replays a saved trace without a collector and retains all file messages', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const file = new File(
          [
            serializeTraceFile(
              session,
              [
                {
                  _tag: 'Log',
                  sessionId: 'test',
                  time: 1n,
                  level: 'Info',
                  message: 'hello',
                  annotations: {},
                },
              ],
              2,
            ),
          ],
          'test.eitrace',
        )
        const loaded = yield* ReadTrace({ file, readId: 1 }).effect
        expect(loaded._tag).toBe('LoadedTrace')
        if (loaded._tag !== 'LoadedTrace') throw new Error('Expected a loaded file')
        const sampled = yield* SwitchTrace({ sessionId: loaded.entry.session.sessionId }).effect
        expect(sampled.sessionId).toBe('loaded:test')
        expect(traceStore.stats().logs).toBe(1)
        expect(loadedMessages.get('loaded:test')?.messages).toHaveLength(1)
        traceStore.clear()
        loadedMessages.clear()
      }),
    ))
})

describe('Foldkit inspector scenes', () => {
  it('keeps open available and save disabled while offline', () => {
    scene(
      { update, view },
      given({ ...initialModel, connection: { _tag: 'Disconnected' as const, attempt: 0 } }),
      expectView(testId('open-trace')).toBeEnabled(),
      expectView(testId('save-trace')).toBeDisabled(),
      expectView(text('Collector unreachable')).toExist(),
    )
  })
  it('renders an explicit not-found page from Model state', () => {
    scene(
      { update, view },
      given({ ...initialModel, path: '/missing' }),
      expectView(text('No such page')).toExist(),
      expectView(role('link', { name: 'Back to the inspector' })).toHaveAttr('href', '/'),
    )
  })
})
