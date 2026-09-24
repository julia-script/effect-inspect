import { describe, expect, it } from 'bun:test'
import type { ClientMessage } from '../../../src/protocol/Schema.ts'
import { TraceStore } from '../trace/TraceStore.ts'
import { firstVisible, forEachVisible, layout } from './Layout.ts'
import { formatTick, tickTimes } from './Renderer.ts'
import { timings } from './metrics.ts'
import { matches } from './selection.ts'
import { clamp, isFull, pan, zoom } from './Viewport.ts'

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

describe('Viewport', () => {
  it('clamps to the trace bounds while preserving width', () => {
    expect(clamp({ from: -50, to: 50 }, 200)).toEqual({ from: 0, to: 100 })
    expect(clamp({ from: 180, to: 280 }, 200)).toEqual({ from: 100, to: 200 })
  })

  it('never yields a window wider than the trace', () => {
    expect(clamp({ from: -10, to: 500 }, 100)).toEqual({ from: 0, to: 100 })
  })

  it('zooms around the anchor, keeping the anchored time fixed', () => {
    const view = zoom({ from: 0, to: 100 }, 25, 0.5, 100)
    // Anchor was 25% across; it must still be 25% across the new window.
    expect((25 - view.from) / (view.to - view.from)).toBeCloseTo(0.25, 6)
    expect(view.to - view.from).toBeCloseTo(50, 6)
  })

  it('pans and stops at the edges', () => {
    expect(pan({ from: 10, to: 20 }, -100, 200)).toEqual({ from: 0, to: 10 })
    expect(pan({ from: 190, to: 200 }, 100, 200)).toEqual({ from: 190, to: 200 })
  })

  it('detects the full window, which is what makes live mode follow', () => {
    expect(isFull({ from: 0, to: 100 }, 100)).toBe(true)
    expect(isFull({ from: 10, to: 100 }, 100)).toBe(false)
  })
})

describe('Layout', () => {
  it('buckets by depth and sorts each row by start', () => {
    const traceStore = store([
      start('root', 0),
      start('b', 30, 'root'),
      start('a', 10, 'root'),
      end('a', 20),
      end('b', 40),
      end('root', 50),
    ])
    const built = layout(traceStore)
    expect(built.rows.map((row) => row.spans.map((span) => span.name))).toEqual([
      ['root'],
      ['a', 'b'],
    ])
  })

  it('reuses the previous layout when the store has not changed', () => {
    const traceStore = store([start('root', 0)])
    const first = layout(traceStore)
    expect(layout(traceStore, first)).toBe(first)
  })

  it('rebuilds after a late parent re-depths a subtree', () => {
    // Child before parent: the child is a root at depth 0 until the parent lands.
    const traceStore = store([start('child', 10, 'parent')])
    const before = layout(traceStore)
    expect(before.rows[0]!.spans.map((span) => span.name)).toEqual(['child'])

    traceStore.apply(start('parent', 0))
    const after = layout(traceStore, before)
    expect(after).not.toBe(before)
    expect(after.rows[0]!.spans.map((span) => span.name)).toEqual(['parent'])
    expect(after.rows[1]!.spans.map((span) => span.name)).toEqual(['child'])
  })

  it('finds a wide span that began off-screen to the left', () => {
    // The whole point of the prefix-max: 'wide' starts before the window but
    // covers it, and a binary search on start alone would skip it.
    const traceStore = store([
      start('wide', 0),
      end('wide', 1000),
      start('narrow', 10),
      end('narrow', 12),
      start('late', 900),
      end('late', 910),
    ])
    const row = layout(traceStore).rows[0]!
    const seen: Array<string> = []
    forEachVisible(row, 500, 600, 1000, (span) => seen.push(span.name))
    expect(seen).toEqual(['wide'])
  })

  it('skips rows entirely to the left of the window', () => {
    const traceStore = store([
      start('a', 0),
      end('a', 1),
      start('b', 2),
      end('b', 3),
      start('c', 100),
      end('c', 101),
    ])
    const row = layout(traceStore).rows[0]!
    expect(firstVisible(row, 50)).toBe(2)
  })

  it('draws an open span out to the trace duration', () => {
    const traceStore = store([start('open', 0), start('other', 90), end('other', 100)])
    const row = layout(traceStore).rows[0]!
    const seen: Array<string> = []
    forEachVisible(row, 95, 100, 100, (span) => seen.push(span.name))
    expect(seen).toContain('open')
  })
})

