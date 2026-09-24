/**
 * The effect-inspect wire protocol.
 *
 * Three unions: {@link ClientMessage} (instrumented program → collector),
 * {@link CollectorMessage} (collector → instrumented program) and
 * {@link WebappMessage} (collector → webapp).
 *
 * Informed by `effect/devtools/DevToolsSchema` but deliberately different:
 * spans are delta-encoded as `SpanStart` / `SpanEnd` rather than a full span
 * snapshot re-sent on end, every message carries a `sessionId`, and attribute
 * values are a bounded {@link Json} union instead of `Schema.Any`.
 */
import { Schema } from 'effect'

/**
 * Monotonic nanosecond timestamp, matching `Tracer.Span#startTime`.
 *
 * Carried as a decimal string on the wire because JSON numbers cannot hold
 * nanos without precision loss.
 */
export const Timestamp = Schema.BigIntFromString
export type Timestamp = Schema.Schema.Type<typeof Timestamp>

/**
 * A JSON value.
 *
 * Attribute and annotation values are bounded to this rather than
 * `Schema.Any`: anything unrepresentable (a function, a symbol, a class
 * instance, a `bigint`) is stringified by the producer at the edge, so a
 * decoder never has to guess.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json }

export const Json: Schema.Codec<Json> = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Null,
  Schema.Array(Schema.suspend(() => Json)),
  Schema.Record(
    Schema.String,
    Schema.suspend(() => Json),
  ),
])

/** Span attributes, log annotations, and metric/event attributes. */
export const Attributes = Schema.Record(Schema.String, Json)
export type Attributes = Schema.Schema.Type<typeof Attributes>

/** Identifies one run of an instrumented program. */
export const SessionId = Schema.String
export type SessionId = Schema.Schema.Type<typeof SessionId>

const sessionId = { sessionId: SessionId }

/** Mirrors `Tracer.SpanKind`. */
export const SpanKind = Schema.Literals(['internal', 'server', 'client', 'producer', 'consumer'])
export type SpanKind = Schema.Schema.Type<typeof SpanKind>

/** Mirrors `LogLevel.LogLevel`. */
export const LogLevel = Schema.Literals([
  'All',
  'Fatal',
  'Error',
  'Warn',
  'Info',
  'Debug',
  'Trace',
  'None',
])
export type LogLevel = Schema.Schema.Type<typeof LogLevel>

/**
 * Wall-clock anchor for a session's monotonic clock.
 *
 * `startTime` is nanos from the same monotonic source as span times;
 * `wallClockEpochMillis` is `Date.now()` sampled at the same instant. Together
 * they let the webapp render absolute times and align sessions with each other.
 */
export const Clock = Schema.Struct({
  startTime: Timestamp,
  wallClockEpochMillis: Schema.Natural,
})
export type Clock = Schema.Schema.Type<typeof Clock>

/** First message on a client connection; opens the session. */
export const Hello = Schema.Struct({
  _tag: Schema.tag('Hello'),
  ...sessionId,
  program: Schema.String,
  pid: Schema.Natural,
  runtime: Schema.String,
  protocolVersion: Schema.Natural,
  clock: Clock,
})
export type Hello = Schema.Schema.Type<typeof Hello>

/** The protocol version a `Hello` must carry. Bump on any breaking change. */
export const protocolVersion = 1

/**
 * A span parent that lives outside this session's span tree — propagated from
 * another tracing system, so the collector has ids but no span body.
 */
export const ExternalParent = Schema.Struct({
  _tag: Schema.tag('ExternalParent'),
  spanId: Schema.String,
  traceId: Schema.String,
  sampled: Schema.Boolean,
})
export type ExternalParent = Schema.Schema.Type<typeof ExternalParent>

/** A span parent within this session, referenced by id only. */
export const LocalParent = Schema.Struct({
  _tag: Schema.tag('LocalParent'),
  spanId: Schema.String,
})
export type LocalParent = Schema.Schema.Type<typeof LocalParent>

