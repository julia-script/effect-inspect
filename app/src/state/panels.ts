/**
 * Whether the sessions sidebar and the span detail panel are collapsed.
 *
 * Both panels are *chrome around* the chart, not the chart itself, so which of
 * them a user wants open is a durable preference rather than per-visit state —
 * it lives in `localStorage` alongside the theme.
 *
 * The hydration constraint is the same one {@link module:state/theme} has, and
 * so is the answer: the server cannot read `localStorage`, so these atoms are
 * seeded with the *default* and adopt storage in an effect. Unlike the theme
 * there is no boot script and no flash to avoid, because a collapsed panel is
 * a layout the user sees and re-renders once — not a colour that would flash.
 *
 * See `usePanel` in {@link module:components/Panel} for the read side, which
 * defers to the server's value until hydration commits.
 */
import { Atom } from 'effect/unstable/reactivity'

/** `localStorage` key. One record, so a panel added later costs no migration. */
export const PANELS_STORAGE_KEY = 'effect-inspect:panels'

/** The collapsible panels. The value is `true` when the panel is collapsed. */
export interface PanelState {
  readonly sessions: boolean
  readonly detail: boolean
}

/** Both panels open — what the server renders, and a first visit gets. */
export const DEFAULT_PANELS: PanelState = { sessions: false, detail: false }

/** Reads stored collapse state, ignoring anything that is not our shape. */
const stored = (): PanelState => {
  if (typeof localStorage === 'undefined') return DEFAULT_PANELS
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PANELS_STORAGE_KEY) ?? 'null')
    if (typeof raw !== 'object' || raw === null) return DEFAULT_PANELS
    const value = raw as Partial<Record<keyof PanelState, unknown>>
    return {
      sessions: value.sessions === true,
      detail: value.detail === true,
    }
  } catch {
    // Bad JSON, or Safari private mode throwing on access. A panel preference
    // is never worth failing to boot over.
    return DEFAULT_PANELS
  }
}

/** The live collapse state. Seeded with the default; see the module comment. */
export const panelsAtom = Atom.make<PanelState>(DEFAULT_PANELS)

/** The minimal registry slice {@link startPanelSync} writes through. */
interface PanelRegistry {
  readonly get: <A>(atom: Atom.Atom<A>) => A
  readonly set: <A>(atom: Atom.Writable<A, A>, value: A) => void
  readonly subscribe: <A>(atom: Atom.Atom<A>, listener: (value: A) => void) => () => void
}

/**
 * Adopts the stored collapse state and persists every change after it.
 *
 * Started once from the root, for the same reason the theme sync is: there is
 * one `localStorage` entry, so there is one owner of it.
 */
export const startPanelSync = (registry: PanelRegistry): (() => void) => {
  const off = registry.subscribe(panelsAtom, (panels) => {
    try {
      localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify(panels))
    } catch {
      // Private mode. The choice still holds for this page load.
    }
  })

  const saved = stored()
  const current = registry.get(panelsAtom)
  if (saved.sessions !== current.sessions || saved.detail !== current.detail) {
    registry.set(panelsAtom, saved)
  }

  return off
}
