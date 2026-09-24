import { describe, expect, it } from 'bun:test'
import { Result } from 'effect'
import { clientCodec } from '../../../src/protocol/Codec.ts'
import type { ClientMessage, Session } from '../../../src/protocol/Schema.ts'
import { traceFileFormatVersion } from '../../../src/protocol/Schema.ts'
import {
  isLoadedSession,
  loadedSession,
  parseTraceFile,
  serializeTraceFile,
  traceFileName,
} from './TraceFile.ts'
import { firehoseTraceFile } from './fixtures/fixtures.ts'
import { TraceStore } from './TraceStore.ts'

const ORIGIN = 1_000_000_000_000_000_000n
const ms = (n: number): bigint => ORIGIN + BigInt(n) * 1_000_000n

const session: Session = {
  sessionId: 's-1',
  program: '/Users/someone/examples/webapp.ts',
  pid: 4242,
  runtime: 'bun 1.4.2',
  clock: { startTime: ORIGIN, wallClockEpochMillis: 1_700_000_000_000 },
  active: true,
}

const start = (spanId: string, at: number, parent?: string): ClientMessage => ({
  _tag: 'SpanStart',
  sessionId: 's-1',
  spanId,
  traceId: 't',
  name: `span-${spanId}`,
  kind: 'internal',
  startTime: ms(at),
  attributes: { where: spanId },
  sampled: true,
  ...(parent === undefined ? {} : { parent: { _tag: 'LocalParent' as const, spanId: parent } }),
})

const end = (spanId: string, at: number): ClientMessage => ({
  _tag: 'SpanEnd',
  sessionId: 's-1',
  spanId,
  endTime: ms(at),
  outcome: { _tag: 'Success' },
  attributes: {},
})

const messages: ReadonlyArray<ClientMessage> = [
  start('a', 0),
  start('b', 1, 'a'),
  {
    _tag: 'SpanEvent',
    sessionId: 's-1',
    spanId: 'b',
    name: 'cache.miss',
    time: ms(2),
    attributes: { key: 'x' },
  },
  end('b', 3),
  {
    _tag: 'Log',
    sessionId: 's-1',
    time: ms(4),
    level: 'Info',
    message: 'hello',
    spanId: 'a',
    annotations: {},
  },
  end('a', 5),
]

const saved = (): string => serializeTraceFile(session, messages, 1_700_000_009_000)

/** Everything the chart and event log actually read, as a comparable value. */
const render = (store: TraceStore) => ({
  stats: store.stats(),
  origin: store.origin,
  roots: [...store.roots],
  spans: [...store.spans.values()]
    .map((span) => ({
      ...span,
      children: [...span.children],
      events: span.events.map((event) => ({ ...event })),
    }))
    .sort((a, b) => a.spanId.localeCompare(b.spanId)),
  logs: store.logs.map((log) => ({ ...log })),
})

describe('serializeTraceFile', () => {
  it('writes a header line then one line per message', () => {
    const lines = saved()
      .split('\n')
      .filter((line) => line !== '')
    expect(lines).toHaveLength(messages.length + 1)
    expect(JSON.parse(lines[0]!)._tag).toBe('TraceFileHeader')
    expect(JSON.parse(lines[1]!)._tag).toBe('SpanStart')
  })

  it('writes body lines byte-identically to the wire encoding', () => {
    const body = saved().split('\n').slice(1, -1).join('\n')
    expect(`${body}\n`).toBe(messages.map((m) => clientCodec.encode(m)).join(''))
  })
})