export const SpanParent = Schema.Union([LocalParent, ExternalParent])
export type SpanParent = Schema.Schema.Type<typeof SpanParent>

/**
 * A span opened. Sent once, when the span starts — never re-sent.
 *
 * `parent` is absent for a root span.
 */
export const SpanStart = Schema.Struct({
  _tag: Schema.tag('SpanStart'),
  ...sessionId,
  spanId: Schema.String,
  traceId: Schema.String,
  parent: Schema.optional(SpanParent),
  name: Schema.String,
  kind: SpanKind,
  startTime: Timestamp,
  attributes: Attributes,
  sampled: Schema.Boolean,
  fiberId: Schema.optional(Schema.Natural),
})
export type SpanStart = Schema.Schema.Type<typeof SpanStart>

/**
 * How a span finished.
 *
 * The full `Cause` is not carried: the webapp only needs to colour the span and
 * show a message, so the producer flattens failures to `error` (rendered
 * message) plus optional `stack`. `_tag: "Failure"` covers expected errors,
 * defects and interrupts alike, distinguished by `kind`.
 */
export const SpanOutcomeSuccess = Schema.Struct({
  _tag: Schema.tag('Success'),
})
export type SpanOutcomeSuccess = Schema.Schema.Type<typeof SpanOutcomeSuccess>

export const SpanOutcomeFailure = Schema.Struct({
  _tag: Schema.tag('Failure'),
  kind: Schema.Literals(['Fail', 'Die', 'Interrupt']),
  error: Schema.String,
  stack: Schema.optional(Schema.String),
})
export type SpanOutcomeFailure = Schema.Schema.Type<typeof SpanOutcomeFailure>

export const SpanOutcome = Schema.Union([SpanOutcomeSuccess, SpanOutcomeFailure])
export type SpanOutcome = Schema.Schema.Type<typeof SpanOutcome>

/**
 * A span closed.
 *
 * `attributes` carries only attributes added after `SpanStart` was sent; the
 * collector merges them over the ones it already has.
 */
export const SpanEnd = Schema.Struct({
  _tag: Schema.tag('SpanEnd'),
  ...sessionId,
  spanId: Schema.String,
  endTime: Timestamp,
  outcome: SpanOutcome,
  attributes: Attributes,
})
export type SpanEnd = Schema.Schema.Type<typeof SpanEnd>

/** A point-in-time event recorded against a span. */
export const SpanEvent = Schema.Struct({
  _tag: Schema.tag('SpanEvent'),
  ...sessionId,
  spanId: Schema.String,
  name: Schema.String,
  time: Timestamp,
  attributes: Attributes,
})
export type SpanEvent = Schema.Schema.Type<typeof SpanEvent>

/** A log record, in the same ordered stream as spans. */
export const Log = Schema.Struct({
  _tag: Schema.tag('Log'),
  ...sessionId,
  time: Timestamp,
  level: LogLevel,
  message: Json,
  spanId: Schema.optional(Schema.String),
  fiberId: Schema.optional(Schema.Natural),
  annotations: Attributes,
})
export type Log = Schema.Schema.Type<typeof Log>

const metric = <const Type extends string, State extends Schema.Top>(type: Type, state: State) =>
  Schema.Struct({
    type: Schema.tag(type),
    name: Schema.String,
    description: Schema.optional(Schema.String),
    attributes: Schema.Record(Schema.String, Schema.String),
    state,
  })

export const Counter = metric(
  'Counter',
  Schema.Struct({ count: Schema.Natural, incremental: Schema.Boolean }),
)
export type Counter = Schema.Schema.Type<typeof Counter>

export const Gauge = metric('Gauge', Schema.Struct({ value: Schema.Finite }))
export type Gauge = Schema.Schema.Type<typeof Gauge>

