---
'effect-inspect': patch
---

Root `--help` gains a JSON SHAPE section: the top-level keys of a query response, a reminder that context keys (`completeness`, `termination`, ...) are siblings of `result`, and the most-used key paths. Each per-session command's help points to its field lists and says to read `summary`'s `notices` first.
