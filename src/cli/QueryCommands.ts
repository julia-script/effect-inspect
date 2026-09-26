/**
 * The query commands of the `effect-inspect` CLI: `sessions`, `summary`,
 * `spans`, `span`, `logs` and `export`.
 *
 * Every command prints exactly one JSON document on stdout (pretty, or compact
 * with `--json`) and, on failure, one diagnostic on stderr; the exit code
 * names the failure (see {@link exitCodes}). Live queries go through
 * `query/Client.ts`, file queries through `Query.queryFile`, so both answer
 * with the one contract of `query/Query.ts`.
 *
 * The help text here is the primary manual for agents driving the CLI, so it
 * spells out the whole local contract: sources, flags, defaults, JSON shapes,
 * errors and exit codes.
 */
import { Config, Console, Data, Effect, Option, Result, Stream } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import * as Stdio from 'effect/Stdio'
import { Command, CliError, Flag } from 'effect/unstable/cli'
import { FetchHttpClient } from 'effect/unstable/http'
import { defaultPort } from '../collector/Config.ts'
import * as Client from '../query/Client.ts'
import * as Query from '../query/Query.ts'

// ---------------------------------------------------------------------------
// Output and exit codes
// ---------------------------------------------------------------------------

/** Process exit code per outcome. `1` is reserved for unexpected internal errors. */
export const exitCodes: Readonly<Record<Query.ErrorTag, number>> = {
  InvalidRequest: 2,
  SessionNotFound: 3,
  SpanNotFound: 4,
  SessionConflict: 5,
  ResponseTooLarge: 6,
  TraceFileError: 7,
  CollectorUnavailable: 8,
  CollectorError: 9,
  OutputError: 10,
}

/** Longest `--timeout-ms` accepted: ten minutes. */
const maxTimeoutMs = 600_000

/** A handled failure: its JSON is already printed, only the exit code is left. */
class CliExit extends Data.TaggedError('CliExit')<{ readonly code: number }> {}

/** `export`'s success document. */
export interface ExportResponse {
  readonly ok: true
  readonly apiVersion: typeof Query.apiVersion
  readonly op: 'export'
  readonly query: {
    readonly op: 'export'
    readonly sessionId: string
    readonly out: string
    readonly force: boolean
  }
  readonly result: { readonly sessionId: string; readonly file: string; readonly bytes: number }
}

type Response = Query.QueryResponse | ExportResponse

const write = (text: string, to: 'stdout' | 'stderr') =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(text), to === 'stdout' ? stdio.stdout() : stdio.stderr())
  }).pipe(Effect.ignore)

const encoder = new TextEncoder()

/** Pretty JSON by default; one compact line with `--json`. */
const render = (response: Response, json: boolean) =>
  `${JSON.stringify(response, null, json ? undefined : 2)}\n`

/**
 * The exact stdout text for `response`, held to `Query.limits.responseBytes`
 * as emitted: after formatting, trailing newline included. The query layer
 * bounds compact JSON only, so indentation (or the newline) can still push a
 * page over; that becomes a small fixed-shape `ResponseTooLarge` instead.
 */
export const renderBounded = (
  response: Response,
  json: boolean,
): { readonly response: Response; readonly text: string } => {
  const text = render(response, json)
  const bytes = encoder.encode(text).length
  if (bytes <= Query.limits.responseBytes) return { response, text }
  const bounded = Query.failure(
    response.op,
    'ResponseTooLarge',
    `The ${json ? 'compact' : 'pretty-printed'} JSON output would be ${bytes} bytes on stdout, over the ${Query.limits.responseBytes}-byte limit.`,
    json
      ? 'Request fewer items (--limit, --top, --children, --events) or narrow the filters. Identifiers are never shortened to fit.'
      : 'Add --json (compact, no indentation) or request fewer items (--limit, --top, --children, --events) or narrow the filters. Identifiers are never shortened to fit.',
    {
      bytes,
      limitBytes: Query.limits.responseBytes,
      originalOutcome: response.ok ? 'ok' : response.error._tag,
      output: json ? 'compact' : 'pretty',
    },
  )
  return { response: bounded, text: render(bounded, json) }
}

/** Prints `response` and, for a failure, a stderr diagnostic and its exit code. */
const emit = Effect.fnUntraced(function* (unbounded: Response, json: boolean) {
  const { response, text } = renderBounded(unbounded, json)
  yield* write(text, 'stdout')
  if (response.ok) return
  const code = exitCodes[response.error._tag]
  yield* write(
    `effect-inspect${response.op === null ? '' : ` ${response.op}`}: ${response.error._tag} (exit ${code}): ${response.error.message}\nhint: ${response.error.hint}\n`,
    'stderr',
  )
  return yield* new CliExit({ code })
})

const invalid = (op: string, message: string, hint: string) =>
  Query.failure(op, 'InvalidRequest', message, hint)

/** Keeps only the fields that were given, so the echo shows what was asked. */
const given = (fields: Record<string, Option.Option<unknown>>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (Option.isSome(value)) out[key] = value.value
  }
  return out
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

interface LiveFlags {
  readonly url: Option.Option<string>
  readonly timeoutMs: Option.Option<number>
}

interface SourceFlags extends LiveFlags {
  readonly session: Option.Option<string>
  readonly file: Option.Option<string>
}

/** Collector URL: `--url`, else `http://localhost:$EFFECT_INSPECT_PORT`, else the default port. */
const liveTarget = (op: string, flags: LiveFlags) =>
  Effect.gen(function* () {
    const timeoutMs = Option.getOrElse(flags.timeoutMs, () => Client.defaultTimeoutMs)
    if (timeoutMs < 1 || timeoutMs > maxTimeoutMs) {
      return yield* Effect.fail(
        invalid(
          op,
          `--timeout-ms must be an integer from 1 to ${maxTimeoutMs}.`,
          `Omit it for the ${Client.defaultTimeoutMs} ms default.`,
        ),
      )
    }
    let url: string
    if (Option.isSome(flags.url)) url = flags.url.value
    else {
      const port = yield* Effect.result(
        Config.Port('EFFECT_INSPECT_PORT').pipe(Config.withDefault(defaultPort)),
      )
      if (Result.isFailure(port)) {
        return yield* Effect.fail(
          invalid(
            op,
            'EFFECT_INSPECT_PORT is set but is not a valid port (1-65535).',
            'Fix or unset EFFECT_INSPECT_PORT, or pass --url http://HOST:PORT.',
          ),
        )
      }
      url = `http://localhost:${port.success}`
    }
    const parsed = URL.canParse(url) ? new URL(url) : undefined
    if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      return yield* Effect.fail(
        invalid(
          op,
          '--url must be an absolute http:// or https:// URL.',
          `Use the collector's HTTP address, e.g. http://localhost:${defaultPort} (the same port programs reach at ws://).`,
        ),
      )
    }
    return { url, timeoutMs }
  })