describe('parseTraceFile', () => {
  it('round-trips the messages exactly, including bigint nanos', () => {
    const parsed = Result.getOrThrow(parseTraceFile(saved()))
    expect(parsed.messages).toEqual(messages)
    expect(parsed.truncatedLines).toBe(0)
    expect(parsed.header.session.clock.startTime).toBe(ORIGIN)
    expect(parsed.header.formatVersion).toBe(traceFileFormatVersion)
  })

  it('renders structurally identically to the live trace it was saved from', () => {
    const live = new TraceStore()
    live.applyAll(messages)

    const cold = new TraceStore()
    cold.applyAll(Result.getOrThrow(parseTraceFile(saved())).messages)

    expect(render(cold)).toEqual(render(live))
  })

  it('carries a message the trace model does not render', () => {
    const metrics: ClientMessage = {
      _tag: 'Metrics',
      sessionId: 's-1',
      time: ms(1),
      metrics: [
        {
          type: 'Gauge',
          name: 'heap',
          attributes: {},
          state: { value: 1024 },
        },
      ],
    }
    const text = serializeTraceFile(session, [...messages, metrics], 1)
    expect(Result.getOrThrow(parseTraceFile(text)).messages).toContainEqual(metrics)
  })

  it('reports a truncated final line instead of failing', () => {
    const text = saved()
    const cut = text.slice(0, text.length - 40)
    const parsed = Result.getOrThrow(parseTraceFile(cut))
    expect(parsed.truncatedLines).toBe(1)
    expect(parsed.messages).toEqual(messages.slice(0, -1))
  })

  it('fails on a truncated header', () => {
    const result = parseTraceFile(saved().slice(0, 30))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.message).toInclude('not an effect-inspect')
  })

  it('fails on an empty file', () => {
    expect(Result.isFailure(parseTraceFile(''))).toBe(true)
  })

  it('fails on a corrupt interior line rather than rendering a trace with a hole', () => {
    const lines = saved().split('\n')
    lines[3] = '{ not json'
    const result = parseTraceFile(lines.join('\n'))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.message).toInclude('corrupt')
  })

  it('fails on a format version from the future', () => {
    const lines = saved().split('\n')
    lines[0] = lines[0]!.replace(
      `"formatVersion":${traceFileFormatVersion}`,
      `"formatVersion":${traceFileFormatVersion + 1}`,
    )
    const result = parseTraceFile(lines.join('\n'))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.message).toInclude('format version')
  })

  it('rejects a plain NDJSON message stream with no header', () => {
    expect(
      Result.isFailure(parseTraceFile(messages.map((m) => clientCodec.encode(m)).join(''))),
    ).toBe(true)
  })
})

describe('loadedSession', () => {
  it('namespaces the id so it cannot collide with the live session', () => {
    const header = Result.getOrThrow(parseTraceFile(saved())).header
    const loaded = loadedSession(header)
    expect(loaded.sessionId).not.toBe(session.sessionId)
    expect(isLoadedSession(loaded.sessionId)).toBe(true)
    expect(isLoadedSession(session.sessionId)).toBe(false)
    expect(loaded.active).toBe(false)
    expect(loaded.clock).toEqual(session.clock)
  })

  it('survives a second save/load round trip unchanged', () => {
    const once = Result.getOrThrow(parseTraceFile(saved()))
    const twice = Result.getOrThrow(
      parseTraceFile(serializeTraceFile(loadedSession(once.header), once.messages, 2)),
    )
    expect(twice.messages).toEqual(messages)
  })
})

describe('traceFileName', () => {
  it('uses the program file name, not its path', () => {
    expect(traceFileName(session, 1_700_000_009_000)).toMatch(/^webapp\.ts-[\d-]+T[\d-]+\.eitrace$/)
  })

  it('never produces a path separator or an empty name', () => {
    expect(traceFileName({ ...session, program: '../../etc/passwd' }, 1)).not.toInclude('/')
    expect(traceFileName({ ...session, program: '///' }, 1)).toStartWith('trace-')
  })
})

describe('the committed firehose fixture', () => {
  it('loads a real 13k-span trace with no collector and renders it', () => {
    const parsed = Result.getOrThrow(parseTraceFile(firehoseTraceFile()))
    expect(parsed.truncatedLines).toBe(0)
    expect(parsed.header.session.program).toBe('example:firehose')

    const store = new TraceStore()
    store.applyAll(parsed.messages)
    const stats = store.stats()
    expect(stats.spans).toBeGreaterThan(13_000)
    expect(stats.openSpans).toBe(0)
    expect([...store.spans.values()].filter((span) => span.orphaned)).toHaveLength(0)
    expect(stats.duration).toBeGreaterThan(0)
  })
})

describe('re-saving a loaded trace', () => {
  it('does not stack the loaded prefix on the session id', () => {
    const once = loadedSession(Result.getOrThrow(parseTraceFile(saved())).header)
    const twice = loadedSession(
      Result.getOrThrow(parseTraceFile(serializeTraceFile(once, messages, 2))).header,
    )
    expect(twice.sessionId).toBe(once.sessionId)
  })
})