export const Histogram = metric(
  'Histogram',
  Schema.Struct({
    buckets: Schema.Array(Schema.Tuple([Schema.Finite, Schema.Natural])),
    count: Schema.Natural,
    min: Schema.Finite,
    max: Schema.Finite,
    sum: Schema.Finite,
  }),
)
export type Histogram = Schema.Schema.Type<typeof Histogram>

export const Frequency = metric(
  'Frequency',
  Schema.Struct({ occurrences: Schema.Record(Schema.String, Schema.Natural) }),
)
export type Frequency = Schema.Schema.Type<typeof Frequency>

export const Summary = metric(
  'Summary',
  Schema.Struct({
    quantiles: Schema.Array(
      Schema.Tuple([
        Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
        Schema.NullOr(Schema.Finite),
      ]),
    ),
    count: Schema.Natural,
    min: Schema.Finite,
    max: Schema.Finite,
    sum: Schema.Finite,
  }),
)
export type Summary = Schema.Schema.Type<typeof Summary>

export const Metric = Schema.Union([Counter, Gauge, Histogram, Frequency, Summary])
export type Metric = Schema.Schema.Type<typeof Metric>

/** A snapshot of every metric, taken at `time`. */
export const Metrics = Schema.Struct({
  _tag: Schema.tag('Metrics'),
  ...sessionId,
  time: Timestamp,
  metrics: Schema.Array(Metric),
})
export type Metrics = Schema.Schema.Type<typeof Metrics>

/** A fiber lifecycle transition. */
export const FiberEvent = Schema.Struct({
  _tag: Schema.tag('FiberEvent'),
  ...sessionId,
  fiberId: Schema.Natural,
  event: Schema.Literals(['Start', 'End', 'Suspend', 'Resume']),
  parentFiberId: Schema.optional(Schema.Natural),
  time: Timestamp,
})
export type FiberEvent = Schema.Schema.Type<typeof FiberEvent>

/**
 * A `process.memoryUsage()` reading, sampled on an interval by the client.
 *
 * Node and Bun only: a runtime without `process.memoryUsage` emits none of
 * these and a session simply has no memory track. Figures are bytes, as the
 * runtime reports them; `time` shares the monotonic base of span times, so the
 * webapp can draw the curve against the same x-axis as the flame chart.
 */
export const MemorySample = Schema.Struct({
  _tag: Schema.tag('MemorySample'),
  ...sessionId,
  time: Timestamp,
  heapUsed: Schema.Natural,
  heapTotal: Schema.Natural,
  rss: Schema.Natural,
  external: Schema.Natural,
})
export type MemorySample = Schema.Schema.Type<typeof MemorySample>

export const Ping = Schema.Struct({
  _tag: Schema.tag('Ping'),
  ...sessionId,
})
export type Ping = Schema.Schema.Type<typeof Ping>

export const Pong = Schema.Struct({
  _tag: Schema.tag('Pong'),
  ...sessionId,
})
export type Pong = Schema.Schema.Type<typeof Pong>

/** Asks the client for a {@link Metrics} snapshot. */
export const MetricsRequest = Schema.Struct({
  _tag: Schema.tag('MetricsRequest'),
})
export type MetricsRequest = Schema.Schema.Type<typeof MetricsRequest>

/** Telemetry the instrumented program sends to the collector. */
export const ClientMessage = Schema.Union([
  Hello,
  SpanStart,
  SpanEnd,
  SpanEvent,
  Log,
  Metrics,
  FiberEvent,
  MemorySample,
  Ping,
])
export type ClientMessage = Schema.Schema.Type<typeof ClientMessage>

/** What the collector sends back to the instrumented program. */
export const CollectorMessage = Schema.Union([Pong, MetricsRequest])
export type CollectorMessage = Schema.Schema.Type<typeof CollectorMessage>

/** A session the collector knows about, as listed to the webapp. */
export const Session = Schema.Struct({
  sessionId: SessionId,
  program: Schema.String,
  pid: Schema.Natural,
  runtime: Schema.String,
  clock: Clock,
  active: Schema.Boolean,
  endedAtEpochMillis: Schema.optional(Schema.Natural),
})
export type Session = Schema.Schema.Type<typeof Session>

