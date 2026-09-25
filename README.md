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
  sessionId: 'checkout-before-1', // see "Choosing the session ID"; defaults to a random UUID
  bufferSize: 131072, // outbound queue, in messages (~34 MB at the measured mean)
})
```

### Choosing the session ID

A launcher — you, a script, or a coding agent — can pick the session ID before
starting an already instrumented program, so it can find that exact run later
without searching the session list:

```bash
EFFECT_INSPECT_SESSION_ID=checkout-before-1 bun my-program.ts
```

The `sessionId` option wins over the variable; with neither, a random UUID is
used only when the variable is absent. IDs are 1–128 ASCII letters, digits,
`.`, `_` or `-`, starting with a letter or digit. An invalid ID — including a
variable that is set but empty — is not replaced with another one: the program
runs normally, records nothing, and logs a warning saying why. The same
happens when the runtime has an environment it may not read: under Deno
without env permission the layer checks the permission first (it never asks
for it, so the program is not stopped at a prompt) and disables recording.
Pass the `sessionId` option, or grant access with
`--allow-env=EFFECT_INSPECT_SESSION_ID`, to record there. A runtime with no
environment at all, such as a browser, just uses a random UUID. Setting the variable does not instrument a program by
itself; it still needs `Inspect.layer()`.

**Use one ID per run.** The ID is kept across reconnects, but a _different_
run announcing an ID the collector already holds — even one whose run has
ended — is refused as a collision: its telemetry is discarded, the original
trace is left untouched, and the session records the refused connection in its
`conflicts` count. Give reproduction attempts their own IDs, and remember that
child processes inherit the variable: give each instrumented child a distinct
value, or remove it from the child's environment (`env -u
EFFECT_INSPECT_SESSION_ID …`, or delete the key from the `env` passed to
`spawn`) — setting it to an empty string disables recording instead. IDs
correlate runs; they are not authentication.

Collision refusal needs a collector from this release or later. It tells runs
apart by a per-client instance ID that older clients do not send, so an older
client is treated as one run per ID and reconnects as before. An older
collector ignores the instance ID and merges runs that reuse an ID into one
session.

## Querying runs from the command line

Coding agents (and people) can query a run as JSON instead of opening the web
UI. Pick the session ID before launch, then ask for exactly that run:

```bash
npx effect-inspect start                                   # terminal 1, leave running
EFFECT_INSPECT_SESSION_ID=checkout-fail-001 bun my-program.ts
npx effect-inspect summary --session checkout-fail-001 --json
npx effect-inspect spans   --session checkout-fail-001 --status failed --json
npx effect-inspect span    --session checkout-fail-001 --span SPAN_ID --json
npx effect-inspect logs    --session checkout-fail-001 --span SPAN_ID --json
npx effect-inspect export  --session checkout-fail-001 --out checkout-fail-001.eitrace --json
npx effect-inspect summary --file checkout-fail-001.eitrace --json   # no collector needed
```

Live queries need `--session`; the newest session is never assumed, and an
unknown or reused ID fails with its own error instead of answering for another
run. Every command prints one JSON document on stdout (at most 1 MiB), a
diagnostic on stderr on failure, and a distinct exit code per outcome. The
collector address is `--url`, else `http://localhost:$EFFECT_INSPECT_PORT`,
else port 34437. `npx effect-inspect --help` and `npx effect-inspect <command>
--help` are the full reference: flags, defaults, JSON fields, errors and what
to try next. Durations are observed elapsed time, not CPU time or a slowness
verdict.

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
```
