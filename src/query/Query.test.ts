import { describe, expect, it } from 'bun:test'
import { Result } from 'effect'
import { traceFileHeaderCodec } from '../protocol/Codec.ts'
import type * as Protocol from '../protocol/Schema.ts'
import { serializeTraceFile } from '../trace/TraceFile.ts'
import * as Query from './Query.ts'

const origin = 5_000_000_000n
const at = (ms: number) => origin + BigInt(Math.round(ms * 1_000_000))
const sid = 'run-1'

const session = (overrides?: Partial<Protocol.Session>): Protocol.Session => ({
  sessionId: sid,
  program: 'test.ts',
  pid: 1,
  runtime: 'bun',
  clock: { startTime: origin, wallClockEpochMillis: 1_700_000_000_000 },
  active: false,
  endedAtEpochMillis: 1_700_000_001_000,
  ...overrides,
})

const start = (spanId: string, ms: number, parent?: string): Protocol.ClientMessage => ({
  _tag: 'SpanStart',
  sessionId: sid,
  spanId,
  traceId: 't',
  name: spanId.replace(/-\d+$/, ''),
  kind: 'internal',
  startTime: at(ms),
  attributes: {},
  sampled: true,
  ...(parent === undefined ? {} : { parent: { _tag: 'LocalParent' as const, spanId: parent } }),
})

const end = (
  spanId: string,
  ms: number,
  outcome: Protocol.SpanOutcome = { _tag: 'Success' },
): Protocol.ClientMessage => ({
  _tag: 'SpanEnd',
  sessionId: sid,
  spanId,
  endTime: at(ms),
  outcome,
  attributes: {},
})

const fail = (kind: 'Fail' | 'Die' | 'Interrupt', error = 'boom'): Protocol.SpanOutcomeFailure => ({
  _tag: 'Failure',
  kind,
  error,
})

const log = (
  ms: number,
  message: Protocol.Json,
  spanId?: string,
  level: Protocol.LogLevel = 'Info',
  annotations: Protocol.Attributes = {},
): Protocol.ClientMessage => ({
  _tag: 'Log',
  sessionId: sid,
  time: at(ms),
  level,
  message,
  annotations,
  ...(spanId === undefined ? {} : { spanId }),
})

const zeroCapture = { droppedMessages: 0, skippedLines: 0, conflictDetection: true }

const live = (
  messages: ReadonlyArray<Protocol.ClientMessage>,
  overrides?: Partial<Protocol.Session>,
  capture = zeroCapture,
): Query.TraceSource =>
  Query.fromSnapshot(
    {
      session: session(overrides),
      messages,
      droppedMessages: capture.droppedMessages,
      skippedLines: capture.skippedLines,
      conflictDetection: capture.conflictDetection,
    },
    1_700_000_002_000,
  )

/** Runs a per-session request, asserting it succeeds. */
const ok = (source: Query.TraceSource, request: unknown) => {
  const decoded = Query.decodeRequest(request)
  if (Result.isFailure(decoded)) throw new Error(decoded.failure.error.message)
  const response = Query.run(source, decoded.success as Query.SessionQuery)
  if (!response.ok) throw new Error(`${response.error._tag}: ${response.error.message}`)
  return response as Exclude<Query.QueryResponse, Query.QueryFailure | Query.SessionsResponse>
}

const errorTag = (response: Query.QueryResponse) => (response.ok ? 'ok' : response.error._tag)

