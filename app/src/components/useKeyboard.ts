/**
 * The chart's keyboard bindings — Chrome DevTools' performance-panel keys.
 *
 * One listener on `window` rather than a focusable canvas: the bindings have to
 * work after clicking an event-log row or a session in the sidebar, and
 * requiring the user to click back onto the chart first would make W/A/S/D feel
 * broken. The cost of that choice is that this handler is responsible for
 * staying out of the way of text entry — see {@link isTypingTarget}.
 */
import { useContext, useEffect } from 'react'
import { RegistryContext } from '@effect/atom-react'
import { selectedSpanIdAtom } from '../chart/selection.ts'
import { type Direction, firstSpan, isTypingTarget, step } from '../chart/navigate.ts'
import { traceStore } from '../state/atoms.ts'
import { activeChart, revealSpan } from './FlameChart.tsx'

/** Zoom step per W/S press. Matches the wheel's feel over a few presses. */
const ZOOM_STEP = 1.25
/** Pan step per A/D press, as a fraction of the visible window. */
const PAN_STEP = 0.12
/** Rows scrolled per Q/E press, in CSS pixels (two rows). */
const ROW_STEP = 32

const ARROWS: Record<string, Direction> = {
  ArrowUp: 'parent',
  ArrowDown: 'child',
  ArrowLeft: 'previous',
  ArrowRight: 'next',
}

/**
 * Binds the chart's keys for as long as the component is mounted.
 *
 * Returns nothing: every effect is a write to the shared selection model or a
 * call onto the mounted renderer, so there is no state for React to hold.
 */
export const useKeyboard = (
  onShowHelp: () => void,
  onCloseHelp: () => void,
  helpOpen: boolean,
): void => {
  const registry = useContext(RegistryContext)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return
      // Leave browser and OS shortcuts alone — ctrl/cmd+D is a bookmark, not a pan.
      if (event.ctrlKey || event.metaKey || event.altKey) return

      const chart = activeChart()
      const selected = registry.get(selectedSpanIdAtom)

      const direction = ARROWS[event.key]
      if (direction !== undefined) {
        // With nothing selected, the first arrow press selects the earliest
        // root rather than doing nothing — otherwise arrow traversal appears
        // dead until you happen to click a bar.
        const next =
          selected === undefined ? firstSpan(traceStore) : step(traceStore, selected, direction)
        if (next !== undefined) {
          registry.set(selectedSpanIdAtom, next)
          // Keeps the new selection on screen. `revealSpan` preserves the
          // window width, so a traversal never changes the zoom level — it
          // slides, which is what "without a jarring jump" asks for.
          revealSpan(next)
        }
        event.preventDefault()
        return
      }

      switch (event.key) {
        case 'w':
        case 'W':
          chart?.zoomBy(1 / ZOOM_STEP)
          break
        case 's':
        case 'S':
          chart?.zoomBy(ZOOM_STEP)
          break
        case 'a':
        case 'A':
          chart?.panBy(-PAN_STEP)
          break
        case 'd':
        case 'D':
          chart?.panBy(PAN_STEP)
          break
        // Vertical row scrolling. Not a Chrome binding — Chrome scrolls rows
        // with the wheel, which the chart already does on alt-wheel — but a
        // deep trace is unreachable from the keyboard without it.
        case 'q':
        case 'Q':
          chart?.scrollRows(-ROW_STEP)
          break
        case 'e':
        case 'E':
          chart?.scrollRows(ROW_STEP)
          break
        case 'Enter':
          // The detail panel is always mounted and reads the selection, so
          // "open the detail panel" is "make sure something is selected and
          // visible". With nothing selected, select the first span.
          if (selected === undefined) {
            const first = firstSpan(traceStore)
            if (first !== undefined) {
              registry.set(selectedSpanIdAtom, first)
              revealSpan(first)
            }
          } else {
            revealSpan(selected)
          }
          break
        case 'Escape':
          // Escape dismisses innermost-first, like every layered UI: it closes
          // the shortcut overlay if one is open, and only clears the selection
          // when there is no overlay to close. Doing both at once would lose
          // the selection as a side effect of closing a help panel.
          if (helpOpen) onCloseHelp()
          else registry.set(selectedSpanIdAtom, undefined)
          break
        case '0':
          chart?.resetView()
          break
        case '?':
          onShowHelp()
          break
        default:
          return
      }
      event.preventDefault()
    }

    globalThis.addEventListener('keydown', onKeyDown)
    return () => globalThis.removeEventListener('keydown', onKeyDown)
  }, [registry, onShowHelp, onCloseHelp, helpOpen])
}
