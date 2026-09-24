# effect-inspect

## 0.1.1

### Patch Changes

- 6021ae4: Fix spans rendering as never-ending in the flame chart.

  Under a burst of activity the client silently discarded telemetry: its outbound buffer evicted the oldest queued messages to make room for new ones, so the `SpanEnd` of long-lived spans could be thrown away while their children survived. Those spans then drew as bars extending to `now`, forever. The session's clock anchor could be lost the same way, leaving the trace with no wall-clock start time.

  The client now sends batched WebSocket frames instead of one frame per message, and its buffer refuses new messages when full rather than evicting already-recorded history. The default buffer also grew from 8,192 to 131,072 messages (~34 MB), which is enough headroom that realistic bursts no longer overflow at all — configurable via `bufferSize`. If the buffer ever does fill, the loss is now the newest messages rather than a hole punched in the middle of the trace.