/** Every session the collector holds. Sent on connect and on change. */
export const SessionList = Schema.Struct({
  _tag: Schema.tag('SessionList'),
  sessions: Schema.Array(Session),
})
export type SessionList = Schema.Schema.Type<typeof SessionList>

/**
 * Everything already recorded for a session, replayed in arrival order.
 *
 * Sent once when the webapp subscribes, before any live telemetry for that
 * session. `complete` is false when the backlog is split across several
 * messages, so the webapp knows more is coming.
 */
export const Backlog = Schema.Struct({
  _tag: Schema.tag('Backlog'),
  ...sessionId,
  messages: Schema.Array(ClientMessage),
  complete: Schema.Boolean,
})
export type Backlog = Schema.Schema.Type<typeof Backlog>

/** A live client message forwarded to the webapp as it arrives. */
export const Live = Schema.Struct({
  _tag: Schema.tag('Live'),
  message: ClientMessage,
})
export type Live = Schema.Schema.Type<typeof Live>

/**
 * A session ended — its program exited or its connection dropped.
 *
 * **Nothing emits this.** The collector marks the session `active: false` and
 * re-sends the whole {@link SessionList} on every change, which already tells
 * the webapp everything this message would. The variant is kept because the
 * protocol is extended additively and removing it would break the union for
 * anyone decoding an older stream; the webapp handler for it was deleted
 * rather than left looking implemented.
 */
export const SessionEnded = Schema.Struct({
  _tag: Schema.tag('SessionEnded'),
  ...sessionId,
  endedAtEpochMillis: Schema.Natural,
})
export type SessionEnded = Schema.Schema.Type<typeof SessionEnded>

/** What the collector sends to the webapp. */
export const WebappMessage = Schema.Union([SessionList, Backlog, Live, SessionEnded])
export type WebappMessage = Schema.Schema.Type<typeof WebappMessage>

/** Asks the collector to stream one session: its backlog, then live messages. */
export const Subscribe = Schema.Struct({
  _tag: Schema.tag('Subscribe'),
  ...sessionId,
})
export type Subscribe = Schema.Schema.Type<typeof Subscribe>

/** Stops the stream started by {@link Subscribe}. */
export const Unsubscribe = Schema.Struct({
  _tag: Schema.tag('Unsubscribe'),
  ...sessionId,
})
export type Unsubscribe = Schema.Schema.Type<typeof Unsubscribe>

/** What the webapp sends to the collector. */
export const WebappRequest = Schema.Union([Subscribe, Unsubscribe])
export type WebappRequest = Schema.Schema.Type<typeof WebappRequest>

/**
 * Line 1 of a saved trace file.
 *
 * The rest of the file is {@link ClientMessage} NDJSON, byte-identical to what
 * the wire carries — a trace file is the protocol message stream with a header
 * on top, not a second representation of a trace. So any new `ClientMessage`
 * variant is carried by a saved trace for free, and {@link traceFileFormatVersion}
 * only moves if *this* struct or the line layout changes.
 *
 * The full {@link Session} is embedded because a loaded trace has no
 * `SessionList` to get its `clock` from, and without the clock the webapp
 * cannot show absolute times.
 */
export const TraceFileHeader = Schema.Struct({
  _tag: Schema.tag('TraceFileHeader'),
  formatVersion: Schema.Natural,
  /** {@link protocolVersion} at save time. Recorded for diagnosis, not enforced. */
  protocolVersion: Schema.Natural,
  session: Session,
  savedAtEpochMillis: Schema.Natural,
})
export type TraceFileHeader = Schema.Schema.Type<typeof TraceFileHeader>

/** The trace file layout version. Bump only on a change to the header or the line layout. */
export const traceFileFormatVersion = 1