const readTrace = (op: string, path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    return yield* fs.readFileString(path)
  }).pipe(
    Effect.mapError((error) =>
      Query.failure(
        op,
        'TraceFileError',
        `The file could not be read: ${error.message}`,
        'Check that --file names an existing, readable .eitrace file (written by `effect-inspect export` or the web UI save button).',
        { file: path },
      ),
    ),
  )

/**
 * Answers one query from exactly one source: the collector for `--session`,
 * or a saved file for `--file` (with `--session` as an assertion).
 */
const answer = (op: string, flags: SourceFlags, fields: Record<string, unknown>) =>
  Effect.gen(function* () {
    const session = Option.getOrUndefined(flags.session)
    if (Option.isSome(flags.file)) {
      if (Option.isSome(flags.url) || Option.isSome(flags.timeoutMs)) {
        return invalid(
          op,
          '--url and --timeout-ms apply only to live queries and cannot be combined with --file.',
          'Drop --url/--timeout-ms to query the file, or drop --file to query the collector.',
        )
      }
      const request = { op, ...(session === undefined ? {} : { sessionId: session }), ...fields }
      const decoded = Query.decodeRequest(request)
      if (Result.isFailure(decoded)) return decoded.failure
      const text = yield* readTrace(op, flags.file.value)
      return Query.queryFile(text, flags.file.value, request)
    }
    if (session === undefined && op !== 'sessions') {
      return invalid(
        op,
        'Name the source: --session ID for a live collector query, or --file PATH for a saved trace. The newest session is never assumed.',
        'Pass the exact EFFECT_INSPECT_SESSION_ID the program was launched with; run `effect-inspect sessions` only if you do not know it.',
      )
    }
    const request = { op, ...(session === undefined ? {} : { sessionId: session }), ...fields }
    const decoded = Query.decodeRequest(request)
    if (Result.isFailure(decoded)) return decoded.failure
    const target = yield* liveTarget(op, flags)
    return yield* Client.query(target, request).pipe(Effect.provide(FetchHttpClient.layer))
  }).pipe(Effect.catch((failure: Query.QueryFailure) => Effect.succeed(failure)))

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const json = Flag.Boolean('json').pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    'Print the JSON compact on one line (recommended for programs). Without it the same JSON is pretty-printed.',
  ),
)

const session = Flag.String('session').pipe(
  Flag.optional,
  Flag.withDescription(
    'Exact session ID. Live: required, selects that session on the collector. With --file: optional assertion that the file holds this ID.',
  ),
)

const file = Flag.String('file').pipe(
  Flag.optional,
  Flag.withDescription(
    'Path of a saved .eitrace to query offline instead of the collector. No collector is contacted.',
  ),
)

const url = Flag.String('url').pipe(
  Flag.optional,
  Flag.withDescription(
    `Live only. Collector base URL. Default http://localhost:$EFFECT_INSPECT_PORT, else http://localhost:${defaultPort}.`,
  ),
)

const timeoutMs = Flag.Int('timeout-ms').pipe(
  Flag.optional,
  Flag.withDescription(
    `Live only. Milliseconds to wait for the whole answer, 1-${maxTimeoutMs} (default ${Client.defaultTimeoutMs}); then CollectorUnavailable.`,
  ),
)

const page = (max: number, fallback: number, what: string) => ({
  limit: Flag.Int('limit').pipe(
    Flag.optional,
    Flag.withDescription(`${what} per page, 1-${max} (default ${fallback}).`),
  ),
  offset: Flag.Int('offset').pipe(
    Flag.optional,
    Flag.withDescription(
      'Items to skip, >= 0 (default 0). Use result.nextOffset from the previous page.',
    ),
  ),
})

const window = (what: string) => ({
  fromMs: Flag.Finite('from-ms').pipe(
    Flag.optional,
    Flag.withDescription(
      `Window start in session ms, inclusive (${what}). Negative values need = : --from-ms=-5.`,
    ),
  ),
  toMs: Flag.Finite('to-ms').pipe(
    Flag.optional,
    Flag.withDescription(`Window end in session ms, inclusive; must be >= --from-ms.`),
  ),
})

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

/** Indents continuation lines under the help formatter's DESCRIPTION heading. */
const text = (body: string) => body.trim().split('\n').join('\n  ')

const sourceRules = `
SOURCE (exactly one; never implicit)
  --session ID   Live. Asks the collector for the session with exactly this ID.
                 IDs are case-sensitive and never completed, guessed or replaced by
                 the newest session. The ID is the EFFECT_INSPECT_SESSION_ID (or the
                 Inspect.layer sessionId option) the program was launched with.
  --file PATH    Offline. Reads a saved .eitrace (from \`export\` or the web UI).
                 No collector is contacted; --url and --timeout-ms are rejected.
                 --session may be added: then the file must hold exactly that ID
                 (a web-UI re-save's "loaded:" prefix is accepted), else SessionNotFound.
  Neither        InvalidRequest (exit 2), even when only one session exists.

COLLECTOR ADDRESS (live only)
  --url URL, else http://localhost:$EFFECT_INSPECT_PORT, else http://localhost:${defaultPort}.
  It is the same port \`effect-inspect start\` listens on. --timeout-ms (default
  ${Client.defaultTimeoutMs}) bounds connecting plus reading the whole answer; when it passes,
  or nothing listens, the result is CollectorUnavailable (exit 8).`

