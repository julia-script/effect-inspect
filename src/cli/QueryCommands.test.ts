import { describe, expect, it } from 'bun:test'
import * as Query from '../query/Query.ts'
import { renderBounded } from './QueryCommands.ts'

const bytes = (text: string) => new TextEncoder().encode(text).length
const limit = Query.limits.responseBytes

/** A failure whose compact JSON is exactly `size` bytes, before the newline. */
const failureOfSize = (size: number) => {
  const base = Query.failure('summary', 'SessionNotFound', 'm', 'h', { pad: '' })
  return Query.failure('summary', 'SessionNotFound', 'm', 'h', {
    pad: 'x'.repeat(size - bytes(JSON.stringify(base))),
  })
}

describe('renderBounded', () => {
  it('counts the trailing newline: exactly-limit compact JSON plus newline is too large', () => {
    const fits = renderBounded(failureOfSize(limit - 1), true)
    expect(bytes(fits.text)).toBe(limit)
    expect(fits.response.ok ? 'ok' : fits.response.error._tag).toBe('SessionNotFound')

    const over = renderBounded(failureOfSize(limit), true)
    expect(bytes(over.text)).toBeLessThan(2000)
    expect(over.response.ok).toBe(false)
    if (over.response.ok) return
    expect(over.response.error).toMatchObject({
      _tag: 'ResponseTooLarge',
      bytes: limit + 1,
      limitBytes: limit,
      originalOutcome: 'SessionNotFound',
      output: 'compact',
    })
    expect(over.text.endsWith('\n')).toBe(true)
  })

  it('bounds the pretty rendering, which is larger than the compact one, and suggests --json', () => {
    const response = failureOfSize(limit - 200_000)
    expect(bytes(renderBounded(response, true).text)).toBeLessThanOrEqual(limit)
    // Pretty adds indentation to every key; 200 KB of headroom is not enough for this shape.
    const wide = Query.failure('summary', 'SessionNotFound', 'm', 'h', {
      items: Array.from({ length: 60_000 }, (_, i) => ({ i })),
    })
    const compact = renderBounded(wide, true)
    const pretty = renderBounded(wide, false)
    expect(compact.response.ok ? 'ok' : compact.response.error._tag).toBe('SessionNotFound')
    expect(pretty.response.ok).toBe(false)
    if (pretty.response.ok) return
    expect(pretty.response.error).toMatchObject({ _tag: 'ResponseTooLarge', output: 'pretty' })
    expect(pretty.response.error.bytes).toBeGreaterThan(limit)
    expect(pretty.response.error.hint).toContain('--json')
    expect(bytes(pretty.text)).toBeLessThan(2000)
  })
})
