/**
 * Browser-only helpers for saved traces. Parsing and serializing live in
 * `src/trace/TraceFile.ts`, shared with the headless query core.
 */
import type { Session, TraceFileHeader } from '../../../src/protocol/Schema.ts'
import { traceFileExtension } from '../../../src/trace/TraceFile.ts'

export * from '../../../src/trace/TraceFile.ts'

/**
 * Prefix on a loaded session's id.
 *
 * Without it, loading a trace exported from the collector you are currently
 * connected to would collide with the live session of the same id and the two
 * would fight over the selection.
 */
export const loadedSessionPrefix = 'loaded:'

/** True for a session id produced by {@link parseTraceFile}. */
export const isLoadedSession = (sessionId: string): boolean =>
  sessionId.startsWith(loadedSessionPrefix)

/** A filename safe on every platform, carrying the program and save time. */
export const traceFileName = (session: Session, savedAtEpochMillis: number): string => {
  const program = session.program.split(/[/\\]/).pop() ?? 'trace'
  const safe = program.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'trace'
  const stamp = new Date(savedAtEpochMillis).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${safe}-${stamp}${traceFileExtension}`
}

/** The `Session` a loaded trace lists as: never active, id namespaced so it cannot collide. */
export const loadedSession = (header: TraceFileHeader): Session => ({
  ...header.session,
  // Idempotent: re-saving a loaded trace and loading it again must not stack
  // `loaded:loaded:` prefixes onto the id.
  sessionId: isLoadedSession(header.session.sessionId)
    ? header.session.sessionId
    : `${loadedSessionPrefix}${header.session.sessionId}`,
  active: false,
  endedAtEpochMillis: header.session.endedAtEpochMillis ?? header.savedAtEpochMillis,
})
