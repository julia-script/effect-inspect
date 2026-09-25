/**
 * The in-memory trace model for one session.
 *
 * This is deliberately **not** React state and **not** an atom. A dense trace
 * is 10k+ spans and the flame chart redraws on every pan/zoom frame; putting a
 * span in React state would cost a reconciliation per span, and putting one in
 * an atom would cost a subscription per span. Instead the store is a plain
 * mutable structure that the canvas renderer reads directly during its draw
 * call, and React only ever learns that *something* changed — via
 * {@link TraceStore.version} — never what.
 *
 * The shapes here are tuned for the renderer's access pattern: it walks spans
 * in depth-then-start order once per frame, so `rows` is maintained
 * incrementally rather than rebuilt, and every field the renderer touches is a
 * number rather than a `bigint` (see {@link TraceSpan.start}).
 */
import type { Attributes, Json, LogLevel, SpanKind, SpanOutcome } from '../protocol/Schema.ts'
import type { ClientMessage } from '../protocol/Schema.ts'

/**
 * A span in renderer-facing form.
 *
 * Times are **milliseconds relative to the session's first observed event**,
 * as `number`, not the protocol's absolute `bigint` nanos. The renderer does
 * arithmetic on these every frame and `bigint` maths is both slower and
 * unusable in canvas coordinates; the conversion happens once, here, at ingest.
 * {@link TraceStore.epochOrigin} keeps the absolute anchor for display.
 */
export interface TraceSpan {
  readonly spanId: string
  readonly traceId: string
  readonly name: string
  readonly kind: SpanKind
  /** Parent span id, or `undefined` for a root (or externally-parented) span. */
  readonly parentId: string | undefined
  /** Milliseconds since {@link TraceStore.origin}. */
  readonly start: number
  /** Milliseconds since {@link TraceStore.origin}, or `undefined` while open. */
  end: number | undefined
  /** Nesting depth; 0 for a root span. */
  depth: number
  /** Set once `SpanEnd` arrives. */
  outcome: SpanOutcome | undefined
  /** `SpanStart` attributes merged with the late ones from `SpanEnd`. */
  attributes: Record<string, Json>
  /** Child span ids, in arrival order. */
  readonly children: Array<string>
  /** Point-in-time events on this span, in arrival order. */
  readonly events: Array<TraceSpanEvent>
  readonly fiberId: number | undefined
  /** True when the parent id was seen but the parent span has not arrived. */
  orphaned: boolean
}

/** A point-in-time event recorded against a span. */
export interface TraceSpanEvent {
  readonly name: string
  /** Milliseconds since {@link TraceStore.origin}. */
  readonly time: number
  readonly attributes: Attributes
}

/** A log record, kept in arrival order alongside the spans. */
export interface TraceLog {
  /** Milliseconds since {@link TraceStore.origin}. */
  readonly time: number
  readonly level: LogLevel
  readonly message: Json
  readonly spanId: string | undefined
  readonly fiberId: number | undefined
  readonly annotations: Attributes
}

/**
 * One `process.memoryUsage()` reading, in the chart's time base.
 *
 * Figures stay in bytes; the track formats them. `time` is relative millis like
 * everything else here, so the memory curve and the flame bars share an x-axis
 * by construction rather than by two pieces of code agreeing.
 */
export interface TraceMemorySample {
  /** Milliseconds since {@link TraceStore.origin}. */
  readonly time: number
  readonly heapUsed: number
  readonly heapTotal: number
  readonly rss: number
  readonly external: number
}

/** Cheap counters for the header, so the UI never walks the span map to count. */
export interface TraceStats {
  readonly spans: number
  readonly openSpans: number
  readonly errors: number
  readonly logs: number
  readonly events: number
  /** Milliseconds since {@link TraceStore.origin} of the latest observed time. */
  readonly duration: number
}

const NANOS_PER_MILLI = 1_000_000n

