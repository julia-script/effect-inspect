import { describe, expect, it } from 'bun:test'
import {
  formatBytes,
  MEMORY_HANDLE_HEIGHT,
  MEMORY_TRACK_HEIGHT,
  sampleAt,
  trackHeight,
} from './MemoryTrack.ts'
import type { TraceMemorySample } from '../trace/TraceStore.ts'

const sample = (time: number, heapUsed: number): TraceMemorySample => ({
  time,
  heapUsed,
  heapTotal: heapUsed * 2,
  rss: heapUsed * 3,
  external: 0,
})

describe('trackHeight', () => {
  it('is zero for a session with no samples, collapsed or not', () => {
    // The "absent entirely, not an empty box" rule: a runtime without
    // `process.memoryUsage` must cost the chart no vertical space at all.
    expect(trackHeight([], false)).toBe(0)
    expect(trackHeight([], true)).toBe(0)
  })

  it('is the full track when expanded and the handle when collapsed', () => {
    const samples = [sample(0, 100)]
    expect(trackHeight(samples, false)).toBe(MEMORY_TRACK_HEIGHT)
    expect(trackHeight(samples, true)).toBe(MEMORY_HANDLE_HEIGHT)
  })
})

describe('sampleAt', () => {
  const samples = [sample(0, 1), sample(10, 2), sample(20, 3), sample(30, 4)]

  it('finds the reading at or before a time', () => {
    expect(sampleAt(samples, 10)?.heapUsed).toBe(2)
    expect(sampleAt(samples, 19.9)?.heapUsed).toBe(2)
    expect(sampleAt(samples, 20)?.heapUsed).toBe(3)
    expect(sampleAt(samples, 9999)?.heapUsed).toBe(4)
  })

  it('falls back to the first reading before the series starts', () => {
    expect(sampleAt(samples, -5)?.heapUsed).toBe(1)
  })

  it('has nothing to return for an empty series', () => {
    expect(sampleAt([], 5)).toBeUndefined()
  })

  it('agrees with a linear scan over a long series', () => {
    const many = Array.from({ length: 1000 }, (_, i) => sample(i * 7, i))
    for (const time of [0, 1, 6, 7, 3499, 3500, 6992, 6993, 100_000]) {
      const linear = [...many].reverse().find((entry) => entry.time <= time) ?? many[0]
      expect(sampleAt(many, time)).toBe(linear!)
    }
  })
})

describe('formatBytes', () => {
  it('picks the shortest readable unit', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })
})
