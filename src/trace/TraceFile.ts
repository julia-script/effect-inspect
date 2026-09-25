/**
 * Saving a trace to a file and loading it back.
 *
 * The file **is** the protocol message stream: line 1 is a
 * {@link Protocol.TraceFileHeader}, every line after it is a `ClientMessage`
 * exactly as `clientCodec` writes it on the wire. So a new protocol message
 * variant is carried by a saved trace for free — the format version only moves
 * if the header or the line layout changes, never because the protocol grew.
 *
 * Parsing is deliberately lenient about the *tail* and strict about the
 * *head*: a header that will not decode means this is not a trace file and
 * there is nothing to show, while a truncated last line means the writer died
 * mid-save and everything before it is still a real trace worth rendering.
 */
import { Result } from 'effect'
import { clientCodec, traceFileHeaderCodec } from '../protocol/Codec.ts'
import {
  protocolVersion,
  traceFileFormatVersion,
  type ClientMessage,
  type Session,
  type TraceCapture,
  type TraceFileHeader,
} from '../protocol/Schema.ts'

/** File extension for a saved trace. */
export const traceFileExtension = '.eitrace'

/** Why a file could not be read as a trace. `message` is shown to the user verbatim. */
export interface TraceFileError {
  readonly _tag: 'TraceFileError'
  readonly message: string
}

const fail = (message: string): Result.Result<never, TraceFileError> =>
  Result.fail({ _tag: 'TraceFileError', message })

/** A parsed trace file: its header, its messages, and what was lost at the tail. */
export interface LoadedTrace {
  readonly header: TraceFileHeader
  readonly messages: ReadonlyArray<ClientMessage>
  /**
   * Trailing lines that would not decode, almost always a truncated save.
   *
   * Non-zero is surfaced in the UI rather than thrown: the spans before the cut
   * are real, and a partial trace beats a blank chart.
   */
  readonly truncatedLines: number
}

/**
 * Serializes a session and its messages to trace-file text.
 *
 * `messages` is the raw protocol stream in arrival order — not a re-derivation
 * from the rendered trace model, which would silently drop every message the
 * model does not draw. `capture` is written only when the caller knows the
 * collector's loss counters; omitting it marks completeness as unknown.
 */
export const serializeTraceFile = (
  session: Session,
  messages: Iterable<ClientMessage>,
  savedAtEpochMillis: number,
  capture?: TraceCapture,
): string => {
  const header = traceFileHeaderCodec.encode({
    _tag: 'TraceFileHeader',
    formatVersion: traceFileFormatVersion,
    protocolVersion,
    session,
    savedAtEpochMillis,
    ...(capture === undefined ? {} : { capture }),
  })
  const body: Array<string> = []
  for (const message of messages) body.push(clientCodec.encode(message))
  return header + body.join('')
}

/**
 * Parses trace-file text.
 *
 * Fails only when the file is not a trace file at all — an unreadable header,
 * a format version from the future, or a body whose *interior* is corrupt. A
 * bad line that is not the last one means the file was edited or mangled, not
 * merely cut short, and rendering a trace with a hole in the middle would be a
 * lie; a bad final line is reported as {@link LoadedTrace.truncatedLines}.
 */
export const parseTraceFile = (text: string): Result.Result<LoadedTrace, TraceFileError> => {
  const lines = text.split('\n')
  const headerLine = lines[0]
  if (headerLine === undefined || headerLine.trim() === '') {
    return fail('The file is empty.')
  }

  const headerResult = traceFileHeaderCodec.decode(headerLine)
  if (Result.isFailure(headerResult)) {
    return fail('This is not an effect-inspect trace file: its header could not be read.')
  }
  const header = headerResult.success
  if (header.formatVersion > traceFileFormatVersion) {
    return fail(
      `This trace file is format version ${header.formatVersion}; this build understands up to ${traceFileFormatVersion}.`,
    )
  }

  const messages: Array<ClientMessage> = []
  let truncatedLines = 0
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!
    if (line.trim() === '') continue
    const decoded = clientCodec.decode(line)
    if (Result.isSuccess(decoded)) {
      messages.push(decoded.success)
      continue
    }
    // Only the final line may be a casualty of a truncated write; a bad line
    // with good lines after it means the file is corrupt, not cut short.
    const isLast = lines.slice(index + 1).every((rest) => rest.trim() === '')
    if (!isLast) {
      return fail(`This trace file is corrupt: line ${index + 1} could not be read.`)
    }
    truncatedLines = 1
  }

  return Result.succeed({ header, messages, truncatedLines })
}
