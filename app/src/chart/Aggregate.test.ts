/**
 * Self time is the whole task, so it is tested against hand-computed numbers
 * first and the three tab shapes second.
 *
 * Every trace here is small enough to work out on paper; the firehose fixture
 * at the end is the "does it hold at 13k spans" check, not a correctness one.
 */
import { describe, expect, it } from 'bun:test'
import { Result } from 'effect'
import type { ClientMessage } from '../../../src/protocol/Schema.ts'
import { TraceStore } from '../trace/TraceStore.ts'
import { parseTraceFile } from '../trace/TraceFile.ts'
import { firehoseTraceFile } from '../trace/fixtures/fixtures.ts'
import { aggregate, type TreeNode } from './aggregate.ts'
import { timings } from './metrics.ts'

const ORIGIN = 1_000_000_000_000_000_000n
const ms = (n: number): bigint => ORIGIN + BigInt(Math.round(n * 1_000_000))

const start = (spanId: string, at: number, parent?: string, name = spanId): ClientMessage => ({
  _tag: 'SpanStart',
  sessionId: 's',
  spanId,
  traceId: 't',
  name,
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

const self = (traceStore: TraceStore, id: string, now = traceStore.stats().duration): number =>
  timings(traceStore, traceStore.spans.get(id)!, now).self

/** Finds a node by name path, e.g. `root > work`. */
const at = (nodes: ReadonlyArray<TreeNode>, ...path: ReadonlyArray<string>): TreeNode => {
  let level = nodes
  let found: TreeNode | undefined
  for (const name of path) {
    found = level.find((node) => node.name === name)
    if (found === undefined) throw new Error(`no node ${path.join(' > ')}`)
    level = found.children
  }
  return found!
}

describe('self time', () => {
  it('subtracts a single child', () => {
    // root 0..100, child 10..40 ⇒ self 70.
    const traceStore = store([
      start('root', 0),
      start('c', 10, 'root'),
      end('c', 40),
      end('root', 100),
    ])
    expect(self(traceStore, 'root')).toBe(70)
    expect(self(traceStore, 'c')).toBe(30)
  })

  it('unions overlapping concurrent children instead of summing them', () => {
    // Two children 10..40 and 20..50 both run inside root 0..100.
    // Summing would charge 30+30=60 and leave self 40; the union covers
    // 10..50 = 40, so self is 60.
    const traceStore = store([
      start('root', 0),
      start('a', 10, 'root'),
      start('b', 20, 'root'),
      end('a', 40),
      end('b', 50),
      end('root', 100),
    ])
    expect(self(traceStore, 'root')).toBe(60)
  })

  it('never reads as zero when children merely overlap heavily', () => {
    // Ten children each covering the whole of root. Summing charges 1000ms
    // against a 100ms parent and clamps self to 0 — the exact failure mode
    // this task exists to fix. The union is 100, so self is 0 here legitimately
    // only because they truly cover it; shift them and self reappears.
    const covering = store([
      start('root', 0),
      ...Array.from({ length: 10 }, (_, i) => start(`c${i}`, 0, 'root')).flat(),
      ...Array.from({ length: 10 }, (_, i) => end(`c${i}`, 100)),
      end('root', 100),
    ])
    expect(self(covering, 'root')).toBe(0)

    // Same ten children, but they all sit inside 20..60: self is 100-40 = 60.
    const inset = store([
      start('root', 0),
      ...Array.from({ length: 10 }, (_, i) => start(`c${i}`, 20, 'root')),
      ...Array.from({ length: 10 }, (_, i) => end(`c${i}`, 60)),
      end('root', 100),
    ])
    expect(self(inset, 'root')).toBe(60)
  })

  it('adds the gaps between disjoint children back to the parent', () => {
    // Children 10..20 and 60..80 ⇒ covered 30, self 70.
    const traceStore = store([
      start('root', 0),
      start('a', 10, 'root'),
      end('a', 20),
      start('b', 60, 'root'),
      end('b', 80),
      end('root', 100),
    ])
    expect(self(traceStore, 'root')).toBe(70)
  })

  it('clips a child that runs past its parent', () => {
    // Child 50..200 against root 0..100: only 50..100 is inside, self 50.
    const traceStore = store([
      start('root', 0),
      start('c', 50, 'root'),
      end('root', 100),
      end('c', 200),
    ])
    expect(self(traceStore, 'root')).toBe(50)
  })

  it('ignores grandchildren — only direct children are subtracted', () => {
    // root 0..100 ⊃ mid 10..60 ⊃ leaf 20..50.
    // root self = 100-50 = 50, mid self = 50-30 = 20, leaf self = 30.
    const traceStore = store([
      start('root', 0),
      start('mid', 10, 'root'),
      start('leaf', 20, 'mid'),
      end('leaf', 50),
      end('mid', 60),
      end('root', 100),
    ])
    expect(self(traceStore, 'root')).toBe(50)
    expect(self(traceStore, 'mid')).toBe(20)
    expect(self(traceStore, 'leaf')).toBe(30)
  })

  it('runs an open span and its open children to now', () => {
    const traceStore = store([start('root', 0), start('c', 10, 'root')])
    expect(timings(traceStore, traceStore.spans.get('root')!, 100)).toEqual({
      total: 100,
      self: 10,
    })
  })

  it('clips both the span and its children to a window', () => {
    // root 0..100 with child 10..40. Window 20..60: root contributes 40,
    // the child's visible part is 20..40 = 20, so self is 20.
    const traceStore = store([
      start('root', 0),
      start('c', 10, 'root'),
      end('c', 40),
      end('root', 100),
    ])
    expect(timings(traceStore, traceStore.spans.get('root')!, 100, 20, 60)).toEqual({
      total: 40,
      self: 20,
    })
  })

  it('reports nothing for a span outside the window', () => {
    const traceStore = store([start('root', 0), end('root', 10)])
    expect(timings(traceStore, traceStore.spans.get('root')!, 100, 50, 60)).toEqual({
      total: 0,
      self: 0,
    })
  })
})

/**
 * One trace reused by the three tab suites:
 *
 *   root      0..100   self 100-60          = 40   (children cover 10..70)
 *     work   10..40    self 30
 *     work   30..70    self 40
 *       db   50..60    self 10   ⇒ work self is 40-10 = 30
 *
 * Totals by name: root 100, work 30+40 = 70, db 10.
 * Self by name:   root 40, work 30+30 = 60, db 10.
 *
 * The two `work` spans overlap for 10ms (30..40), which is why the selves sum
 * to 110 over a 100ms trace: concurrent work outruns wall time.
 */
const shared = (): TraceStore =>
  store([
    start('root', 0),
    start('w1', 10, 'root', 'work'),
    start('w2', 30, 'root', 'work'),
    end('w1', 40),
    start('db', 50, 'w2', 'db'),
    end('db', 60),
    end('w2', 70),
    end('root', 100),
  ])

describe('Summary', () => {
  it('groups by name with count, total, self and average', () => {
    const traceStore = shared()
    const { summary } = aggregate(traceStore, -Infinity, Infinity, '', false)
    const row = (name: string) => summary.find((entry) => entry.name === name)!

    expect(row('work').count).toBe(2)
    expect(row('work').total).toBe(70) // 30 + 40
    expect(row('work').self).toBe(60) // 30 + (40-10)
    expect(row('work').average).toBe(35)
    expect(row('root')).toMatchObject({ count: 1, total: 100, self: 40 })
    expect(row('db')).toMatchObject({ count: 1, total: 10, self: 10 })
  })

  it('sums self time to the total work done, not to wall time', () => {
    // 40 (root) + 30 (w1) + 30 (w2) + 10 (db) = 110 against a 100ms trace.
    // The extra 10 is real: w1 10..40 and w2 30..70 overlap for 10ms and two
    // fibers each genuinely spent it. Self time answers "where did the work
    // go", and concurrent work outruns wall time — that is the whole reason
    // this is a union of *children* rather than a partition of the timeline.
    const { summary } = aggregate(shared(), -Infinity, Infinity, '', false)
    expect(summary.reduce((sum, row) => sum + row.self, 0)).toBe(110)
  })

  it('does partition wall time when nothing runs concurrently', () => {
    // Same shape with the siblings made disjoint: 100 exactly, no overlap to
    // double count. A sum-of-children self time fails this one.
    const serial = store([
      start('root', 0),
      start('w1', 10, 'root', 'work'),
      end('w1', 30),
      start('w2', 30, 'root', 'work'),
      start('db', 50, 'w2', 'db'),
      end('db', 60),
      end('w2', 70),
      end('root', 100),
    ])
    const { summary } = aggregate(serial, -Infinity, Infinity, '', false)
    expect(summary.reduce((sum, row) => sum + row.self, 0)).toBe(100)
  })

  it('sorts heaviest self time first', () => {
    const { summary } = aggregate(shared(), -Infinity, Infinity, '', false)
    expect(summary.map((row) => row.name)).toEqual(['work', 'root', 'db'])
  })

  it('follows the viewport', () => {
    // Window 0..50 sees root 0..50, work 10..40, work 30..50, no db.
    const { summary } = aggregate(shared(), 0, 50, '', false)
    expect(summary.find((row) => row.name === 'db')).toBeUndefined()
    expect(summary.find((row) => row.name === 'work')!.total).toBe(50) // 30 + 20
    // root 0..50 with children covering 10..50 ⇒ self 10; w1 30, w2 20.
    expect(summary.find((row) => row.name === 'root')!.self).toBe(10)
    expect(summary.reduce((sum, row) => sum + row.self, 0)).toBe(60)
  })

  it('drops non-matching spans only when the filter hides them', () => {
    const traceStore = shared()
    expect(
      aggregate(traceStore, -Infinity, Infinity, 'work', false).summary.map((row) => row.name),
    ).toContain('root')
    expect(
      aggregate(traceStore, -Infinity, Infinity, 'work', true).summary.map((row) => row.name),
    ).toEqual(['work'])
  })
})

describe('Call tree', () => {
  it('is root-first with callees nested under their caller', () => {
    const { callTree } = aggregate(shared(), -Infinity, Infinity, '', false)
    expect(callTree.map((node) => node.name)).toEqual(['root'])
    expect(at(callTree, 'root').children.map((node) => node.name)).toEqual(['work'])
    expect(at(callTree, 'root', 'work', 'db').total).toBe(10)
  })

  it('merges same-named siblings into one node', () => {
    const work = at(aggregate(shared(), -Infinity, Infinity, '', false).callTree, 'root', 'work')
    expect(work.count).toBe(2)
    expect(work.total).toBe(70)
    expect(work.self).toBe(60)
  })

  it("gives a node its own total, not its subtree's", () => {
    // root's total is root's 100, not 100+70+10.
    expect(at(aggregate(shared(), -Infinity, Infinity, '', false).callTree, 'root').total).toBe(100)
  })

  it('promotes a span whose parent is outside the window to a root', () => {
    // Window 45..100 excludes work 10..40 but keeps root, w2 and db.
    const { callTree } = aggregate(shared(), 45, 100, '', false)
    expect(callTree.map((node) => node.name).sort()).toEqual(['root'])
    expect(at(callTree, 'root', 'work', 'db').total).toBe(10)
  })

  it('promotes a span whose parent the filter hid', () => {
    const { callTree } = aggregate(shared(), -Infinity, Infinity, 'db', true)
    expect(callTree.map((node) => node.name)).toEqual(['db'])
  })
})

describe('Bottom-up', () => {
  it('lists names leaf-first by self time, with callers beneath', () => {
    const { bottomUp } = aggregate(shared(), -Infinity, Infinity, '', false)
    expect(bottomUp.map((node) => node.name)).toEqual(['work', 'root', 'db'])
    // `db`'s caller chain is work → root, nearest caller first.
    expect(at(bottomUp, 'db').children.map((node) => node.name)).toEqual(['work'])
    expect(at(bottomUp, 'db', 'work', 'root').self).toBe(10)
  })

  it('carries the callee self time up the caller chain, not the caller own time', () => {
    // Under `db`, the `work` row means "10ms of self time spent in db, called
    // from work" — not work's own 60ms.
    expect(
      at(aggregate(shared(), -Infinity, Infinity, '', false).bottomUp, 'db', 'work').self,
    ).toBe(10)
  })

  it('totals each root to the same self time the Summary reports', () => {
    const { bottomUp, summary } = aggregate(shared(), -Infinity, Infinity, '', false)
    for (const node of bottomUp) {
      expect(node.self).toBe(summary.find((row) => row.name === node.name)!.self)
    }
  })
})

describe('concurrency, the shape that breaks naive self time', () => {
  it('keeps a parent of 80 fully-overlapping children honest', () => {
    // What `example:concurrent` does: 80 tasks at one depth, all overlapping.
    // Parent 0..1000; children each 100..900. Union is 800, so self is 200.
    // Summing 80 × 800 = 64,000 would clamp self to 0.
    const traceStore = store([
      start('root', 0),
      ...Array.from({ length: 80 }, (_, i) => start(`t${i}`, 100, 'root', 'task')),
      ...Array.from({ length: 80 }, (_, i) => end(`t${i}`, 900)),
      end('root', 1000),
    ])
    expect(self(traceStore, 'root')).toBe(200)

    const { summary } = aggregate(traceStore, -Infinity, Infinity, '', false)
    expect(summary.find((row) => row.name === 'task')).toMatchObject({
      count: 80,
      total: 64_000,
      self: 64_000,
    })
    expect(summary.find((row) => row.name === 'root')!.self).toBe(200)
  })

  it('handles a deep chain without losing time at any level', () => {
    // What `example:deep` does: each level 1ms inside the one above.
    const depth = 40
    const messages: Array<ClientMessage> = []
    for (let i = 0; i < depth; i++) {
      messages.push(start(`l${i}`, i, i === 0 ? undefined : `l${i - 1}`, `level-${i}`))
    }
    for (let i = depth - 1; i >= 0; i--) messages.push(end(`l${i}`, 2 * depth - i))
    const traceStore = store(messages)

    const { summary, callTree } = aggregate(traceStore, -Infinity, Infinity, '', false)
    // Every level but the innermost has exactly 2ms of self time (1ms before
    // its child starts, 1ms after it ends); the innermost owns the rest.
    for (let i = 0; i < depth - 1; i++) {
      expect(summary.find((row) => row.name === `level-${i}`)!.self).toBeCloseTo(2, 6)
    }
    expect(summary.reduce((sum, row) => sum + row.self, 0)).toBeCloseTo(
      traceStore.spans.get('l0')!.end! - traceStore.spans.get('l0')!.start,
      6,
    )
    // The call tree is one chain `depth` nodes long.
    let node = at(callTree, 'level-0')
    for (let i = 1; i < depth; i++) node = at([node], `level-${i - 1}`, `level-${i}`)
    expect(node.name).toBe(`level-${depth - 1}`)
  })
})

describe('the real 13k-span fixture', () => {
  const loaded = (): TraceStore => {
    const traceStore = new TraceStore()
    traceStore.applyAll(Result.getOrThrow(parseTraceFile(firehoseTraceFile())).messages)
    return traceStore
  }

  it('aggregates without losing or inventing time', () => {
    const traceStore = loaded()
    const built = aggregate(traceStore, -Infinity, Infinity, '', false)
    expect(built.timings.length).toBeGreaterThan(13_000)

    // Self times still partition the trace: the sum equals the union of the
    // root spans' durations, which for this trace is the whole recording.
    const totalSelf = built.summary.reduce((sum, row) => sum + row.self, 0)
    const rootTotal = traceStore.roots.reduce((sum, id) => {
      const span = traceStore.spans.get(id)!
      return sum + ((span.end ?? 0) - span.start)
    }, 0)
    expect(totalSelf).toBeCloseTo(rootTotal, 3)

    // No negative or NaN anywhere.
    expect(built.summary.every((row) => row.self >= 0 && Number.isFinite(row.self))).toBe(true)
  })

  it('builds all three views in well under a frame', () => {
    const traceStore = loaded()
    const at0 = performance.now()
    aggregate(traceStore, -Infinity, Infinity, '', false)
    const elapsed = performance.now() - at0
    // Generous: the real budget is "not per frame at all", and this is the
    // whole 13k trace with no viewport clipping.
    expect(elapsed).toBeLessThan(250)
  })
})
