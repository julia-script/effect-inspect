---
'effect-inspect': minor
---

`summary.result.memory` places process-wide memory in time: `peakHeapAtMs`, first/last sample times, sampling cadence (`medianIntervalMs`, `maxGapMs` with `maxGapFromMs`/`maxGapToMs`) and `spansActiveAtPeak`, the innermost spans active when the heap peaked. A `memorySamplingGap` notice reports a gap between samples over 10× the median, with possible causes phrased as possibilities. `span` gains `processMemory`: the process-wide samples within the span's interval. Additive; `apiVersion` stays 1.
