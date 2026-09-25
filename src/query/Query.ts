/**
 * Headless, read-only trace queries with one contract for every source.
 *
 * A {@link TraceSource} is a frozen session: a collector snapshot or a saved
 * `.eitrace`. Both are the same protocol message stream, so both are analysed
 * by the same code — the browser's {@link TraceStore} reconstruction and
 * {@link timings} math — and a snapshot queried live answers exactly as its
 * exported file does.
 *
 * Every answer is JSON, bounded in size, names its source and time reference,
 * and says what it cannot vouch for: a response never presents partial or
 * conflicting evidence as a complete, unambiguous run. Requests and responses
 * are plain data so the CLI can print them and the collector can serve them.
 *
 * Timing is observation, not diagnosis. `durationMs` is elapsed time between a
 * span's recorded start and end; `outsideChildrenMs` is the part of it not
 * covered by any recorded direct child. Neither is CPU time, and neither says
 * an operation is slow, stuck or under-instrumented on its own.
 */
import { Result, Schema } from 'effect'
import type * as Protocol from '../protocol/Schema.ts'
import { timings } from '../trace/Timing.ts'
import { parseTraceFile, serializeTraceFile } from '../trace/TraceFile.ts'
import { type TraceSpan, TraceStore } from '../trace/TraceStore.ts'

/** Version of this request/response contract. Bumped on a breaking change. */
export const apiVersion = 1

/** Defaults and caps for every bounded part of a response. */
export const limits = {
  /** `sessions` page size. */
  sessions: { default: 50, max: 500 },
  /** `spans` page size. */
  spans: { default: 20, max: 200 },
  /** `logs` page size. */
  logs: { default: 50, max: 500 },
  /** Items per ranked list in `summary`. */
  top: { default: 5, max: 50 },
  /** Children listed by `span`. */
  children: { default: 20, max: 200 },
  /** Span events listed by `span`. */
  events: { default: 20, max: 200 },
  /** Nearest ancestors listed by `span`. */
  ancestry: 32,
  /** Attribute/annotation keys kept per object; the rest are counted, not sent. */
  attributeKeys: 32,
  /** Characters of one JSON-encoded attribute value before it is cut. */
  valueChars: 500,
  /** Characters of a failure message. */
  errorChars: 500,
  /** Characters of a failure stack. */
  stackChars: 4000,
  /** Characters of a log message. */
  logMessageChars: 2000,
} as const

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Loss counters the collector keeps for a session. Mirrors
 * {@link Protocol.TraceCapture}; `undefined` on a source means unknown.
 */
export type Capture = Protocol.TraceCapture

/** One frozen session, from the collector or from a file. */
export interface TraceSource {
  readonly kind: 'live' | 'file'
  /** Path (or label) of the file, for `kind: 'file'`. */
  readonly file?: string | undefined
  readonly session: Protocol.Session
  /** Retained protocol messages in arrival order. */
  readonly messages: ReadonlyArray<Protocol.ClientMessage>
  /** Collector loss counters, or `undefined` when the source never recorded them. */
  readonly capture: Capture | undefined
  /** Undecodable trailing file lines; 0 for live sources. */
  readonly truncatedLines: number
  /** When the snapshot was taken (live) or the file saved, epoch millis. */
  readonly snapshotAtEpochMillis: number
}

/** A live source from a collector `Store` snapshot taken at `now`. */
export const fromSnapshot = (
  snapshot: {
    readonly session: Protocol.Session
    readonly messages: ReadonlyArray<Protocol.ClientMessage>
    readonly droppedMessages: number
    readonly skippedLines: number
    readonly conflictDetection: boolean
  },
  now: number,
): TraceSource => ({
  kind: 'live',
  session: snapshot.session,
  messages: snapshot.messages,
  capture: {
    droppedMessages: snapshot.droppedMessages,
    skippedLines: snapshot.skippedLines,
    conflictDetection: snapshot.conflictDetection,
  },
  truncatedLines: 0,
  snapshotAtEpochMillis: now,
})

/**
 * Trace-file text for a source, with its loss counters in the header so a
 * query against the file reports the same completeness as the snapshot.
 */
export const toTraceFile = (source: TraceSource): string =>
  serializeTraceFile(source.session, source.messages, source.snapshotAtEpochMillis, source.capture)

/** Parses trace-file text into a file source, or the `TraceFileError` response. */
export const fromTraceFile = (
  text: string,
  file: string,
): Result.Result<TraceSource, QueryFailure> =>
  Result.match(parseTraceFile(text), {
    onFailure: (error) =>
      Result.fail(
        failure(
          null,
          'TraceFileError',
          error.message,
          'Check the path points at a saved .eitrace file.',
          {
            file,
          },
        ),
      ),
    onSuccess: ({ header, messages, truncatedLines }) =>
      Result.succeed({
        kind: 'file' as const,
        file,
        session: header.session,
        messages,
        capture: header.capture,
        truncatedLines,
        snapshotAtEpochMillis: header.savedAtEpochMillis,
      }),
  })

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const pageSize = (max: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: max }))
const Millis = Schema.Finite
const sessionId = Schema.optional(Schema.String)

