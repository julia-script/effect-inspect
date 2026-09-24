/**
 * Theme preference, and the one place that owns the `dark` class.
 *
 * Three moving parts, and the split between them is the whole design:
 *
 * - **The preference** (`light | dark | system`) is what the user chose. It
 *   lives in an atom and in `localStorage`.
 * - **The resolution** (`light | dark`) is what that preference means right
 *   now, which for `system` depends on `prefers-color-scheme` and can change
 *   under a stationary preference.
 * - **The class on `<html>`** is what CSS and the canvas actually read.
 *
 * The class is applied *imperatively*, not by React rendering it. TanStack
 * Start renders the document on the server, where `localStorage` and
 * `prefers-color-scheme` are both unavailable, so a React-rendered class can
 * only ever be the default — and correcting it in an effect is a flash. See
 * {@link THEME_BOOT_SCRIPT}, which runs before first paint.
 */
import { Atom } from 'effect/unstable/reactivity'

/** What the user chose. `system` defers to `prefers-color-scheme`. */
export type Theme = 'light' | 'dark' | 'system'

/** What a preference resolves to — the two states the DOM can actually be in. */
export type ResolvedTheme = 'light' | 'dark'

/** `localStorage` key. Shared with {@link THEME_BOOT_SCRIPT}, which is a string. */
export const THEME_STORAGE_KEY = 'effect-inspect:theme'

/** Dark is the default, per the spec, and is what the server renders. */
export const DEFAULT_THEME: Theme = 'dark'

const isTheme = (value: unknown): value is Theme =>
  value === 'light' || value === 'dark' || value === 'system'

/**
 * Blocking inline script for `<head>`.
 *
 * This is the no-flash mechanism. The server always renders `class="dark"`
 * (the default), so a user whose stored preference is `light` would otherwise
 * see a dark frame before hydration corrects it. Running synchronously in
 * `<head>`, before the body paints, means the correction happens in the same
 * frame as the first paint and there is nothing to see.
 *
 * It is deliberately duplicated logic rather than an import: it must run before
 * any module graph is fetched, so it cannot be a module. It is small and both
 * copies read the same {@link THEME_STORAGE_KEY}.
 *
 * `color-scheme` is set alongside the class so form controls, scrollbars and
 * the canvas's own backdrop match before any stylesheet has applied.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{
var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
var t=(s==='light'||s==='dark'||s==='system')?s:${JSON.stringify(DEFAULT_THEME)};
var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.classList.toggle('dark',d);
document.documentElement.style.colorScheme=d?'dark':'light';
}catch(e){}})()`

/** Reads the stored preference. Returns the default on the server or bad data. */
const storedTheme = (): Theme => {
  if (typeof localStorage === 'undefined') return DEFAULT_THEME
  try {
    const stored: unknown = localStorage.getItem(THEME_STORAGE_KEY)
    return isTheme(stored) ? stored : DEFAULT_THEME
  } catch {
    // Safari in private mode throws on `localStorage` access rather than
    // returning null, and a profiler must not fail to boot over a theme.
    return DEFAULT_THEME
  }
}

/**
 * The user's preference.
 *
 * Seeded with {@link DEFAULT_THEME} rather than with the stored value, even
 * though the stored value is readable on the client. React hydrates against
 * the *server's* markup, so a toggle that rendered `light` as checked on the
 * first client pass would mismatch a server that rendered `dark` — a real
 * hydration error, not a cosmetic one. The stored preference is adopted a beat
 * later by {@link startThemeSync}, in an effect, where a divergence is a normal
 * state update instead.
 *
 * This costs nothing visually: the *class* on `<html>` is already correct by
 * then — {@link THEME_BOOT_SCRIPT} set it before the first paint — so the only
 * thing catching up is which of three radios is checked.
 */
export const themeAtom = Atom.make<Theme>(DEFAULT_THEME)

/**
 * What the preference resolves to right now.
 *
 * A separate atom rather than a derived read because it has a second input the
 * preference does not see: the OS setting can change while `system` is
 * selected. {@link startThemeSync} owns writing it.
 */
export const resolvedThemeAtom = Atom.make<ResolvedTheme>(
  typeof document === 'undefined' ? DEFAULT_THEME : currentResolved(),
)

/** Resolves a preference against the OS setting. */
export const resolve = (theme: Theme): ResolvedTheme => {
  if (theme !== 'system') return theme
  if (typeof matchMedia === 'undefined') return DEFAULT_THEME
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** What the DOM is showing, read from the class the boot script set. */
function currentResolved(): ResolvedTheme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/** The minimal registry slice this module writes through. */
interface ThemeRegistry {
  readonly get: <A>(atom: Atom.Atom<A>) => A
  readonly set: <A>(atom: Atom.Writable<A, A>, value: A) => void
  readonly subscribe: <A>(atom: Atom.Atom<A>, listener: (value: A) => void) => () => void
}

/**
 * Keeps `<html>`, `localStorage` and {@link resolvedThemeAtom} in step with the
 * preference, for as long as the returned function is not called.
 *
 * Started once from the root component rather than from a hook per consumer:
 * there is exactly one `<html>` element, so there is exactly one owner of its
 * class. Everything else — the toggle, the canvas — reads atoms.
 */
export const startThemeSync = (registry: ThemeRegistry): (() => void) => {
  const apply = (theme: Theme): void => {
    const resolved = resolve(theme)
    const root = document.documentElement
    // Idempotent, so an OS change while on an explicit preference costs nothing.
    if (root.classList.contains('dark') !== (resolved === 'dark')) {
      // Foundation ships `.theme-switching` to freeze transitions for one
      // repaint, so a flip is a single clean swap rather than a few hundred
      // colour fades running at different durations.
      root.classList.add('theme-switching')
      root.classList.toggle('dark', resolved === 'dark')
      requestAnimationFrame(() => root.classList.remove('theme-switching'))
    }
    root.style.colorScheme = resolved
    if (registry.get(resolvedThemeAtom) !== resolved) {
      registry.set(resolvedThemeAtom, resolved)
    }
  }

  const offAtom = registry.subscribe(themeAtom, (theme) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // Private mode. The preference still applies for this page load.
    }
    apply(theme)
  })

  // Adopt the stored preference into the atom.
  //
  // Note what is *not* here: an `apply` before this point. The atom is seeded
  // with the default rather than with storage (see {@link themeAtom}), so
  // applying it first would flip `<html>` away from the class the boot script
  // correctly set, and the subscriber above would then persist that wrong
  // value over the user's real preference. The document is already right; the
  // atom is the thing that is behind.
  const stored = storedTheme()
  if (stored === registry.get(themeAtom)) apply(stored)
  else registry.set(themeAtom, stored)

  // Only meaningful while `system` is selected, but subscribing
  // unconditionally means there is no listener to add and remove as the
  // preference changes — `apply` is already idempotent.
  const query = matchMedia('(prefers-color-scheme: dark)')
  const onSystemChange = (): void => apply(registry.get(themeAtom))
  query.addEventListener('change', onSystemChange)

  return () => {
    offAtom()
    query.removeEventListener('change', onSystemChange)
  }
}