describe('Query timing', () => {
  it('splits a span into the union of recorded children and the remainder', () => {
    // Children overlap (10-50, 30-70) and one outlives the parent (90-120).
    const source = live([
      start('parent', 0),
      start('a', 10, 'parent'),
      start('b', 30, 'parent'),
      end('a', 50),
      end('b', 70),
      start('c', 90, 'parent'),
      end('parent', 100),
      end('c', 120),
    ])
    const response = ok(source, { op: 'span', spanId: 'parent' })
    const span = response.op === 'span' ? response.result : undefined
    expect(span?.durationMs).toBe(100)
    expect(span?.childCoveredMs).toBe(70) // [10,70] ∪ [90,100], not 40+40+10
    expect(span?.outsideChildrenMs).toBe(30)
    expect(span?.children.items.map((child) => child.spanId)).toEqual(['a', 'b', 'c'])
    expect(response.time).toEqual({
      unit: 'ms',
      reference: 'sessionStart',
      observedFromMs: 0,
      observedUntilMs: 120,
    })
  })

  it('keeps open spans explicit instead of inventing a duration', () => {
    const source = live([
      start('root', 5),
      start('waiting', 10, 'root'),
      start('done', 10, 'root'),
      end('done', 400),
    ])
    const spans = ok(source, { op: 'spans', sort: 'duration' })
    const items = spans.op === 'spans' ? spans.result.items : []
    // Open spans interleave by elapsed lower bound (root >= 395 ranks above done = 390).
    expect(items.map((item) => [item.spanId, item.status])).toEqual([
      ['root', 'open'],
      ['done', 'ok'],
      ['waiting', 'open'],
    ])
    const root = items.find((item) => item.spanId === 'root')
    expect(root?.durationMs).toBeNull()
    expect(root?.outsideChildrenMs).toBeNull()
    expect(root?.elapsedLowerBoundMs).toBe(395)
    expect(spans.completeness.openSpans).toBe(2)
    // outsideChildren ranks an open span by its uncovered time so far (51 > short's 10).
    const uncovered = ok(
      live([
        start('open', 0),
        start('short', 0),
        end('short', 10),
        start('tail', 50),
        end('tail', 51),
      ]),
      { op: 'spans', sort: 'outsideChildren' },
    )
    expect(uncovered.op === 'spans' && uncovered.result.items.map((item) => item.spanId)).toEqual([
      'open',
      'short',
      'tail',
    ])

    const summary = ok(source, { op: 'summary' })
    expect(
      summary.op === 'summary' && summary.result.longestOpen.map((item) => item.spanId),
    ).toEqual(['root', 'waiting'])
  })

  it('puts notices and the innermost unfinished span of an ended session first', () => {
    const messages = [
      start('root', 0),
      start('work', 10, 'root'),
      start('step', 20, 'work'),
      start('done', 30, 'work'),
      end('done', 40),
      log(100, 'last'),
    ]
    // Disconnect recorded at 1000 ms; 5 oldest messages evicted.
    const summary = ok(live(messages, {}, { ...zeroCapture, droppedMessages: 5 }), {
      op: 'summary',
    }) as Query.SummaryResponse
    expect(Object.keys(summary).indexOf('notices')).toBeLessThan(
      Object.keys(summary).indexOf('result'),
    )
    const keys = Object.keys(summary.result)
    expect(keys.indexOf('unfinished')).toBeLessThan(keys.indexOf('longest'))
    expect(summary.termination).toEqual({
      state: 'ended',
      lastObservedMs: 100,
      endedAtMs: 1000,
      unobservedTailMs: 900,
    })
    const { unfinished } = summary.result
    expect(unfinished.open).toBe(3)
    expect(unfinished.innermost.items.map((item) => item.spanId)).toEqual(['step'])
    expect(unfinished.innermost.items[0]!.openAncestors).toEqual({
      items: [
        expect.objectContaining({ spanId: 'root', status: 'open', elapsedLowerBoundMs: 100 }),
        expect.objectContaining({ spanId: 'work', status: 'open', elapsedLowerBoundMs: 90 }),
      ],
      truncated: false,
    })
    expect(summary.notices.map((notice) => notice.code)).toEqual([
      'openSpans',
      'rankingsCompletedOnly',
      'collectorEvicted',
    ])
    expect(summary.notices[0]!.message).toContain('900 ms after the last retained message')
    expect(summary.notices[0]!.message).toContain(
      '"step" (spanId step), open for at least 80 ms, within "root" (spanId root), open for at least 100 ms',
    )

    const active = ok(live(messages, { active: true, endedAtEpochMillis: undefined }), {
      op: 'summary',
    }) as Query.SummaryResponse
    expect(active.termination.state).toBe('active')
    expect(active.notices[0]!.message).toContain('may still end')
    expect(JSON.stringify(active.notices)).not.toContain('crash')
  })

  it('places memory samples in time without attributing them to spans', () => {
    const mem = (ms: number, heapUsed: number): Protocol.ClientMessage => ({
      _tag: 'MemorySample',
      sessionId: sid,
      time: at(ms),
      heapUsed,
      heapTotal: 0,
      rss: heapUsed,
      external: 0,
    })
    // Samples every 10 ms, then a 500 ms gap; heap peaks at 30 inside 'leaf'.
    const source = live([
      start('root', 0),
      start('leaf', 25, 'root'),
      mem(0, 1),
      mem(10, 2),
      mem(20, 3),
      mem(30, 9),
      end('leaf', 35),
      mem(40, 4),
      mem(540, 5),
    ])
    const summary = ok(source, { op: 'summary' }) as Query.SummaryResponse
    expect(summary.result.memory).toMatchObject({
      peakHeapAtMs: 30,
      medianIntervalMs: 10,
      maxGapMs: 500,
      maxGapFromMs: 40,
      maxGapToMs: 540,
      spansActiveAtPeak: { total: 1, items: [expect.objectContaining({ spanId: 'leaf' })] },
    })
    const gap = summary.notices.find((notice) => notice.code === 'memorySamplingGap')
    expect(gap?.message).toContain('500 ms (from 40 ms to 540 ms)')
    expect(JSON.stringify(summary)).not.toMatch(/allocat|leak|retained by/i)

    const leaf = ok(source, { op: 'span', spanId: 'leaf' })
    expect(leaf.op === 'span' && leaf.result.processMemory).toEqual({
      samples: 1,
      firstSampleMs: 30,
      lastSampleMs: 30,
      firstHeapUsedBytes: 9,
      lastHeapUsedBytes: 9,
      maxHeapUsedBytes: 9,
    })
    // Open: measured up to the last observation.
    const root = ok(source, { op: 'span', spanId: 'root' })
    expect(root.op === 'span' && root.result.processMemory?.samples).toBe(6)
  })

  it('treats an open child of a closed span as covering it up to the parent end', () => {
    const source = live([start('p', 0), start('child', 20, 'p'), end('p', 50)])
    const response = ok(source, { op: 'span', spanId: 'p' })
    const span = response.op === 'span' ? response.result : undefined
    expect(span?.childCoveredMs).toBe(30)
    expect(span?.openChildCount).toBe(1)
  })
})

