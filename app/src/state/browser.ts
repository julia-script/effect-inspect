import { Clock, Effect, Queue, Result, Schema, Stream } from 'effect'
import { Command, Mount, Subscription } from 'foldkit'
import { afterCommit } from 'foldkit/render'
import { Session } from '../../../src/protocol/Schema.ts'
import { webappCodec, webappRequestCodec } from '../../../src/protocol/Codec.ts'
import {
  isLoadedSession,
  loadedSession,
  parseTraceFile,
  serializeTraceFile,
  traceFileName,
} from '../trace/TraceFile.ts'
import { FlameRenderer } from '../chart/Renderer.ts'
import { eventRows } from '../components/data.ts'
import { firstSpan, isTypingTarget, step, type Direction } from '../chart/navigate.ts'
import { Message } from './message.ts'
import {
  initialModel,
  Selection,
  type Model,
  Model as ModelSchema,
  Theme,
  Panels,
} from './model.ts'
import { COLLECTOR_URL, loadedMessages, traceStore } from './trace.ts'

export const THEME_STORAGE_KEY = 'effect-inspect:theme'
export const PANELS_STORAGE_KEY = 'effect-inspect:panels'
let socket: WebSocket | undefined
let subscribed: string | undefined
let renderer: FlameRenderer | undefined

const send = (tag: 'Subscribe' | 'Unsubscribe', sessionId: string) => {
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(webappRequestCodec.encode({ _tag: tag, sessionId }))
}

export const SwitchTrace = Command.define('SwitchTrace', {
  args: { sessionId: Schema.UndefinedOr(Schema.String) },
  messages: [Message.SampledTrace],
  execute: ({ sessionId }) =>
    Effect.sync(() => {
      if (subscribed !== undefined && !isLoadedSession(subscribed)) send('Unsubscribe', subscribed)
      subscribed = sessionId
      traceStore.clear()
      if (sessionId !== undefined) {
        if (isLoadedSession(sessionId))
          traceStore.applyAll(loadedMessages.get(sessionId)?.messages ?? [])
        else send('Subscribe', sessionId)
      }
      renderer?.resetView()
      return Message.SampledTrace({ sessionId, version: traceStore.version })
    }),
})

export const ReflectSelection = Command.define('ReflectSelection', {
  args: Selection.fields,
  messages: [Message.CompletedBrowserAction],
  execute: (selection) =>
    Effect.sync(() => {
      renderer?.updateSelection(selection)
      return Message.CompletedBrowserAction()
    }),
})

export const ApplyPreferences = Command.define('ApplyPreferences', {
  args: { theme: Theme, panels: Panels, resolvedTheme: Schema.Literals(['light', 'dark']) },
  messages: [Message.AppliedPreferences],
  execute: ({ theme, panels, resolvedTheme }) =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Panels))(panels).pipe(
        Effect.orDie,
      )
      return yield* Effect.sync(() => {
        const root = document.documentElement
        root.classList.add('theme-switching')
        root.classList.toggle('dark', resolvedTheme === 'dark')
        root.style.colorScheme = resolvedTheme
        requestAnimationFrame(() => root.classList.remove('theme-switching'))
        try {
          localStorage.setItem(THEME_STORAGE_KEY, theme)
          localStorage.setItem(PANELS_STORAGE_KEY, encoded)
        } catch {
          /* Storage may be unavailable; preferences still apply. */
        }
        return Message.AppliedPreferences()
      })
    }),
})

export const ReadPreferences = Command.define('ReadPreferences', {
  messages: [Message.GotPreferences],
  execute: Effect.sync(() => {
    let theme: typeof Theme.Type = 'dark'
    let panels = initialModel.panels
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY)
      if (stored === 'light' || stored === 'dark' || stored === 'system') theme = stored
      const parsed: unknown = Result.getOrUndefined(
        Schema.decodeResult(Schema.fromJsonString(Schema.Unknown))(
          localStorage.getItem(PANELS_STORAGE_KEY) ?? 'null',
        ),
      )
      if (typeof parsed === 'object' && parsed !== null) {
        const value = parsed as Record<string, unknown>
        panels = { sessions: value.sessions === true, detail: value.detail === true }
      }
    } catch {
      /* Use defaults for corrupt or unavailable storage. */
    }
    return Message.GotPreferences({
      theme,
      panels,
      systemDark: matchMedia('(prefers-color-scheme: dark)').matches,
    })
  }),
})

