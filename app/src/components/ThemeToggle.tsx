/**
 * The theme control: a three-state segmented switch for `light | dark | system`.
 *
 * A segmented group rather than a single cycling button, because the
 * preference has three values and `system` is not a state you can discover by
 * clicking through — with three radios the current choice and the available
 * choices are both visible at once.
 *
 * It is a `radiogroup`, so a screen reader announces "3 of 3, system,
 * selected", and arrow keys move between options the way a native radio group
 * does. Only the checked option is in the tab order (`tabIndex`), which is the
 * standard roving-tabindex pattern — Tab reaches the group, arrows move inside it.
 */
import { useAtom } from '@effect/atom-react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { type ComponentType, useSyncExternalStore } from 'react'
import { DEFAULT_THEME, type Theme, themeAtom } from '../state/theme.ts'

const OPTIONS: ReadonlyArray<{
  readonly value: Theme
  readonly label: string
  readonly Icon: ComponentType<{ readonly className?: string }>
}> = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
]

/** No-op subscribe: {@link useHydrated} never changes after the first commit. */
const noSubscribe = (): (() => void) => () => {}

/**
 * `false` during server render and during hydration, `true` afterwards.
 *
 * `useSyncExternalStore` is the sanctioned way to ask this: React calls the
 * third argument on the server and while hydrating, and the second one after,
 * which is precisely the distinction needed — and unlike a `useEffect` + state
 * pair, React guarantees the switch happens once hydration has committed
 * rather than racing it.
 */
const useHydrated = (): boolean =>
  useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  )

export const ThemeToggle = () => {
  const [stored, setTheme] = useAtom(themeAtom)
  // Until the tree has hydrated, render the preference the *server* rendered.
  //
  // The atom catches up to `localStorage` in an effect, and that effect can
  // land before this lazily-loaded component hydrates — so reading the atom
  // directly would mean the first client render of these radios disagreed with
  // the markup React is hydrating against, which is a hydration error rather
  // than a cosmetic one. The page itself is never wrong meanwhile: the class on
  // `<html>` was set by a blocking script before the first paint, so the only
  // thing catching up here is which of three radios is checked, for one commit.
  const theme = useHydrated() ? stored : DEFAULT_THEME

  /** Arrow keys cycle, as a native radio group does. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (step === undefined) return
    event.preventDefault()
    const index = OPTIONS.findIndex((option) => option.value === theme)
    const next = OPTIONS[(index + step + OPTIONS.length) % OPTIONS.length]!
    setTheme(next.value)
    // Focus follows selection inside a radio group, so the keyboard user's
    // focus ring lands on what they just chose rather than staying behind.
    event.currentTarget.querySelector<HTMLElement>(`[data-theme="${next.value}"]`)?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      onKeyDown={onKeyDown}
      className="flex items-center gap-0.5 rounded-control bg-inset p-0.5 shadow-hairline"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const checked = theme === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            title={label}
            data-theme={value}
            tabIndex={checked ? 0 : -1}
            onClick={() => setTheme(value)}
            className={`flex size-6 items-center justify-center rounded-chip transition-colors ${
              checked ? 'bg-surface text-ink shadow-btn' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            <Icon className="size-3.5" />
          </button>
        )
      })}
    </div>
  )
}
