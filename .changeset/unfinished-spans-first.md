---
'effect-inspect': minor
---

`summary` now leads with what a crashed or disconnected run left unfinished. A top-level `notices` array states easy-to-miss facts (spans without a recorded end, how the session ended, that `longest` ranks completed spans only, collector eviction). `result.unfinished` lists the innermost open spans — the last recorded position on each open chain — with their open ancestors, before `longest`. Every per-session response gains `termination` (`state` active/ended/unknown, `lastObservedMs`, `endedAtMs`, `unobservedTailMs`). `spans --sort duration|outsideChildren` interleaves open spans by a lower bound instead of listing them last. Additive; `apiVersion` stays 1.
