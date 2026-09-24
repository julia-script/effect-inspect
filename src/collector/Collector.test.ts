/**
 * End-to-end collector tests: a real server on an ephemeral port, driven by
 * stub programs and a stub webapp client over real WebSockets.
 *
 * Going through the socket rather than calling handlers directly is the point —
 * framing, routing by path, and what happens when a peer disappears mid-stream
 * are exactly the parts that break.
 */
import { describe, expect, it } from 'bun:test'
import { Effect, Scope } from 'effect'
import { clientCodec, webappCodec, webappRequestCodec } from '../protocol/Codec.ts'
import type * as Protocol from '../protocol/Schema.ts'
import { protocolVersion } from '../protocol/Schema.ts'
import { make as makeSocketServer } from './BunWebSocketServer.ts'
import { handleConnection, webappPath } from './Server.ts'
import { make as makeStore, Store } from './Store.ts'

const clock = { startTime: 1_000n, wallClockEpochMillis: 1_700_000_000_000 }

const hello = (sessionId: string, program: string): Protocol.ClientMessage => ({
  _tag: 'Hello',
  sessionId,
  program,
  pid: 4242,
  runtime: 'bun',
  protocolVersion,
  clock,
})

const spanStart = (sessionId: string, spanId: string): Protocol.ClientMessage => ({
  _tag: 'SpanStart',
  sessionId,
  spanId,
  traceId: 'trace-1',
  name: spanId,
  kind: 'internal',
  startTime: 1_000n,
  attributes: {},
  sampled: true,
})

/** The span ids of a run of client messages, for readable assertions. */
const spanIds = (messages: ReadonlyArray<Protocol.ClientMessage> | undefined) =>
  messages?.map((message) => (message._tag === 'SpanStart' ? message.spanId : message._tag))

type StoreService = Store['Service']

/** A collector running on an ephemeral port for the current scope. */
interface Collector {
  readonly port: number
  readonly store: StoreService
}

/** Starts a collector on an ephemeral port, stopped when the scope closes. */
const startCollector = Effect.fnUntraced(function* (options?: { readonly capacity?: number }) {
  const store = yield* makeStore(options)
  const server = yield* makeSocketServer({ port: 0 })
  yield* Effect.forkScoped(Effect.provideService(server.run(handleConnection), Store, store))
  return {
    port: server.address._tag === 'UnixPathAddress' ? 0 : server.address.port,
    store,
  } satisfies Collector
})

/** A stub peer: an open WebSocket plus everything it has received. */
interface Peer {
  readonly send: (line: string) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
  /** Every webapp message received so far, decoded. */
  readonly received: () => ReadonlyArray<Protocol.WebappMessage>
}

/** Opens a WebSocket to the collector, closed when the scope closes. */
const connect = Effect.fnUntraced(function* (port: number, path = '/') {
  const received: Array<Protocol.WebappMessage> = []

  const socket = yield* Effect.acquireRelease(
    Effect.callback<WebSocket>((resume) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
      ws.addEventListener('message', (event) => {
        for (const line of String(event.data).split('\n')) {
          if (line.trim() === '') continue
          const decoded = webappCodec.decode(line)
          if (decoded._tag === 'Success') received.push(decoded.success)
        }
      })
      ws.addEventListener('open', () => resume(Effect.succeed(ws)), { once: true })
    }),
    (ws) => Effect.sync(() => ws.close()),
  )

  return {
    send: (line: string) => Effect.sync(() => socket.send(line)),
    close: Effect.sync(() => socket.close()),
    received: () => received,
  } satisfies Peer
})

/**
 * Polls `condition` until it holds, so a test never races the event loop.
 *
 * Everything here crosses a real socket, so the collector's view of the world
 * is always a few ticks behind the `send` that caused it.
 */
const until = (condition: Effect.Effect<boolean>, label: string): Effect.Effect<void> =>
  Effect.flatMap(condition, (met) =>
    met ? Effect.void : Effect.flatMap(Effect.sleep('5 millis'), () => until(condition, label)),
  ).pipe(
    Effect.timeoutOrElse({
      duration: '5 seconds',
      orElse: () => Effect.die(new Error(`timed out waiting for ${label}`)),
    }),
  )

/** Runs a scoped test effect to completion, tearing down sockets and servers. */
const runTest = <E>(effect: Effect.Effect<void, E, Scope.Scope>): Promise<void> =>
  Effect.runPromise(Effect.scoped(effect) as Effect.Effect<void, E>)

