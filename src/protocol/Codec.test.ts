import { describe, expect, it } from 'bun:test'
import { Result } from 'effect'
import {
  clientCodec,
  collectorCodec,
  type Codec,
  traceFileHeaderCodec,
  webappCodec,
  webappRequestCodec,
} from './Codec.ts'
import type {
  ClientMessage,
  CollectorMessage,
  TraceFileHeader,
  WebappMessage,
  WebappRequest,
} from './Schema.ts'
import { protocolVersion, traceFileFormatVersion } from './Schema.ts'

const sessionId = 'session-1'
const clock = { startTime: 1_000n, wallClockEpochMillis: 1_700_000_000_000 }

const roundTrip = <A>(codec: Codec<A>, message: A): A => {
  const line = codec.encode(message)
  expect(line.endsWith('\n')).toBe(true)
  expect(line.slice(0, -1)).not.toInclude('\n')
  return Result.getOrThrow(codec.decode(line))
}

const clientMessages: Record<string, ClientMessage> = {
  Hello: {
    _tag: 'Hello',
    sessionId,
    program: 'example',
    pid: 4242,
    runtime: 'bun',
    protocolVersion,
    clock,
  },
  'SpanStart (root)': {
    _tag: 'SpanStart',
    sessionId,
    spanId: 'span-1',
    traceId: 'trace-1',
    name: 'root',
    kind: 'internal',
    startTime: 1_000n,
    attributes: {},
    sampled: true,
  },
  'SpanStart (local parent, nested attributes)': {
    _tag: 'SpanStart',
    sessionId,
    spanId: 'span-2',
    traceId: 'trace-1',
    parent: { _tag: 'LocalParent', spanId: 'span-1' },
    name: 'child',
    kind: 'client',
    startTime: 2_000n,
    attributes: {
      'http.method': 'GET',
      'http.status': 200,
      retried: false,
      nothing: null,
      tags: ['a', 'b'],
      nested: { deep: { deeper: 1 } },
    },
    sampled: true,
    fiberId: 7,
  },
  'SpanStart (external parent)': {
    _tag: 'SpanStart',
    sessionId,
    spanId: 'span-3',
    traceId: 'trace-external',
    parent: {
      _tag: 'ExternalParent',
      spanId: 'span-upstream',
      traceId: 'trace-external',
      sampled: false,
    },
    name: 'continued-from-upstream',
    kind: 'server',
    startTime: 3_000n,
    attributes: {},
    sampled: false,
  },
  'SpanEnd (success)': {
    _tag: 'SpanEnd',
    sessionId,
    spanId: 'span-1',
    endTime: 9_000n,
    outcome: { _tag: 'Success' },
    attributes: {},
  },
  'SpanEnd (failure)': {
    _tag: 'SpanEnd',
    sessionId,
    spanId: 'span-2',
    endTime: 9_500n,
    outcome: {
      _tag: 'Failure',
      kind: 'Fail',
      error: 'RequestError: connection refused',
      stack: 'at fetchUser (src/user.ts:12:3)',
    },
    attributes: { 'error.retries': 3 },
  },
  'SpanEnd (defect)': {
    _tag: 'SpanEnd',
    sessionId,
    spanId: 'span-3',
    endTime: 9_600n,
    outcome: { _tag: 'Failure', kind: 'Die', error: 'TypeError: x is not a function' },
    attributes: {},
  },
  'SpanEnd (interrupt)': {
    _tag: 'SpanEnd',
    sessionId,
    spanId: 'span-4',
    endTime: 9_700n,
    outcome: { _tag: 'Failure', kind: 'Interrupt', error: 'interrupted' },
    attributes: {},
  },
  SpanEvent: {
    _tag: 'SpanEvent',
    sessionId,
    spanId: 'span-1',
    name: 'cache.miss',
    time: 4_000n,
    attributes: { key: 'user:1' },
  },
  Log: {
    _tag: 'Log',
    sessionId,
    time: 5_000n,
    level: 'Info',
    message: 'hello',
    spanId: 'span-1',
    fiberId: 7,
    annotations: { requestId: 'abc' },
  },
  'Log (structured message, no span)': {
    _tag: 'Log',
    sessionId,
    time: 5_100n,
    level: 'Error',
    message: { reason: 'boom', code: 500 },
    annotations: {},
  },
  Metrics: {
    _tag: 'Metrics',
    sessionId,
    time: 6_000n,
    metrics: [
      {
        type: 'Counter',
        name: 'requests',
        description: 'total requests',
        attributes: { route: '/' },
        state: { count: 12, incremental: true },
      },
      { type: 'Gauge', name: 'memory', attributes: {}, state: { value: 1.5 } },
      {
        type: 'Histogram',
        name: 'latency',
        attributes: {},
        state: {
          buckets: [
            [10, 3],
            [100, 9],
          ],
          count: 9,
          min: 1,
          max: 99,
          sum: 321,
        },
      },
      {
        type: 'Frequency',
        name: 'status',
        attributes: {},
        state: { occurrences: { '200': 9, '500': 1 } },
      },
      {
        type: 'Summary',
        name: 'duration',
        attributes: {},
        state: {
          quantiles: [
            [0.5, 12],
            [0.99, null],
          ],
          count: 10,
          min: 1,
          max: 50,
          sum: 130,
        },
      },
    ],
  },
  FiberEvent: {
    _tag: 'FiberEvent',
    sessionId,
    fiberId: 7,
    event: 'Start',
    parentFiberId: 1,
    time: 7_000n,
  },
  'FiberEvent (suspend, no parent)': {
    _tag: 'FiberEvent',
    sessionId,
    fiberId: 7,
    event: 'Suspend',
    time: 7_100n,
  },
  Ping: { _tag: 'Ping', sessionId },
}