describe('Query failures and filters', () => {
  const source = live([
    start('ok-1', 0),
    end('ok-1', 10),
    start('charge-1', 5),
    end('charge-1', 25, fail('Fail', 'card declined '.repeat(100))),
    start('crash-1', 30),
    end('crash-1', 31, fail('Die')),
    start('race-1', 40),
    end('race-1', 90, fail('Interrupt')),
  ])

  it('distinguishes errors, defects and interruptions', () => {
    const statuses = (status: string) => {
      const response = ok(source, { op: 'spans', status })
      return response.op === 'spans' ? response.result.items.map((item) => item.spanId) : []
    }
    expect(statuses('failed')).toEqual(['charge-1', 'crash-1', 'race-1'])
    expect(statuses('error')).toEqual(['charge-1'])
    expect(statuses('defect')).toEqual(['crash-1'])
    expect(statuses('interrupted')).toEqual(['race-1'])
    expect(statuses('ok')).toEqual(['ok-1'])
  })

  it('bounds failure messages and lists real failures before interruptions', () => {
    const summary = ok(source, { op: 'summary' })
    if (summary.op !== 'summary') throw new Error('expected summary')
    expect(summary.result.spans).toEqual({
      total: 4,
      ok: 1,
      error: 1,
      defect: 1,
      interrupted: 1,
      open: 0,
    })
    expect(summary.result.failures.items.map((item) => item.spanId)).toEqual([
      'charge-1',
      'crash-1',
    ])
    const error = summary.result.failures.items[0]?.error
    expect(error?.message.length).toBe(Query.limits.errorChars)
    expect(error?.messageTruncated).toBe(true)
    expect(summary.result.longest[0]?.spanId).toBe('race-1')
  })

  it('filters by name, minimum duration and time overlap', () => {
    const ids = (request: object) => {
      const response = ok(source, { op: 'spans', ...request })
      return response.op === 'spans' ? response.result.items.map((item) => item.spanId) : []
    }
    expect(ids({ name: 'CHARGE' })).toEqual(['charge-1'])
    expect(ids({ minDurationMs: 20 })).toEqual(['charge-1', 'race-1'])
    expect(ids({ fromMs: 26, toMs: 35 })).toEqual(['crash-1'])
  })

  it('pages with a stable order and reports the next offset', () => {
    const many = live(
      Array.from({ length: 25 }, (_, i) => [start(`s-${i}`, i), end(`s-${i}`, i + 1)]).flat(),
    )
    const first = ok(many, { op: 'spans', limit: 10 })
    const last = ok(many, { op: 'spans', limit: 10, offset: 20 })
    if (first.op !== 'spans' || last.op !== 'spans') throw new Error('expected spans')
    expect(first.result).toMatchObject({ total: 25, offset: 0, limit: 10, nextOffset: 10 })
    expect(last.result.items.map((item) => item.spanId)).toEqual([
      's-20',
      's-21',
      's-22',
      's-23',
      's-24',
    ])
    expect(last.result.nextOffset).toBeNull()
    expect(last.query).toMatchObject({ status: 'any', sort: 'start', limit: 10, offset: 20 })
  })

  it('rejects invalid, oversized and misspelt requests', () => {
    const tag = (input: unknown) =>
      Result.match(Query.decodeRequest(input), {
        onSuccess: () => 'ok',
        onFailure: (failure) => failure.error._tag,
      })
    expect(tag({ op: 'spans', limit: 0 })).toBe('InvalidRequest')
    expect(tag({ op: 'spans', limit: Query.limits.spans.max + 1 })).toBe('InvalidRequest')
    expect(tag({ op: 'spans', stauts: 'failed' })).toBe('InvalidRequest')
    expect(tag({ op: 'spans', status: 'slow' })).toBe('InvalidRequest')
    expect(tag({ op: 'spans', fromMs: 10, toMs: 5 })).toBe('InvalidRequest')
    expect(tag({ op: 'nope' })).toBe('InvalidRequest')
    expect(tag({ op: 'spans', limit: Query.limits.spans.max })).toBe('ok')
  })
})