export const ReadTrace = Command.define('ReadTrace', {
  args: { file: Schema.instanceOf(File), readId: Schema.Finite },
  messages: [Message.LoadedTrace, Message.FailedReadTrace],
  execute: ({ file, readId }) =>
    Effect.tryPromise({
      try: () => file.text(),
      catch: (cause) => `Could not read ${file.name}: ${String(cause)}`,
    }).pipe(
      Effect.map((text) => {
        const parsed = parseTraceFile(text)
        if (Result.isFailure(parsed))
          return Message.FailedReadTrace({ error: parsed.failure.message, readId })
        const { header, messages, truncatedLines } = parsed.success
        const session = loadedSession(header)
        const existing = loadedMessages.get(session.sessionId)
        if (existing === undefined || readId > existing.readId)
          loadedMessages.set(session.sessionId, { messages, readId })
        return Message.LoadedTrace({ entry: { session, truncatedLines }, readId })
      }),
      Effect.catch((error) => Effect.succeed(Message.FailedReadTrace({ error, readId }))),
    ),
})

export const OpenTracePicker = Command.define('OpenTracePicker', {
  messages: [Message.CompletedBrowserAction],
  execute: Effect.sync(() => {
    document.querySelector<HTMLInputElement>('[data-testid="trace-file-input"]')?.click()
    return Message.CompletedBrowserAction()
  }),
})

export const SaveTrace = Command.define('SaveTrace', {
  args: { session: Session },
  messages: [Message.CompletedBrowserAction],
  execute: ({ session }) =>
    Effect.gen(function* () {
      const savedAt = yield* Clock.currentTimeMillis
      const url = yield* Effect.sync(() => {
        const messages = loadedMessages.get(session.sessionId)?.messages ?? traceStore.raw
        const text = serializeTraceFile(session, messages, savedAt)
        const objectUrl = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }))
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        anchor.download = traceFileName(session, savedAt)
        anchor.click()
        return objectUrl
      })
      yield* Effect.sleep('1 second')
      yield* Effect.sync(() => URL.revokeObjectURL(url))
      return Message.CompletedBrowserAction()
    }),
})

export const NavigateChart = Command.define('NavigateChart', {
  args: { key: Schema.String, selectedSpanId: Schema.UndefinedOr(Schema.String) },
  messages: [Message.CompletedNavigation],
  execute: ({ key, selectedSpanId }) =>
    Effect.sync(() => {
      const directions: Record<string, Direction> = {
        ArrowUp: 'parent',
        ArrowDown: 'child',
        ArrowLeft: 'previous',
        ArrowRight: 'next',
      }
      const direction = directions[key]
      let next = selectedSpanId
      if (direction !== undefined) {
        next =
          selectedSpanId === undefined
            ? firstSpan(traceStore)
            : step(traceStore, selectedSpanId, direction)
        if (next === undefined) next = selectedSpanId
        if (next !== undefined) renderer?.revealSpan(next)
      } else {
        switch (key.toLowerCase()) {
          case 'w':
            renderer?.zoomBy(1 / 1.25)
            break
          case 's':
            renderer?.zoomBy(1.25)
            break
          case 'a':
            renderer?.panBy(-0.12)
            break
          case 'd':
            renderer?.panBy(0.12)
            break
          case 'q':
            renderer?.scrollRows(-32)
            break
          case 'e':
            renderer?.scrollRows(32)
            break
          case '0':
            renderer?.resetView()
            break
          case 'enter':
            next ??= firstSpan(traceStore)
            if (next !== undefined) renderer?.revealSpan(next)
            break
        }
      }
      return Message.CompletedNavigation({ spanId: next })
    }),
})

export const RevealSpan = Command.define('RevealSpan', {
  args: { spanId: Schema.String },
  messages: [Message.CompletedBrowserAction],
  execute: ({ spanId }) =>
    Effect.sync(() => {
      renderer?.revealSpan(spanId)
      return Message.CompletedBrowserAction()
    }),
})

export const ScrollLog = Command.define('ScrollLog', {
  args: {
    spanId: Schema.UndefinedOr(Schema.String),
    top: Schema.Finite,
    traceVersion: Schema.Finite,
    filter: Schema.String,
    filterHides: Schema.Boolean,
    logSort: ModelSchema.fields.logSort,
  },
  messages: [Message.ScrolledLog],
  execute: ({ spanId, top, ...input }) =>
    afterCommit.pipe(
      Effect.andThen(
        Effect.sync(() => {
          const element = document.getElementById('event-log-scroll')
          if (element === null) return Message.ScrolledLog({ top })
          let next = top
          if (spanId !== undefined) {
            next = element.scrollTop
            const index = eventRows(input).findIndex((row) => row.span.spanId === spanId)
            const rowTop = index * 22
            if (index !== -1 && (rowTop < next || rowTop + 22 > next + element.clientHeight))
              next = Math.max(rowTop - element.clientHeight / 2, 0)
          }
          element.scrollTop = next
          return Message.ScrolledLog({ top: element.scrollTop })
        }),
      ),
    ),
})