/** Span status values a span can have. */
export const spanStatuses = ['ok', 'error', 'defect', 'interrupted', 'open'] as const
export type SpanStatus = (typeof spanStatuses)[number]

/** `spans` status filter: a {@link SpanStatus}, `failed` (any failure) or `any`. */
export const StatusFilter = Schema.Literals(['any', 'failed', ...spanStatuses])
export type StatusFilter = Schema.Schema.Type<typeof StatusFilter>

export const SpanSort = Schema.Literals(['start', 'duration', 'outsideChildren'])
export type SpanSort = Schema.Schema.Type<typeof SpanSort>

/** Log levels a `minLevel` filter accepts, least severe first. */
export const logLevels = ['Trace', 'Debug', 'Info', 'Warn', 'Error', 'Fatal'] as const
export const MinLevel = Schema.Literals(logLevels)

export const LogScope = Schema.Literals(['span', 'subtree'])

/** Lists sessions. Live: every session the collector holds. File: the file's one session. */
export const SessionsRequest = Schema.Struct({
  op: Schema.Literal('sessions'),
  limit: Schema.optional(pageSize(limits.sessions.max)),
  offset: Schema.optional(Schema.Natural),
})

/** Counts, failures and ranked timings for one session. */
export const SummaryRequest = Schema.Struct({
  op: Schema.Literal('summary'),
  sessionId,
  top: Schema.optional(pageSize(limits.top.max)),
})

