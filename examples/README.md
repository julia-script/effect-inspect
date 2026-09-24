# Examples

Six programs, each instrumented with `Inspect.layer()` and each exercising a
different shape of trace. Start the collector and the webapp first:

```bash
bun run collector   # terminal 1 — ws://localhost:34437
bun run dev:app     # terminal 2 — http://localhost:5173
```

Then run any of these in a third terminal. Each appears in the webapp's session
list under its own name, so you can leave several in the history and switch
between them.

| Command                      | What it exercises                                                                                                       | What to look for in the UI                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run example:webapp`     | The everyday case — a fake HTTP handler, 8 requests. ~62 spans, 3 deep, done in a second.                               | Eight `GET /orders/N` roots in a row, each with `auth` → `order.load` → `response.serialize` beneath it. Some requests hit `cache.get` (one short child), others two `db.query` bars. Select a `db.query` — its detail panel should show `db.statement` and `db.rows`. Nine log lines correlate to the spans they were emitted in.                                                                                           |
| `bun run example:concurrent` | Fan-out. Three waves of `Effect.forEach`/`Effect.all` at unbounded concurrency. ~112 spans.                             | 80 concurrent tasks across three waves, under a `fan-out` root. Starts are staggered by 4ms per index and durations vary 10–220ms. **Note:** rows are assigned by tree depth, so tasks that overlap in time land on the same row and hide each other — expect far fewer than 80 visible bars. This is the example that shows it.                                                                                             |
| `bun run example:deep`       | Vertical depth — 40 levels of recursion. ~43 spans.                                                                     | One `level-1` root nesting 40 deep, each level a couple of ms shorter than its parent. Use it to check row layout at depth, label elision when a bar is narrower than its name, and that nesting rules hold all the way down. A shallow two-level `sibling` runs concurrently at depth 1, which — because rows are keyed on tree depth — sits on top of `level-1` rather than beside it.                                     |
| `bun run example:failing`    | Every failure mode: a typed error, a defect, an interruption, and a retry that succeeds on the third attempt. 11 spans. | Five red bars and six normal ones, and `errors 5` in the header. `charge.card` (Fail) reads `PaymentDeclined: card **** 4242 was declined`; `cart.total` (Die) a `TypeError`; `report.generate` (Interrupt) an `InterruptError` after a 60ms timeout; `fetch.attempt-1` and `-2` red with `fetch.attempt-3` normal next to them. The program itself succeeds — errors are caught _after_ the span that recorded them closed. |
| `bun run example:slow`       | Live tailing and reconnect. Runs until you stop it, emitting a root `tick-N` with two children every ~600ms.            | Watch new roots appear at the right edge while the chart stays where you put it. Open spans (a tick mid-flight) should draw open-ended. Then kill the collector (Ctrl-C terminal 1) and start it again: the program keeps running and the session **resumes under the same id**, so the trace continues rather than starting over.                                                                                           |
| `bun run example:firehose`   | Performance. 10,000 spans by default, `bun run example:firehose 50000` for more.                                        | 100 `batch-N` parents with 100 leaves each — very wide, only 3 deep. Pan and zoom should stay smooth. Takes ~2.5s to emit and deliver; it paces itself on purpose (see below).                                                                                                                                                                                                                                               |

## Notes

- **The collector must be running**, but nothing breaks if it is not: the layer
  is a deliberate no-op when it cannot connect, so each example prints a warning
  telling you how to start one and then runs normally, untraced.
- **`firehose` paces itself.** The client's outbound queue holds 8192 messages
  and shutdown waits at most 250ms to flush it, so emitting 20k messages
  flat-out delivers about 85% of them. The example sleeps ~12ms between batches
  and settles for a second at the end. If you want to _see_ the loss behaviour
  instead, drop those sleeps — the gap surfaces in the trace as a `Warn` log.
- `examples/run.ts` is the shared entry point: it probes the collector, prints
  the hint, and provides the layer. It is not itself an example.

## Instrumenting your own program

```ts
import { Effect } from 'effect'
import { Inspect } from 'effect-inspect'

program.pipe(Effect.provide(Inspect.layer()))
```
