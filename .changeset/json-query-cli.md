---
'effect-inspect': minor
---

New query commands for coding agents: `summary`, `spans`, `span`, `logs`, `export` and `sessions`. Launch an instrumented program with `EFFECT_INSPECT_SESSION_ID=my-run-001`, then query exactly that run with `--session my-run-001`, or a saved trace with `--file PATH` and no collector. Each command prints one bounded JSON document on stdout (`--json` for one compact line), a diagnostic on stderr on failure, and a distinct exit code per outcome. `export` writes a lossless `.eitrace` without overwriting an existing file unless `--force`. Root and per-command `--help` document the workflow, flags, JSON fields, errors and exit codes. The interactive `--wizard` global flag is no longer offered.