/** A filtered, sorted page of spans. */
export const SpansRequest = Schema.Struct({
  op: Schema.Literal('spans'),
  sessionId,
  status: Schema.optional(StatusFilter),
  /** Case-insensitive substring of the span name. */
  name: Schema.optional(Schema.String),
  /** Only spans whose duration (or, while open, elapsed lower bound) is at least this. */
  minDurationMs: Schema.optional(Millis.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Only spans overlapping `[fromMs, toMs]`. Timings are not clipped to it. */
  fromMs: Schema.optional(Millis),
  toMs: Schema.optional(Millis),
  sort: Schema.optional(SpanSort),
  limit: Schema.optional(pageSize(limits.spans.max)),
  offset: Schema.optional(Schema.Natural),
})

/** One span with bounded ancestry, children, events and attributes. */
export const SpanRequest = Schema.Struct({
  op: Schema.Literal('span'),
  sessionId,
  spanId: Schema.String,
  children: Schema.optional(pageSize(limits.children.max)),
  events: Schema.optional(pageSize(limits.events.max)),
})

/** A page of logs, optionally correlated with a span. */
export const LogsRequest = Schema.Struct({
  op: Schema.Literal('logs'),
  sessionId,
  spanId: Schema.optional(Schema.String),
  /** With `spanId`: that span's own logs, or its whole subtree's (default). */
  scope: Schema.optional(LogScope),
  minLevel: Schema.optional(MinLevel),
  fromMs: Schema.optional(Millis),
  toMs: Schema.optional(Millis),
  limit: Schema.optional(pageSize(limits.logs.max)),
  offset: Schema.optional(Schema.Natural),
})

export const QueryRequest = Schema.Union([
  SessionsRequest,
  SummaryRequest,
  SpansRequest,
  SpanRequest,
  LogsRequest,
])
export type QueryRequest = Schema.Schema.Type<typeof QueryRequest>
export type SessionQuery = Exclude<QueryRequest, { readonly op: 'sessions' }>

const decodeQuery = Schema.decodeUnknownResult(QueryRequest, { onExcessProperty: 'error' })

/**
 * Validates an untrusted request. Unknown keys are rejected rather than
 * ignored, so a misspelt filter can never silently widen a result.
 */
export const decodeRequest = (input: unknown): Result.Result<QueryRequest, QueryFailure> => {
  const op =
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { op?: unknown }).op === 'string'
      ? (input as { op: string }).op
      : null
  return Result.flatMap(
    Result.mapError(decodeQuery(input), (error) =>
      failure(op, 'InvalidRequest', error.message, 'Fix the request; see the documented fields.'),
    ),
    (request) =>
      'fromMs' in request &&
      request.fromMs !== undefined &&
      request.toMs !== undefined &&
      request.fromMs > request.toMs
        ? Result.fail(
            failure(
              op,
              'InvalidRequest',
              'fromMs must not be after toMs.',
              'Swap or fix the range.',
            ),
          )
        : Result.succeed(request),
  )
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type ErrorTag =
  | 'InvalidRequest'
  | 'SessionNotFound'
  | 'SessionConflict'
  | 'SpanNotFound'
  | 'TraceFileError'
  | 'CollectorUnavailable'
  | 'CollectorError'

/** Every failed query, whatever the source or transport. */
export interface QueryFailure {
  readonly ok: false
  readonly apiVersion: typeof apiVersion
  readonly op: string | null
  readonly error: {
    readonly _tag: ErrorTag
    readonly message: string
    /** What to try next. */
    readonly hint: string
    readonly [detail: string]: unknown
  }
}

export const failure = (
  op: string | null,
  tag: ErrorTag,
  message: string,
  hint: string,
  details?: Record<string, unknown>,
): QueryFailure => ({
  ok: false,
  apiVersion,
  op,
  error: { ...details, _tag: tag, message, hint },
})

/** Which session answered, and from where. */
export interface SourceInfo {
  readonly kind: 'live' | 'file'
  readonly file: string | null
  readonly sessionId: string
  readonly program: string
  readonly pid: number
  readonly runtime: string
  /** Live: the client was still connected at snapshot time, so more may arrive. */
  readonly active: boolean
  /** Wall clock of the session's time origin (`startMs` 0). */
  readonly startedAtEpochMillis: number
  readonly endedAtEpochMillis: number | null
  /** Live: snapshot time. File: save time. */
  readonly snapshotAtEpochMillis: number
}

/** How to read every `...Ms` field in a response. */
export interface TimeInfo {
  readonly unit: 'ms'
  /**
   * `sessionStart`: milliseconds since the session's clock origin, taken when
   * its inspect client started. Wall clock = `startedAtEpochMillis + ms`.
   * Monotonic, so comparable within a session only.
   */
  readonly reference: 'sessionStart'
  /** Earliest retained timestamp, or `null` with no timed data. */
  readonly observedFromMs: number | null
  /** Latest retained timestamp. Open spans are measured up to here. */
  readonly observedUntilMs: number | null
}

/**
 * What the evidence may be missing. `status`:
 * - `lossRecorded`: at least one counter below is non-zero.
 * - `noLossRecorded`: collector counters are known and every counter is 0.
 *   Not proof of completeness — only what was measured.
 * - `unknown`: nothing was recorded as lost, but the source never kept the
 *   collector counters (a browser save or older file).
 */
export interface Completeness {
  readonly status: 'lossRecorded' | 'noLossRecorded' | 'unknown'
  /** Evicted by the collector's per-session capacity; `null` = unknown. */
  readonly collectorDroppedMessages: number | null
  /** Undecodable lines the collector skipped; `null` = unknown. */
  readonly collectorSkippedLines: number | null
  /** Drops the client reported (its `effect_inspect.dropped` Warn logs) in retained logs. */
  readonly clientDroppedMessages: number
  /** Undecodable trailing lines of a file (a cut-short save). */
  readonly fileTruncatedLines: number
  /** Span ids with a retained end or event but no retained start. */
  readonly spansMissingStart: number
  /** Spans whose local parent span is not retained. */
  readonly spansMissingParent: number
  /** Spans with no recorded end: still running, or their end was never received. */
  readonly openSpans: number
  readonly retainedMessages: number
  /**
   * Messages the collector accepted for the session (retained + evicted);
   * `null` = unknown. Unchanged between two responses means same data.
   */
  readonly messagesObserved: number | null
}

/**
 * Collision state. A query never succeeds against a session with
 * `count > 0` (see `SessionConflict`). `detection`:
 * - `enforced`: the collector would have refused and counted a reused ID.
 * - `unavailable`: the owning client predates instance IDs; a reused ID
 *   would have merged silently, so `count: 0` proves nothing.
 * - `unknown`: a file without collector metadata.
 */
export interface ConflictInfo {
  readonly count: number | null
  readonly detection: 'enforced' | 'unavailable' | 'unknown'
}

/** Shared context of every successful per-session response. */
export interface Context {
  readonly source: SourceInfo
  readonly time: TimeInfo
  readonly completeness: Completeness
  readonly conflict: ConflictInfo
}

export interface ErrorInfo {
  readonly kind: 'Fail' | 'Die' | 'Interrupt'
  readonly message: string
  readonly messageTruncated: boolean
}

/**
 * One span, compactly. For a completed span `durationMs = childCoveredMs +
 * outsideChildrenMs`; for an open span those three are `null` and
 * `elapsedLowerBoundMs` says how long it had been open by `observedUntilMs`.
 */
export interface SpanItem {
  readonly spanId: string
  readonly traceId: string
  readonly name: string
  readonly kind: Protocol.SpanKind
  /** Local parent id, or `null` for a root or externally-parented span. */
  readonly parentSpanId: string | null
  readonly status: SpanStatus
  readonly startMs: number
  readonly endMs: number | null
  readonly durationMs: number | null
  /** Union of recorded direct-child intervals, clipped to this span. */
  readonly childCoveredMs: number | null
  /** `durationMs - childCoveredMs`: not covered by a recorded child. Not CPU time. */
  readonly outsideChildrenMs: number | null
  readonly elapsedLowerBoundMs: number | null
  readonly childCount: number
  /** Children without an end; counted as covering until this span's end. */
  readonly openChildCount: number
  readonly eventCount: number
  readonly logCount: number
  readonly error: ErrorInfo | null
}

/** A JSON object cut down to a bounded size. */
export interface BoundedAttributes {
  readonly values: Record<string, Protocol.Json>
  /** Keys whose value was replaced by the first `valueChars` of its JSON encoding. */
  readonly truncatedKeys: ReadonlyArray<string>
  /** Keys dropped beyond the first `attributeKeys`. */
  readonly omittedKeys: number
}

export interface SpanRef {
  readonly spanId: string
  readonly name: string
  readonly status: SpanStatus
  readonly startMs: number
  readonly durationMs: number | null
}

export interface SpanDetail extends SpanItem {
  readonly attributes: BoundedAttributes
  readonly stack: string | null
  readonly stackTruncated: boolean
  readonly parent:
    | { readonly kind: 'none' }
    | { readonly kind: 'local'; readonly spanId: string; readonly retained: boolean }
    | { readonly kind: 'external'; readonly spanId: string; readonly traceId: string }
  /** Root-most first, ending at the direct parent. */
  readonly ancestry: {
    readonly items: ReadonlyArray<SpanRef>
    /** More ancestors exist above the first item. */
    readonly truncated: boolean
  }
  /** First children by start time. */
  readonly children: { readonly total: number; readonly items: ReadonlyArray<SpanItem> }
  /** First span events by time. */
  readonly events: {
    readonly total: number
    readonly items: ReadonlyArray<{
      readonly name: string
      readonly timeMs: number
      readonly attributes: BoundedAttributes
    }>
  }
}

export interface LogItem {
  readonly timeMs: number
  readonly level: Protocol.LogLevel
  /** The message; a non-string message is JSON-encoded. */
  readonly message: string
  readonly messageTruncated: boolean
  readonly spanId: string | null
  readonly spanName: string | null
  readonly fiberId: number | null
  readonly annotations: BoundedAttributes
}

export interface Page<A> {
  readonly total: number
  readonly offset: number
  readonly limit: number
  /** Offset of the next page, or `null` on the last. */
  readonly nextOffset: number | null
  readonly items: ReadonlyArray<A>
}

export interface NameGroup {
  readonly name: string
  readonly count: number
  readonly completed: number
  readonly open: number
  /** Spans with any failure outcome, interruptions included. */
  readonly failed: number
  /** Sum over completed spans. Nested and concurrent spans overlap. */
  readonly totalDurationMs: number
  readonly maxDurationMs: number | null
  readonly totalOutsideChildrenMs: number
}

export interface Summary {
  readonly spans: {
    readonly total: number
    readonly ok: number
    readonly error: number
    readonly defect: number
    readonly interrupted: number
    readonly open: number
  }
  readonly spanEvents: number
  readonly logs: {
    readonly total: number
    readonly byLevel: Partial<Record<Protocol.LogLevel, number>>
  }
  readonly memory: {
    readonly samples: number
    readonly peakHeapUsedBytes: number
    readonly peakRssBytes: number
    readonly lastHeapUsedBytes: number
  } | null
  /** `error`/`defect` spans (not interruptions), earliest start first. */
  readonly failures: { readonly total: number; readonly items: ReadonlyArray<SpanItem> }
  /** Completed spans, largest `durationMs` first. */
  readonly longest: ReadonlyArray<SpanItem>
  /** Completed spans, largest `outsideChildrenMs` first. */
  readonly largestOutsideChildren: ReadonlyArray<SpanItem>
  /** Open spans, largest `elapsedLowerBoundMs` first. */
  readonly longestOpen: ReadonlyArray<SpanItem>
  /** Span names, largest `totalDurationMs` first. */
  readonly names: { readonly total: number; readonly items: ReadonlyArray<NameGroup> }
}

export type SessionsResult = Page<{
  readonly sessionId: string
  readonly program: string
  readonly pid: number
  readonly runtime: string
  readonly active: boolean
  readonly startedAtEpochMillis: number
  readonly endedAtEpochMillis: number | null
  /** Refused reuses of this ID; `null` when none were recorded (see `conflict`). */
  readonly conflicts: number | null
}>

interface Success<Op extends string, R> {
  readonly ok: true
  readonly apiVersion: typeof apiVersion
  readonly op: Op
  /** The request as applied, defaults filled in. */
  readonly query: Record<string, unknown>
  readonly result: R
}

export type SessionsResponse = Success<'sessions', SessionsResult> & {
  readonly source: { readonly kind: 'live' | 'file'; readonly file: string | null }
}
export type SummaryResponse = Success<'summary', Summary> & Context
export type SpansResponse = Success<'spans', Page<SpanItem>> & Context
export type SpanResponse = Success<'span', SpanDetail> & Context
export type LogsResponse = Success<'logs', Page<LogItem>> & Context

export type QueryResponse =
  | SessionsResponse
  | SummaryResponse
  | SpansResponse
  | SpanResponse
  | LogsResponse
  | QueryFailure

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** Microsecond resolution is plenty and keeps float noise out of the JSON. */
const ms = (value: number): number => Math.round(value * 1000) / 1000

const cut = (text: string, max: number) =>
  text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true }