const context = `
CONTEXT FIELDS (every successful per-session response)
  Top-level siblings of result, never inside it (.completeness, not
  .result.completeness). result's own fields are listed above (RESULT FIELDS /
  SPAN ITEM FIELDS); root \`effect-inspect --help\` has the JSON SHAPE overview.
  notices        summary only, top level: read it first. { code, message } facts easy
                 to miss (open spans, eviction, sampling gaps); run \`summary\` before
                 drilling down with other commands.
  query          The request as applied, defaults filled in. Check it to confirm
                 which filters were used.
  source         kind "live"|"file", file (path or null), sessionId (exact), program,
                 pid, runtime, active (live: program still connected, so more data
                 may arrive and a repeated query can differ), startedAtEpochMillis,
                 endedAtEpochMillis (connection closed; not proof the program
                 succeeded), snapshotAtEpochMillis (live: query time; file: save time).
                 programTruncated/runtimeTruncated mark text cut to 200 characters.
  time           unit "ms"; reference "sessionStart": every ...Ms field is milliseconds
                 since the session's clock origin (when its inspect client started),
                 microsecond resolution. Wall clock = startedAtEpochMillis + ms. Values
                 can be negative (work that began before the client). observedFromMs /
                 observedUntilMs: earliest / latest retained timestamp, null when none.
  termination    state "active" (still connected at snapshot time; open spans may still
                 end), "ended" (the collector recorded a disconnect) or "unknown" (no
                 end time on record). lastObservedMs (= observedUntilMs), endedAtMs
                 (the disconnect in session ms, from the collector's wall clock, so
                 approximate; null unless ended), unobservedTailMs (endedAtMs -
                 lastObservedMs: time before the disconnect with nothing retained).
                 The protocol has no end-of-session message: a crash, a kill, a clean
                 exit and a dropped connection look the same, so open spans at the end
                 do not by themselves establish a crash.
  completeness   status: "noLossRecorded" (collector counters known, all loss/gap
                 counters 0 - still not proof nothing is missing), "lossRecorded" (some
                 counter > 0: evidence is partial), or "unknown" (source never kept
                 collector counters: browser save or older file). Counters:
                 collectorDroppedMessages and collectorSkippedLines (null = unknown),
                 clientDroppedMessages, fileTruncatedLines, spansMissingStart,
                 spansOutOfOrder, spansMissingParent, openSpans, retainedMessages,
                 messagesObserved (null = unknown; unchanged between two responses
                 means the data did not change).
  conflict       count (runs refused for reusing this ID; null = unknown) and detection:
                 "enforced" (the collector refuses reused IDs), "unavailable" (older
                 client: a reuse would have merged silently, so count 0 proves
                 nothing), "unknown" (file without collector metadata).
  A session with count > 0 is never answered: see SessionConflict.`

const spanItem = `
SPAN ITEM FIELDS
  spanId, traceId       Exact IDs, never shortened; pass spanId to \`span\` / \`logs --span\`.
  name, nameTruncated   Span name, cut to 200 characters.
  kind                  internal | server | client | producer | consumer.
  parentSpanId          Local parent span ID, or null (root or remote parent).
  status                ok | error (typed failure, Fail) | defect (Die) |
                        interrupted | open (no end recorded).
  startMs, endMs        Session ms; endMs null while open.
  durationMs            endMs - startMs: elapsed wall time. null when open.
  childCoveredMs        Union of recorded direct-child intervals clipped to the span
                        (overlapping children count once). null when open.
  outsideChildrenMs     durationMs - childCoveredMs: elapsed time no recorded child
                        covers. NOT CPU time and not proof of missing instrumentation.
  elapsedLowerBoundMs   Open spans only: observedUntilMs - startMs, how long it had been
                        open at the last observation. An open span may still be running
                        or its end may be lost; it is not a deadlock verdict.
  childCount, openChildCount, eventCount, logCount
  error                 null, or { kind: "Fail"|"Die"|"Interrupt", message (<= 500
                        characters), messageTruncated }.`

const timing = `
READING TIMINGS
  Durations are observations, not verdicts. A long span may be waiting, doing I/O,
  retrying, or running code without spans; outsideChildrenMs only says no recorded
  child covered that time. Neither field is CPU time, and nothing here labels an
  operation slow: there are no built-in budgets or baselines. State any threshold
  you apply yourself (e.g. --min-duration-ms is echoed in query).`

const outputRules = (op: string, emptyResults = true) => `
OUTPUT
  stdout   One JSON document: pretty-printed (2-space indent), or compact on one line
           with --json, followed by a newline.
           Success: { "ok": true, "apiVersion": 1, "op": "${op}", "query", ..., "result" }.
           Failure: { "ok": false, "apiVersion": 1, "op", "error": { "_tag", "message",
           "hint", ...details } }.
           The complete stdout, as printed in the chosen mode and including the final
           newline, is always at most 1048576 UTF-8 bytes. Pretty output is larger than
           compact, so a page can fit with --json but not without it: that case is
           ResponseTooLarge with error.output "pretty" (exit 6); add --json or ask for
           fewer items.
  stderr   Empty on success. On failure one line "effect-inspect ${op}: TAG (exit N): message"
           and a "hint:" line.${emptyResults ? '\n  An empty result is a success: ok true, result.total 0, exit 0.' : ''}
  Error messages from the query engine name request fields: sessionId = --session,
  spanId = --span, fromMs/toMs = --from-ms/--to-ms, minDurationMs = --min-duration-ms,
  minLevel = --min-level; limit, offset, top, children, events, status, sort, name and
  scope match their flags.`

const exitTable = (tags: ReadonlyArray<Query.ErrorTag>) => `
EXIT CODES AND ERRORS (error._tag)
  0   ok, including empty results
  1   internal error (bug; details on stderr)
${tags.map((tag) => `  ${String(exitCodes[tag]).padEnd(3)} ${errorHelp[tag]}`).join('\n')}`

const errorHelp: Readonly<Record<Query.ErrorTag, string>> = {
  InvalidRequest:
    'InvalidRequest: unknown, missing, conflicting, malformed or out-of-range flag. Nothing\n      was queried. Fix the flags (see above).',
  SessionNotFound:
    'SessionNotFound: no session with exactly error.sessionId on this collector (or in\n      this file; then error.fileSessionId names what it holds). Nothing was substituted.\n      Check the ID you launched with, that the program uses Inspect.layer() pointed at\n      this collector and has started, --url/EFFECT_INSPECT_PORT; or run `sessions`.',
  SpanNotFound:
    'SpanNotFound: the session has no retained span error.spanId (wrong ID, evicted, or\n      never received; error.completeness says whether loss was recorded). Use `spans`.',
  SessionConflict:
    'SessionConflict: error.conflicts other runs announced this ID, so no data can be\n      attributed to one run. Relaunch with a new unique EFFECT_INSPECT_SESSION_ID.',
  ResponseTooLarge:
    'ResponseTooLarge: the answer would exceed 1048576 bytes (error.limitBytes). Without\n      error.output, the query itself was too large as compact JSON (live: HTTP 413) and\n      error.bytes is that size; with error.output "pretty" or "compact", error.bytes is\n      the size stdout would have had in that mode. error.originalOutcome is what it\n      would have been. Add --json if output is "pretty", lower --limit/--top/\n      --children/--events or narrow the filters; IDs are never shortened to fit.',
  TraceFileError:
    'TraceFileError: --file could not be read, is empty, is not a trace, is from a newer\n      format, or is corrupt (error.file). Gzip is not supported.',
  CollectorUnavailable:
    'CollectorUnavailable: nothing answered at error.url within --timeout-ms. Start\n      `effect-inspect start`, fix --url/EFFECT_INSPECT_PORT, raise --timeout-ms, or use --file.',
  CollectorError:
    'CollectorError: something answered at error.url but not this query API (an older\n      collector or another service). Upgrade/restart the collector or fix the URL.',
  OutputError:
    'OutputError: --out could not be written (error.file): it already exists (pass\n      --force to replace it) or its directory is missing or not writable.',
}