/** Socket lifetime belongs to the runtime. Span bursts bypass the Model and emit one sampled version. */
const collector = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let retry: ReturnType<typeof setTimeout> | undefined
      let frame: number | undefined
      let attempt = 0
      let closed = false
      const emit = (message: Message) => Queue.offerUnsafe(queue, message)
      const repaint = () => {
        if (frame !== undefined) return
        frame = requestAnimationFrame(() => {
          frame = undefined
          emit(Message.SampledTrace({ sessionId: subscribed, version: traceStore.version }))
        })
      }
      const connect = () => {
        if (closed) return
        emit(Message.GotConnection({ connection: { _tag: 'Connecting' } }))
        const ws = new WebSocket(COLLECTOR_URL)
        socket = ws
        ws.onopen = () => {
          attempt = 0
          emit(Message.GotConnection({ connection: { _tag: 'Connected' } }))
        }
        ws.onmessage = (event) => {
          if (closed || typeof event.data !== 'string') return
          const decoded = webappCodec.decodeAll(event.data)
          if (Result.isFailure(decoded)) {
            emit(Message.GotDecodeError())
            return
          }
          for (const message of decoded.success) {
            switch (message._tag) {
              case 'SessionList':
                emit(Message.GotSessions({ sessions: message.sessions }))
                break
              case 'Backlog':
                if (message.sessionId === subscribed) {
                  traceStore.applyAll(message.messages)
                  repaint()
                }
                break
              case 'Live':
                if (message.message.sessionId === subscribed) {
                  traceStore.apply(message.message)
                  repaint()
                }
                break
              case 'SessionEnded':
                break
            }
          }
        }
        ws.onerror = () => {}
        ws.onclose = () => {
          if (closed) return
          socket = undefined
          emit(Message.GotConnection({ connection: { _tag: 'Disconnected', attempt } }))
          retry = setTimeout(connect, Math.min(1000 * 2 ** attempt, 10_000))
          attempt++
        }
      }
      connect()
      return () => {
        closed = true
        if (retry !== undefined) clearTimeout(retry)
        if (frame !== undefined) cancelAnimationFrame(frame)
        socket?.close()
        socket = undefined
        subscribed = undefined
        loadedMessages.clear()
      }
    }),
    (cleanup) => Effect.sync(cleanup),
  ),
)

const browserEvents = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const emit = (message: Message) => Queue.offerUnsafe(queue, message)
      const keyboard = (event: KeyboardEvent) => {
        if (
          event.defaultPrevented ||
          isTypingTarget(event.target) ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey
        )
          return
        if (
          ![
            'w',
            's',
            'a',
            'd',
            'q',
            'e',
            '0',
            'Enter',
            'Escape',
            '?',
            'ArrowUp',
            'ArrowDown',
            'ArrowLeft',
            'ArrowRight',
          ].includes(event.key.toLowerCase()) &&
          !['Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(
            event.key,
          )
        )
          return
        event.preventDefault()
        emit(Message.PressedChartKey({ key: event.key }))
      }
      const over = (event: DragEvent) => {
        if (!event.dataTransfer?.types.includes('Files')) return
        event.preventDefault()
        emit(Message.ChangedFileDrag({ dragging: true }))
      }
      const leave = (event: DragEvent) => {
        if (event.relatedTarget === null) emit(Message.ChangedFileDrag({ dragging: false }))
      }
      const drop = (event: DragEvent) => {
        const file = event.dataTransfer?.files[0]
        if (file === undefined) return
        event.preventDefault()
        emit(Message.ChangedFileDrag({ dragging: false }))
        emit(Message.ChoseFile({ file }))
      }
      const media = matchMedia('(prefers-color-scheme: dark)')
      const changed = (event: MediaQueryListEvent) =>
        emit(Message.GotSystemTheme({ dark: event.matches }))
      globalThis.addEventListener('keydown', keyboard)
      globalThis.addEventListener('dragover', over)
      globalThis.addEventListener('dragleave', leave)
      globalThis.addEventListener('drop', drop)
      media.addEventListener('change', changed)
      return () => {
        globalThis.removeEventListener('keydown', keyboard)
        globalThis.removeEventListener('dragover', over)
        globalThis.removeEventListener('dragleave', leave)
        globalThis.removeEventListener('drop', drop)
        media.removeEventListener('change', changed)
      }
    }),
    (cleanup) => Effect.sync(cleanup),
  ),
)

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  startup: Subscription.persistent(Stream.succeed(Message.StartedResources())),
  collector: entry(
    { path: Schema.String },
    {
      modelToDependencies: ({ path }) => ({ path }),
      dependenciesToStream: ({ path }) => (path === '/' ? collector : Stream.empty),
    },
  ),
  browser: Subscription.persistent(browserEvents),
}))

