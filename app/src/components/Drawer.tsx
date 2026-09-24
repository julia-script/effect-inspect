/**
 * The bottom tabbed drawer.
 *
 * Four tabs over one trace: the Event log is per span, the other three are
 * aggregations of the visible range. Only the active tab is mounted, so a
 * closed Summary costs nothing — the aggregation is built by the tab, not by
 * the drawer.
 */
import { useState } from 'react'
import { BottomUp, CallTree, Summary } from './Aggregation.tsx'
import { EventLog } from './EventLog.tsx'

const TABS = [
  { id: 'log', label: 'Event log', render: () => <EventLog /> },
  { id: 'summary', label: 'Summary', render: () => <Summary /> },
  { id: 'bottom-up', label: 'Bottom-up', render: () => <BottomUp /> },
  { id: 'call-tree', label: 'Call tree', render: () => <CallTree /> },
] as const

export const Drawer = () => {
  const [height, setHeight] = useState(220)
  const [collapsed, setCollapsed] = useState(false)
  const [active, setActive] = useState<(typeof TABS)[number]['id']>('log')

  /**
   * Drag the top edge to resize. Pointer capture so it survives leaving the bar.
   *
   * Capturing redirects the `pointerup` to the bar, so no `click` ever fires on
   * a control inside it. The guard therefore lives **here**, on the bar, rather
   * than as a `stopPropagation` on each child: a drag only starts when the
   * pointer landed on the bar itself, so every button in the bar — present and
   * future — stays clickable without having to remember to opt out.
   */
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
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
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActive(tab.id)}
            className={`border-b py-1.5 text-[11px] ${
              tab.id === active
                ? 'border-neutral-400 text-neutral-200'
                : 'border-transparent text-neutral-600 hover:text-neutral-400'
            }`}
          >
            {tab.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="ml-auto text-[11px] text-neutral-600 hover:text-neutral-300"
        >
          {collapsed ? 'expand' : 'collapse'}
        </button>
      </div>
      {!collapsed && TABS.find((tab) => tab.id === active)!.render()}
    </div>
  )
}
