# effect-inspect

A performance inspector for Effect programs. Add one layer to your app, open
localhost, and watch a live flame chart of its spans, events and logs.

Your program dials out to a long-lived **collector**, and the **webapp** reads
the trace back from it. The collector owns the history, so
restarting your program does not lose the trace.

The collector's history is in memory only, so restarting _the collector_ does
drop every trace it was holding. Save the ones you want to keep — see
[Saving and loading traces](#saving-and-loading-traces).

## Quickstart

Install the package in an Effect project. The `effect-inspect` command runs on
Node.js 22 or newer and does not require Bun. The library import works in a
JavaScript runtime with a global `WebSocket` implementation.

```bash
npm install effect-inspect effect
```

Start the collector and bundled webapp, then open the URL it prints:

```bash
npx effect-inspect start
# effect-inspect listening at http://localhost:34437
```

Run your instrumented program in another terminal. The collector listens for
programs at `ws://localhost:34437/`. Run `npx effect-inspect --help` for
command help or `npx effect-inspect start --help` for start options.

When working from this repository, install its dependencies with `bun install`
and run an example:

```bash
bun run example:webapp
```

Its spans appear in the webapp within a second of being emitted. See
[`examples/README.md`](examples/README.md) for the other five and what each one
is worth looking at.

## Instrumenting your own program

```ts
import { Effect } from 'effect'
import { Inspect } from 'effect-inspect'

const program = Effect.gen(function* () {
  yield* Effect.sleep('50 millis')
}).pipe(Effect.withSpan('my-work'))

Effect.runPromise(program.pipe(Effect.provide(Inspect.layer())))
```

`Inspect.layer()` installs a tracer and a logger, so `Effect.withSpan`,
`Effect.annotateCurrentSpan` and `Effect.log*` all reach the collector. The
logger is merged with your existing ones, so console output is unchanged.

Options, all optional:

```ts
Inspect.layer({
  url: 'ws://localhost:34437', // where the collector listens
  programName: 'my-service', // what the session list shows; defaults to the entry script's file name
  bufferSize: 131072, // outbound queue, in messages (~34 MB at the measured mean)
})
```

## Saving and loading traces

**save** in the header writes the selected session to a `.eitrace` file.
**open** — or dropping a file anywhere on the page — reads one back. A loaded
trace appears in the session list marked `file` and renders exactly like a live
one: chart, event log, filter and detail panel all work, and **no collector
needs to be running at all**.

The file is the protocol message stream itself — one JSON line per message,
with a small header carrying the session's clock — so a saved trace loses
nothing the live view had, and saving a loaded trace again is lossless.

This is also the answer to the collector's in-memory history: a trace you have
saved survives a collector restart, a machine restart, and being emailed to
someone else.

**Adding the layer is safe anywhere.** If no collector is listening, the program
runs exactly as it would have — no hang, no error, no delay. If the collector
goes away mid-run the program keeps going and reconnects in the background,
resuming the same session. If you outrun the socket, the buffer refuses the
newest messages once it is full and reports the gap as a warning in the trace,
rather than pushing backpressure into your fibers — so what you lose is the tail
of a burst, never a span's start or end that already made it into the buffer.

The one consequence: when the collector is down you get silence, not an error.
The examples probe for it first and print a hint — worth copying if you hit
this while demoing.

## Configuration

| Variable                  | Default  | Effect                                 |
| ------------------------- | -------- | -------------------------------------- |
| `EFFECT_INSPECT_PORT`     | `34437`  | Port the collector listens on          |
| `EFFECT_INSPECT_CAPACITY` | `200000` | Messages the collector retains per run |

The collector serves both roles on one port, routed by path: programs dial
`ws://localhost:34437/`, the webapp `ws://localhost:34437/webapp`.

The installed command uses Node.js for its WebSocket server and bundled UI. The
library's `Inspect.layer()` uses the runtime's global `WebSocket`; use
`Inspect.layerWebSocket()` with a supplied Effect WebSocket constructor when
that global is unavailable.

## Development

```bash
bun run check         # format, lint, typecheck — must pass before a commit
bun run check:write   # auto-fix what it can
bun test src app      # unit tests
bun run stub:collector  # fake collector, for working on the webapp alone
bun run dev:app       # webapp dev server on http://localhost:34438
```