const startSampling = (sample: () => void): (() => void) => {
  const timer = setInterval(sample, 150)
  return () => clearInterval(timer)
}

export const MountChart = Mount.defineStream('MountChart', {
  args: Selection.fields,
  messages: [
    Message.SelectedSpan,
    Message.HoveredSpan,
    Message.ToggledMemory,
    Message.SampledChart,
  ],
  execute: ({ element, ...selection }) =>
    Stream.callback<
      Extract<Message, { _tag: 'SelectedSpan' | 'HoveredSpan' | 'ToggledMemory' | 'SampledChart' }>
    >((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const canvas = element as HTMLCanvasElement
          const emit = (
            message: Extract<
              Message,
              { _tag: 'SelectedSpan' | 'HoveredSpan' | 'ToggledMemory' | 'SampledChart' }
            >,
          ) => Queue.offerUnsafe(queue, message)
          const sample = () => {
            const hit = instance.hovered()
            emit(
              Message.SampledChart({
                viewport: instance.viewport(),
                tooltip:
                  hit === undefined
                    ? undefined
                    : { spanId: hit.span.spanId, x: hit.x, y: hit.y, width: canvas.clientWidth },
              }),
            )
          }
          const instance = new FlameRenderer(
            canvas,
            selection,
            (spanId) => emit(Message.SelectedSpan({ spanId, reveal: false })),
            (spanId) => {
              emit(Message.HoveredSpan({ spanId }))
              sample()
            },
            () => emit(Message.ToggledMemory()),
          )
          renderer = instance
          const stopSampling = startSampling(sample)
          if (import.meta.env.DEV)
            Object.assign(globalThis, { __flameChart: instance, __traceStore: traceStore })
          return () => {
            stopSampling()
            instance.dispose()
            if (renderer === instance) renderer = undefined
            if (import.meta.env.DEV)
              Object.assign(globalThis, { __flameChart: undefined, __traceStore: undefined })
          }
        }),
        (cleanup) => Effect.sync(cleanup),
      ),
    ),
})

export const MeasureLog = Mount.defineStream('MeasureLog', {
  messages: [Message.MeasuredLog],
  execute: ({ element }) =>
    Stream.callback<ReturnType<typeof Message.MeasuredLog>>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const observer = new ResizeObserver(([entry]) =>
            Queue.offerUnsafe(
              queue,
              Message.MeasuredLog({ height: entry?.contentRect.height ?? 0 }),
            ),
          )
          observer.observe(element)
          return observer
        }),
        (observer) => Effect.sync(() => observer.disconnect()),
      ),
    ),
})

export const ResizeDrawer = Mount.defineStream('ResizeDrawer', {
  messages: [Message.ResizedDrawer],
  execute: ({ element }) =>
    Stream.callback<ReturnType<typeof Message.ResizedDrawer>>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          let start: { y: number; height: number } | undefined
          const down = (event: PointerEvent) => {
            if (event.target !== element || event.button !== 0) return
            start = { y: event.clientY, height: element.parentElement?.clientHeight ?? 220 }
            element.setPointerCapture(event.pointerId)
          }
          const move = (event: PointerEvent) => {
            if (start === undefined) return
            Queue.offerUnsafe(
              queue,
              Message.ResizedDrawer({
                height: Math.min(Math.max(start.height - (event.clientY - start.y), 80), 600),
              }),
            )
          }
          const up = () => {
            start = undefined
          }
          element.addEventListener('pointerdown', down as EventListener)
          globalThis.addEventListener('pointermove', move)
          globalThis.addEventListener('pointerup', up)
          globalThis.addEventListener('pointercancel', up)
          return () => {
            element.removeEventListener('pointerdown', down as EventListener)
            globalThis.removeEventListener('pointermove', move)
            globalThis.removeEventListener('pointerup', up)
            globalThis.removeEventListener('pointercancel', up)
          }
        }),
        (cleanup) => Effect.sync(cleanup),
      ),
    ),
})

export const FocusHelp = Mount.define('FocusHelp', {
  messages: [Message.CompletedBrowserAction],
  execute: ({ element }) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = document.activeElement
          const button = element.querySelector<HTMLButtonElement>('button')
          button?.focus()
          const trap = (event: KeyboardEvent) => {
            if (event.key !== 'Tab') return
            event.preventDefault()
            button?.focus()
          }
          globalThis.addEventListener('keydown', trap, true)
          return () => {
            globalThis.removeEventListener('keydown', trap, true)
            if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
          }
        }),
        (cleanup) => Effect.sync(cleanup),
      )
      return Message.CompletedBrowserAction()
    }),
})