describe('Query span detail and logs', () => {
  const longValue = 'x'.repeat(Query.limits.valueChars + 10)
  const manyKeys = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]))
  const source = live([
    { ...(start('root', 0) as Extract<Protocol.ClientMessage, { _tag: 'SpanStart' }>) },
    start('mid', 1, 'root'),
    {
      ...(start('leaf', 2, 'mid') as Extract<Protocol.ClientMessage, { _tag: 'SpanStart' }>),
      attributes: { ...manyKeys, k0: longValue },
    },
    {
      _tag: 'SpanEvent',
      sessionId: sid,
      spanId: 'leaf',
      name: 'retry',
      time: at(3),
      attributes: {},
    },
    log(3, 'leaf says hi', 'leaf', 'Debug'),
    log(4, { structured: true }, 'mid', 'Warn'),
    log(4.5, 'x'.repeat(Query.limits.logMessageChars + 1), 'root', 'Error'),
    log(5, 'unrelated'),
    end('leaf', 6, {
      _tag: 'Failure',
      kind: 'Fail',
      error: 'boom',
      stack: 's'.repeat(Query.limits.stackChars + 5),
    }),
    end('mid', 7),
    end('root', 8),
    {
      _tag: 'SpanStart',
      sessionId: sid,
      spanId: 'ext',
      traceId: 'other',
      name: 'ext',
      kind: 'server',
      startTime: at(9),
      attributes: {},
      sampled: true,
      parent: { _tag: 'ExternalParent', spanId: 'remote', traceId: 'other', sampled: true },
    },
  ])

  it('returns ancestry, bounded attributes, events and stack', () => {
    const response = ok(source, { op: 'span', spanId: 'leaf' })
    if (response.op !== 'span') throw new Error('expected span')
    const leaf = response.result
    expect(leaf.ancestry).toEqual({
      items: [
        {
          spanId: 'root',
          name: 'root',
          nameTruncated: false,
          status: 'ok',
          startMs: 0,
          durationMs: 8,
        },
        {
          spanId: 'mid',
          name: 'mid',
          nameTruncated: false,
          status: 'ok',
          startMs: 1,
          durationMs: 6,
        },
      ],
      truncated: false,
    })
    expect(leaf.parent).toEqual({ kind: 'local', spanId: 'mid', retained: true })
    expect(leaf.attributes.omittedKeys).toBe(8)
    expect(leaf.attributes.entries).toHaveLength(Query.limits.attributeKeys)
    const k0 = leaf.attributes.entries[0]
    expect(k0).toMatchObject({ key: 'k0', keyTruncated: false, valueTruncated: true })
    expect(k0?.value).toHaveLength(Query.limits.valueChars)
    expect(leaf.attributes.entries[1]).toEqual({
      key: 'k1',
      keyTruncated: false,
      value: 1,
      valueTruncated: false,
    })
    expect(leaf.events).toEqual({
      total: 1,
      items: [
        {
          name: 'retry',
          nameTruncated: false,
          timeMs: 3,
          attributes: { entries: [], omittedKeys: 0 },
        },
      ],
    })
    expect(leaf.stackTruncated).toBe(true)
    expect(leaf.logCount).toBe(1)

    const ext = ok(source, { op: 'span', spanId: 'ext' })
    expect(ext.op === 'span' && ext.result.parent).toEqual({
      kind: 'external',
      spanId: 'remote',
      traceId: 'other',
    })
    expect(ext.op === 'span' && ext.result.parentSpanId).toBeNull()
  })

  it('bounds children of a wide span', () => {
    const wide = live([
      start('p', 0),
      ...Array.from({ length: 30 }, (_, i) => start(`c-${i}`, i + 1, 'p')),
    ])
    const response = ok(wide, { op: 'span', spanId: 'p', children: 3 })
    expect(response.op === 'span' && response.result.children.total).toBe(30)
    expect(response.op === 'span' && response.result.children.items.length).toBe(3)
  })

  it('correlates logs with a span or its subtree', () => {
    const messages = (request: object) => {
      const response = ok(source, { op: 'logs', ...request })
      return response.op === 'logs' ? response.result.items : []
    }
    expect(messages({ spanId: 'mid' }).map((item) => item.spanName)).toEqual(['leaf', 'mid'])
    expect(messages({ spanId: 'mid', scope: 'span' }).map((item) => item.message)).toEqual([
      '{"structured":true}',
    ])
    expect(messages({ minLevel: 'Warn' }).map((item) => item.level)).toEqual(['Warn', 'Error'])
    expect(messages({ fromMs: 4.5 }).map((item) => item.timeMs)).toEqual([4.5, 5])
    const long = messages({ minLevel: 'Error' })[0]
    expect(long?.message).toHaveLength(Query.limits.logMessageChars)
    expect(long?.messageTruncated).toBe(true)
    expect(messages({}).length).toBe(4)
  })

  it('reports an unknown span as SpanNotFound, not an empty success', () => {
    const decoded = Query.decodeRequest({ op: 'span', spanId: 'missing' })
    const response = Query.run(source, Result.getOrThrow(decoded) as Query.SessionQuery)
    expect(errorTag(response)).toBe('SpanNotFound')
    const logs = Query.run(
      source,
      Result.getOrThrow(
        Query.decodeRequest({ op: 'logs', spanId: 'missing' }),
      ) as Query.SessionQuery,
    )
    expect(errorTag(logs)).toBe('SpanNotFound')
  })
})