describe('timings', () => {
  it('subtracts child time from total to get self time', () => {
    const traceStore = store([
      start('root', 0),
      start('child', 10, 'root'),
      end('child', 40),
      end('root', 100),
    ])
    const root = traceStore.spans.get('root')!
    expect(timings(traceStore, root, 100)).toEqual({ total: 100, self: 70 })
  })

  it('treats an open span as running to now', () => {
    const traceStore = store([start('root', 0)])
    expect(timings(traceStore, traceStore.spans.get('root')!, 250).total).toBe(250)
  })
})

describe('ruler', () => {
  it('produces ticks inside the window at a 1/2/5 step', () => {
    const ticks = tickTimes(0, 100, 900)
    expect(ticks.length).toBeGreaterThan(2)
    expect(ticks.every((tick) => tick >= 0 && tick <= 100)).toBe(true)
    const step = ticks[1]! - ticks[0]!
    expect([1, 2, 5, 10, 20, 25, 50]).toContain(step)
  })

  it('keeps adjacent ticks textually distinct when zoomed right in', () => {
    const ticks = tickTimes(10, 10.05, 900)
    const labels = ticks.map((tick) => formatTick(tick, ticks))
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('switches to seconds for a long trace', () => {
    const ticks = tickTimes(0, 10_000, 900)
    expect(formatTick(ticks[1]!, ticks)).toMatch(/s$/)
  })

  it('survives a degenerate window', () => {
    expect(tickTimes(0, 0, 900)).toEqual([0])
  })
})

describe('filter', () => {
  it('matches case-insensitively and lets an empty filter through', () => {
    expect(matches('HTTP.request', 'http')).toBe(true)
    expect(matches('db.query', 'http')).toBe(false)
    expect(matches('anything', '')).toBe(true)
  })
})

describe('10k spans', () => {
  /** A trace shaped like a real one: many roots, each a few levels deep. */
  const big = (): TraceStore => {
    const messages: Array<ClientMessage> = []
    let id = 0
    for (let root = 0; root < 1000; root++) {
      const rootId = `s${id++}`
      const at = root * 10
      messages.push(start(rootId, at))
      let parent = rootId
      for (let depth = 0; depth < 9; depth++) {
        const childId = `s${id++}`
        messages.push(start(childId, at + depth, parent))
        messages.push(end(childId, at + 9 - depth))
        parent = childId
      }
      messages.push(end(rootId, at + 9))
    }
    return store(messages)
  }

  it('indexes and culls a 10k-span trace within a frame budget', () => {
    const traceStore = big()
    expect(traceStore.stats().spans).toBe(10_000)

    const built = layout(traceStore)
    const total = built.duration

    // The claim under test: a pan/zoom frame must not touch every span. Sweep
    // a 1%-wide window across the whole trace and count the spans visited —
    // that is exactly what the renderer's draw loop does per row per frame.
    const width = total / 100
    let visited = 0
    let frames = 0
    const startedAt = performance.now()
    for (let from = 0; from + width <= total; from += width) {
      for (const row of built.rows) {
        forEachVisible(row, from, from + width, total, () => {
          visited++
        })
      }
      frames++
    }
    const perFrame = (performance.now() - startedAt) / frames

    // Culling works: ~1% of the trace per frame, not 10k spans.
    expect(visited / frames).toBeLessThan(500)
    // And it is fast enough that the draw call, not the index, is the budget.
    expect(perFrame).toBeLessThan(2)
  })

  it('reuses the index across pan frames, so only ingest pays for the sort', () => {
    const traceStore = big()
    const built = layout(traceStore)
    for (let i = 0; i < 100; i++) expect(layout(traceStore, built)).toBe(built)
  })
})