describe('collector', () => {
  it('serves two concurrent programs and a subscribed webapp client', () =>
    runTest(
      Effect.gen(function* () {
        const collector = yield* startCollector()

        const alpha = yield* connect(collector.port)
        const beta = yield* connect(collector.port)
        yield* alpha.send(clientCodec.encode(hello('session-alpha', 'alpha')))
        yield* beta.send(clientCodec.encode(hello('session-beta', 'beta')))

        yield* until(
          Effect.map(collector.store.sessions, (sessions) => sessions.length === 2),
          'both sessions registered',
        )

        const webapp = yield* connect(collector.port, webappPath)

        // The session list arrives unprompted on connect, listing both programs.
        yield* until(
          Effect.sync(() => webapp.received().some((message) => message._tag === 'SessionList')),
          'session list',
        )
        const list = webapp.received().findLast((message) => message._tag === 'SessionList')
        expect(
          list?._tag === 'SessionList'
            ? list.sessions.map((session) => session.program).sort()
            : [],
        ).toEqual(['alpha', 'beta'])

        // A span recorded before the webapp subscribes must still reach it.
        yield* alpha.send(clientCodec.encode(spanStart('session-alpha', 'before-subscribe')))
        yield* beta.send(clientCodec.encode(spanStart('session-beta', 'beta-only')))
        yield* until(
          Effect.map(
            collector.store.snapshot('session-alpha'),
            (snapshot) => snapshot?.messages.length === 1,
          ),
          'alpha span recorded',
        )

        yield* webapp.send(
          webappRequestCodec.encode({ _tag: 'Subscribe', sessionId: 'session-alpha' }),
        )
        yield* until(
          Effect.sync(() => webapp.received().some((message) => message._tag === 'Backlog')),
          'backlog',
        )
        const backlog = webapp.received().find((message) => message._tag === 'Backlog')
        expect(backlog?._tag === 'Backlog' ? backlog.sessionId : undefined).toBe('session-alpha')
        expect(backlog?._tag === 'Backlog' ? backlog.complete : undefined).toBe(true)
        expect(spanIds(backlog?._tag === 'Backlog' ? backlog.messages : [])).toEqual([
          'before-subscribe',
        ])

        // Live tail: only the subscribed session is forwarded.
        yield* alpha.send(clientCodec.encode(spanStart('session-alpha', 'after-subscribe')))
        yield* beta.send(clientCodec.encode(spanStart('session-beta', 'beta-unsubscribed')))
        yield* until(
          Effect.sync(() => webapp.received().some((message) => message._tag === 'Live')),
          'live message',
        )
        yield* Effect.sleep('50 millis')

        expect(
          webapp
            .received()
            .flatMap((message) =>
              message._tag === 'Live' && message.message._tag === 'SpanStart'
                ? [message.message.spanId]
                : [],
            ),
        ).toEqual(['after-subscribe'])
      }),
    ))

  it('drops the oldest messages past the cap and reports the count', () =>
    runTest(
      Effect.gen(function* () {
        const collector = yield* startCollector({ capacity: 3 })
        const program = yield* connect(collector.port)
        yield* program.send(clientCodec.encode(hello('session-capped', 'capped')))

        for (const spanId of ['a', 'b', 'c', 'd', 'e']) {
          yield* program.send(clientCodec.encode(spanStart('session-capped', spanId)))
        }

        yield* until(
          Effect.map(collector.store.losses, (losses) => losses.droppedMessages === 2),
          'two messages dropped',
        )

        const snapshot = yield* collector.store.snapshot('session-capped')
        // Oldest dropped first, and the retained window stays in arrival order.
        expect(spanIds(snapshot?.messages)).toEqual(['c', 'd', 'e'])
        expect(snapshot?.droppedMessages).toBe(2)
      }),
    ))

  it('skips malformed lines without dropping the session or the connection', () =>
    runTest(
      Effect.gen(function* () {
        const collector = yield* startCollector()
        const program = yield* connect(collector.port)
        yield* program.send(clientCodec.encode(hello('session-noisy', 'noisy')))

        // Bad lines sharing a frame with good ones is the case `decodeAll` cannot
        // survive: everything but the bad lines must still be recorded.
        yield* program.send(
          clientCodec.encode(spanStart('session-noisy', 'before')) +
            'not json at all\n' +
            '{"_tag":"Nope"}\n' +
            clientCodec.encode(spanStart('session-noisy', 'after')),
        )

        yield* until(
          Effect.map(
            collector.store.snapshot('session-noisy'),
            (snapshot) => snapshot?.messages.length === 2,
          ),
          'both good spans recorded',
        )

        const snapshot = yield* collector.store.snapshot('session-noisy')
        expect(spanIds(snapshot?.messages)).toEqual(['before', 'after'])
        expect(snapshot?.skippedLines).toBe(2)

        // The connection survives, so telemetry after the bad lines still lands.
        yield* program.send(clientCodec.encode(spanStart('session-noisy', 'later')))
        yield* until(
          Effect.map(
            collector.store.snapshot('session-noisy'),
            (snapshot) => snapshot?.messages.length === 3,
          ),
          'connection still live after malformed input',
        )
      }),
    ))

  it('ends a session when its program dies and resumes it on reconnect', () =>
    runTest(
      Effect.gen(function* () {
        const collector = yield* startCollector()
        const first = yield* connect(collector.port)
        yield* first.send(clientCodec.encode(hello('session-restart', 'restarter')))
        yield* first.send(clientCodec.encode(spanStart('session-restart', 'first-run')))
        yield* until(
          Effect.map(
            collector.store.snapshot('session-restart'),
            (snapshot) => snapshot?.messages.length === 1,
          ),
          'first run recorded',
        )

        // Killing the program looks like an abrupt close to the collector.
        yield* first.close
        yield* until(
          Effect.map(collector.store.sessions, (sessions) => sessions[0]?.active === false),
          'session marked ended',
        )

        // The collector is still serving: a reconnect resumes the same session.
        const second = yield* connect(collector.port)
        yield* second.send(clientCodec.encode(hello('session-restart', 'restarter')))
        yield* second.send(clientCodec.encode(spanStart('session-restart', 'second-run')))
        yield* until(
          Effect.map(
            collector.store.snapshot('session-restart'),
            (snapshot) => snapshot?.messages.length === 2,
          ),
          'second run appended to the same session',
        )

        const sessions = yield* collector.store.sessions
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.active).toBe(true)
        const snapshot = yield* collector.store.snapshot('session-restart')
        expect(spanIds(snapshot?.messages)).toEqual(['first-run', 'second-run'])
      }),
    ))
})
