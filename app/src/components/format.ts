/** Shared number formatting for the chart chrome and the event log. */

/** Millis, with the unit and precision Chrome's performance panel uses. */
export const formatDuration = (millis: number): string => {
  if (!Number.isFinite(millis)) return '—'
  if (millis >= 1000) return `${(millis / 1000).toFixed(2)}s`
  if (millis >= 1) return `${millis.toFixed(2)}ms`
  return `${(millis * 1000).toFixed(0)}µs`
}

/** An attribute value as one line of text; objects/arrays are JSON, not `[object Object]`. */
export const formatValue = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
