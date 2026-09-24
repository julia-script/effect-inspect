/**
 * Traversal tests.
 *
 * Built on small hand-made traces where the expected answer is obvious, plus
 * one pass over the committed 13k-span fixture to prove the walk holds on a
 * real trace — no collector and no browser needed.
 */
import { describe, expect, it } from 'bun:test'
import { Result } from 'effect'
import type { ClientMessage } from '../../../src/protocol/Schema.ts'
import { TraceStore } from '../trace/TraceStore.ts'
import { parseTraceFile } from '../trace/TraceFile.ts'
import { firehoseTraceFile } from '../trace/fixtures/fixtures.ts'
import { firstSpan, step } from './navigate.ts'

const ORIGIN = 1_000_000_000_000_000_000n
const ms = (n: number): bigint => ORIGIN + BigInt(Math.round(n * 1_000_000))

const start = (spanId: string, at: number, parent?: string): ClientMessage => ({
  _tag: 'SpanStart',
  sessionId: 's',
  spanId,
  traceId: 't',
  name: spanId,
  kind: 'internal',
  startTime: ms(at),
  attributes: {},
  sampled: true,
  ...(parent === undefined ? {} : { parent: { _tag: 'LocalParent' as const, spanId: parent } }),
})

const end = (spanId: string, at: number): ClientMessage => ({
  _tag: 'SpanEnd',
  sessionId: 's',
  spanId,
  endTime: ms(at),
  outcome: { _tag: 'Success' },
  attributes: {},
})

const store = (messages: ReadonlyArray<ClientMessage>): TraceStore => {
  const traceStore = new TraceStore()
  traceStore.applyAll(messages)
  return traceStore
}

/** root ─┬─ a (0..10) ─── a1 (1..4) / a2 (5..9)
 *        └─ b (20..30) */
const tree = (): TraceStore =>
  store([
    start('root', 0),
    start('a', 0, 'root'),
    start('a1', 1, 'a'),
    end('a1', 4),
    start('a2', 5, 'a'),
    end('a2', 9),
    end('a', 10),
    start('b', 20, 'root'),
    end('b', 30),
    end('root', 30),
  ])

describe('navigate', () => {
  it('walks up to the parent and down to the earliest child', () => {
    const s = tree()
    expect(step(s, 'a1', 'parent')).toBe('a')
    expect(step(s, 'a', 'parent')).toBe('root')
    expect(step(s, 'a', 'child')).toBe('a1')
    expect(step(s, 'root', 'child')).toBe('a')
  })

  it('walks siblings in start order, not arrival order', () => {
    // a2 is appended to `a.children` after a1 and also starts later, so both
    // orders agree here; the reversed case below is the one that matters.
    const s = tree()
    expect(step(s, 'a1', 'next')).toBe('a2')
    expect(step(s, 'a2', 'previous')).toBe('a1')
    expect(step(s, 'a', 'next')).toBe('b')
    expect(step(s, 'b', 'previous')).toBe('a')
  })

  it('orders siblings by start even when they arrive out of order', () => {
    // `late` starts first but arrives second — arrival order would put it
    // after `early`, which is not what the eye sees on the row.
    const s = store([start('root', 0), start('early', 5, 'root'), start('late', 1, 'root')])
    expect(step(s, 'root', 'child')).toBe('late')
    expect(step(s, 'late', 'next')).toBe('early')
    expect(step(s, 'early', 'previous')).toBe('late')
  })

  it('stops at the edges instead of wrapping', () => {
    const s = tree()
    expect(step(s, 'root', 'parent')).toBeUndefined()
    expect(step(s, 'a1', 'previous')).toBeUndefined()
    expect(step(s, 'b', 'next')).toBeUndefined()
    expect(step(s, 'a1', 'child')).toBeUndefined()
  })

  it('treats the other roots as a root span’s siblings', () => {
    const s = store([start('r1', 0), start('r2', 10), start('r3', 20)])
    expect(step(s, 'r1', 'next')).toBe('r2')
    expect(step(s, 'r2', 'next')).toBe('r3')
    expect(step(s, 'r2', 'previous')).toBe('r1')
    expect(step(s, 'r1', 'parent')).toBeUndefined()
  })

  it('returns undefined for an unknown span rather than throwing', () => {
    const s = tree()
    expect(step(s, 'nope', 'parent')).toBeUndefined()
    expect(step(s, 'nope', 'next')).toBeUndefined()
  })

  it('cannot reach a parent that has not arrived yet', () => {
    // An orphan's parent id points at nothing, so up does not move. Its
    // siblings are the roots, because that is the row it is drawn on.
    const s = store([start('orphan', 5, 'missing'), start('r', 0)])
    expect(s.spans.get('orphan')?.orphaned).toBe(true)
    expect(step(s, 'orphan', 'parent')).toBeUndefined()
    expect(step(s, 'orphan', 'previous')).toBe('r')
  })

  it('down then up returns to where it started', () => {
    const s = tree()
    const down = step(s, 'a', 'child')!
    expect(step(s, down, 'parent')).toBe('a')
  })

  it('picks the earliest root as the first selection', () => {
    expect(firstSpan(store([start('late', 10), start('early', 1)]))).toBe('early')
    expect(firstSpan(new TraceStore())).toBeUndefined()
  })

  it('traverses the real 13k-span fixture', () => {
    const parsed = Result.getOrThrow(parseTraceFile(firehoseTraceFile()))
    const s = new TraceStore()
    s.applyAll(parsed.messages)
    expect(s.stats().spans).toBeGreaterThan(13_000)

    // Walk the whole top row: every step moves forward in start time, no step
    // repeats, and the walk terminates. A traversal bug shows up here as a
    // cycle or an early stop.
    const root = firstSpan(s)!
    let cursor: string | undefined = root
    const seen = new Set<string>()
    let last = Number.NEGATIVE_INFINITY
    while (cursor !== undefined) {
      expect(seen.has(cursor)).toBe(false)
      seen.add(cursor)
      const span = s.spans.get(cursor)!
      expect(span.start).toBeGreaterThanOrEqual(last)
      last = span.start
      cursor = step(s, cursor, 'next')
    }
    expect(seen.size).toBe(s.roots.length)

    // Descend as deep as the trace goes, checking the parent link inverts each
    // step, then climb back to a root.
    let down: string = root
    const chain: Array<string> = [down]
    for (;;) {
      const child = step(s, down, 'child')
      if (child === undefined) break
      expect(step(s, child, 'parent')).toBe(down)
      down = child
      chain.push(down)
    }
    expect(chain.length).toBeGreaterThan(1)
    for (let i = chain.length - 1; i > 0; i--) {
      expect(step(s, chain[i]!, 'parent')).toBe(chain[i - 1])
    }
  })
})