const bound = (input: Readonly<Record<string, Protocol.Json>>): BoundedAttributes => {
  const keys = Object.keys(input)
  const values: Record<string, Protocol.Json> = {}
  const truncatedKeys: Array<string> = []
  for (const key of keys.slice(0, limits.attributeKeys)) {
    const value = input[key]!
    const encoded = JSON.stringify(value)
    if (encoded.length > limits.valueChars) {
      values[key] = encoded.slice(0, limits.valueChars)
      truncatedKeys.push(key)
    } else values[key] = value
  }
  return { values, truncatedKeys, omittedKeys: Math.max(keys.length - limits.attributeKeys, 0) }
}

const statusOf = (span: TraceSpan): SpanStatus => {
  if (span.end === undefined) return 'open'
  if (span.outcome?._tag !== 'Failure') return 'ok'
  if (span.outcome.kind === 'Fail') return 'error'
  if (span.outcome.kind === 'Die') return 'defect'
  return 'interrupted'
}

const matchesStatus = (status: SpanStatus, filter: StatusFilter): boolean => {
  if (filter === 'any') return true
  if (filter === 'failed')
    return status === 'error' || status === 'defect' || status === 'interrupted'
  return status === filter
}

/** A source reconstructed once, plus the evidence gaps the renderer ignores. */
class Analysis {
  readonly store = new TraceStore()
  readonly now: number
  readonly observedFrom: number | undefined
  readonly externalParents = new Map<string, Protocol.ExternalParent>()
  readonly logCounts = new Map<string, number>()
  readonly missingStarts: number
  readonly clientDropped: number
  private readonly items = new Map<string, SpanItem>()