const session = {
  sessionId,
  program: 'example',
  pid: 4242,
  runtime: 'bun',
  clock,
  active: true,
}

const collectorMessages: Record<string, CollectorMessage> = {
  Pong: { _tag: 'Pong', sessionId },
  MetricsRequest: { _tag: 'MetricsRequest' },
}

const webappMessages: Record<string, WebappMessage> = {
  SessionList: { _tag: 'SessionList', sessions: [session] },
  'SessionList (ended session)': {
    _tag: 'SessionList',
    sessions: [{ ...session, active: false, endedAtEpochMillis: 1_700_000_005_000 }],
  },
  Backlog: {
    _tag: 'Backlog',
    sessionId,
    messages: Object.values(clientMessages),
    complete: true,
  },
  Live: { _tag: 'Live', message: clientMessages['SpanEvent']! },
  SessionEnded: { _tag: 'SessionEnded', sessionId, endedAtEpochMillis: 1_700_000_005_000 },
}

const webappRequests: Record<string, WebappRequest> = {
  Subscribe: { _tag: 'Subscribe', sessionId },
  Unsubscribe: { _tag: 'Unsubscribe', sessionId },
}

const traceFileHeaders: Record<string, TraceFileHeader> = {
  'TraceFileHeader (active session)': {
    _tag: 'TraceFileHeader',
    formatVersion: traceFileFormatVersion,
    protocolVersion,
    session: { sessionId, program: 'example', pid: 4242, runtime: 'bun', clock, active: true },
    savedAtEpochMillis: 1_700_000_009_000,
  },
  'TraceFileHeader (ended session)': {
    _tag: 'TraceFileHeader',
    formatVersion: traceFileFormatVersion,
    protocolVersion,
    session: {
      sessionId,
      program: 'example',
      pid: 4242,
      runtime: 'bun',
      clock,
      active: false,
      endedAtEpochMillis: 1_700_000_005_000,
    },
    savedAtEpochMillis: 1_700_000_009_000,
  },
}

const suites = [
  ['clientCodec', clientCodec, clientMessages],
  ['traceFileHeaderCodec', traceFileHeaderCodec, traceFileHeaders],
  ['collectorCodec', collectorCodec, collectorMessages],
  ['webappCodec', webappCodec, webappMessages],
  ['webappRequestCodec', webappRequestCodec, webappRequests],
] as const

for (const [name, codec, messages] of suites) {
  describe(name, () => {
    for (const [label, message] of Object.entries(messages)) {
      it(`round-trips ${label}`, () => {
        expect(roundTrip(codec as Codec<unknown>, message)).toEqual(message)
      })
    }

    it('round-trips every variant as one NDJSON chunk', () => {
      const all = Object.values(messages)
      const chunk = all.map((m) => (codec as Codec<unknown>).encode(m)).join('')
      expect(Result.getOrThrow((codec as Codec<unknown>).decodeAll(chunk))).toEqual(all)
    })
  })
}

describe('encoding', () => {
  it('carries nanosecond times as lossless decimal strings', () => {
    const startTime = 1_234_567_890_123_456_789n
    expect(startTime > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)

    const message = { ...clientMessages['SpanStart (root)'], startTime } as ClientMessage
    const line = clientCodec.encode(message)
    expect(JSON.parse(line).startTime).toBe('1234567890123456789')
    expect(roundTrip(clientCodec, message)).toEqual(message)
  })

  it('omits absent optional fields rather than writing null', () => {
    const encoded = JSON.parse(clientCodec.encode(clientMessages['SpanStart (root)']!))
    expect('parent' in encoded).toBe(false)
    expect('fiberId' in encoded).toBe(false)
  })
})

