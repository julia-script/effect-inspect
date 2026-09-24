// `new Date()` and global `Error` are the exact exotic inputs these edge
// conversions exist to narrow, so constructing them here is the point.
// oxlint-disable effecttsgo/global-date
// oxlint-disable effecttsgo/global-error-in-effect-failure
import { describe, expect, it } from 'bun:test'
import { Cause, Exit } from 'effect'
import { clientCodec } from '../protocol/Codec.ts'
import { toAttributes, toJson, toOutcome } from './Edge.ts'

describe('toJson', () => {
  it('passes JSON values through unchanged', () => {
    expect(toJson('text')).toBe('text')
    expect(toJson(42)).toBe(42)
    expect(toJson(true)).toBe(true)
    expect(toJson(null)).toBe(null)
    expect(toJson([1, 'two', { three: false }])).toStrictEqual([1, 'two', { three: false }])
    expect(toJson({ nested: { deep: [1] } })).toStrictEqual({ nested: { deep: [1] } })
  })

  it('stringifies values the protocol cannot carry', () => {
    // The codec rejects these rather than letting JSON.stringify turn them to
    // null, so they have to be narrowed here instead.
    expect(toJson(Infinity)).toBe('Infinity')
    expect(toJson(-Infinity)).toBe('-Infinity')
    expect(toJson(NaN)).toBe('NaN')
    expect(toJson(10n)).toBe('10')
    expect(toJson(undefined)).toBe('undefined')
    expect(toJson(Symbol('sym'))).toBe('Symbol(sym)')
    expect(typeof toJson(() => 1)).toBe('string')
    expect(toJson(new Error('boom'))).toBe('Error: boom')
    expect(typeof toJson(new Date(0))).toBe('string')
    expect(typeof toJson(new Map([['a', 1]]))).toBe('string')
  })

  it('narrows values nested inside arrays and objects', () => {
    expect(toJson({ a: [NaN, 1n], b: { c: undefined } })).toStrictEqual({
      a: ['NaN', '1'],
      b: { c: 'undefined' },
    })
  })

  it('replaces cycles instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = { name: 'root' }
    cyclic['self'] = cyclic
    expect(toJson(cyclic)).toStrictEqual({ name: 'root', self: '[Circular]' })
  })

  it('does not treat a repeated sibling as a cycle', () => {
    const shared = { value: 1 }
    expect(toJson({ a: shared, b: shared })).toStrictEqual({ a: { value: 1 }, b: { value: 1 } })
  })

  it('produces values the protocol codec accepts', () => {
    const line = clientCodec.encode({
      _tag: 'SpanEvent',
      sessionId: 'session',
      spanId: 'span',
      name: 'event',
      time: 1n,
      attributes: toAttributes({ bad: NaN, fn: () => 1, big: 2n, ok: 'yes' }),
    })
    expect(line).toInclude('"bad":"NaN"')
    expect(line).toInclude('"ok":"yes"')
  })
})

describe('toAttributes', () => {
  it('accepts a Map or a record', () => {
    expect(toAttributes(new Map<string, unknown>([['a', 1n]]))).toStrictEqual({ a: '1' })
    expect(toAttributes({ a: 1n })).toStrictEqual({ a: '1' })
  })
})

describe('toOutcome', () => {
  it('reports success', () => {
    expect(toOutcome(Exit.succeed('value'))).toStrictEqual({ _tag: 'Success' })
  })

  it('flattens each failure kind', () => {
    expect(toOutcome(Exit.fail('oops'))).toMatchObject({ _tag: 'Failure', kind: 'Fail' })
    expect(toOutcome(Exit.die(new Error('defect')))).toMatchObject({
      _tag: 'Failure',
      kind: 'Die',
    })
    expect(toOutcome(Exit.failCause(Cause.interrupt(1)))).toMatchObject({
      _tag: 'Failure',
      kind: 'Interrupt',
    })
  })

  it('renders the error message and keeps a stack when there is one', () => {
    const outcome = toOutcome(Exit.fail(new Error('boom')))
    expect(outcome).toMatchObject({ _tag: 'Failure', kind: 'Fail' })
    expect((outcome as { error: string }).error).toInclude('boom')
    expect((outcome as { stack?: string }).stack).toInclude('boom')
  })

  it('prefers a real failure over the interrupt that accompanies it', () => {
    // Interrupting siblings is how Effect unwinds a failure, so an interrupt
    // alongside a failure would otherwise mask the useful half.
    const outcome = toOutcome(
      Exit.failCause(Cause.combine(Cause.interrupt(1), Cause.fail(new Error('real')))),
    )
    expect(outcome).toMatchObject({ _tag: 'Failure', kind: 'Fail' })
  })
})
