import { TraceStore } from '../trace/TraceStore.ts'
import type { ClientMessage } from '../../../src/protocol/Schema.ts'

/** Stable resource read directly by the renderer; never a span per UI subscription. */
export const traceStore = new TraceStore()
export const loadedMessages = new Map<
  string,
  { readonly messages: ReadonlyArray<ClientMessage>; readonly readId: number }
>()
export const COLLECTOR_URL =
  import.meta.env.VITE_COLLECTOR_URL ??
  (typeof window === 'undefined'
    ? 'ws://localhost:34437/webapp'
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/webapp`)