describe('Query completeness', () => {
  it('reports no recorded loss only when the collector counters are known and zero', () => {
    const response = ok(live([start('a', 0), end('a', 1)]), { op: 'summary' })
    expect(response.completeness).toEqual({
      status: 'noLossRecorded',
      collectorDroppedMessages: 0,
      collectorSkippedLines: 0,
      clientDroppedMessages: 0,
      fileTruncatedLines: 0,
      spansMissingStart: 0,
      spansOutOfOrder: 0,
      spansMissingParent: 0,
      openSpans: 0,
      retainedMessages: 2,
      messagesObserved: 2,
    })
    expect(response.conflict).toEqual({ count: 0, detection: 'enforced' })
  })

  it('counts capacity eviction, skipped lines, client drops and missing boundaries', () => {
    const source = live(
      [
        // Eviction took `gone`'s start; its end and event survived.
        end('gone', 2),
        {
          _tag: 'SpanEvent',
          sessionId: sid,
          spanId: 'gone',
          name: 'e',
          time: at(1),
          attributes: {},
        },
        start('orphan', 3, 'evicted-parent'),
        log(4, 'effect-inspect dropped 7 messages', undefined, 'Warn', {
          'effect_inspect.dropped': 7,
          'effect_inspect.droppedTotal': 7,
        }),
      ],
      undefined,
      { droppedMessages: 12, skippedLines: 1, conflictDetection: true },
    )
    const response = ok(source, { op: 'summary' })
    expect(response.completeness).toMatchObject({
      status: 'lossRecorded',
      collectorDroppedMessages: 12,
      collectorSkippedLines: 1,
      clientDroppedMessages: 7,
      spansMissingStart: 1,
      spansMissingParent: 1,
      messagesObserved: 16,
    })
    const orphan = ok(source, { op: 'span', spanId: 'orphan' })
    expect(orphan.op === 'span' && orphan.result.parent).toEqual({
      kind: 'local',
      spanId: 'evicted-parent',
      retained: false,
    })
  })

  it('marks an old collector client as unable to detect ID reuse', () => {
    const response = ok(live([], undefined, { ...zeroCapture, conflictDetection: false }), {
      op: 'summary',
    })
    expect(response.conflict).toEqual({ count: 0, detection: 'unavailable' })
    expect(response.time.observedUntilMs).toBeNull()
  })
})

describe('Query session selection', () => {
  it('refuses a conflicted session instead of answering for it', () => {
    const source = live([start('a', 0)], { conflicts: 2 })
    for (const op of ['summary', 'spans', 'logs'] as const) {
      const response = Query.run(source, { op })
      expect(errorTag(response)).toBe('SessionConflict')
      expect(response.ok ? undefined : response.error.conflicts).toBe(2)
    }
    const file = Query.queryFile(Query.toTraceFile(source), 'a.eitrace', { op: 'summary' })
    expect(errorTag(file)).toBe('SessionConflict')
  })

  it('lists sessions newest first, with conflicts visible', () => {
    const response = Query.listSessions(
      { kind: 'live', file: null },
      [
        session({ sessionId: 'old', clock: { startTime: 0n, wallClockEpochMillis: 1 } }),
        session({
          sessionId: 'new',
          clock: { startTime: 0n, wallClockEpochMillis: 2 },
          conflicts: 1,
        }),
      ],
      { op: 'sessions' },
    )
    if (!response.ok) throw new Error(response.error._tag)
    expect(response.result.items.map((item) => [item.sessionId, item.conflicts])).toEqual([
      ['new', 1],
      ['old', null],
    ])
  })

  it('matches a file only against its own exact session ID', () => {
    const text = Query.toTraceFile(live([start('a', 0), end('a', 1)]))
    expect(
      errorTag(Query.queryFile(text, 'x.eitrace', { op: 'summary', sessionId: 'run-2' })),
    ).toBe('SessionNotFound')
    expect(errorTag(Query.queryFile(text, 'x.eitrace', { op: 'summary', sessionId: sid }))).toBe(
      'ok',
    )
    expect(errorTag(Query.queryFile(text, 'x.eitrace', { op: 'summary' }))).toBe('ok')
    const resaved = serializeTraceFile(session({ sessionId: `loaded:${sid}` }), [], 1)
    expect(errorTag(Query.queryFile(resaved, 'x.eitrace', { op: 'summary', sessionId: sid }))).toBe(
      'ok',
    )
  })
})