/**
 * Converts protocol nanos to milliseconds relative to `origin`, as a `number`.
 *
 * The subtraction happens in `bigint` so it stays exact, and only the
 * (small, relative) result is narrowed to `number` — narrowing the absolute
 * nanos first would lose precision well before it got here.
 */
const toRelativeMillis = (time: bigint, origin: bigint): number =>
  Number((time - origin) / NANOS_PER_MILLI) + Number((time - origin) % NANOS_PER_MILLI) / 1_000_000

/**
 * Mutable span index for one session.
 *
 * Ingest is `apply`, one protocol message at a time, in arrival order. Reads
 * are direct field access — `spans`, `roots` and `rows` are live structures,
 * not copies, so the renderer must treat them as read-only and must re-read
 * them (not cache them) whenever {@link version} changes.
 */
export class TraceStore {
  /** Every span seen, by span id. Includes spans that are still open. */
  readonly spans = new Map<string, TraceSpan>()
  /** Root span ids in arrival order — the renderer's entry points. */
  readonly roots: Array<string> = []
  /** Span ids that have no `SpanEnd` yet, so the renderer can draw them open-ended. */
  readonly openSpans = new Set<string>()
  /** Logs in arrival order. */
  readonly logs: Array<TraceLog> = []

  /**
   * Memory samples in arrival order, which is also time order.
   *
   * A plain array rather than anything indexed: the track draws the whole
   * series each frame by walking it once, and at the client's 100ms interval a
   * ten-minute trace is 6,000 entries — a scan the renderer does not notice.
   * ponytail: linear scan, swap for a binary search into the viewport if a
   * trace ever runs long enough for it to show up in a frame budget.
   */
  readonly memory: Array<TraceMemorySample> = []

  /**
   * Largest `heapUsed` seen — the memory track's y-axis top, kept here so the
   * renderer never re-scans the series to scale a frame.
   */
  memoryPeak = 0

  /** Smallest `heapUsed` seen — the memory track's y-axis floor. */
  memoryTrough = Number.POSITIVE_INFINITY

  /** Largest `rss` seen; the secondary line has its own scale. */
  memoryRssPeak = 0

  /**
   * Every message ingested, in arrival order — the source for saving to a file.
   *
   * The rendered model above is lossy on purpose (relative millis, merged
   * attributes, `Metrics`/`FiberEvent` dropped), so a file written from it
   * would quietly lose whatever the chart does not draw. Keeping the decoded
   * messages costs one array slot each — they are already allocated — and
   * makes save a copy rather than a re-derivation.
   */
  readonly raw: Array<ClientMessage> = []

  /**
   * Span ids bucketed by depth: `rows[2]` is every span nested two levels deep.
   *
   * This is the flame chart's row layout. It is maintained incrementally on
   * ingest so the renderer never has to traverse the tree to find a row, and
   * so drawing a viewport means scanning only the rows it covers.
   */
  readonly rows: Array<Array<string>> = []

  /**
   * Spans waiting on a parent that has not arrived, keyed by the missing
   * parent id.
   *
   * A child can legitimately precede its parent: the backlog preserves arrival
   * order, and a parent's `SpanStart` is emitted when it opens, which a
   * concurrent fiber's child can beat to the wire. Rather than drop such a
   * span, it is parked here and re-linked when the parent shows up.
   */
  private readonly pendingChildren = new Map<string, Array<string>>()

  /** Monotonic nanos of the first event seen; the zero point for `start`/`end`. */
  origin: bigint | undefined
  /** Wall-clock millis matching {@link origin}, from the session's `Hello`. */
  epochOrigin: number | undefined

  /**
   * Bumped on every mutation.
   *
   * This is the *only* value React is allowed to observe. The renderer polls
   * it per frame to decide whether to redraw; the UI mirrors it into an atom
   * on a timer so counters update without a render per span.
   */
  version = 0

