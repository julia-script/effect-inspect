# effect-inspect

## 0.2.0

### Minor Changes

- 27fffee: Let a launcher choose the session ID before starting an instrumented program, through the `sessionId` layer option or the `EFFECT_INSPECT_SESSION_ID` environment variable; a random UUID remains the default. The ID survives reconnects, while a different run reusing an ID the collector already holds is refused and counted as a conflict instead of being merged into the original trace. Collision refusal needs the updated collector; older collectors still merge runs that reuse an ID.
- 1a9a75e: The collector now answers read-only trace queries over HTTP on its port (`POST /api/v1/query`, `GET /api/v1/export?sessionId=ID`): session discovery, a run summary, filtered spans, one span with its ancestry, children and events, and correlated logs. Answers are bounded JSON that name the exact session and time reference, report recorded loss or unknown completeness, and refuse a session whose ID another run reused. Saved traces answer the same queries offline, and an exported trace keeps the collector's loss counters in an optional header field that older builds ignore.
- a2aba7c: New query commands for coding agents: `summary`, `spans`, `span`, `logs`, `export` and `sessions`. Launch an instrumented program with `EFFECT_INSPECT_SESSION_ID=my-run-001`, then query exactly that run with `--session my-run-001`, or a saved trace with `--file PATH` and no collector. Each command prints one bounded JSON document on stdout (`--json` for one compact line), a diagnostic on stderr on failure, and a distinct exit code per outcome. `export` writes a lossless `.eitrace` without overwriting an existing file unless `--force`. Root and per-command `--help` document the workflow, flags, JSON fields, errors and exit codes. The interactive `--wizard` global flag is no longer offered.

## 0.1.1

### Patch Changes

- 6021ae4: Fix spans rendering as never-ending in the flame chart.

  Under a burst of activity the client silently discarded telemetry: its outbound buffer evicted the oldest queued messages to make room for new ones, so the `SpanEnd` of long-lived spans could be thrown away while their children survived. Those spans then drew as bars extending to `now`, forever. The session's clock anchor could be lost the same way, leaving the trace with no wall-clock start time.

  The client now sends batched WebSocket frames instead of one frame per message, and its buffer refuses new messages when full rather than evicting already-recorded history. The default buffer also grew from 8,192 to 131,072 messages (~34 MB), which is enough headroom that realistic bursts no longer overflow at all — configurable via `bufferSize`. If the buffer ever does fill, the loss is now the newest messages rather than a hole punched in the middle of the trace.