describe('Query live/file equivalence', () => {
  const messages: ReadonlyArray<Protocol.ClientMessage> = [
    start('root', 0),
    start('work', 1, 'root'),
    log(2, 'working', 'work'),
    end('work', 30, fail('Fail')),
    start('open', 31, 'root'),
    {
      _tag: 'MemorySample',
      sessionId: sid,
      time: at(32),
      heapUsed: 10,
      heapTotal: 20,
      rss: 30,
      external: 0,
    },
    end('orphan-end', 33),
  ]
  const source = live(messages, undefined, {
    droppedMessages: 3,
    skippedLines: 0,
    conflictDetection: true,
  })
  const text = Query.toTraceFile(source)

  it('answers every query identically from a snapshot and its exported file', () => {
    for (const request of [
      { op: 'summary' },
      { op: 'spans', sort: 'outsideChildren' },
      { op: 'span', spanId: 'root' },
      { op: 'logs', spanId: 'root' },
      { op: 'span', spanId: 'missing' },
    ]) {
      const fromLive = Query.run(
        source,
        Result.getOrThrow(Query.decodeRequest(request)) as Query.SessionQuery,
      )
      const fromFile = Query.queryFile(text, 'saved.eitrace', request)
      const strip = (response: Query.QueryResponse) =>
        response.ok && 'source' in response
          ? { ...response, source: { ...response.source, kind: null, file: null } }
          : response
      expect(strip(fromFile)).toEqual(strip(fromLive))
    }
  })

  it('reports a cut-short file as loss while keeping what came before', () => {
    const cut = text.slice(0, text.lastIndexOf('\n', text.length - 2) + 20)
    const response = Query.queryFile(cut, 'cut.eitrace', { op: 'summary' })
    if (!response.ok || response.op !== 'summary') throw new Error(errorTag(response))
    expect(response.completeness.fileTruncatedLines).toBe(1)
    expect(response.completeness.status).toBe('lossRecorded')
    expect(response.result.spans.total).toBe(3)
  })

  it('reports an older or browser-saved file as unknown completeness', () => {
    const response = Query.queryFile(
      serializeTraceFile(session(), messages.slice(0, 4), 1),
      'old.eitrace',
      {
        op: 'summary',
      },
    )
    if (!response.ok || response.op !== 'summary') throw new Error(errorTag(response))
    expect(response.completeness).toMatchObject({
      status: 'unknown',
      collectorDroppedMessages: null,
      collectorSkippedLines: null,
      messagesObserved: null,
    })
    expect(response.conflict).toEqual({ count: null, detection: 'unknown' })
  })

  it('reports an unreadable file as TraceFileError', () => {
    expect(errorTag(Query.queryFile('not a trace\n', 'bad.eitrace', { op: 'summary' }))).toBe(
      'TraceFileError',
    )
    expect(errorTag(Query.queryFile('', 'empty.eitrace', { op: 'summary' }))).toBe('TraceFileError')
  })

  it('keeps the new header field compatible in both directions', () => {
    const header = text.slice(0, text.indexOf('\n'))
    // An older header (no capture) still decodes.
    const old = JSON.parse(header)
    delete old.capture
    expect(Result.isSuccess(traceFileHeaderCodec.decode(JSON.stringify(old)))).toBe(true)
    // Unknown header keys are ignored, which is how an older build reads `capture`.
    expect(
      Result.isSuccess(
        traceFileHeaderCodec.decode(JSON.stringify({ ...old, laterField: { x: 1 } })),
      ),
    ).toBe(true)
  })
})

