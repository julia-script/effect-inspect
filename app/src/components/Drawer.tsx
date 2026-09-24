/**
 * The bottom tabbed drawer.
 *
 * M1 ships one tab (Event log); the tab strip exists because the spec's
 * milestone-2 tabs (Summary, Bottom-up, Call tree) drop straight into it, and
 * a single-tab strip is a handful of lines rather than an abstraction.
 */
import { useState } from 'react'
import { EventLog } from './EventLog.tsx'

export const Drawer = () => {
  const [height, setHeight] = useState(220)
  const [collapsed, setCollapsed] = useState(false)

  /** Drag the top edge to resize. Pointer capture so it survives leaving the bar. */
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    const startY = event.clientY
    const startHeight = height
    const move = (moveEvent: PointerEvent) => {
      setHeight(Math.min(Math.max(startHeight - (moveEvent.clientY - startY), 80), 600))
    }
    const up = () => {
      globalThis.removeEventListener('pointermove', move)
      globalThis.removeEventListener('pointerup', up)
    }
    globalThis.addEventListener('pointermove', move)
    globalThis.addEventListener('pointerup', up)
  }

  return (
    <div
      className="flex shrink-0 flex-col border-t border-neutral-900"
      style={{ height: collapsed ? 'auto' : height }}
    >
      <div
        onPointerDown={collapsed ? undefined : onPointerDown}
        className={`flex items-center gap-3 px-3 ${collapsed ? '' : 'cursor-row-resize'}`}
      >
        <span className="border-b border-neutral-400 py-1.5 text-[11px] text-neutral-200">
          Event log
        </span>
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="ml-auto text-[11px] text-neutral-600 hover:text-neutral-300"
        >
          {collapsed ? 'expand' : 'collapse'}
        </button>
      </div>
      {!collapsed && <EventLog />}
    </div>
  )
}