  constructor(readonly source: TraceSource) {
    const store = this.store
    // Anchor at the session clock, not the first retained message, so times
    // are identical across snapshots, evictions and exported files.
    store.origin = source.session.clock.startTime
    store.epochOrigin = source.session.clock.wallClockEpochMillis

    const started = new Set<string>()
    const missing = new Set<string>()
    let clientDropped = 0
    for (const message of source.messages) {
      if (message._tag === 'SpanStart') {
        started.add(message.spanId)
        if (message.parent?._tag === 'ExternalParent') {
          this.externalParents.set(message.spanId, message.parent)
        }
      } else if (
        (message._tag === 'SpanEnd' || message._tag === 'SpanEvent') &&
        !started.has(message.spanId)
      ) {
        missing.add(message.spanId)
      } else if (message._tag === 'Log') {
        const dropped = message.annotations['effect_inspect.dropped']
        if (typeof dropped === 'number') clientDropped += dropped
      }
    }
    this.missingStarts = missing.size
    this.clientDropped = clientDropped

    store.applyAll(source.messages)

    let from = Number.POSITIVE_INFINITY
    for (const span of store.spans.values()) from = Math.min(from, span.start)
    for (const log of store.logs) {
      from = Math.min(from, log.time)
      if (log.spanId !== undefined) {
        this.logCounts.set(log.spanId, (this.logCounts.get(log.spanId) ?? 0) + 1)
      }
    }
    for (const sample of store.memory) from = Math.min(from, sample.time)
    this.observedFrom = from === Number.POSITIVE_INFINITY ? undefined : from
    this.now = store.stats().duration
  }

  item(span: TraceSpan): SpanItem {
    const cached = this.items.get(span.spanId)
    if (cached !== undefined) return cached
    const status = statusOf(span)
    let openChildCount = 0
    for (const id of span.children) {
      if (this.store.spans.get(id)?.end === undefined) openChildCount++
    }
    const closed = span.end !== undefined
    const { total, self } = timings(this.store, span, this.now)
    const error =
      span.outcome?._tag === 'Failure'
        ? (() => {
            const { text, truncated } = cut(span.outcome.error, limits.errorChars)
            return { kind: span.outcome.kind, message: text, messageTruncated: truncated }
          })()
        : null
    const item: SpanItem = {
      spanId: span.spanId,
      traceId: span.traceId,
      name: span.name,
      kind: span.kind,
      parentSpanId: span.parentId ?? null,
      status,
      startMs: ms(span.start),
      endMs: closed ? ms(span.end!) : null,
      durationMs: closed ? ms(total) : null,
      childCoveredMs: closed ? ms(total - self) : null,
      outsideChildrenMs: closed ? ms(self) : null,
      elapsedLowerBoundMs: closed ? null : ms(Math.max(this.now - span.start, 0)),
      childCount: span.children.length,
      openChildCount,
      eventCount: span.events.length,
      logCount: this.logCounts.get(span.spanId) ?? 0,
      error,
    }
    this.items.set(span.spanId, item)
    return item
  }

  context(): Context {
    const { source, store } = this
    const { session, capture } = source
    const counters = {
      collectorDroppedMessages: capture?.droppedMessages ?? null,
      collectorSkippedLines: capture?.skippedLines ?? null,
      clientDroppedMessages: this.clientDropped,
      fileTruncatedLines: source.truncatedLines,
      spansMissingStart: this.missingStarts,
      spansMissingParent: [...store.spans.values()].filter((span) => span.orphaned).length,
    }
    const lost = Object.values(counters).some((value) => value !== null && value > 0)
    const empty = store.spans.size + store.logs.length + store.memory.length === 0
    let status: Completeness['status'] = 'noLossRecorded'
    if (lost) status = 'lossRecorded'
    else if (capture === undefined) status = 'unknown'
    let detection: ConflictInfo['detection'] = 'unknown'
    if (capture !== undefined) detection = capture.conflictDetection ? 'enforced' : 'unavailable'
    return {
      source: {
        kind: source.kind,
        file: source.file ?? null,
        sessionId: session.sessionId,
        program: session.program,
        pid: session.pid,
        runtime: session.runtime,
        active: session.active,
        startedAtEpochMillis: session.clock.wallClockEpochMillis,
        endedAtEpochMillis: session.endedAtEpochMillis ?? null,
        snapshotAtEpochMillis: source.snapshotAtEpochMillis,
      },
      time: {
        unit: 'ms',
        reference: 'sessionStart',
        observedFromMs: this.observedFrom === undefined ? null : ms(this.observedFrom),
        observedUntilMs: empty ? null : ms(this.now),
      },
      completeness: {
        status,
        ...counters,
        openSpans: store.openSpans.size,
        retainedMessages: source.messages.length,
        messagesObserved:
          capture === undefined ? null : source.messages.length + capture.droppedMessages,
      },
      conflict: {
        count: session.conflicts ?? (capture === undefined ? null : 0),
        detection,
      },
    }
  }
}

