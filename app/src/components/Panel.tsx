/**
 * The shared furniture the side panels are built from: the collapse hook, the
 * rail a collapsed panel leaves behind, and the designed empty state.
 *
 * Both side panels are the same object seen from opposite edges — a titled
 * surface that can fold to a rail — so the collapse affordance, its width and
 * its label orientation live here once rather than being written twice with a
 * left/right difference in each.
 */
import { useAtom } from '@effect/atom-react'
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react'
import { useSyncExternalStore, type ReactNode } from 'react'
import { DEFAULT_PANELS, panelsAtom, type PanelState } from '../state/panels.ts'
import { Button } from './atoms/Button.tsx'

/** No-op subscribe: {@link useHydrated} never changes after the first commit. */
const noSubscribe = (): (() => void) => () => {}

/**
 * `false` during server render and while hydrating, `true` afterwards.
 *
 * Same mechanism, and the same reason, as the copy in `ThemeToggle`: the
 * stored panel state is adopted in an effect that can land before a lazily
 * loaded component hydrates, so reading the atom directly would render markup
 * that disagrees with what React is hydrating against.
 */
const useHydrated = (): boolean =>
  useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  )

/**
 * One panel's collapsed flag and a toggle for it.
 *
 * Returns the *server's* value until hydration commits, so the first client
 * render always matches the markup; the stored preference arrives one commit
 * later, which for a layout is a single re-render rather than a flash.
 */
export const usePanel = (key: keyof PanelState): readonly [boolean, () => void] => {
  const [panels, setPanels] = useAtom(panelsAtom)
  const hydrated = useHydrated()
  const collapsed = hydrated ? panels[key] : DEFAULT_PANELS[key]
  return [collapsed, () => setPanels({ ...panels, [key]: !panels[key] })]
}

/** Which way the chevron points, per edge and state. */
const chevron = (edge: 'left' | 'right', collapsed: boolean): LucideIcon => {
  const pointsRight = edge === 'left' ? collapsed : !collapsed
  return pointsRight ? ChevronRight : ChevronLeft
}

/**
 * The collapse control. Quiet until hovered, like every other chrome button.
 *
 * `aria-expanded` and `aria-controls` rather than a changing label, so the
 * button's accessible name stays stable while its state is announced — the
 * same shape the drawer's collapse button already uses.
 */
export const CollapseButton = ({
  edge,
  collapsed,
  onToggle,
  label,
  controls,
}: {
  readonly edge: 'left' | 'right'
  readonly collapsed: boolean
  readonly onToggle: () => void
  readonly label: string
  readonly controls: string
}) => {
  const Icon = chevron(edge, collapsed)
  return (
    <Button
      type="button"
      variant="quiet"
      size="xs"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls={controls}
      aria-label={label}
      title={label}
      className="size-6 shrink-0 px-0 text-ink-3 hover:text-ink"
    >
      <Icon className="size-3.5" />
    </Button>
  )
}

/**
 * A collapsed panel, as a narrow rail carrying its own name and re-open control.
 *
 * A rail rather than nothing at all: a panel that vanishes entirely leaves no
 * clue that it existed, and the user who collapsed it last week has to
 * rediscover the feature. 28px is the button plus the panel's border.
 */
export const CollapsedRail = ({
  edge,
  title,
  onToggle,
  id,
}: {
  readonly edge: 'left' | 'right'
  readonly title: string
  readonly onToggle: () => void
  readonly id: string
}) => (
  <aside
    id={id}
    className={`flex w-7 shrink-0 flex-col items-center gap-2 bg-surface py-1.5 ${
      edge === 'left' ? 'border-r' : 'border-l'
    } border-line`}
  >
    <CollapseButton
      edge={edge}
      collapsed
      onToggle={onToggle}
      label={`Show ${title.toLowerCase()}`}
      controls={id}
    />
    {/* Vertical, reading bottom-to-top on the left rail and top-to-bottom on
        the right, so each label runs away from the content it belongs to. */}
    <span
      className="text-[10px] tracking-wider whitespace-nowrap text-ink-3 uppercase"
      style={{
        writingMode: 'vertical-rl',
        transform: edge === 'left' ? 'rotate(180deg)' : undefined,
      }}
    >
      {title}
    </span>
  </aside>
)

/**
 * The panel header: a section label, and whatever control belongs beside it.
 *
 * Fixed 28px content height so the sidebar's header, the detail panel's header
 * and the drawer's tab bar all land on the same baseline grid.
 */
export const PanelHeader = ({
  title,
  children,
}: {
  readonly title: string
  readonly children?: ReactNode
}) => (
  <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
    <span className="min-w-0 flex-1 truncate text-[10px] tracking-wider text-ink-3 uppercase">
      {title}
    </span>
    {children}
  </div>
)

/**
 * The designed empty state: an icon, what is missing, and the action that fixes it.
 *
 * Three lines rather than one sentence, because "Select a span." tells a new
 * user what is absent but not what to do about it. The icon is what makes the
 * block read as a deliberate state rather than as a failed render, and the
 * hint carries the verb.
 */
export const Empty = ({
  icon: Icon,
  title,
  hint,
  className = '',
}: {
  readonly icon: LucideIcon
  readonly title: string
  readonly hint: ReactNode
  readonly className?: string
}) => (
  <div
    className={`flex flex-col items-center justify-center gap-2 px-4 py-8 text-center ${className}`}
  >
    <Icon className="size-5 text-ink-3" strokeWidth={1.5} aria-hidden />
    <p className="text-xs text-ink-2">{title}</p>
    <p className="max-w-56 text-[11px] leading-relaxed text-balance text-ink-3">{hint}</p>
  </div>
)
