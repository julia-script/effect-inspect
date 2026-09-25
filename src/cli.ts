#!/usr/bin/env node
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
// NodeHttpServer needs a native server constructor to own the HTTP and upgrade listeners.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { Effect, Exit, Layer, Runtime, Schema } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import * as Stdio from 'effect/Stdio'
import { CliConfig, Command, GlobalFlag } from 'effect/unstable/cli'
import { queryCommands, runCli } from './cli/QueryCommands.ts'
import { collectorConfig, defaultPort } from './collector/Config.ts'
import { run } from './collector/Server.ts'
import { defaultCapacity, layer as storeLayer } from './collector/Store.ts'
import { loadWebApp } from './collector/WebApp.ts'

/** Indents continuation lines under the help formatter's DESCRIPTION heading. */
const text = (body: string) => body.trim().split('\n').join('\n  ')

const start = Command.make('start', {}, () =>
  Effect.gen(function* () {
    const { capacity, port } = yield* collectorConfig
    const fetch = yield* loadWebApp
    yield* Effect.logInfo(`effect-inspect listening at http://localhost:${port}`)
    return yield* Effect.provide(
      run(fetch),
      Layer.mergeAll(storeLayer({ capacity }), NodeHttpServer.layer(createServer, { port })),
    )
  }),
).pipe(
  Command.withShortDescription(
    'Start the collector and web UI (configured by EFFECT_INSPECT_PORT and EFFECT_INSPECT_CAPACITY)',
  ),
  Command.withDescription(
    text(`
Start the collector and web UI (configured by EFFECT_INSPECT_PORT and EFFECT_INSPECT_CAPACITY).

The collector receives telemetry from programs instrumented with Inspect.layer(),
keeps it in memory per session, serves the web UI at http://localhost:PORT/ and
answers the query commands (summary, spans, span, logs, export, sessions) on the same
port. It runs in the foreground until stopped (Ctrl-C or SIGTERM); stopping it drops
every trace it held, so \`export\` the sessions you want to keep first. Leave it
running in its own terminal or as a background process while you query.

ENVIRONMENT
  EFFECT_INSPECT_PORT      Port to listen on (default ${defaultPort}). Query commands read
                           the same variable to find the collector unless --url is given.
  EFFECT_INSPECT_CAPACITY  Messages retained per session (default ${defaultCapacity}); older ones
                           are evicted and reported as completeness.collectorDroppedMessages.

CONNECTING PROGRAMS
  Programs connect to ws://localhost:${defaultPort} by default. Inspect.layer() does not read
  EFFECT_INSPECT_PORT: on another port pass Inspect.layer({ url: "ws://localhost:PORT" }).
  (The examples in the effect-inspect repository do follow EFFECT_INSPECT_PORT.)
  If no collector is listening, instrumented programs run normally but record nothing.

OUTPUT AND EXIT
  Logs "effect-inspect listening at http://localhost:PORT" on stdout once ready.
  Exits 1 if the port is taken or the configuration is invalid; 130 on Ctrl-C.
`),
  ),
  Command.withExamples([
    { command: 'effect-inspect start', description: 'Collector and UI on the default port' },
    {
      command: 'EFFECT_INSPECT_PORT=34500 effect-inspect start',
      description: 'On another port; query it with EFFECT_INSPECT_PORT=34500 or --url',
    },
  ]),
)