const page = <A>(all: ReadonlyArray<A>, offset: number, limit: number): Page<A> => ({
  total: all.length,
  offset,
  limit,
  nextOffset: offset + limit < all.length ? offset + limit : null,
  items: all.slice(offset, offset + limit),
})

const byStart = (a: SpanItem, b: SpanItem): number =>
  a.startMs - b.startMs || (a.spanId < b.spanId ? -1 : Number(a.spanId > b.spanId))

/** Completed spans by `measure` descending, then open spans by lower bound; ties by start. */
const ranked =
  (measure: 'durationMs' | 'outsideChildrenMs') =>
  (a: SpanItem, b: SpanItem): number => {
    const aOpen = a.endMs === null
    const bOpen = b.endMs === null
    if (aOpen !== bOpen) return aOpen ? 1 : -1
    const key = aOpen ? 'elapsedLowerBoundMs' : measure
    return b[key]! - a[key]! || byStart(a, b)
  }

const sorters: Record<SpanSort, (a: SpanItem, b: SpanItem) => number> = {
  start: byStart,
  duration: ranked('durationMs'),
  outsideChildren: ranked('outsideChildrenMs'),
}

const summarize = (analysis: Analysis, top: number): Summary => {
  const items = [...analysis.store.spans.values()].map((span) => analysis.item(span))
  const counts = { total: items.length, ok: 0, error: 0, defect: 0, interrupted: 0, open: 0 }
  const groups = new Map<string, { -readonly [K in keyof NameGroup]: NameGroup[K] }>()
  for (const item of items) {
    counts[item.status]++
    let group = groups.get(item.name)
    if (group === undefined) {
      group = {
        name: item.name,
        count: 0,
        completed: 0,
        open: 0,
        failed: 0,
        totalDurationMs: 0,
        maxDurationMs: null,
        totalOutsideChildrenMs: 0,
      }
      groups.set(item.name, group)
    }
    group.count++
    if (item.error !== null) group.failed++
    if (item.durationMs === null) group.open++
    else {
      group.completed++
      group.totalDurationMs += item.durationMs
      group.totalOutsideChildrenMs += item.outsideChildrenMs!
      group.maxDurationMs = Math.max(group.maxDurationMs ?? 0, item.durationMs)
    }
  }
  const byLevel: Partial<Record<Protocol.LogLevel, number>> = {}
  for (const log of analysis.store.logs) byLevel[log.level] = (byLevel[log.level] ?? 0) + 1

  const completed = items.filter((item) => item.endMs !== null)
  const failures = items
    .filter((item) => item.status === 'error' || item.status === 'defect')
    .sort(byStart)
  const { store } = analysis
  const last = store.memory.at(-1)
  return {
    spans: counts,
    spanEvents: store.stats().events,
    logs: { total: store.logs.length, byLevel },
    memory:
      last === undefined
        ? null
        : {
            samples: store.memory.length,
            peakHeapUsedBytes: store.memoryPeak,
            peakRssBytes: store.memoryRssPeak,
            lastHeapUsedBytes: last.heapUsed,
          },
    failures: { total: failures.length, items: failures.slice(0, top) },
    longest: completed.toSorted(sorters.duration).slice(0, top),
    largestOutsideChildren: completed.toSorted(sorters.outsideChildren).slice(0, top),
    longestOpen: items
      .filter((item) => item.endMs === null)
      .sort(sorters.duration)
      .slice(0, top),
    names: {
      total: groups.size,
      items: [...groups.values()]
        .map((group) => ({
          ...group,
          totalDurationMs: ms(group.totalDurationMs),
          totalOutsideChildrenMs: ms(group.totalOutsideChildrenMs),
        }))
        .sort((a, b) => b.totalDurationMs - a.totalDurationMs || (a.name < b.name ? -1 : 1))
        .slice(0, top),
    },
  }
}

const ref = (analysis: Analysis, span: TraceSpan): SpanRef => {
  const item = analysis.item(span)
  return {
    spanId: item.spanId,
    name: item.name,
    status: item.status,
    startMs: item.startMs,
    durationMs: item.durationMs,
  }
}

