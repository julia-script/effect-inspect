/**
 * The collector's read-only query API over HTTP, on the collector's port.
 *
 * - `POST /api/v1/query` — body: a `Query.QueryRequest` JSON object. Reply:
 *   a `Query.QueryResponse` JSON object. The body is authoritative; the
 *   status mirrors it (200 ok, 400 InvalidRequest, 404 SessionNotFound or
 *   SpanNotFound, 409 SessionConflict).
 * - `GET /api/v1/export?sessionId=ID` — the session's frozen snapshot as
 *   `.eitrace` text with its loss counters in the header (200), or a
 *   `QueryFailure` JSON body (400/404). A conflicted session still exports,
 *   so the evidence is kept; queries against the file refuse it the same way.
 *
 * Each request answers from one atomic snapshot of one session. Two requests
 * against an active session see different snapshots; compare
 * `completeness.messagesObserved` to tell whether data changed between pages.
 */
import { Clock, Effect, Result } from 'effect'
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import * as Query from '../query/Query.ts'
import { Store } from './Store.ts'

/** Path prefix of the query API. */
export const apiPath = '/api/v1/'

const statusOf = (response: Query.QueryResponse): number => {
  if (response.ok) return 200
  switch (response.error._tag) {
    case 'InvalidRequest':
      return 400
    case 'SessionNotFound':
    case 'SpanNotFound':
      return 404
    case 'SessionConflict':
      return 409
    default:
      return 500
  }
}

const reply = (response: Query.QueryResponse) =>
  HttpServerResponse.jsonUnsafe(response, { status: statusOf(response) })

/** Answers one decoded request from the store. */
export const answer = (input: unknown): Effect.Effect<Query.QueryResponse, never, Store> =>
  Effect.gen(function* () {
    const decoded = Query.decodeRequest(input)
    if (Result.isFailure(decoded)) return decoded.failure
    const request = decoded.success
    const store = yield* Store
    if (request.op === 'sessions') {
      return Query.listSessions({ kind: 'live', file: null }, yield* store.sessions, request)
    }
    if (request.sessionId === undefined) return Query.sessionRequired(request.op)
    const snapshot = yield* store.snapshot(request.sessionId)
    if (snapshot === undefined) return Query.liveSessionNotFound(request.op, request.sessionId)
    // ponytail: rebuilds the trace model per request (~O(retained messages)).
    // Cache by `messagesObserved` if repeated queries on huge sessions show up.
    return Query.run(Query.fromSnapshot(snapshot, yield* Clock.currentTimeMillis), request)
  })

/** Handles a request under {@link apiPath}. */
export const handle = (
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Store> =>
  Effect.gen(function* () {
    if (url.pathname === `${apiPath}query` && request.method === 'POST') {
      const body = yield* Effect.result(request.json)
      if (Result.isFailure(body)) {
        return reply(
          Query.failure(
            null,
            'InvalidRequest',
            'The request body is not JSON.',
            'Send a JSON query object.',
          ),
        )
      }
      return reply(yield* answer(body.success))
    }
    if (url.pathname === `${apiPath}export` && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null) return reply(Query.sessionRequired('export'))
      const store = yield* Store
      const snapshot = yield* store.snapshot(sessionId)
      if (snapshot === undefined) return reply(Query.liveSessionNotFound('export', sessionId))
      const source = Query.fromSnapshot(snapshot, yield* Clock.currentTimeMillis)
      return HttpServerResponse.text(Query.toTraceFile(source), {
        contentType: 'application/x-ndjson',
      })
    }
    return reply(
      Query.failure(
        null,
        'InvalidRequest',
        `Unknown endpoint ${request.method} ${url.pathname}.`,
        `Use POST ${apiPath}query or GET ${apiPath}export?sessionId=ID.`,
      ),
    )
  })
