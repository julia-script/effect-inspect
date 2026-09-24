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
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            // The bar above captures the pointer to drive its resize drag,
            // which redirects the pointerup and kills the click on anything
            // inside it. Stopping the pointerdown here keeps the tabs
            // clickable without the bar losing its drag elsewhere.
            onPointerDown={(event) => event.stopPropagation()}
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
