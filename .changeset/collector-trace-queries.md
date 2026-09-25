---
'effect-inspect': minor
---

The collector now answers read-only trace queries over HTTP on its port (`POST /api/v1/query`, `GET /api/v1/export?sessionId=ID`): session discovery, a run summary, filtered spans, one span with its ancestry, children and events, and correlated logs. Answers are bounded JSON that name the exact session and time reference, report recorded loss or unknown completeness, and refuse a session whose ID another run reused. Saved traces answer the same queries offline, and an exported trace keeps the collector's loss counters in an optional header field that older builds ignore.