const sessionErrors: ReadonlyArray<Query.ErrorTag> = [
  'InvalidRequest',
  'SessionNotFound',
  'SessionConflict',
  'ResponseTooLarge',
  'TraceFileError',
  'CollectorUnavailable',
  'CollectorError',
]

const spanErrors: ReadonlyArray<Query.ErrorTag> = [
  'InvalidRequest',
  'SessionNotFound',
  'SpanNotFound',
  'SessionConflict',
  'ResponseTooLarge',
  'TraceFileError',
  'CollectorUnavailable',
  'CollectorError',
]

const livePaging = `
  Live sessions that are still active (source.active true) can change between two
  calls, so offsets may shift; compare completeness.messagesObserved, wait until
  active is false, or export and page through the file for a stable walk.`

const pagingRules = (max: number, fallback: number, order: string, consistency = livePaging) => `
PAGING
  result is a page: { total, offset, limit, nextOffset, items }. total counts every
  match; nextOffset is the --offset of the next page, or null on the last page.
  --limit 1-${max} (default ${fallback}). Order: ${order}.${consistency}`

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const sessionsCommand = Command.make(
  'sessions',
  {
    file,
    url,
    timeoutMs,
    ...page(Query.limits.sessions.max, Query.limits.sessions.default, 'Sessions'),
    json,
  },
  (flags) =>
    Effect.flatMap(
      answer(
        'sessions',
        { ...flags, session: Option.none() },
        given({ limit: flags.limit, offset: flags.offset }),
      ),
      (response) => emit(response, flags.json),
    ),
).pipe(
  Command.withShortDescription('Discovery only: list sessions when you do not know the ID'),
  Command.withDescription(
    text(`
List sessions on the collector (newest start first, ties by ID), or the single session
in a --file. Use it only to discover an ID you did not choose: when you launched the
program with EFFECT_INSPECT_SESSION_ID, query that ID directly with \`summary\`.

SOURCE
  Live by default (no --session: this command takes none). --file PATH lists the file's
  one session instead; --url/--timeout-ms are then rejected.
  Collector address: --url, else http://localhost:$EFFECT_INSPECT_PORT, else
  http://localhost:${defaultPort}. --timeout-ms bounds the whole call (default ${Client.defaultTimeoutMs}).

RESULT
  { "ok": true, "apiVersion": 1, "op": "sessions",
    "query": { "op": "sessions", "limit": 50, "offset": 0 },
    "source": { "kind": "live", "file": null },
    "result": { "total": 1, "offset": 0, "limit": 50, "nextOffset": null, "items": [
      { "sessionId": "failing-run-001", "program": "example:failing",
        "programTruncated": false, "pid": 58569, "runtime": "bun 1.4.2",
        "runtimeTruncated": false, "active": false,
        "startedAtEpochMillis": 1790352511476, "endedAtEpochMillis": 1790352511719,
        "conflicts": null } ] } }
  active        The program is still connected (more data may arrive).
  endedAtEpochMillis  When the connection closed (null while active); not success.
  conflicts     Refused reuses of the ID (queries for it fail with SessionConflict);
                null = none recorded, which for an older client proves nothing.
  An empty collector gives total 0 and items [] with exit 0.
${pagingRules(
  Query.limits.sessions.max,
  Query.limits.sessions.default,
  'newest startedAtEpochMillis first',
  `
  Each call lists the collector's sessions at that moment: sessions that start
  between two calls shift offsets. Compare result.total between pages, or use a
  --limit large enough for one page.`,
)}
${outputRules('sessions')}
${exitTable(['InvalidRequest', 'ResponseTooLarge', 'TraceFileError', 'CollectorUnavailable', 'CollectorError'])}
`),
  ),
  Command.withExamples([
    { command: 'effect-inspect sessions --json', description: 'Sessions on the local collector' },
    {
      command: 'effect-inspect sessions --file failing-run-001.eitrace --json',
      description: 'The session a saved file holds',
    },
  ]),
)