  private spanCount = 0
  private errorCount = 0
  private eventCount = 0
  private maxTime = 0

  /** Snapshot of the counters — allocates, so call it per repaint, not per span. */
  stats(): TraceStats {
    return {
      spans: this.spanCount,
      openSpans: this.openSpans.size,
      errors: this.errorCount,
      logs: this.logs.length,
      events: this.eventCount,
      duration: this.maxTime,
    }
  }

  /** Drops everything — used when switching sessions. */
  clear(): void {
    this.spans.clear()
    this.roots.length = 0
    this.openSpans.clear()
    this.logs.length = 0
    this.memory.length = 0
    this.memoryPeak = 0
    this.memoryTrough = Number.POSITIVE_INFINITY
    this.memoryRssPeak = 0
    this.raw.length = 0
    this.rows.length = 0
    this.pendingChildren.clear()
    this.origin = undefined
    this.epochOrigin = undefined
    this.spanCount = 0
    this.errorCount = 0
    this.eventCount = 0
    this.maxTime = 0
    this.version++
  }

  /** Ingests one client message. Unknown/undrawn variants are ignored, not errors. */
  apply(message: ClientMessage): void {
    this.raw.push(message)
    switch (message._tag) {
      case 'Hello': {
        this.anchor(message.clock.startTime)
        this.epochOrigin = message.clock.wallClockEpochMillis
        break
      }
      case 'SpanStart': {
        this.applySpanStart(message)
        break
      }
      case 'SpanEnd': {
        this.applySpanEnd(message)
        break
      }
      case 'SpanEvent': {
        this.applySpanEvent(message)
        break
      }
      case 'Log': {
        this.applyLog(message)
        break
      }
      case 'MemorySample': {
        this.applyMemorySample(message)
        break
      }
      default:
        // Metrics and FiberEvent are carried by the protocol but not drawn in
        // M1 (see the spec); ignoring them here keeps the store's memory
        // proportional to what the renderer actually reads.
        return
    }
    this.version++
  }

  /** Ingests a batch, bumping `version` once rather than per message. */
  applyAll(messages: Iterable<ClientMessage>): void {
    const before = this.version
    for (const message of messages) this.apply(message)
    // `apply` already bumped per message; collapse to a single logical change
    // so a 10k-message backlog is one repaint, not ten thousand.
    this.version = before + 1
  }

  private anchor(time: bigint): void {
    this.origin ??= time
  }

  private relative(time: bigint): number {
    this.anchor(time)
    const value = toRelativeMillis(time, this.origin!)
    if (value > this.maxTime) this.maxTime = value
    return value
  }

  private applySpanStart(message: Extract<ClientMessage, { _tag: 'SpanStart' }>): void {
    if (this.spans.has(message.spanId)) return // SpanStart is sent once; a repeat is a replay.

    // An ExternalParent's span body lives in another tracing system, so there
    // is nothing to nest under here — treat it as a root, like Chrome does
    // with a trace that starts mid-flight.
    const parentId = message.parent?._tag === 'LocalParent' ? message.parent.spanId : undefined
    const parent = parentId === undefined ? undefined : this.spans.get(parentId)

    const span: TraceSpan = {
      spanId: message.spanId,
      traceId: message.traceId,
      name: message.name,
      kind: message.kind,
      parentId,
      start: this.relative(message.startTime),
      end: undefined,
      depth: parent === undefined ? 0 : parent.depth + 1,
      outcome: undefined,
      attributes: { ...message.attributes },
      children: [],
      events: [],
      fiberId: message.fiberId,
      orphaned: parentId !== undefined && parent === undefined,
    }

    this.spans.set(span.spanId, span)
    this.openSpans.add(span.spanId)
    this.spanCount++

    if (parent !== undefined) {
      parent.children.push(span.spanId)
    } else if (parentId === undefined) {
      this.roots.push(span.spanId)
    } else {
      // Parent id known but span not here yet — park until it arrives.
      const pending = this.pendingChildren.get(parentId)
      if (pending === undefined) this.pendingChildren.set(parentId, [span.spanId])
      else pending.push(span.spanId)
    }

    this.addToRow(span)
    this.adoptPending(span)
  }