describe('Query response bounds', () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
  const huge = 'n'.repeat(100_000)
  const wide = '界'.repeat(100_000)
  const emoji = `a${'😀'.repeat(50_000)}`

  const hugeSource = live(
    [
      ...Array.from({ length: 200 }, (_, i) => {
        const base = start(`s-${i}`, i) as Extract<Protocol.ClientMessage, { _tag: 'SpanStart' }>
        return {
          ...base,
          name: [huge, wide, emoji][i % 3]! + i,
          attributes: { [`${huge}${i}`]: wide, [`${wide}${i}`]: 1 },
        }
      }),
      ...Array.from({ length: 200 }, (_, i) =>
        end(`s-${i}`, i + 1, i % 2 === 0 ? fail('Fail', wide) : undefined),
      ),
      {
        _tag: 'SpanEvent',
        sessionId: sid,
        spanId: 's-0',
        name: wide,
        time: at(0.5),
        attributes: { [huge]: huge },
      },
      log(0.5, wide, 's-1', 'Info', { [huge]: wide }),
    ],
    { program: wide, runtime: huge },
  )

  it('keeps huge and non-ASCII names, keys and values under the byte bound', () => {
    for (const request of [
      { op: 'spans', limit: Query.limits.spans.max },
      { op: 'summary', top: Query.limits.top.max },
      { op: 'span', spanId: 's-0' },
      { op: 'logs', limit: Query.limits.logs.max },
    ]) {
      const response = ok(hugeSource, request)
      expect(bytes(response)).toBeLessThanOrEqual(Query.limits.responseBytes)
    }
    const spans = ok(hugeSource, { op: 'spans', limit: 3 })
    if (spans.op !== 'spans') throw new Error('expected spans')
    for (const item of spans.result.items) {
      expect(item.nameTruncated).toBe(true)
      expect(item.name.length).toBeLessThanOrEqual(Query.limits.nameChars)
      expect(item.name.isWellFormed()).toBe(true)
    }
    // The surrogate pair straddling the cut is dropped, not split.
    expect(spans.result.items[2]?.name).toHaveLength(Query.limits.nameChars - 1)
    // Identities stay exact and usable.
    expect(spans.result.items.map((item) => item.spanId)).toEqual(['s-0', 's-1', 's-2'])
    expect(spans.source).toMatchObject({ programTruncated: true, runtimeTruncated: true })

    const span = ok(hugeSource, { op: 'span', spanId: 's-0' })
    if (span.op !== 'span') throw new Error('expected span')
    expect(span.result.attributes.entries.map((entry) => entry.key.length)).toEqual([
      Query.limits.keyChars,
      Query.limits.keyChars,
    ])
    expect(span.result.attributes.entries.every((entry) => entry.keyTruncated)).toBe(true)
    expect(span.result.events.items[0]).toMatchObject({ nameTruncated: true })
    expect(span.result.error?.messageTruncated).toBe(true)

    const logs = ok(hugeSource, { op: 'logs', spanId: 's-1', scope: 'span' })
    if (logs.op !== 'logs') throw new Error('expected logs')
    expect(logs.result.items[0]).toMatchObject({ spanNameTruncated: true, messageTruncated: true })
    expect(logs.result.items[0]?.annotations.entries[0]).toMatchObject({
      keyTruncated: true,
      valueTruncated: true,
    })

    const summary = ok(hugeSource, { op: 'summary', top: 50 })
    if (summary.op !== 'summary') throw new Error('expected summary')
    expect(summary.result.names.total).toBe(200)
    expect(summary.result.names.items.every((group) => group.nameTruncated)).toBe(true)
  })

  it('refuses a response that only exact identifiers make too large, with a small error', () => {
    const longId = (i: number) => `${'i'.repeat(50_000)}-${i}`
    const source = live(
      Array.from({ length: 50 }, (_, i) => [start(longId(i), i), end(longId(i), i + 1)]).flat(),
    )
    const response = Query.run(source, { op: 'spans', limit: 50 })
    expect(response.ok ? 'ok' : response.error).toMatchObject({
      _tag: 'ResponseTooLarge',
      limitBytes: Query.limits.responseBytes,
      originalOutcome: 'ok',
    })
    expect(bytes(response)).toBeLessThan(2_000)
    // The same page, smaller, still returns the IDs verbatim.
    const small = ok(source, { op: 'spans', limit: 2 })
    expect(small.op === 'spans' && small.result.items[0]?.spanId).toBe(longId(0))
  })

  it('bounds echoes of untrusted request text and error details', () => {
    const tagAndSize = (response: Query.QueryResponse) => [
      response.ok ? 'ok' : response.error._tag,
      bytes(response) < 4_000,
    ]
    const text = Query.toTraceFile(live([start('a', 0), end('a', 1)]))
    const huge = 'x'.repeat(2_000_000)
    expect(tagAndSize(Query.queryFile(text, 'f', { op: huge }))).toEqual(['InvalidRequest', true])
    expect(Query.queryFile(text, 'f', { op: huge }).op).toBeNull()
    expect(tagAndSize(Query.queryFile(text, 'f', { op: 'spans', status: huge }))).toEqual([
      'InvalidRequest',
      true,
    ])
    expect(tagAndSize(Query.queryFile(text, 'f', { op: 'summary', sessionId: huge }))).toEqual([
      'InvalidRequest',
      true,
    ])
    expect(tagAndSize(Query.queryFile(text, 'f', { op: 'spans', name: huge }))).toEqual([
      'InvalidRequest',
      true,
    ])
    // A long but acceptable ID is echoed exactly in a SessionNotFound.
    const longest = 'y'.repeat(Query.limits.requestTextChars)
    const missing = Query.queryFile(text, 'f', { op: 'summary', sessionId: longest })
    expect(missing.ok ? undefined : missing.error.sessionId).toBe(longest)
    // A huge file label cannot inflate a failure past the bound either.
    const bad = Query.queryFile('not a trace', huge, { op: 'summary' })
    expect(tagAndSize(bad)).toEqual(['ResponseTooLarge', true])
    expect(bad.ok ? undefined : bad.error.originalOutcome).toBe('TraceFileError')
  })
})