const summaryCommand = Command.make(
  'summary',
  {
    session,
    file,
    url,
    timeoutMs,
    top: Flag.Int('top').pipe(
      Flag.optional,
      Flag.withDescription(
        `Items per ranked list, 1-${Query.limits.top.max} (default ${Query.limits.top.default}).`,
      ),
    ),
    json,
  },
  (flags) =>
    Effect.flatMap(answer('summary', flags, given({ top: flags.top })), (response) =>
      emit(response, flags.json),
    ),
).pipe(
  Command.withShortDescription(
    'Step 1: counts, failures, longest spans and completeness of one run',
  ),
  Command.withDescription(
    text(`
Overview of one session: notices, span counts by status, failures, unfinished spans
and where they were last recorded, the longest completed spans, the spans
with the most time outside recorded children, still-open spans, per-name totals, log
counts by level and memory samples, plus how complete the evidence is. Start every
investigation here, then drill down with \`spans\`, \`span\` and \`logs\`.
${sourceRules}

RESULT (abbreviated; lists hold at most --top items)
  { "ok": true, "apiVersion": 1, "op": "summary",
    "query": { "op": "summary", "sessionId": "failing-run-001", "top": 5 },
    "notices": [],
    "source": { "kind": "live", "sessionId": "failing-run-001", "active": false, ... },
    "time": { "unit": "ms", "reference": "sessionStart",
              "observedFromMs": -1.348, "observedUntilMs": 240.867 },
    "termination": { "state": "ended", "lastObservedMs": 240.867, "endedAtMs": 243,
                     "unobservedTailMs": 2.133 },
    "completeness": { "status": "noLossRecorded", "openSpans": 0, ... },
    "conflict": { "count": 0, "detection": "enforced" },
    "result": {
      "spans": { "total": 11, "ok": 6, "error": 3, "defect": 1, "interrupted": 1, "open": 0 },
      "spanEvents": 3,
      "logs": { "total": 4, "byLevel": { "Info": 3, "Warn": 1 } },
      "memory": { "samples": 2, "peakHeapUsedBytes": 7158493, "peakRssBytes": 61489152,
                  "lastHeapUsedBytes": 7158493 },
      "failures": { "total": 4, "items": [ SPAN ITEM, ... ] },
      "unfinished": { "open": 0, "innermost": { "total": 0, "items": [] } },
      "longest": [ SPAN ITEM, ... ],
      "largestOutsideChildren": [ SPAN ITEM, ... ],
      "longestOpen": [ SPAN ITEM, ... ],
      "names": { "total": 11, "items": [ { "name": "failures", "nameTruncated": false,
        "count": 1, "completed": 1, "open": 0, "failed": 0, "totalDurationMs": 241.993,
        "maxDurationMs": 241.993, "totalOutsideChildrenMs": 0.658 }, ... ] } } }

RESULT FIELDS
  notices          Top level, before result: { code, message } facts easy to miss.
                   openSpans (spans without a recorded end, the termination state
                   and the last recorded position), rankingsCompletedOnly (longest and
                   largestOutsideChildren skip open spans), collectorEvicted (oldest
                   messages evicted at capacity: data before observedFromMs is
                   missing), memorySamplingGap (the largest gap between memory
                   samples exceeds 10x the median). Messages state facts;
                   explanations are possibilities.
  spans            Counts by status. failures lists error and defect spans (not
                   interruptions), earliest start first; failures.total counts all.
  unfinished       open: spans without a recorded end. innermost: open spans with no
                   open child - the last recorded position on each open chain, not a
                   cause - largest elapsedLowerBoundMs first. Each is a SPAN ITEM plus
                   openAncestors: { items: [ { spanId, name, nameTruncated, status,
                   startMs, durationMs, elapsedLowerBoundMs } ], truncated }:
                   contiguous open ancestors, root-most first, at most 32 nearest;
                   truncated marks more above. durationMs is null (no end);
                   elapsedLowerBoundMs is observedUntilMs - startMs.
  longest          Completed spans only, largest durationMs first.
  largestOutsideChildren  Completed spans only, largest outsideChildrenMs first.
  longestOpen      Open spans, largest elapsedLowerBoundMs first.
  names            Groups by full span name, largest totalDurationMs first. Sums cover
                   completed spans; nested and concurrent spans overlap, so totals can
                   exceed the run's wall time. failed counts every failure incl.
                   interruptions.
  logs.byLevel     Only levels that occur.
  memory           Process-wide samples (all work in the process), or null without
                   samples: { samples, peakHeapUsedBytes, peakHeapAtMs, peakRssBytes,
                   lastHeapUsedBytes, firstSampleMs, lastSampleMs, medianIntervalMs,
                   maxGapMs, maxGapFromMs, maxGapToMs, spansActiveAtPeak }. Periodic
                   samples miss peaks between them; maxGapMs is the longest stretch
                   with no sample. spansActiveAtPeak: { total, items: [ { spanId,
                   name, nameTruncated, status, startMs, durationMs } ] }, the
                   innermost spans active at peakHeapAtMs - active at that time only,
                   not shown to be what the heap in use belongs to.
${spanItem}
${context}
${timing}
${outputRules('summary')}
${exitTable(sessionErrors)}
`),
  ),
  Command.withExamples([
    {
      command: 'effect-inspect summary --session failing-run-001 --json',
      description: 'Live: the run launched with EFFECT_INSPECT_SESSION_ID=failing-run-001',
    },
    {
      command:
        'effect-inspect summary --file failing-run-001.eitrace --session failing-run-001 --json',
      description: 'Offline, asserting the file holds that session',
    },
  ]),
)