  /** Re-links children that arrived before this span did. */
  private adoptPending(parent: TraceSpan): void {
    const pending = this.pendingChildren.get(parent.spanId)
    if (pending === undefined) return
    this.pendingChildren.delete(parent.spanId)
    for (const childId of pending) {
      const child = this.spans.get(childId)
      if (child === undefined) continue
      parent.children.push(childId)
      child.orphaned = false
      this.redepth(child, parent.depth + 1)
    }
  }

  /**
   * Moves a subtree to a new depth after a late parent arrives.
   *
   * Iterative rather than recursive: a deeply-nested Effect program can stack
   * hundreds of spans and a blown call stack during ingest would take the
   * whole webapp down.
   */
  private redepth(root: TraceSpan, depth: number): void {
    const stack: Array<[TraceSpan, number]> = [[root, depth]]
    while (stack.length > 0) {
      const next = stack.pop()
      if (next === undefined) break
      const [span, spanDepth] = next
      if (span.depth !== spanDepth) {
        this.removeFromRow(span)
        span.depth = spanDepth
        this.addToRow(span)
      }
      for (const childId of span.children) {
        const child = this.spans.get(childId)
        if (child !== undefined) stack.push([child, spanDepth + 1])
      }
    }
  }

  private addToRow(span: TraceSpan): void {
    while (this.rows.length <= span.depth) this.rows.push([])
    this.rows[span.depth]!.push(span.spanId)
  }

  private removeFromRow(span: TraceSpan): void {
    const row = this.rows[span.depth]
    if (row === undefined) return
    const index = row.indexOf(span.spanId)
    if (index !== -1) row.splice(index, 1)
  }

  private applySpanEnd(message: Extract<ClientMessage, { _tag: 'SpanEnd' }>): void {
    const span = this.spans.get(message.spanId)
    // A SpanEnd with no SpanStart means the backlog was truncated ahead of it;
    // there is no bar to close, so drop it rather than invent a span.
    if (span === undefined) return

    span.end = this.relative(message.endTime)
    span.outcome = message.outcome
    // SpanEnd carries only late attributes; merge them over what SpanStart set.
    if (Object.keys(message.attributes).length > 0) {
      span.attributes = { ...span.attributes, ...message.attributes }
    }
    if (this.openSpans.delete(message.spanId) && message.outcome._tag === 'Failure') {
      this.errorCount++
    }
  }

  private applySpanEvent(message: Extract<ClientMessage, { _tag: 'SpanEvent' }>): void {
    const span = this.spans.get(message.spanId)
    if (span === undefined) return
    span.events.push({
      name: message.name,
      time: this.relative(message.time),
      attributes: message.attributes,
    })
    this.eventCount++
  }

  private applyMemorySample(message: Extract<ClientMessage, { _tag: 'MemorySample' }>): void {
    this.memory.push({
      time: this.relative(message.time),
      heapUsed: message.heapUsed,
      heapTotal: message.heapTotal,
      rss: message.rss,
      external: message.external,
    })
    if (message.heapUsed > this.memoryPeak) this.memoryPeak = message.heapUsed
    if (message.heapUsed < this.memoryTrough) this.memoryTrough = message.heapUsed
    if (message.rss > this.memoryRssPeak) this.memoryRssPeak = message.rss
  }

  private applyLog(message: Extract<ClientMessage, { _tag: 'Log' }>): void {
    this.logs.push({
      time: this.relative(message.time),
      level: message.level,
      message: message.message,
      spanId: message.spanId,
      fiberId: message.fiberId,
      annotations: message.annotations,
    })
  }
}
