/**
 * The bottom tabbed drawer.
 *
 * Four tabs over one trace: the Event log is per span, the other three are
 * aggregations of the visible range. Only the active tab is mounted, so a
 * closed Summary costs nothing — the aggregation is built by the tab, not by
 * the drawer.
 *
 * The tab bar is hand-rolled rather than `@radix-ui/react-tabs`. Radix would
 * be a new dependency to render four buttons, and its `TabsContent` keeps a
 * panel per tab — the opposite of the mount-only-the-active-tab decision above.
 * The roles and the roving tabindex below are the whole of what it would buy.
 */
import { useRef, useState } from 'react'
import { BottomUp, CallTree, Summary } from './Aggregation.tsx'
import { EventLog } from './EventLog.tsx'
import { Button } from './atoms/Button.tsx'

const TABS = [
  { id: 'log', label: 'Event log', render: () => <EventLog /> },
  { id: 'summary', label: 'Summary', render: () => <Summary /> },
  { id: 'bottom-up', label: 'Bottom-up', render: () => <BottomUp /> },
  { id: 'call-tree', label: 'Call tree', render: () => <CallTree /> },
] as const

type TabId = (typeof TABS)[number]['id']

/** Arrow-key step within the tab list, wrapping at both ends. */
const STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 }

export const Drawer = () => {
  const [height, setHeight] = useState(220)
  const [collapsed, setCollapsed] = useState(false)
  const [active, setActive] = useState<TabId>('log')
  const tabList = useRef<HTMLDivElement>(null)

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

  /**
   * Arrow keys move the selection, as the tabs pattern requires.
   *
   * Only the active tab is reachable with Tab (the roving tabindex below), so
   * without this the other three would be unreachable from the keyboard.
   * Focus has to move with the selection or the next arrow press is read by
   * whatever still holds focus.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = STEP[event.key]
    if (step === undefined) return
    event.preventDefault()
    const index = TABS.findIndex((tab) => tab.id === active)
    const next = TABS[(index + step + TABS.length) % TABS.length]!
    setActive(next.id)
    tabList.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus()
  }

  return (
    <div
      className="flex shrink-0 flex-col border-t border-line bg-surface"
      style={{ height: collapsed ? 'auto' : height }}
    >
      <div
        onPointerDown={collapsed ? undefined : onPointerDown}
        className={`flex h-8 shrink-0 items-center gap-1 px-2 ${
          collapsed ? '' : 'cursor-row-resize'
        }`}
      >
        <div
          ref={tabList}
          role="tablist"
          aria-label="Trace views"
          onKeyDown={onKeyDown}
          className="flex items-center gap-1"
        >
          {TABS.map((tab) => {
            const selected = tab.id === active
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`drawer-tab-${tab.id}`}
                data-tab={tab.id}
                aria-selected={selected}
                aria-controls="drawer-panel"
                // Roving tabindex: the tab list is one stop, arrows move within.
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(tab.id)}
                className={`rounded-chip px-2 py-1 text-[11px] transition-colors ${
                  selected ? 'bg-hover text-ink' : 'text-ink-3 hover:bg-hover hover:text-ink-2'
                }`}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
        <Button
          type="button"
          variant="quiet"
          size="xs"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          aria-controls="drawer-panel"
          className="ml-auto text-ink-3 hover:text-ink"
        >
          {collapsed ? 'expand' : 'collapse'}
        </Button>
      </div>
      {!collapsed && (
        <div
          id="drawer-panel"
          role="tabpanel"
          aria-labelledby={`drawer-tab-${active}`}
          className="flex min-h-0 flex-1 flex-col"
        >
          {TABS.find((tab) => tab.id === active)!.render()}
        </div>
      )}
    </div>
  )
}
