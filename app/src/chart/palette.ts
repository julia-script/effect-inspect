/**
 * The canvas's bridge to the CSS token vocabulary.
 *
 * `<canvas>` paints with strings, not custom properties: `ctx.fillStyle =
 * 'var(--canvas)'` is silently ignored. So the chart cannot inherit the theme
 * the way the DOM chrome does — it has to *read* it. This module is that read,
 * and it exists so the flame chart has no colour constants of its own left.
 *
 * **Read once per theme change, never per frame.** `getComputedStyle` forces
 * style resolution, which at 60fps on a chart that is already drawing 10k
 * spans would be the single most expensive thing in the frame. The renderer
 * subscribes to the theme atom and calls {@link readPalette} on change, exactly
 * as it already does for selection and filter changes.
 */

/** Every colour the chart paints, resolved to values a canvas context accepts. */
export interface Palette {
  /** The chart's own backdrop — foundation's `--canvas`. */
  readonly bg: string
  /** The overview strip, a step off the backdrop — `--surface`. */
  readonly panel: string
  /** Gridlines and the ruler's baseline — `--grid-line`. */
  readonly grid: string
  /** Ruler tick labels and other de-emphasised text — `--ink-3`. */
  readonly rulerText: string
  /** Span labels on a matching bar — `--ink`. */
  readonly label: string
  /** Span labels on a dimmed bar, and the hover fill — `--ink-2`. */
  readonly labelDim: string
  /** A failed span's bar — `--red` at rest. */
  readonly error: string
  /** A failed span's bar under the cursor. */
  readonly errorHot: string
  /** The selected span's outline — `--ink`, the highest-contrast token there is. */
  readonly selected: string
  /** Bar fill by nesting depth. Five steps; see `--depth-*` in `styles.css`. */
  readonly depth: ReadonlyArray<string>
  /** Scrim over the parts of the overview strip outside the viewport window. */
  readonly overviewScrim: string
  /** The viewport window's outline on the overview strip. */
  readonly overviewWindow: string
  /** The memory track's heap curve — `--ink-2`, the headline series. */
  readonly memoryCurve: string
  /** Fill under the heap curve. */
  readonly memoryFill: string
  /** The secondary dashed `rss` line — dimmer than the heap. */
  readonly memoryRss: string
  /** The track's label text and its cursor rule. */
  readonly memoryLabel: string
  /** The track's baseline rule. */
  readonly memoryBase: string
  /** Background chip behind on-canvas readouts — foundation's `--tooltip-bg`. */
  readonly readoutBg: string
  /** Text on that chip — `--tooltip-fg`. */
  readonly readoutFg: string
}

/**
 * Resolves one custom property against `<html>`.
 *
 * `document.documentElement` rather than the canvas: the canvas sits inside the
 * shell, which paints its own background, and reading from it would resolve
 * inherited values correctly but pointlessly — every token in play is declared
 * on `:root`/`.dark`, which is the same element.
 */
const read = (style: CSSStyleDeclaration, name: string, fallback: string): string => {
  const value = style.getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

/**
 * Mixes `color` with `base` at `amount` percent, as a string the canvas can use.
 *
 * `color-mix()` in a canvas `fillStyle` is supported wherever `oklch()` is, and
 * every browser that ships `@property`-less Tailwind v4 has both — so this is a
 * plain string rather than a manual colour-space conversion. It exists because
 * a few chart surfaces need a token at partial strength (the overview scrim,
 * the area fill under the memory curve) and foundation ships no `-tint` for
 * the neutrals.
 */
const mix = (color: string, base: string, amount: number): string =>
  `color-mix(in oklch, ${color} ${amount}%, ${base})`

/**
 * Snapshot of the current theme's chart colours.
 *
 * Fallbacks are the dark values, which is what the server renders and what a
 * headless canvas test with no stylesheet attached would otherwise get as an
 * empty string — an empty `fillStyle` assignment is ignored and leaves the
 * previous colour, so a missing token would paint garbage rather than
 * something plain.
 */
export const readPalette = (): Palette => {
  const style = getComputedStyle(document.documentElement)
  const bg = read(style, '--canvas', '#1c1d20')
  const ink = read(style, '--ink', '#f5f6f7')
  const ink2 = read(style, '--ink-2', '#a8adb8')
  const ink3 = read(style, '--ink-3', '#6f7480')
  const red = read(style, '--red', '#e05252')

  return {
    bg,
    panel: read(style, '--surface', '#26272c'),
    grid: read(style, '--grid-line', '#3a3c42'),
    rulerText: ink3,
    label: ink,
    labelDim: ink2,
    // A failed span is red at rest and *fully* red under the cursor. Resting
    // bars are mixed back toward the chart background so a trace with many
    // failures does not become a wall of red, but the mix stays well clear of
    // the depth ramp's neutrals — "unmistakably the error colour" is a
    // requirement in both themes, so this is 72%, not a tint.
    error: mix(red, bg, 72),
    errorHot: red,
    selected: ink,
    depth: [
      read(style, '--depth-1', '#3f3f46'),
      read(style, '--depth-2', '#52525b'),
      read(style, '--depth-3', '#34343a'),
      read(style, '--depth-4', '#45454d'),
      read(style, '--depth-5', '#2e2e33'),
    ],
    // The scrim dims the out-of-view thirds of the overview strip. It is the
    // chart background at 72% rather than a black alpha, so on the light theme
    // it *lightens* the excluded range instead of dirtying it.
    overviewScrim: mix(bg, 'transparent', 72),
    overviewWindow: read(style, '--line-strong', '#4a4d55'),
    memoryCurve: ink2,
    memoryFill: mix(ink2, 'transparent', 16),
    memoryRss: ink3,
    memoryLabel: ink3,
    memoryBase: read(style, '--line', '#33353b'),
    readoutBg: read(style, '--tooltip-bg', '#1a1b1e'),
    readoutFg: read(style, '--tooltip-fg', '#f5f6f7'),
  }
}