describe('decoding', () => {
  it('tolerates surrounding whitespace', () => {
    const message = clientMessages['Ping']!
    const decoded = clientCodec.decode(`  ${clientCodec.encode(message).trim()}  `)
    expect(Result.getOrThrow(decoded)).toEqual(message)
  })

  it('skips blank lines in a chunk', () => {
    const message = clientMessages['Ping']!
    const chunk = `\n${clientCodec.encode(message)}\n  \n${clientCodec.encode(message)}`
    expect(Result.getOrThrow(clientCodec.decodeAll(chunk))).toEqual([message, message])
  })

  it('fails on malformed JSON', () => {
    const result = clientCodec.decode('{ not json')
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe('DecodeError')
      expect(result.failure.line).toBe('{ not json')
    }
  })

  it('fails on an unknown message tag', () => {
    expect(Result.isFailure(clientCodec.decode('{"_tag":"Nope"}'))).toBe(true)
  })

  it('fails on a known tag with a missing field', () => {
    expect(Result.isFailure(clientCodec.decode('{"_tag":"Ping"}'))).toBe(true)
  })

  it('rejects a non-finite attribute value', () => {
    const line = clientCodec
      .encode(clientMessages['SpanStart (root)']!)
      .replace('"attributes":{}', '"attributes":{"bad":1e999}')
    expect(JSON.parse(line).attributes.bad).toBe(Number.POSITIVE_INFINITY)
    expect(Result.isFailure(clientCodec.decode(line))).toBe(true)
  })

  it('refuses to encode a non-finite attribute value', () => {
    const message = {
      ...clientMessages['SpanStart (root)']!,
      attributes: { bad: Number.NaN },
    } as ClientMessage
    expect(() => clientCodec.encode(message)).toThrow()

    const result = clientCodec.encodeResult(message)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure._tag).toBe('EncodeError')
  })

  it('encodeResult succeeds on a valid message', () => {
    const message = clientMessages['Ping']!
    expect(Result.getOrThrow(clientCodec.encodeResult(message))).toBe(clientCodec.encode(message))
  })

  it('rejects a negative count, which JSON would carry silently', () => {
    const message = {
      _tag: 'Metrics',
      sessionId,
      time: 1n,
      metrics: [
        { type: 'Frequency', name: 'f', attributes: {}, state: { occurrences: { a: -1 } } },
      ],
    } as ClientMessage
    expect(Result.isFailure(clientCodec.encodeResult(message))).toBe(true)
  })

  it('rejects an out-of-range summary quantile', () => {
    const message = {
      _tag: 'Metrics',
      sessionId,
      time: 1n,
      metrics: [
        {
          type: 'Summary',
          name: 's',
          attributes: {},
          state: { quantiles: [[1.5, 1]], count: 1, min: 0, max: 1, sum: 1 },
        },
      ],
    } as ClientMessage
    expect(Result.isFailure(clientCodec.encodeResult(message))).toBe(true)
  })

  it('fails the whole chunk when one line is bad', () => {
    const chunk = `${clientCodec.encode(clientMessages['Ping']!)}{ not json\n`
    expect(Result.isFailure(clientCodec.decodeAll(chunk))).toBe(true)
  })

  it('rejects a collector message on the client codec', () => {
    expect(
      Result.isFailure(
        clientCodec.decode(collectorCodec.encode(collectorMessages['MetricsRequest']!)),
      ),
    ).toBe(true)
  })
})

describe('traceFileHeaderCodec', () => {
  it('keeps the session clock lossless across a round trip', () => {
    const header = {
      ...traceFileHeaders['TraceFileHeader (active session)']!,
      session: {
        ...traceFileHeaders['TraceFileHeader (active session)']!.session,
        clock: { startTime: 1_234_567_890_123_456_789n, wallClockEpochMillis: 1_700_000_000_000 },
      },
    }
    expect(roundTrip(traceFileHeaderCodec, header)).toEqual(header)
  })

  it('rejects a client message, so a body line cannot pass as a header', () => {
    expect(
      Result.isFailure(traceFileHeaderCodec.decode(clientCodec.encode(clientMessages['Ping']!))),
    ).toBe(true)
  })

  it('rejects a header on the client codec', () => {
    expect(
      Result.isFailure(
        clientCodec.decode(
          traceFileHeaderCodec.encode(traceFileHeaders['TraceFileHeader (active session)']!),
        ),
      ),
    ).toBe(true)
  })
})
