/**
 * The tracer and logger that observe the host program.
 *
 * Both delegate rather than replace: the tracer wraps whatever tracer is
 * already installed and the logger is merged into the existing set, so adding
 * the inspect layer never removes behaviour the program already had. Every
 * method here is called on the host program's own fibers, so none of them may
 * fail, suspend, or do real work — they narrow a value to the protocol's domain
 * and hand it to a queue.
 */
import { Cause, Clock, Effect, Logger, References, Tracer } from 'effect'
import type { InspectClient } from './Client.ts'
import { toAttributes, toJson, toOutcome } from './Edge.ts'
import type * as Protocol from '../protocol/Schema.ts'

const parentOf = (span: Tracer.Span): Protocol.SpanParent | undefined => {
  const parent = span.parent
  if (parent._tag === 'None') return undefined
  const value = parent.value
  return value._tag === 'Span'
    ? { _tag: 'LocalParent', spanId: value.spanId }
    : {
        _tag: 'ExternalParent',
        spanId: value.spanId,
        traceId: value.traceId,
        sampled: value.sampled,
      }
}

/**
 * Creates a tracer that mirrors every span to the client while delegating to
 * the current tracer.
 *
 * `SpanStart` is sent once when the span opens and `SpanEnd` when it closes,
 * carrying the end time, the flattened outcome, and the span's attributes for
 * the collector to merge. See `span` for why the attributes are not a strict
 * delta.
 */
export const make = (client: InspectClient['Service']): Effect.Effect<Tracer.Tracer> =>
  Effect.map(Effect.tracer, (currentTracer) =>
    Tracer.make({
      span(options) {
        const span = currentTracer.span(options)

        // `SpanStart` goes out immediately, so a live trace shows the span as
        // soon as it opens. Its attributes are usually empty at this instant:
        // Effect applies the ones passed to `Effect.withSpan` through
        // `span.attribute` *after* this method returns, and it does so in the
        // same synchronous burst as any later annotation, so there is no timing
        // signal that separates "initial" from "late".
        //
        // Rather than guess, `SpanEnd` carries the span's whole attribute map.
        // The protocol has the collector merge those over what it already has,
        // and merging is idempotent, so a resent attribute costs a few bytes
        // and changes nothing — which is the cheaper error than dropping an
        // attribute the user set.
        const parent = parentOf(span)
        client.sendUnsafe({
          _tag: 'SpanStart',
          sessionId: client.sessionId,
          spanId: span.spanId,
          traceId: span.traceId,
          ...(parent === undefined ? {} : { parent }),
          name: span.name,
          kind: span.kind,
          startTime: options.startTime,
          attributes: toAttributes(span.attributes),
          sampled: span.sampled,
        })

        const inheritedEvent = span.event.bind(span)
        span.event = (name, startTime, attributes) => {
          client.sendUnsafe({
            _tag: 'SpanEvent',
            sessionId: client.sessionId,
            spanId: span.spanId,
            name,
            time: startTime,
            attributes: toAttributes(attributes ?? {}),
          })
          return inheritedEvent(name, startTime, attributes)
        }

        const inheritedEnd = span.end.bind(span)
        span.end = (endTime, exit) => {
          inheritedEnd(endTime, exit)
          client.sendUnsafe({
            _tag: 'SpanEnd',
            sessionId: client.sessionId,
            spanId: span.spanId,
            endTime,
            outcome: toOutcome(exit),
            attributes: toAttributes(span.attributes),
          })
        }

        return span
      },
      context: currentTracer.context,
    }),
  )

/**
 * Creates a logger that mirrors every log record to the client, correlated with
 * the span the logging fiber is inside.
 *
 * Effect's own tracer logger turns logs into span events, which loses logs
 * emitted outside any span. These are sent as `Log` instead, so they keep their
 * level and appear in the stream whether or not a span was active.
 */
export const makeLogger = (client: InspectClient['Service']): Logger.Logger<unknown, void> =>
  Logger.make(({ cause, fiber, logLevel, message }) => {
    const span = fiber.cache.span
    const annotations: Record<string, Protocol.Json> = {
      ...toAttributes(fiber.getRef(References.CurrentLogAnnotations)),
    }
    if (cause.reasons.length > 0) annotations['effect.cause'] = Cause.pretty(cause)

    client.sendUnsafe({
      _tag: 'Log',
      sessionId: client.sessionId,
      // The fiber's own clock, so log times share the span time base rather
      // than mixing in a wall clock the webapp would have to re-anchor.
      time: fiber.getRef(Clock.Clock).currentTimeNanosUnsafe(),
      level: logLevel,
      message: toJson(Array.isArray(message) && message.length === 1 ? message[0] : message),
      ...(span === undefined || span._tag === 'ExternalSpan' ? {} : { spanId: span.spanId }),
      fiberId: fiber.id,
      annotations,
    })
  })
