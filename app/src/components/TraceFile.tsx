/**
 * Saving the selected trace to a file, and loading one back.
 *
 * Drop target is the whole window rather than a zone in the layout: when the
 * collector is down there is no chart to drop onto, and "drop a trace anywhere
 * on the page" is the behaviour every profiler has.
 */
import { RegistryContext, useAtomValue } from '@effect/atom-react'
import { Result } from 'effect'
import { type CSSProperties, useContext, useEffect, useRef, useState } from 'react'
import {
  addLoadedTrace,
  loadedSessionsAtom,
  saveableMessages,
  selectedSessionAtom,
  traceStatsAtom,
  type Registry,
} from '../state/atoms.ts'
import { Button } from './atoms/Button.tsx'
import { serializeTraceFile, traceFileExtension, traceFileName } from '../trace/TraceFile.ts'

/**
 * The shared surface for both header notices.
 *
 * The error and the truncation warning sit in the same place and say the same
 * kind of thing — "the file you opened is not what you expected" — so they get
 * one treatment and differ only by tone, the same red/orange split the stats
 * row and connection badge use.
 */
const NOTICE =
  'absolute inset-x-0 top-11 z-20 mx-auto flex w-fit max-w-xl items-baseline gap-3 rounded-card bg-surface px-3 py-2 text-xs shadow-overlay'

/**
 * A notice's tone wash, as a flat `background-image` over {@link NOTICE}'s
 * opaque `bg-surface`.
 *
 * Foundation's `-tint` tokens are *translucent* in dark (`… / 0.14`), so
 * setting one as the notice's `background-color` lets the toolbar behind it
 * read straight through. Painting it as a one-stop gradient layers the tone on
 * top of an opaque surface instead, which is what a floating panel needs.
 */
const tintWash = (tone: 'red' | 'orange'): CSSProperties => ({
  backgroundImage: `linear-gradient(var(--${tone}-tint), var(--${tone}-tint))`,
})

/** Hands the text to the browser as a download. */
const download = (name: string, text: string): void => {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

export const TraceFileControls = () => {
  const registry: Registry = useContext(RegistryContext)
  const session = useAtomValue(selectedSessionAtom)
  const stats = useAtomValue(traceStatsAtom)
  const loaded = useAtomValue(loadedSessionsAtom)
  const [error, setError] = useState<string | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const open = (file: File): void => {
    setError(undefined)
    file
      .text()
      .then((text) => {
        const result = addLoadedTrace(registry, text)
        if (Result.isFailure(result)) setError(result.failure)
      })
      .catch((cause: unknown) => setError(`Could not read ${file.name}: ${String(cause)}`))
  }

  // Window-level drop, so a trace can be opened with no collector and no chart.
  useEffect(() => {
    const over = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files') !== true) return
      event.preventDefault()
      setDragging(true)
    }
    const leave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragging(false)
    }
    const drop = (event: DragEvent) => {
      const file = event.dataTransfer?.files[0]
      if (file === undefined) return
      event.preventDefault()
      setDragging(false)
      open(file)
    }
    globalThis.addEventListener('dragover', over)
    globalThis.addEventListener('dragleave', leave)
    globalThis.addEventListener('drop', drop)
    return () => {
      globalThis.removeEventListener('dragover', over)
      globalThis.removeEventListener('dragleave', leave)
      globalThis.removeEventListener('drop', drop)
    }
  })

  const save = (): void => {
    if (session === undefined) return
    const savedAt = Date.now()
    const text = serializeTraceFile(session, saveableMessages(registry, session.sessionId), savedAt)
    download(traceFileName(session, savedAt), text)
  }

  const truncated = loaded.find(
    (entry) => entry.session.sessionId === session?.sessionId && entry.truncatedLines > 0,
  )

  return (
    <>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          onClick={save}
          disabled={session === undefined || stats.spans === 0}
          data-testid="save-trace"
        >
          save
        </Button>
        <Button
          type="button"
          size="xs"
          onClick={() => input.current?.click()}
          data-testid="open-trace"
        >
          open
        </Button>
        <input
          ref={input}
          type="file"
          accept={traceFileExtension}
          data-testid="trace-file-input"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file !== undefined) open(file)
            event.target.value = ''
          }}
        />
      </div>

      {error !== undefined && (
        <div
          data-testid="trace-file-error"
          className={`${NOTICE} text-red`}
          style={tintWash('red')}
        >
          {error}
          <button
            type="button"
            onClick={() => setError(undefined)}
            className="shrink-0 text-ink-2 transition-colors hover:text-ink"
          >
            dismiss
          </button>
        </div>
      )}

      {truncated !== undefined && error === undefined && (
        <div
          data-testid="trace-file-truncated"
          className={`${NOTICE} text-orange`}
          style={tintWash('orange')}
        >
          This trace file was cut short mid-write; everything before the cut is shown.
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-page/80">
          <p className="rounded-card border border-dashed border-line-strong bg-surface px-6 py-4 text-xs text-ink-2 shadow-overlay">
            Drop a {traceFileExtension} file to load it
          </p>
        </div>
      )}
    </>
  )
}
