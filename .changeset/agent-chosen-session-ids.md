---
'effect-inspect': minor
---

Let a launcher choose the session ID before starting an instrumented program, through the `sessionId` layer option or the `EFFECT_INSPECT_SESSION_ID` environment variable; a random UUID remains the default. The ID survives reconnects, while a different run reusing an ID the collector already holds is refused and counted as a conflict instead of being merged into the original trace. Collision refusal needs the updated collector; older collectors still merge runs that reuse an ID.