const spansCommand = Command.make(
  'spans',
  {
    session,
    file,
    url,
    timeoutMs,
    status: Flag.Literals('status', ['any', 'failed', ...Query.spanStatuses]).pipe(
      Flag.optional,
      Flag.withDescription('Status filter (default any). failed = error, defect and interrupted.'),
    ),
    name: Flag.String('name').pipe(
      Flag.optional,
      Flag.withDescription(
        `Case-insensitive substring of the full span name (at most ${Query.limits.requestTextChars} characters).`,
      ),
    ),
    minDurationMs: Flag.Finite('min-duration-ms').pipe(
      Flag.optional,
      Flag.withDescription(
        'Only spans with durationMs (open: elapsedLowerBoundMs) >= this many ms, >= 0.',
      ),
    ),
    ...window('selects spans overlapping the window'),
    sort: Flag.Literals('sort', ['start', 'duration', 'outsideChildren']).pipe(
      Flag.optional,
      Flag.withDescription('Order (default start). See ORDER below.'),
    ),
    ...page(Query.limits.spans.max, Query.limits.spans.default, 'Spans'),
    json,
  },
  (flags) =>
    Effect.flatMap(
      answer(
        'spans',
        flags,
        given({
          status: flags.status,
          name: flags.name,
          minDurationMs: flags.minDurationMs,
          fromMs: flags.fromMs,
          toMs: flags.toMs,
          sort: flags.sort,
          limit: flags.limit,
          offset: flags.offset,
        }),
      ),
      (response) => emit(response, flags.json),
    ),
).pipe(
  Command.withShortDescription('Step 2: filter, rank and page the spans of one run'),
  Command.withDescription(
    text(`
A filtered, sorted page of one session's spans. Use --status failed to find failures,
--sort duration or --sort outsideChildren to rank elapsed time, --name to follow one
operation, and --from-ms/--to-ms to look at a time range. Copy a spanId into \`span\`
or \`logs --span\`.
${sourceRules}

FILTERS (all combine with AND)
  --status          any | failed | ok | error | defect | interrupted | open (default any).
                    error = typed failure (Fail), defect = Die, interrupted = Interrupt,
                    failed = any of those three, open = no end recorded.
  --name TEXT       Case-insensitive substring of the full (untruncated) name.
  --min-duration-ms Minimum durationMs, or elapsedLowerBoundMs for open spans.
  --from-ms/--to-ms Spans whose [startMs, endMs] (open spans: [startMs,
                    observedUntilMs]) overlaps the window, bounds inclusive, are
                    selected. Their timings are for the whole span, NOT clipped to the
                    window. The response's "window" field states this:
                    { "fromMs", "toMs", "match": "overlap", "inclusive": true,
                      "timings": "fullSpan" }, or null without a window. Either bound
                    may be given alone. Negative values: --from-ms=-5.

ORDER (--sort)
  start            startMs ascending (default).
  duration         durationMs descending. Open spans are interleaved by
                   elapsedLowerBoundMs: their true duration is at least that.
  outsideChildren  outsideChildrenMs descending. Open spans are interleaved by the
                   time so far no recorded child covered (open children count as
                   covering up to observedUntilMs): a lower bound, not shown in the
                   item (their outsideChildrenMs is null).
  Ties: startMs, then spanId.
${pagingRules(Query.limits.spans.max, Query.limits.spans.default, 'as --sort')}

RESULT (abbreviated)
  { "ok": true, "apiVersion": 1, "op": "spans",
    "query": { "op": "spans", "sessionId": "failing-run-001", "status": "failed",
               "sort": "start", "limit": 20, "offset": 0 },
    "source": { ... }, "time": { ... }, "termination": { ... },
    "completeness": { ... }, "conflict": { ... },
    "window": null,
    "result": { "total": 5, "offset": 0, "limit": 20, "nextOffset": null, "items": [
      { "spanId": "0a40c31fbf88b7db", "traceId": "9d502fd678d8f15c0328b182dc1e3509",
        "name": "charge.card", "nameTruncated": false, "kind": "internal",
        "parentSpanId": "99dd044045282fe6", "status": "error",
        "startMs": -0.671, "endMs": 20.775, "durationMs": 21.446,
        "childCoveredMs": 0, "outsideChildrenMs": 21.446, "elapsedLowerBoundMs": null,
        "childCount": 0, "openChildCount": 0, "eventCount": 1, "logCount": 1,
        "error": { "kind": "Fail",
                   "message": "PaymentDeclined: card **** 4242 was declined\\n    at ...",
                   "messageTruncated": false } }, ... ] } }
${spanItem}
${context}
${timing}
${outputRules('spans')}
${exitTable(sessionErrors)}
`),
  ),
  Command.withExamples([
    {
      command: 'effect-inspect spans --session failing-run-001 --status failed --json',
      description: 'Every failed span, earliest first',
    },
    {
      command:
        'effect-inspect spans --session failing-run-001 --sort outsideChildren --limit 5 --json',
      description:
        'Five spans ranked by elapsed time outside recorded children (open spans by a lower bound)',
    },
    {
      command:
        'effect-inspect spans --session failing-run-001 --from-ms=0 --to-ms 50 --sort duration --json',
      description: 'Spans overlapping the first 50 ms, longest first',
    },
    {
      command: 'effect-inspect spans --file failing-run-001.eitrace --name fetch --json',
      description: 'Offline: spans whose name contains "fetch"',
    },
  ]),
)

const spanCommand = Command.make(
  'span',
  {
    session,
    file,
    url,
    timeoutMs,
    span: Flag.String('span').pipe(
      Flag.withDescription('Required. Exact spanId (from summary, spans or logs).'),
    ),
    children: Flag.Int('children').pipe(
      Flag.optional,
      Flag.withDescription(
        `Children listed, 1-${Query.limits.children.max} (default ${Query.limits.children.default}).`,
      ),
    ),
    events: Flag.Int('events').pipe(
      Flag.optional,
      Flag.withDescription(
        `Span events listed, 1-${Query.limits.events.max} (default ${Query.limits.events.default}).`,
      ),
    ),
    json,
  },
  (flags) =>
    Effect.flatMap(
      answer(
        'span',
        flags,
        given({ spanId: Option.some(flags.span), children: flags.children, events: flags.events }),
      ),
      (response) => emit(response, flags.json),
    ),
).pipe(
  Command.withShortDescription(
    'Step 3: one span with error, attributes, ancestry, children, events',
  ),
  Command.withDescription(
    text(`
Everything retained about one span: its timing and outcome, error message and stack,
attributes, where it sits (parent and ancestry up to the root), its first children and
its span events. Use it after \`summary\` or \`spans\` gave you a spanId.
${sourceRules}

RESULT (abbreviated): a SPAN ITEM plus the fields below
  { "ok": true, "apiVersion": 1, "op": "span",
    "query": { "op": "span", "sessionId": "failing-run-001",
               "spanId": "0a40c31fbf88b7db", "children": 20, "events": 20 },
    "source": { ... }, "time": { ... }, "termination": { ... },
    "completeness": { ... }, "conflict": { ... },
    "result": { "spanId": "0a40c31fbf88b7db", "name": "charge.card", "status": "error",
      ...other SPAN ITEM fields...,
      "attributes": { "entries": [], "omittedKeys": 0 },
      "stack": "Error\\n    at <anonymous> (.../examples/failing.ts:36:21)\\n    ...",
      "stackTruncated": false,
      "parent": { "kind": "local", "spanId": "99dd044045282fe6", "retained": true },
      "ancestry": { "items": [
          { "spanId": "3a4801517020bae9", "name": "failures", "nameTruncated": false,
            "status": "ok", "startMs": -1.126, "durationMs": 241.993 },
          { "spanId": "99dd044045282fe6", "name": "typed-error", "nameTruncated": false,
            "status": "ok", "startMs": -0.702, "durationMs": 21.949 } ],
        "truncated": false },
      "children": { "total": 0, "items": [] },
      "events": { "total": 1, "items": [ { "name": "charging card **** 4242",
          "nameTruncated": false, "timeMs": -0.538, "attributes": { "entries": [
            { "key": "effect.fiberId", "keyTruncated": false, "value": 1,
              "valueTruncated": false }, ... ], "omittedKeys": 0 } } ] } } }

RESULT FIELDS
  attributes     entries in the span's key order, at most 32; omittedKeys counts the
                 rest. key is cut to 100 characters (keyTruncated), so two long keys
                 can print alike and still be different entries. value is the JSON
                 value, or, when its JSON encoding exceeds 500 characters, the first
                 500 characters of that encoding as a string (valueTruncated true).
  stack          Failure stack, at most 4000 characters (stackTruncated), or null.
  parent         { kind: "none" } for a root; { kind: "local", spanId, retained } for a
                 local parent (retained false: the parent is not in the data);
                 { kind: "external", spanId, traceId } for a remote parent.
  ancestry       Up to 32 nearest ancestors as { spanId, name, nameTruncated, status,
                 startMs, durationMs }, root-most first, ending at the direct parent;
                 truncated true when more exist above.
  children       total and the first --children child SPAN ITEMs by startMs.
  events         total and the first --events events by time:
                 { name, nameTruncated, timeMs, attributes }. Effect logs emitted inside
                 the span are also recorded as its events (as above); use \`logs --span\`
                 for their level and message.
  processMemory  Process-wide memory samples within the span's interval (open: up to
                 observedUntilMs): { samples, firstSampleMs, lastSampleMs,
                 firstHeapUsedBytes, lastHeapUsedBytes, maxHeapUsedBytes }, or null
                 when no sample falls in range. Includes all concurrent work in the
                 process; not what this span itself used or kept.
${spanItem}
${context}
${timing}
${outputRules('span')}
${exitTable(spanErrors)}
`),
  ),
  Command.withExamples([
    {
      command: 'effect-inspect span --session failing-run-001 --span SPAN_ID --json',
      description: 'SPAN_ID is a spanId copied from summary or spans output',
    },
    {
      command:
        'effect-inspect span --file failing-run-001.eitrace --span SPAN_ID --children 100 --json',
      description: 'Offline, listing up to 100 children',
    },
  ]),
)

