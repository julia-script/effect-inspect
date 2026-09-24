/**
 * The flame-bar depth ramp is the one token set this repo designs rather than
 * installs, and its whole job is a visual property: bars must stay
 * distinguishable by depth, and their labels legible, in *both* themes. That is
 * exactly the kind of requirement that rots silently — someone nudges a
 * lightness to taste, two depths merge, and nothing fails.
 *
 * So the ratios are asserted here, against the real declarations parsed out of
 * `styles.css`. No browser: oklch → sRGB → relative luminance is arithmetic,
 * and running it in `bun test` keeps the guarantee on the same gate as
 * everything else.
 *
 * Reads with `node:fs` rather than Effect's `FileSystem`, for the same reason
 * `trace/fixtures` does: this is a synchronous read of a checked-in file at
 * module scope, and `.oxlintrc.json` exempts both paths from
 * `effecttsgo/node-builtin-import`.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/** Strips CSS comments, which otherwise contain the selectors we search for. */
const uncommented = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '')

const css = uncommented(readFileSync(new URL('../styles.css', import.meta.url), 'utf8'))

/** Pulls one `--name: oklch(L C H)` declaration out of a `:root`/`.dark` block. */
const token = (block: string, name: string): readonly [number, number, number] => {
  const match = new RegExp(`${name}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(block)
  if (match === null) throw new Error(`no oklch declaration for ${name}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * The text of a top-level rule block, by selector.
 *
 * The selector must start a line and be followed by `{`, because both files
 * mention these selectors in other positions — foundation's `@custom-variant
 * dark (&:where(.dark, .dark *))` contains `.dark` but opens no block, and a
 * plain `indexOf` would silently return the *next* block instead and compare
 * the dark ramp against light tokens.
 */
const blockOf = (source: string, selector: string): string => {
  const match = new RegExp(`^${selector.replace('.', '\\.')}\\s*\\{`, 'm').exec(source)
  if (match === null) throw new Error(`no ${selector} block`)
  const open = match.index + match[0].length - 1
  return source.slice(open, source.indexOf('}', open))
}

/** oklch → linear sRGB. The standard OKLab matrices; see the CSS Color 4 spec. */
const linearRgb = ([l, c, h]: readonly [number, number, number]): readonly [
  number,
  number,
  number,
] => {
  const hRad = (h * Math.PI) / 180
  const a = c * Math.cos(hRad)
  const b = c * Math.sin(hRad)

  const lp = l + 0.3963377774 * a + 0.2158037573 * b
  const mp = l - 0.1055613458 * a - 0.0638541728 * b
  const sp = l - 0.0894841775 * a - 1.291485548 * b

  const lc = lp ** 3
  const mc = mp ** 3
  const sc = sp ** 3

  return [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ]
}

/**
 * WCAG relative luminance.
 *
 * Takes linear-light sRGB directly — the gamma encode/decode round trip the
 * spec describes cancels out, so going through 8-bit channels would only add
 * rounding error.
 */
const luminance = (oklch: readonly [number, number, number]): number => {
  const [r, g, b] = linearRgb(oklch)
  const clamp = (v: number): number => Math.min(Math.max(v, 0), 1)
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b)
}

/** WCAG contrast ratio between two colours. */
const contrast = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const foundation = uncommented(
  readFileSync(new URL('../beautifui/foundation.css', import.meta.url), 'utf8'),
)

const THEMES = [
  { name: 'light', selector: ':root' },
  { name: 'dark', selector: '.dark' },
]

describe.each(THEMES)('the $name theme depth ramp', ({ selector }) => {
  // The depth ramp is ours (`styles.css`); the canvas and ink it is judged
  // against are foundation's.
  const ramp = blockOf(css, selector)
  const base = blockOf(foundation, selector)
  const canvas = token(base, '--canvas')
  const ink = token(base, '--ink')
  const depths = [1, 2, 3, 4, 5].map((n) => token(ramp, `--depth-${n}`))

  test('every bar is distinguishable from the chart background', () => {
    for (const depth of depths) expect(contrast(depth, canvas)).toBeGreaterThan(1.25)
  })

  test('a span label stays legible on every bar', () => {
    // WCAG AA for normal text. Labels are 10px, so this is the bar to clear.
    for (const depth of depths) expect(contrast(depth, ink)).toBeGreaterThanOrEqual(4.5)
  })

  test('adjacent depths never merge, including the cycle wraparound', () => {
    // `DEPTH_FILL[depth % 5]`, so depth 4 abuts depth 0 as surely as 0 abuts 1.
    for (let index = 0; index < depths.length; index++) {
      const here = depths[index]!
      const next = depths[(index + 1) % depths.length]!
      expect(contrast(here, next)).toBeGreaterThan(1.25)
    }
  })

  test('a failed span reads as unmistakably red against the chart', () => {
    expect(contrast(token(base, '--red'), canvas)).toBeGreaterThan(3)
  })
})