describe('Query corrections', () => {
  it('measures observed time and open spans before the clock anchor', () => {
    const source = live([start('early', -10), end('early', -5), start('open', -8)])
    const spans = ok(source, { op: 'spans' })
    expect(spans.time).toMatchObject({ observedFromMs: -10, observedUntilMs: -5 })
    const open =
      spans.op === 'spans' ? spans.result.items.find((i) => i.spanId === 'open') : undefined
    expect(open?.elapsedLowerBoundMs).toBe(3)
    const empty = ok(live([]), { op: 'summary' })
    expect(empty.time).toMatchObject({ observedFromMs: null, observedUntilMs: null })
  })

  it('states how a time window was applied', () => {
    const source = live([start('long', 0), end('long', 100), start('late', 200), end('late', 210)])
    const windowed = ok(source, { op: 'spans', fromMs: 50, toMs: 60 })
    if (windowed.op !== 'spans') throw new Error('expected spans')
    expect(windowed.window).toEqual({
      fromMs: 50,
      toMs: 60,
      match: 'overlap',
      inclusive: true,
      timings: 'fullSpan',
    })
    // Selected by overlap; its duration is the whole span, not the 10ms in the window.
    expect(windowed.result.items.map((item) => [item.spanId, item.durationMs])).toEqual([
      ['long', 100],
    ])
    const edge = ok(source, { op: 'spans', fromMs: 100 })
    expect(edge.op === 'spans' && edge.result.items.map((item) => item.spanId)).toEqual([
      'long',
      'late',
    ])
    const plain = ok(source, { op: 'spans' })
    expect(plain.op === 'spans' && plain.window).toBeNull()
    const logs = ok(live([log(1, 'a'), log(2, 'b')]), { op: 'logs', toMs: 1 })
    expect(logs.op === 'logs' && logs.window).toEqual({
      fromMs: null,
      toMs: 1,
      match: 'within',
      inclusive: true,
    })
  })

  it('rejects a logs scope without a spanId instead of ignoring it', () => {
    const decoded = Query.decodeRequest({ op: 'logs', scope: 'span' })
    expect(Result.isFailure(decoded) && decoded.failure.error._tag).toBe('InvalidRequest')
    expect(Result.isFailure(decoded) && decoded.failure.error.hint).toContain('spanId')
    const all = ok(live([log(1, 'a', 'x'), log(2, 'b')]), { op: 'logs' })
    expect(all.op === 'logs' && all.result.total).toBe(2)
    expect(all.query).not.toHaveProperty('scope')
  })

  it('separates an end that arrived before its start from a missing start', () => {
    const response = ok(live([end('late-start', 5), start('late-start', 1), end('gone', 3)]), {
      op: 'summary',
    })
    expect(response.completeness).toMatchObject({
      status: 'lossRecorded',
      spansMissingStart: 1,
      spansOutOfOrder: 1,
    })
  })
})

describe('Query serialization', () => {
  it('serializes a live query and its file query byte-identically, source aside', () => {
    const source = live([start('a', 0), end('a', 1), log(0.5, 'x', 'a')])
    const text = Query.toTraceFile(source)
    for (const request of [
      { op: 'spans', sort: 'outsideChildren', fromMs: 0 },
      { op: 'logs', spanId: 'a', minLevel: 'Info' },
    ]) {
      const strip = (response: Query.QueryResponse) =>
        JSON.stringify(
          'source' in response
            ? { ...response, source: { ...response.source, kind: 0, file: 0 } }
            : response,
        )
      // The collector decodes too, which fixes key order to the schema's.
      const decoded = Result.getOrThrow(Query.decodeRequest({ ...request, sessionId: sid }))
      const fromLive = Query.run(source, decoded as Query.SessionQuery)
      expect(strip(Query.queryFile(text, 'f', request))).toBe(strip(fromLive))
    }
  })
})