const logsCommand = Command.make(
  'logs',
  {
    session,
    file,
    url,
    timeoutMs,
    span: Flag.String('span').pipe(
      Flag.optional,
      Flag.withDescription(
        'Only logs emitted inside this exact spanId (with --scope). Without it: all logs.',
      ),
    ),
    scope: Flag.Literals('scope', ['subtree', 'span']).pipe(
      Flag.optional,
      Flag.withDescription(
        'Requires --span. subtree (default): the span and all its descendants; span: that span only.',
      ),
    ),
    minLevel: Flag.Literals('min-level', Query.logLevels).pipe(
      Flag.optional,
      Flag.withDescription('Only this level and more severe (default: all levels).'),
    ),
    ...window('log time within the window'),
    ...page(Query.limits.logs.max, Query.limits.logs.default, 'Logs'),
    json,
  },
  (flags) =>
    Effect.flatMap(
      answer(
        'logs',
        flags,
        given({
          spanId: flags.span,
          scope: flags.scope,
          minLevel: flags.minLevel,
          fromMs: flags.fromMs,
          toMs: flags.toMs,
          limit: flags.limit,
          offset: flags.offset,
        }),
      ),
      (response) => emit(response, flags.json),
    ),
).pipe(
  Command.withShortDescription('Step 4: logs of one run, by span, level or time window'),
  Command.withDescription(
    text(`
A page of one session's logs in time order. Correlate them with a span using --span
(logs emitted while that span, or with the default --scope subtree any descendant, was
the current span), filter by --min-level, or take the logs around a failure with
--from-ms/--to-ms set from the span's startMs/endMs. A failed span often has no logs of
its own: try its parent (parentSpanId, or an ancestry item) with --span, or a window.
${sourceRules}

FILTERS (all combine with AND)
  --span ID          Exact spanId; SpanNotFound (exit 4) if it is not retained.
  --scope            subtree (default with --span) | span. Without --span it is an
                     InvalidRequest, never silently ignored.
  --min-level        Trace | Debug | Info | Warn | Error | Fatal; that level and above.
  --from-ms/--to-ms  Log timeMs within the window, bounds inclusive. The response's
                     "window" field is { "fromMs", "toMs", "match": "within",
                     "inclusive": true }, or null. Negative values: --from-ms=-5.
${pagingRules(Query.limits.logs.max, Query.limits.logs.default, 'timeMs ascending; equal times keep arrival order')}

RESULT (abbreviated)
  { "ok": true, "apiVersion": 1, "op": "logs",
    "query": { "op": "logs", "sessionId": "failing-run-001",
               "spanId": "0a40c31fbf88b7db", "scope": "subtree", "limit": 50, "offset": 0 },
    "source": { ... }, "time": { ... }, "termination": { ... },
    "completeness": { ... }, "conflict": { ... },
    "window": null,
    "result": { "total": 1, "offset": 0, "limit": 50, "nextOffset": null, "items": [
      { "timeMs": -0.506, "level": "Info", "message": "charging card **** 4242",
        "messageTruncated": false, "spanId": "0a40c31fbf88b7db",
        "spanName": "charge.card", "spanNameTruncated": false, "fiberId": 1,
        "annotations": { "entries": [], "omittedKeys": 0 } } ] } }

RESULT FIELDS
  level          Trace | Debug | Info | Warn | Error | Fatal.
  message        At most 2000 characters (messageTruncated); non-string messages are
                 JSON-encoded.
  spanId         The span current when the log was emitted, or null (outside any span).
  spanName       That span's name cut to 200 characters, or null when not retained.
  fiberId        Emitting fiber number, or null.
  annotations    Same bounded entries shape as span attributes (32 keys, 100-character
                 keys, 500-character values, *Truncated flags, omittedKeys).
  A Warn log carrying the annotation effect_inspect.dropped means the program dropped
  telemetry; it is counted in completeness.clientDroppedMessages.
${context}
${outputRules('logs')}
${exitTable(spanErrors)}
`),
  ),
  Command.withExamples([
    {
      command: 'effect-inspect logs --session failing-run-001 --span SPAN_ID --json',
      description: 'Logs inside a span and its descendants (SPAN_ID copied from spans output)',
    },
    {
      command: 'effect-inspect logs --session failing-run-001 --min-level Warn --json',
      description: 'Every warning or worse in the run',
    },
    {
      command: 'effect-inspect logs --file failing-run-001.eitrace --from-ms=0 --to-ms 100 --json',
      description: 'Offline: logs from the first 100 ms',
    },
  ]),
)

