/**
 * A fake collector, for developing the webapp without the real one.
 *
 * Speaks the webapp half of the protocol only: announces one session, replays a
 * small backlog on `Subscribe`, then emits live spans and logs forever. The
 * real collector is a separate task; this exists so the shell and the flame
 * chart can be built and demoed against a moving trace in the meantime.
 *
 * Run with `bun run stub:collector`.
 */
import { webappCodec, webappRequestCodec } from '../src/protocol/Codec.ts'
import type { ClientMessage, Session } from '../src/protocol/Schema.ts'
import { protocolVersion } from '../src/protocol/Schema.ts'

const PORT = 34437
const SESSION_ID = 'stub-session-1'

const startedAt = Date.now()
const origin = BigInt(startedAt) * 1_000_000n
let clock = origin

/** Advances the fake monotonic clock by `millis` and returns the new time. */
const tick = (millis: number): bigint => {
  clock += BigInt(Math.round(millis * 1_000_000))
  return clock
}

const session: Session = {
  sessionId: SESSION_ID,
  program: 'stub-program',
  pid: process.pid,
  runtime: 'bun',
  clock: { startTime: origin, wallClockEpochMillis: startedAt },
  active: true,
}

let nextSpan = 0
const spanId = (): string => `span-${++nextSpan}`

const NAMES = [
  'http.request',
  'db.query',
  'cache.get',
  'user.load',
  'render',
  'validate',
  'serialize',
]

/** One root span with a couple of nested children, ended in order. */
const burst = (): Array<ClientMessage> => {
  const messages: Array<ClientMessage> = []
  const rootId = spanId()
  const name = NAMES[Math.floor(Math.random() * NAMES.length)]!

  messages.push({
    _tag: 'SpanStart',
    sessionId: SESSION_ID,
    spanId: rootId,
    traceId: `trace-${rootId}`,
    name,
    kind: 'server',
    startTime: tick(Math.random() * 20),
    attributes: { 'http.method': 'GET', 'http.route': `/${name}` },
    sampled: true,
  })

  const childIds: Array<string> = []
  const childCount = 1 + Math.floor(Math.random() * 3)
  for (let i = 0; i < childCount; i++) {
    const childId = spanId()
    childIds.push(childId)
    messages.push({
      _tag: 'SpanStart',
      sessionId: SESSION_ID,
      spanId: childId,
      traceId: `trace-${rootId}`,
      parent: { _tag: 'LocalParent', spanId: rootId },
      name: NAMES[Math.floor(Math.random() * NAMES.length)]!,
      kind: 'internal',
      startTime: tick(Math.random() * 5),
      attributes: { attempt: i },
      sampled: true,
    })
  }

  messages.push({
    _tag: 'Log',
    sessionId: SESSION_ID,
    time: tick(1),
    level: 'Info',
    message: `handled ${name}`,
    spanId: rootId,
    annotations: {},
  })

  for (const childId of childIds) {
    // One in eight children fails, so the error colouring has something to show.
    const failed = Math.random() < 0.125
    messages.push({
      _tag: 'SpanEnd',
      sessionId: SESSION_ID,
      spanId: childId,
      endTime: tick(Math.random() * 15),
      outcome: failed
        ? { _tag: 'Failure', kind: 'Fail', error: 'stub failure' }
        : { _tag: 'Success' },
      attributes: { 'result.size': Math.floor(Math.random() * 1000) },
    })
  }

  messages.push({
    _tag: 'SpanEnd',
    sessionId: SESSION_ID,
    spanId: rootId,
    endTime: tick(Math.random() * 10),
    outcome: { _tag: 'Success' },
    attributes: {},
  })

  return messages
}

/** Everything emitted so far, replayed to a webapp that subscribes. */
const history: Array<ClientMessage> = [
  {
    _tag: 'Hello',
    sessionId: SESSION_ID,
    program: session.program,
    pid: session.pid,
    runtime: session.runtime,
    protocolVersion,
    clock: session.clock,
  },
]
for (let i = 0; i < 20; i++) history.push(...burst())

const subscribers = new Map<Bun.ServerWebSocket<unknown>, Set<string>>()

const server = Bun.serve({
  port: PORT,
  fetch: (request, srv) =>
    srv.upgrade(request)
      ? undefined
      : new Response('ws only', {
          status: 400,
        }),
  websocket: {
    open: (ws) => {
      subscribers.set(ws, new Set())
      ws.send(webappCodec.encode({ _tag: 'SessionList', sessions: [session] }))
    },
    close: (ws) => {
      subscribers.delete(ws)
    },
    message: (ws, raw) => {
      const decoded = webappRequestCodec.decodeAll(String(raw))
      if (decoded._tag !== 'Success') return
      for (const request of decoded.success) {
        const sessions = subscribers.get(ws)
        if (sessions === undefined) continue
        if (request._tag === 'Subscribe') {
          sessions.add(request.sessionId)
          ws.send(
            webappCodec.encode({
              _tag: 'Backlog',
              sessionId: request.sessionId,
              messages: history,
              complete: true,
            }),
          )
        } else {
          sessions.delete(request.sessionId)
        }
      }
    },
  },
})

setInterval(() => {
  const messages = burst()
  history.push(...messages)
  for (const [ws, sessions] of subscribers) {
    if (!sessions.has(SESSION_ID)) continue
    for (const message of messages) ws.send(webappCodec.encode({ _tag: 'Live', message }))
  }
}, 500)

console.log(`stub collector on ws://localhost:${server.port} (session ${SESSION_ID})`)
