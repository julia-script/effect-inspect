/**
 * Calls a running collector's query API (see `collector/QueryApi.ts`).
 *
 * Never fails: transport problems become the same `QueryFailure` shape the
 * collector returns, tagged `CollectorUnavailable` (nothing answered in time)
 * or `CollectorError` (something answered, but not this API), so a caller
 * prints one JSON contract whatever went wrong.
 */
import { Duration, Effect } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { defaultPort } from '../collector/Config.ts'
import * as Query from './Query.ts'

/** Where `effect-inspect start` listens by default. */
export const defaultUrl = `http://localhost:${defaultPort}`

/** How long a call waits for the collector before `CollectorUnavailable`. */
export const defaultTimeoutMs = 5000

export interface Options {
  /** Collector base URL, e.g. {@link defaultUrl}. */
  readonly url: string
  readonly timeoutMs?: number | undefined
}

const unavailable = (op: string | null, url: string, detail: string): Query.QueryFailure =>
  Query.failure(
    op,
    'CollectorUnavailable',
    `No collector answered at ${url}: ${detail}`,
    'Start one with `effect-inspect start` (EFFECT_INSPECT_PORT sets its port) or point at the right URL; for saved traces query the file instead.',
    { url },
  )

const foreign = (op: string | null, url: string, detail: string): Query.QueryFailure =>
  Query.failure(
    op,
    'CollectorError',
    `${url} did not answer as an effect-inspect query API: ${detail}`,
    'The collector may predate the query API, or another service owns that port. Upgrade and restart the collector, or check the URL.',
    { url },
  )

const isResponse = (body: unknown): body is Query.QueryResponse =>
  typeof body === 'object' &&
  body !== null &&
  (body as { apiVersion?: unknown }).apiVersion === Query.apiVersion &&
  typeof (body as { ok?: unknown }).ok === 'boolean'

const opOf = (request: unknown): string | null =>
  typeof request === 'object' &&
  request !== null &&
  typeof (request as { op?: unknown }).op === 'string'
    ? (request as { op: string }).op
    : null

const withTimeout = <A>(
  options: Options,
  op: string | null,
  effect: Effect.Effect<A, never, HttpClient.HttpClient>,
) => {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  return Effect.timeoutOrElse(effect, {
    duration: Duration.millis(timeoutMs),
    orElse: () => Effect.succeed(unavailable(op, options.url, `no answer within ${timeoutMs}ms`)),
  })
}

/** Sends one query request (validated by the collector) and returns its response. */
export const query = (
  options: Options,
  request: unknown,
): Effect.Effect<Query.QueryResponse, never, HttpClient.HttpClient> => {
  const op = opOf(request)
  return withTimeout(
    options,
    op,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(
        HttpClientRequest.post(new URL('/api/v1/query', options.url)).pipe(
          HttpClientRequest.bodyJsonUnsafe(request),
        ),
      )
      const body = yield* response.json
      return isResponse(body)
        ? body
        : foreign(op, options.url, `unexpected body (HTTP ${response.status})`)
    }).pipe(
      Effect.catchTag('HttpClientError', (error) =>
        Effect.succeed(
          error.reason._tag === 'TransportError' || error.reason._tag === 'InvalidUrlError'
            ? unavailable(op, options.url, error.message)
            : foreign(op, options.url, error.message),
        ),
      ),
    ),
  )
}

/**
 * Downloads one session's frozen snapshot as `.eitrace` text, loss counters
 * included, for offline queries that answer exactly as the live one did.
 */
export const exportTrace = (
  options: Options,
  sessionId: string,
): Effect.Effect<
  { readonly ok: true; readonly text: string } | Query.QueryFailure,
  never,
  HttpClient.HttpClient
> =>
  withTimeout(
    options,
    'export',
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const url = new URL('/api/v1/export', options.url)
      url.searchParams.set('sessionId', sessionId)
      const response = yield* client.execute(HttpClientRequest.get(url))
      // An older collector hands unknown paths to the web UI, which may answer 200 HTML.
      if (
        response.status === 200 &&
        response.headers['content-type']?.startsWith('application/x-ndjson') === true
      ) {
        return { ok: true as const, text: yield* response.text }
      }
      const body = yield* response.json
      return isResponse(body) && !body.ok
        ? body
        : foreign('export', options.url, `unexpected body (HTTP ${response.status})`)
    }).pipe(
      Effect.catchTag('HttpClientError', (error) =>
        Effect.succeed(
          error.reason._tag === 'TransportError' || error.reason._tag === 'InvalidUrlError'
            ? unavailable('export', options.url, error.message)
            : foreign('export', options.url, error.message),
        ),
      ),
    ),
  )