const exportCommand = Command.make(
  'export',
  {
    session: Flag.String('session').pipe(
      Flag.optional,
      Flag.withDescription('Required. Exact ID of the live session to save.'),
    ),
    out: Flag.String('out').pipe(
      Flag.optional,
      Flag.withDescription('Required. Path of the .eitrace file to create.'),
    ),
    force: Flag.Boolean('force').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Replace --out if it already exists (default: refuse).'),
    ),
    url,
    timeoutMs,
    json,
  },
  (flags) =>
    Effect.flatMap(
      Effect.gen(function* () {
        if (Option.isNone(flags.session) || Option.isNone(flags.out)) {
          return invalid(
            'export',
            'export needs --session ID (the live session to save) and --out PATH (the file to create).',
            'Example: effect-inspect export --session my-run-001 --out my-run-001.eitrace',
          )
        }
        const sessionId = flags.session.value
        const out = flags.out.value
        const target = yield* liveTarget('export', flags)
        const exported = yield* Client.exportTrace(target, sessionId).pipe(
          Effect.provide(FetchHttpClient.layer),
        )
        if (!exported.ok) return exported
        const fs = yield* FileSystem
        yield* fs
          .writeFileString(out, exported.text, { flag: flags.force ? 'w' : 'wx' })
          .pipe(
            Effect.mapError((error) =>
              Query.failure(
                'export',
                'OutputError',
                `The trace could not be written: ${error.message}`,
                flags.force
                  ? 'Check that the directory exists and is writable.'
                  : 'Choose a new --out path, or pass --force to replace the existing file; check that the directory exists and is writable.',
                { file: out },
              ),
            ),
          )
        return {
          ok: true,
          apiVersion: Query.apiVersion,
          op: 'export',
          query: { op: 'export', sessionId, out, force: flags.force },
          result: { sessionId, file: out, bytes: new TextEncoder().encode(exported.text).length },
        } satisfies ExportResponse
      }).pipe(Effect.catch((failure: Query.QueryFailure) => Effect.succeed(failure))),
      (response) => emit(response, flags.json),
    ),
).pipe(
  Command.withShortDescription('Step 5: save one live session to a .eitrace for offline queries'),
  Command.withDescription(
    text(`
Download one live session from the collector and write it to a new .eitrace file:
the frozen snapshot's protocol messages plus a header with the session's clock and the
collector's loss counters. Every query command then answers from the file with
--file PATH exactly as it answered live at that moment (only source.kind, source.file
and source.snapshotAtEpochMillis differ), with no collector running. The web UI opens
the same files. The collector keeps traces in memory only; export what you need
before it stops.

SOURCE AND FILE
  --session ID   Required, exact live ID (never the newest session). Export is live
                 only; to copy a saved trace, copy the file.
  --out PATH     Required. Created with exclusive create: an existing file is never
                 overwritten unless --force. Relative paths resolve against the
                 current directory. Nothing is written when the download fails.
  Collector address: --url, else http://localhost:$EFFECT_INSPECT_PORT, else
  http://localhost:${defaultPort}. --timeout-ms (default ${Client.defaultTimeoutMs}) bounds the whole download;
  raise it for very large sessions.

SIZE AND COMPLETENESS
  The file is a lossless artifact, not a query answer: it is NOT held to the 1 MiB
  JSON limit and can be as large as the retained session (the collector keeps up to
  EFFECT_INSPECT_CAPACITY messages per session, default 200000). An active session is
  saved as of the download; later telemetry is not in the file. A session with an ID
  conflict still exports, so the evidence is kept, but queries on the file then fail
  with SessionConflict, as live ones do. Run \`summary --file PATH\` to read the
  file's completeness.

RESULT
  { "ok": true, "apiVersion": 1, "op": "export",
    "query": { "op": "export", "sessionId": "failing-run-001",
               "out": "failing-run-001.eitrace", "force": false },
    "result": { "sessionId": "failing-run-001", "file": "failing-run-001.eitrace",
                "bytes": 5321 } }
  bytes          UTF-8 size of the file written. The trace itself never goes to stdout.
${outputRules('export', false)}
${exitTable(['InvalidRequest', 'SessionNotFound', 'ResponseTooLarge', 'CollectorUnavailable', 'CollectorError', 'OutputError'])}
  (ResponseTooLarge here only guards an oversized error reply.)
`),
  ),
  Command.withExamples([
    {
      command:
        'effect-inspect export --session failing-run-001 --out failing-run-001.eitrace --json',
      description: 'Save the run, then query it offline',
    },
    { command: 'effect-inspect summary --file failing-run-001.eitrace --json' },
  ]),
)

/** The query subcommands, in investigation order. */
export const queryCommands = [
  summaryCommand,
  spansCommand,
  spanCommand,
  logsCommand,
  exportCommand,
  sessionsCommand,
] as const

const queryNames: ReadonlySet<string> = new Set(queryCommands.map((command) => command.name))

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Runs `cli` on `args` and resolves to the process exit code.
 *
 * For a query command (without `--help`/`--version`) the parser's own help dump
 * on a usage error is suppressed: its errors become one `InvalidRequest` JSON
 * on stdout, a stderr diagnostic and exit 2, so stdout stays machine-readable.
 * Other invocations (`start`, the root, help) render exactly as the framework
 * does.
 */
export const runCli = <Name extends string, Input, E, R, ContextInput>(
  cli: Command.Command<Name, Input, ContextInput, E, R>,
  version: string,
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const help = args.some(
      (arg) =>
        arg === '--help' ||
        arg === '-h' ||
        arg === '--version' ||
        arg === '-v' ||
        arg.startsWith('--completions'),
    )
    const op = args.find((arg) => queryNames.has(arg))
    const quiet = !help && op !== undefined
    const console = yield* Console.Console
    return yield* Command.runWith(cli, { version, renderErrors: !quiet })(args).pipe(
      Effect.as(0),
      Effect.catch((error) => {
        if (error instanceof CliExit) return Effect.succeed(error.code)
        if (!CliError.isCliError(error)) return Effect.fail(error)
        const errors = error._tag === 'ShowHelp' ? error.errors : [error]
        if (errors.length === 0) return Effect.succeed(0)
        if (!quiet || op === undefined) return Effect.succeed(exitCodes.InvalidRequest)
        return emit(
          invalid(
            op,
            errors.map((each) => each.message).join(' '),
            `Run \`effect-inspect ${op} --help\` for the flags, their types and allowed values.`,
          ),
          args.includes('--json'),
        ).pipe(
          Effect.as(exitCodes.InvalidRequest),
          Effect.catch((exit) => Effect.succeed(exit.code)),
        )
      }),
      quiet
        ? Effect.provideService(
            Console.Console,
            Object.assign(Object.create(console) as Console.Console, { log: () => {} }),
          )
        : (self) => self,
    )
  })
