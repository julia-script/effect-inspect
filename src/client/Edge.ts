/**
 * Edge conversions from Effect's runtime values to the wire protocol's bounded
 * domain.
 *
 * The protocol deliberately refuses anything it cannot render: attribute values
 * are a bounded {@link Protocol.Json} union, and `SpanEnd` carries a flattened
 * outcome rather than a `Cause`. Both narrowings happen here, at the producer,
 * so a decoder never has to guess and an exotic attribute value can never fail
 * an encode mid-flight.
 */
import { Cause, type Exit } from 'effect'
import type * as Protocol from '../protocol/Schema.ts'

/**
 * Coerces an arbitrary runtime value into the protocol's `Json` union.
 *
 * Everything outside the union — functions, symbols, bigints, class instances,
 * `undefined`, and the non-finite numbers the codec rejects — is stringified.
 * Cycles are replaced with `"[Circular]"` rather than throwing.
 */
export const toJson = (value: unknown): Protocol.Json => jsonWithin(value, new Set())

const jsonWithin = (value: unknown, seen: Set<object>): Protocol.Json => {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    // `Infinity`/`NaN` are rejected by the codec, so they become text here.
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'bigint':
      return String(value)
    case 'object':
      break
    // function, symbol, undefined
    default:
      return stringify(value)
  }
  if (value === null) return null
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => jsonWithin(item, seen))
    if (isPlainObject(value)) {
      const out: Record<string, Protocol.Json> = {}
      for (const [key, item] of Object.entries(value)) out[key] = jsonWithin(item, seen)
      return out
    }
    // Dates, Errors, Maps, class instances: rendered, not structurally walked.
    return stringify(value)
  } finally {
    seen.delete(value)
  }
}

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const stringify = (value: unknown): string => {
  if (value === undefined) return 'undefined'
  if (typeof value === 'symbol' || typeof value === 'function') return String(value)
  try {
    // `[object Object]` is an acceptable last resort; the alternative is
    // dropping an attribute the user asked to see.
    // oxlint-disable-next-line no-base-to-string
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  } catch {
    return '[unrenderable]'
  }
}

/** Coerces a map or record of attributes into the protocol's bounded domain. */
export const toAttributes = (
  entries: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>,
): Protocol.Attributes => {
  const out: Record<string, Protocol.Json> = {}
  const pairs = entries instanceof Map ? entries.entries() : Object.entries(entries)
  for (const [key, value] of pairs) out[key] = toJson(value)
  return out
}

/**
 * Flattens an `Exit` into the protocol's `SpanOutcome`.
 *
 * The whole `Cause` is collapsed to a kind plus a rendered message: the webapp
 * only needs to colour the span and show text. A cause carrying several reasons
 * is classified by its most informative one — a real failure or defect outranks
 * an interrupt, since interrupting siblings is how Effect unwinds a failure.
 */
export const toOutcome = (exit: Exit.Exit<unknown, unknown>): Protocol.SpanOutcome => {
  if (exit._tag === 'Success') return { _tag: 'Success' }
  const cause = exit.cause
  const reason =
    cause.reasons.find((candidate) => !Cause.isInterruptReason(candidate)) ?? cause.reasons[0]
  if (reason === undefined) return { _tag: 'Failure', kind: 'Interrupt', error: 'Interrupted' }
  const kind = reason._tag
  const stack = stackOf(Cause.isFailReason(reason) ? reason.error : undefined)
  return {
    _tag: 'Failure',
    kind,
    error: Cause.pretty(cause),
    ...(stack === undefined ? {} : { stack }),
  }
}

const stackOf = (error: unknown): string | undefined =>
  error instanceof Error && typeof error.stack === 'string' ? error.stack : undefined
