/**
 * The keyboard-shortcut overlay, opened with `?`.
 *
 * Undiscoverable shortcuts may as well not exist, so this is paired with a
 * permanent `? keys` hint in the chart toolbar — the overlay is the detail, the
 * hint is how anyone finds out the overlay is there.
 *
 * Hand-rolled rather than shadcn's `dialog`. Radix would be a new dependency,
 * it portals to `body` (this overlay is positioned inside the chart container,
 * not over the whole app), and its own Escape handling would race
 * `useKeyboard`, which already dismisses innermost-first. What it would give us
 * that matters — the focus trap and focus restore — is the effect below.
 */
import { useEffect, useRef } from 'react'
import { Button } from './atoms/Button.tsx'

const KEYS: ReadonlyArray<readonly [string, string]> = [
  ['W / S', 'zoom in / out around the cursor'],
  ['A / D', 'pan left / right'],
  ['Q / E', 'scroll rows up / down'],
  ['0', 'reset zoom, follow live data'],
  ['← / →', 'previous / next sibling span'],
  ['↑ / ↓', 'parent / first child span'],
  ['Enter', 'reveal the selected span'],
  ['Esc', 'clear the selection'],
  ['?', 'this list'],
]

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]'

export const Shortcuts = ({ onClose }: { readonly onClose: () => void }) => {
  const dialog = useRef<HTMLDivElement>(null)

  /**
   * Move focus in, keep it in, and put it back on close.
   *
   * Escape is deliberately *not* handled here: `useKeyboard` owns it and closes
   * the overlay before clearing the selection, so a second handler would only
   * make the ordering ambiguous.
   */
  useEffect(() => {
    const restoreTo = document.activeElement
    dialog.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const element = dialog.current
      if (element === null) return
      const focusable = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) return
      // Wrap at whichever end we are leaving. Also catches focus that has
      // escaped the dialog entirely, which pulls it straight back in.
      const leaving = event.shiftKey ? first : last
      if (document.activeElement === leaving || !element.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }

    globalThis.addEventListener('keydown', onKeyDown, true)
    return () => {
      globalThis.removeEventListener('keydown', onKeyDown, true)
      if (restoreTo instanceof HTMLElement) restoreTo.focus()
    }
  }, [])

  return (
    <div
      // Clicking anywhere dismisses, which is what every overlay of this kind
      // does. Escape is handled by the key hook, which owns Escape already.
      onClick={onClose}
      className="absolute inset-0 z-20 flex items-center justify-center bg-page/80"
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        // The backdrop's click handler is the outside-click dismiss; a click
        // on the panel itself must not travel up to it.
        onClick={(event) => event.stopPropagation()}
        className="w-80 rounded-card bg-surface p-4 text-[11px] shadow-overlay"
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-xs text-ink">Keyboard</h2>
          <Button type="button" variant="quiet" size="xs" onClick={onClose} className="text-ink-2">
            close
          </Button>
        </div>
        <dl className="mt-3 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5">
          {KEYS.map(([key, description]) => (
            <div key={key} className="contents">
              <dt className="tabular-nums text-ink">{key}</dt>
              <dd className="text-ink-2">{description}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
