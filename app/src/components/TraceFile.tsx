/**
 * Saving the selected trace to a file, and loading one back.
 *
 * Drop target is the whole window rather than a zone in the layout: when the
 * collector is down there is no chart to drop onto, and "drop a trace anywhere
 * on the page" is the behaviour every profiler has.
 */
import { RegistryContext, useAtomValue } from '@effect/atom-react'
import { Result } from 'effect'
import { useContext, useEffect, useRef, useState } from 'react'
import {
  addLoadedTrace,
  loadedSessionsAtom,
  saveableMessages,
  selectedSessionAtom,
  traceStatsAtom,
  type Registry,
} from '../state/atoms.ts'
import { serializeTraceFile, traceFileExtension, traceFileName } from '../trace/TraceFile.ts'

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
      <div className="flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={save}
          disabled={session === undefined || stats.spans === 0}
          data-testid="save-trace"
          className="text-neutral-500 transition-colors hover:text-neutral-200 disabled:cursor-not-allowed disabled:text-neutral-700"
        >
          save
        </button>
        <button
          type="button"
          onClick={() => input.current?.click()}
          data-testid="open-trace"
          className="text-neutral-500 transition-colors hover:text-neutral-200"
        >
          open
        </button>
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
          className="absolute inset-x-0 top-11 z-20 mx-auto w-fit max-w-xl rounded border border-red-900 bg-neutral-950 px-3 py-2 text-xs text-red-300"
        >
          {error}
          <button
            type="button"
            onClick={() => setError(undefined)}
            className="ml-3 text-neutral-600 hover:text-neutral-300"
          >
            dismiss
          </button>
        </div>
      )}

      {truncated !== undefined && error === undefined && (
        <div
          data-testid="trace-file-truncated"
          className="absolute inset-x-0 top-11 z-20 mx-auto w-fit rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-400"
        >
          This trace file was cut short mid-write; everything before the cut is shown.
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-neutral-950/80">
          <p className="rounded border border-dashed border-neutral-700 px-6 py-4 text-xs text-neutral-400">
            Drop a {traceFileExtension} file to load it
          </p>
        </div>
      )}
    </>
  )
}