const detail = (
  analysis: Analysis,
  span: TraceSpan,
  childLimit: number,
  eventLimit: number,
): SpanDetail => {
  const { store } = analysis
  const ancestry: Array<SpanRef> = []
  const seen = new Set([span.spanId])
  let parent = span.parentId === undefined ? undefined : store.spans.get(span.parentId)
  let truncated = false
  while (parent !== undefined && !seen.has(parent.spanId)) {
    if (ancestry.length === limits.ancestry) {
      truncated = true
      break
    }
    seen.add(parent.spanId)
    ancestry.push(ref(analysis, parent))
    parent = parent.parentId === undefined ? undefined : store.spans.get(parent.parentId)
  }
  const external = analysis.externalParents.get(span.spanId)
  let parentInfo: SpanDetail['parent'] = { kind: 'none' }
  if (external !== undefined) {
    parentInfo = { kind: 'external', spanId: external.spanId, traceId: external.traceId }
  } else if (span.parentId !== undefined) {
    parentInfo = { kind: 'local', spanId: span.parentId, retained: !span.orphaned }
  }
  const children = span.children
    .flatMap((id) => {
      const child = store.spans.get(id)
      return child === undefined ? [] : [analysis.item(child)]
    })
    .sort(byStart)
  const events = span.events.toSorted((a, b) => a.time - b.time)
  const stack =
    span.outcome?._tag === 'Failure' && span.outcome.stack !== undefined
      ? cut(span.outcome.stack, limits.stackChars)
      : undefined
  return {
    ...analysis.item(span),
    attributes: bound(span.attributes),
    stack: stack?.text ?? null,
    stackTruncated: stack?.truncated ?? false,
    parent: parentInfo,
    ancestry: { items: ancestry.reverse(), truncated },
    children: { total: children.length, items: children.slice(0, childLimit) },
    events: {
      total: events.length,
      items: events.slice(0, eventLimit).map((event) => ({
        name: event.name,
        timeMs: ms(event.time),
        attributes: bound(event.attributes),
      })),
    },
  }
}

/** Span ids of `root` and every retained descendant. */
const subtree = (store: TraceStore, root: TraceSpan): Set<string> => {
  const ids = new Set<string>()
  const stack = [root]
  while (stack.length > 0) {
    const span = stack.pop()!
    if (ids.has(span.spanId)) continue
    ids.add(span.spanId)
    for (const id of span.children) {
      const child = store.spans.get(id)
      if (child !== undefined) stack.push(child)
    }
  }
  return ids
}

const spanNotFound = (op: string, spanId: string, analysis: Analysis): QueryFailure =>
  failure(
    op,
    'SpanNotFound',
    `Span ${spanId} is not in the retained data of session ${analysis.source.session.sessionId}.`,
    'List span ids with the spans query. A span evicted by capacity or never received cannot be recovered; check completeness.',
    {
      spanId,
      sessionId: analysis.source.session.sessionId,
      completeness: analysis.context().completeness,
    },
  )

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Lists `sessions`, newest start first (ties by id). Discovery only: a caller
 * that chose its session ID should query it directly instead.
 */
export const listSessions = (
  source: SessionsResponse['source'],
  sessions: ReadonlyArray<Protocol.Session>,
  request: Extract<QueryRequest, { readonly op: 'sessions' }>,
): SessionsResponse => {
  const limit = request.limit ?? limits.sessions.default
  const offset = request.offset ?? 0
  const items = sessions
    .map((session) => ({
      sessionId: session.sessionId,
      program: session.program,
      pid: session.pid,
      runtime: session.runtime,
      active: session.active,
      startedAtEpochMillis: session.clock.wallClockEpochMillis,
      endedAtEpochMillis: session.endedAtEpochMillis ?? null,
      conflicts: session.conflicts ?? null,
    }))
    .sort(
      (a, b) =>
        b.startedAtEpochMillis - a.startedAtEpochMillis ||
        (a.sessionId < b.sessionId ? -1 : Number(a.sessionId > b.sessionId)),
    )
  return {
    ok: true,
    apiVersion,
    op: 'sessions',
    query: { op: 'sessions', limit, offset },
    source,
    result: page(items, offset, limit),
  }
}

/**
 * Answers a per-session query against one frozen source. The caller has
 * already matched `request.sessionId` to `source` exactly; this refuses a
 * session with a recorded ID conflict instead of answering for it.
 */
