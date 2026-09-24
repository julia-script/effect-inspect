/**
 * NDJSON codec for the protocol unions.
 *
 * The whole encoding lives behind {@link Codec}: one line of JSON per message,
 * `\n`-terminated. Swapping in a compact binary format later means another
 * `make`-shaped factory, not touching callers.
 */
import { Data, Result, Schema } from 'effect'
import {
  ClientMessage,
  CollectorMessage,
  TraceFileHeader,
  WebappMessage,
  WebappRequest,
} from './Schema.ts'

/** Raised when a message cannot be encoded — an out-of-domain field value. */
export class EncodeError extends Data.TaggedError('EncodeError')<{
  readonly reason: string
}> {
  override get message(): string {
    return `Unencodable protocol message: ${this.reason}`
  }
}

/** Raised when a line is not valid JSON, or not a valid message. */
export class DecodeError extends Data.TaggedError('DecodeError')<{
  readonly line: string
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid protocol message: ${this.reason}`
  }
}

/** An encode/decode pair for one protocol union. */
export interface Codec<A> {
  /**
   * Encodes one message as a single `\n`-terminated NDJSON line.
   *
   * Throws {@link EncodeError} if a field is out of its schema's domain (a
   * `NaN` attribute, a negative count). That is a producer bug, not a runtime
   * condition, so callers that would only rethrow need no branch; use
   * {@link Codec.encodeResult} where the value came from outside.
   */
  readonly encode: (message: A) => string
  /** {@link Codec.encode} as a `Result`, for values from an untrusted source. */
  readonly encodeResult: (message: A) => Result.Result<string, EncodeError>
  /** Decodes one NDJSON line. Surrounding whitespace is tolerated. */
  readonly decode: (line: string) => Result.Result<A, DecodeError>
  /**
   * Decodes every non-empty line of an NDJSON chunk.
   *
   * Fails on the first bad line rather than skipping it: a malformed line means
   * the stream is out of sync, and silently dropping telemetry is worse than
   * surfacing it.
   */
  readonly decodeAll: (chunk: string) => Result.Result<ReadonlyArray<A>, DecodeError>
}

const make = <A, E>(schema: Schema.Codec<A, E, never, never>): Codec<A> => {
  const json = Schema.fromJsonString(schema)
  const encodeJson = Schema.encodeResult(json)
  const decodeJson = Schema.decodeUnknownResult(json)

  const encodeResult = (message: A): Result.Result<string, EncodeError> =>
    Result.match(encodeJson(message), {
      onSuccess: (line) => Result.succeed(`${line}\n`),
      onFailure: (error) => Result.fail(new EncodeError({ reason: error.message })),
    })

  const decode = (line: string): Result.Result<A, DecodeError> =>
    Result.mapError(
      decodeJson(line.trim()),
      (error) => new DecodeError({ line, reason: error.message }),
    )

  return {
    encode: (message) => Result.getOrThrow(encodeResult(message)),
    encodeResult,
    decode,
    decodeAll: (chunk) =>
      Result.all(
        chunk
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map(decode),
      ),
  }
}

/** Instrumented program → collector. */
export const clientCodec = make(ClientMessage)

/** Collector → instrumented program. */
export const collectorCodec = make(CollectorMessage)

/** Collector → webapp. */
export const webappCodec = make(WebappMessage)

/** Webapp → collector. */
export const webappRequestCodec = make(WebappRequest)

/** Line 1 of a saved trace file; the rest of the file is {@link clientCodec} lines. */
export const traceFileHeaderCodec = make(TraceFileHeader)
