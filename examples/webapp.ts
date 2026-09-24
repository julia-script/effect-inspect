/**
 * The everyday case: a fake HTTP handler serving a handful of requests.
 *
 * Nested spans (route → auth → db → serialize), span events, and logs
 * correlated to the span they were emitted in. Tens of spans, done in a second.
 *
 * `bun run example:webapp`
 */
import { Effect, Random } from 'effect'
import { main } from './run.ts'

/** A span that just takes some time, so the bar has a width. */
const work = (name: string, minMillis: number, maxMillis: number) =>
  Effect.gen(function* () {
    yield* Effect.sleep(`${yield* Random.nextIntBetween(minMillis, maxMillis)} millis`)
  }).pipe(Effect.withSpan(name))

const authenticate = Effect.gen(function* () {
  yield* work('auth.verifyToken', 2, 6)
  yield* Effect.annotateCurrentSpan('user.id', yield* Random.nextIntBetween(1000, 9999))
  yield* work('auth.loadPermissions', 1, 4)
}).pipe(Effect.withSpan('auth'))

const query = Effect.fn('db.query')(function* (sql: string) {
  const rows = yield* Random.nextIntBetween(1, 200)
  yield* Effect.annotateCurrentSpan({ 'db.statement': sql, 'db.rows': rows })
  yield* Effect.sleep(`${yield* Random.nextIntBetween(3, 25)} millis`)
  return rows
})

const loadOrder = Effect.fn('order.load')(function* (id: number) {
  const cached = yield* Random.nextBoolean
  yield* Effect.annotateCurrentSpan('cache.hit', cached)
  if (cached) return yield* work('cache.get', 1, 3)
  yield* query(`select * from orders where id = ${id}`)
  yield* query(`select * from order_items where order_id = ${id}`)
})

const handle = (id: number) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ 'http.method': 'GET', 'http.route': '/orders/:id' })
    yield* authenticate
    yield* loadOrder(id)
    yield* Effect.logInfo(`served order ${id}`)
    yield* work('response.serialize', 1, 5)
  }).pipe(Effect.withSpan(`GET /orders/${id}`))

const program = Effect.gen(function* () {
  for (let id = 1; id <= 8; id++) yield* handle(id)
}).pipe(Effect.withSpan('server'))

main('example:webapp', program)