export const run = (source: TraceSource, request: SessionQuery): QueryResponse => {
  const { op } = request
  const sessionId = source.session.sessionId
  const conflicts = source.session.conflicts ?? 0
  if (conflicts > 0) {
    return failure(
      op,
      'SessionConflict',
      `Session ID ${sessionId} was announced by ${conflicts} other run(s) besides the one recorded; the data cannot be attributed to your run.`,
      'Relaunch with a new, unique EFFECT_INSPECT_SESSION_ID and query that ID.',
      { sessionId, conflicts },
    )
  }
  const analysis = new Analysis(source)
  const context = analysis.context()
  const { store } = analysis
  switch (request.op) {
    case 'summary': {
      const top = request.top ?? limits.top.default
      return {
        ok: true,
        apiVersion,
        op: 'summary',
        query: { op, sessionId, top },
        ...context,
        result: summarize(analysis, top),
      }
    }
    case 'spans': {
      const status = request.status ?? 'any'
      const sort = request.sort ?? 'start'
      const limit = request.limit ?? limits.spans.default
      const offset = request.offset ?? 0
      const needle = request.name?.toLowerCase()
      const from = request.fromMs ?? Number.NEGATIVE_INFINITY
      const to = request.toMs ?? Number.POSITIVE_INFINITY
      const matched: Array<SpanItem> = []
      for (const span of store.spans.values()) {
        const item = analysis.item(span)
        if (!matchesStatus(item.status, status)) continue
        if (needle !== undefined && !item.name.toLowerCase().includes(needle)) continue
        if (item.startMs > to || (item.endMs ?? analysis.now) < from) continue
        const measured = item.durationMs ?? item.elapsedLowerBoundMs!
        if (request.minDurationMs !== undefined && measured < request.minDurationMs) continue
        matched.push(item)
      }
      matched.sort(sorters[sort])
      return {
        ok: true,
        apiVersion,
        op: 'spans',
        query: { ...request, sessionId, status, sort, limit, offset },
        ...context,
        result: page(matched, offset, limit),
      }
    }
    case 'span': {
      const span = store.spans.get(request.spanId)
      if (span === undefined) return spanNotFound(op, request.spanId, analysis)
      const children = request.children ?? limits.children.default
      const events = request.events ?? limits.events.default
      return {
        ok: true,
        apiVersion,
        op: 'span',
        query: { op, sessionId, spanId: request.spanId, children, events },
        ...context,
        result: detail(analysis, span, children, events),
      }
    }
    case 'logs': {
      const limit = request.limit ?? limits.logs.default
      const offset = request.offset ?? 0
      const scope = request.spanId === undefined ? undefined : (request.scope ?? 'subtree')
      let spans: Set<string> | undefined
      if (request.spanId !== undefined) {
        const span = store.spans.get(request.spanId)
        if (span === undefined) return spanNotFound(op, request.spanId, analysis)
        spans = scope === 'span' ? new Set([span.spanId]) : subtree(store, span)
      }
      const minLevel = request.minLevel === undefined ? -1 : logLevels.indexOf(request.minLevel)
      const from = request.fromMs ?? Number.NEGATIVE_INFINITY
      const to = request.toMs ?? Number.POSITIVE_INFINITY
      const matched = store.logs
        .filter(
          (log) =>
            (spans === undefined || (log.spanId !== undefined && spans.has(log.spanId))) &&
            (minLevel === -1 ||
              logLevels.indexOf(log.level as (typeof logLevels)[number]) >= minLevel) &&
            log.time >= from &&
            log.time <= to,
        )
        // Stable: equal times keep arrival order.
        .sort((a, b) => a.time - b.time)
      const items = matched.slice(offset, offset + limit).map((log): LogItem => {
        const { text, truncated } = cut(
          typeof log.message === 'string' ? log.message : JSON.stringify(log.message),
          limits.logMessageChars,
        )
        return {
          timeMs: ms(log.time),
          level: log.level,
          message: text,
          messageTruncated: truncated,
          spanId: log.spanId ?? null,
          spanName: log.spanId === undefined ? null : (store.spans.get(log.spanId)?.name ?? null),
          fiberId: log.fiberId ?? null,
          annotations: bound(log.annotations),
        }
      })
      return {
        ok: true,
        apiVersion,
        op: 'logs',
        query: { ...request, sessionId, ...(scope === undefined ? {} : { scope }), limit, offset },
        ...context,
        result: { ...page(matched, offset, limit), items },
      }
    }
  }
}

const sessionNotFound = (op: string, requested: string, where: string): QueryFailure =>
  failure(
    op,
    'SessionNotFound',
    `No session with ID ${requested} ${where}. No other session was substituted.`,
    'Check the exact ID the program was launched with (EFFECT_INSPECT_SESSION_ID or the sessionId option), that it uses Inspect.layer() against this collector, and that it has started; or list sessions.',
    { sessionId: requested },
  )

/** Answers a request against trace-file text: the offline equivalent of a collector query. */
export const queryFile = (text: string, file: string, input: unknown): QueryResponse => {
  const decoded = decodeRequest(input)
  if (Result.isFailure(decoded)) return decoded.failure
  const request = decoded.success
  const loaded = fromTraceFile(text, file)
  if (Result.isFailure(loaded)) return { ...loaded.failure, op: request.op }
  const source = loaded.success
  if (request.op === 'sessions') {
    return listSessions({ kind: 'file', file }, [source.session], request)
  }
  const saved = source.session.sessionId
  // A trace re-saved from the browser carries its `loaded:` display prefix.
  if (
    request.sessionId !== undefined &&
    request.sessionId !== saved &&
    `loaded:${request.sessionId}` !== saved
  ) {
    return sessionNotFound(request.op, request.sessionId, `in ${file} (it holds ${saved})`)
  }
  return run(source, request)
}

/** The live `SessionNotFound` failure, shared by the collector's handlers. */
export const liveSessionNotFound = (op: string, sessionId: string): QueryFailure =>
  sessionNotFound(op, sessionId, 'is known to this collector')

/** The live failure for a per-session request without a `sessionId`. */
export const sessionRequired = (op: string): QueryFailure =>
  failure(
    op,
    'InvalidRequest',
    'Live queries must name a session: sessionId is required. The newest session is never assumed.',
    'Pass the exact session ID the program was launched with, or list sessions to discover one.',
  )