const rootHelp = text(`
Inspect Effect programs: record their spans, span events, logs and memory samples,
and query one exact run as JSON, live from a collector or offline from a saved
.eitrace file. Written for coding agents: every query command prints one JSON
document on stdout, diagnostics on stderr, and a distinct exit code per outcome.
In this help, effect-inspect means however you run this CLI (npx effect-inspect,
or node dist/cli.js in a built checkout of the repository).

WHAT MUST BE TRUE
  1. The program is instrumented: it provides Inspect.layer() from the effect-inspect
     package (program.pipe(Effect.provide(Inspect.layer()))). Only Effect spans
     (Effect.withSpan), span annotations/events, Effect logs and memory samples are
     recorded. Nothing here instruments code for you, and no environment variable does.
  2. For live queries a collector is running (\`effect-inspect start\`, leave it running)
     and the program reaches it (ws://localhost:${defaultPort} by default). The collector
     keeps sessions in memory until it stops, so a finished run can still be queried.
  3. For offline queries you only need a .eitrace file (\`export\`); no collector.

CHOOSE THE SESSION ID BEFORE LAUNCH
  EFFECT_INSPECT_SESSION_ID=my-run-001 <command that runs the instrumented program>
  then query exactly that run with --session my-run-001; no need to list sessions.
  IDs: 1-128 ASCII letters, digits, ".", "_" or "-", starting with a letter or digit.
  Use a new ID for every run, retry and instrumented child process. The program's
  Inspect.layer({ sessionId }) option overrides the variable; with neither, the run
  gets a random UUID (find it with \`sessions\`). An invalid or set-but-empty value
  disables recording with a warning in the program's own logs; the program still
  runs. A second run announcing an ID the collector holds is refused, the first run's
  data is kept, and queries for that ID fail with SessionConflict instead of mixing.

INVESTIGATION STEPS
  1. summary --session ID                counts, failures, longest spans, completeness
  2. spans   --session ID --status failed  find spans; --sort duration|outsideChildren
  3. span    --session ID --span SPAN_ID   error, stack, attributes, ancestry, children
  4. logs    --session ID --span SPAN_ID   logs in a span's subtree, or --from-ms/--to-ms
  5. export  --session ID --out FILE       save the run; repeat 1-4 with --file FILE
  sessions   lists sessions, only when you do not know the ID.

SOURCES (every per-session query needs exactly one)
  --session ID   live: the collector at --url, else http://localhost:$EFFECT_INSPECT_PORT,
                 else http://localhost:${defaultPort}. Exact match; the newest session is never
                 assumed and an unknown ID is SessionNotFound, never another run.
  --file PATH    offline: a saved .eitrace; adding --session asserts the file's ID.

OUTPUT AND EXIT CODES (all query commands)
  stdout: one JSON document, pretty-printed; --json prints it compact on one line.
    Success {"ok":true,"apiVersion":1,"op",...,"result"}; failure {"ok":false,
    "apiVersion":1,"op","error":{"_tag","message","hint",...}}. The whole stdout,
    newline included, is at most 1048576 bytes in either mode; pretty output is
    larger, so a page that only fits compact gives ResponseTooLarge: add --json.
  stderr: empty on success; a one-line diagnostic and a hint on failure.
  0 ok (empty results too: result.total 0)   1 internal error
  2 InvalidRequest          3 SessionNotFound         4 SpanNotFound
  5 SessionConflict         6 ResponseTooLarge        7 TraceFileError
  8 CollectorUnavailable    9 CollectorError          10 OutputError (export)
  Each command's --help explains its errors and what to do next.

EVIDENCE AND TIMING
  Times are milliseconds since the session's clock origin (when its inspect client
  started) and can be negative. durationMs is elapsed wall time; outsideChildrenMs is
  elapsed time not covered by recorded child spans. Neither is CPU time or a verdict
  that something is slow, and an open span (no end recorded) is not a deadlock.
  Before concluding that something did not happen, read "completeness": lossRecorded
  means evidence is missing, and noLossRecorded is not proof of completeness.

Run \`effect-inspect <command> --help\` for the full flags, defaults, JSON fields and
errors of each command.
`)

const cli = Command.make('effect-inspect').pipe(
  Command.withDescription(rootHelp),
  Command.withSubcommands([start, ...queryCommands]),
  Command.withExamples([
    {
      command: 'effect-inspect start',
      description: 'Terminal 1: start the collector and leave it running',
    },
    {
      command: 'EFFECT_INSPECT_SESSION_ID=failing-run-001 bun examples/failing.ts',
      description:
        'Terminal 2: run an instrumented program under a chosen ID (a repository example)',
    },
    {
      command: 'effect-inspect summary --session failing-run-001 --json',
      description: 'Overview of exactly that run',
    },
    {
      command: 'effect-inspect spans --session failing-run-001 --status failed --json',
      description: 'Its failed spans; copy a spanId and its parentSpanId',
    },
    { command: 'effect-inspect span --session failing-run-001 --span SPAN_ID --json' },
    { command: 'effect-inspect logs --session failing-run-001 --span PARENT_SPAN_ID --json' },
    {
      command:
        'effect-inspect export --session failing-run-001 --out failing-run-001.eitrace --json',
      description: 'Save it, then query the file with no collector',
    },
    { command: 'effect-inspect summary --file failing-run-001.eitrace --json' },
    { command: 'effect-inspect spans --file failing-run-001.eitrace --status failed --json' },
  ]),
)

const main = Effect.gen(function* () {
  const fs = yield* FileSystem
  const packageJson = yield* fs.readFileString(
    fileURLToPath(new URL('../package.json', import.meta.url)),
  )
  const { version } = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
  )(packageJson)
  const args = yield* (yield* Stdio.Stdio).args
  return yield* runCli(cli, version, args)
})

NodeRuntime.runMain(
  main.pipe(
    Effect.scoped,
    // No interactive wizard: agents drive this CLI without a terminal.
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        CliConfig.layer({
          builtIns: [
            GlobalFlag.Help,
            GlobalFlag.Version,
            GlobalFlag.Completions,
            GlobalFlag.LogLevel,
          ],
        }),
      ),
    ),
  ),
  {
    // `main` succeeds with the exit code; failures keep the default mapping.
    teardown: (exit, onExit) =>
      Exit.isSuccess(exit) && typeof exit.value === 'number'
        ? onExit(exit.value)
        : Runtime.defaultTeardown(exit, onExit),
  },
)
