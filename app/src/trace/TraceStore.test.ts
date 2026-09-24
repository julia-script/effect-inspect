import { describe, expect, it } from 'bun:test'
import type { ClientMessage } from '../../../src/protocol/Schema.ts'
import { TraceStore } from './TraceStore.ts'

const ORIGIN = 1_000_000_000_000_000_000n
const ms = (n: number): bigint => ORIGIN + BigInt(n) * 1_000_000n

const hello = (): ClientMessage => ({
  _tag: 'Hello',
  sessionId: 's',
  program: 'test',
  pid: 1,
  runtime: 'bun',
  protocolVersion: 1,
  clock: { startTime: ORIGIN, wallClockEpochMillis: 1_700_000_000_000 },
})

const start = (
  spanId: string,
  at: number,
  parent?: string,
  attributes: Record<string, string> = {},
): ClientMessage => ({
  _tag: 'SpanStart',
  sessionId: 's',
  spanId,
  traceId: 't',
  name: `span-${spanId}`,
  kind: 'internal',
  startTime: ms(at),
  attributes,
  sampled: true,
  ...(parent === undefined ? {} : { parent: { _tag: 'LocalParent' as const, spanId: parent } }),
})

const end = (
  spanId: string,
  at: number,
  attributes: Record<string, string> = {},
): ClientMessage => ({
  _tag: 'SpanEnd',
  sessionId: 's',
  spanId,
  endTime: ms(at),
  outcome: { _tag: 'Success' },
  attributes,
})

describe('TraceStore', () => {
  it('nests spans and assigns depth and rows', () => {
    const store = new TraceStore()
    store.applyAll([hello(), start('a', 0), start('b', 1, 'a'), start('c', 2, 'b')])

    expect(store.roots).toEqual(['a'])
    expect(store.spans.get('c')!.depth).toBe(2)
    expect(store.rows.map((row) => [...row])).toEqual([['a'], ['b'], ['c']])
    expect(store.spans.get('a')!.children).toEqual(['b'])
  })

  it('re-links and re-depths a child that arrives before its parent', () => {
    const store = new TraceStore()
    // child `b` (and grandchild `c`) beat parent `a` to the wire.
    store.applyAll([hello(), start('b', 1, 'a'), start('c', 2, 'b'), start('a', 0)])

    const b = store.spans.get('b')!
    expect(b.orphaned).toBe(false)
    expect(b.depth).toBe(1)
    expect(store.spans.get('c')!.depth).toBe(2)
    expect(store.roots).toEqual(['a'])
    expect(store.rows.map((row) => [...row])).toEqual([['a'], ['b'], ['c']])
  })

  it('merges late attributes from SpanEnd over the SpanStart ones', () => {
    const store = new TraceStore()
    store.applyAll([hello(), start('a', 0, undefined, { keep: 'yes', over: 'old' })])
    store.apply(end('a', 5, { over: 'new', late: 'added' }))

    expect(store.spans.get('a')!.attributes).toEqual({ keep: 'yes', over: 'new', late: 'added' })
    expect(store.spans.get('a')!.end).toBe(5)
    expect(store.openSpans.size).toBe(0)
  })

  it('tracks open spans, errors and duration', () => {
    const store = new TraceStore()
    store.applyAll([hello(), start('a', 0), start('b', 1)])
    expect(store.stats().openSpans).toBe(2)

    store.apply({
      _tag: 'SpanEnd',
      sessionId: 's',
      spanId: 'a',
      endTime: ms(10),
      outcome: { _tag: 'Failure', kind: 'Fail', error: 'boom' },
      attributes: {},
    })

    const stats = store.stats()
    expect(stats.spans).toBe(2)
    expect(stats.openSpans).toBe(1)
    expect(stats.errors).toBe(1)
    expect(stats.duration).toBe(10)
  })

  it('keeps nanosecond-scale relative times precise as millis', () => {
    const store = new TraceStore()
    store.applyAll([hello(), start('a', 0)])
    store.apply({
      _tag: 'SpanEnd',
      sessionId: 's',
      spanId: 'a',
      endTime: ORIGIN + 1_500_000n, // 1.5ms
      outcome: { _tag: 'Success' },
      attributes: {},
    })
    expect(store.spans.get('a')!.end).toBe(1.5)
  })

  it('treats an external parent as a root', () => {
    const store = new TraceStore()
    store.applyAll([
      hello(),
      {
        _tag: 'SpanStart',
        sessionId: 's',
        spanId: 'a',
        traceId: 't',
        parent: { _tag: 'ExternalParent', spanId: 'x', traceId: 'y', sampled: true },
        name: 'a',
        kind: 'internal',
        startTime: ms(0),
        attributes: {},
        sampled: true,
      },
    ])
    expect(store.roots).toEqual(['a'])
    expect(store.spans.get('a')!.depth).toBe(0)
  })

  it('ignores a SpanEnd with no matching SpanStart and a duplicate SpanStart', () => {
    const store = new TraceStore()
    store.applyAll([hello(), end('ghost', 5), start('a', 0), start('a', 9)])

    expect(store.spans.size).toBe(1)
    expect(store.spans.get('a')!.start).toBe(0)
    expect(store.stats().spans).toBe(1)
  })

  it('records logs and span events against the timeline', () => {
    const store = new TraceStore()
    store.applyAll([
      hello(),
      start('a', 0),
      { _tag: 'SpanEvent', sessionId: 's', spanId: 'a', name: 'tick', time: ms(3), attributes: {} },
      {
        _tag: 'Log',
        sessionId: 's',
        time: ms(4),
        level: 'Info',
        message: 'hello',
        spanId: 'a',
        annotations: {},
      },
    ])

    expect(store.spans.get('a')!.events).toEqual([{ name: 'tick', time: 3, attributes: {} }])
    expect(store.logs).toHaveLength(1)
    expect(store.logs[0]!.time).toBe(4)
    expect(store.stats().events).toBe(1)
  })

  it('collapses a batch into a single version bump and clears', () => {
    const store = new TraceStore()
    const before = store.version
    store.applyAll([hello(), start('a', 0), start('b', 1, 'a')])
    expect(store.version).toBe(before + 1)

    store.clear()
    expect(store.spans.size).toBe(0)
    expect(store.rows).toHaveLength(0)
    expect(store.origin).toBeUndefined()
  })
})
