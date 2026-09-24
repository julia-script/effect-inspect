/**
 * Beautiful UI's `value-pill` atom, installed from
 * `https://www.beautifului.dev/r/value-pill.json`.
 *
 * Adapted to repo convention only: `readonly` props and a named `Tone` export
 * so callers can type a tone they compute. The tone table and the
 * `color-mix` rings are the registry's.
 */
import type { ReactNode } from 'react'

export type Tone = 'neutral' | 'green' | 'orange' | 'red' | 'accent'

const TONES: Record<Tone, { readonly cls: string; readonly ring: string }> = {
  neutral: { cls: 'bg-field text-ink-2', ring: 'var(--shadow-hairline)' },
  green: {
    cls: 'bg-green-tint text-green',
    ring: '0 0 0 1px color-mix(in oklch, var(--green) 28%, transparent)',
  },
  orange: {
    cls: 'bg-orange-tint text-orange',
    ring: '0 0 0 1px color-mix(in oklch, var(--orange) 28%, transparent)',
  },
  red: {
    cls: 'bg-red-tint text-red',
    ring: '0 0 0 1px color-mix(in oklch, var(--red) 28%, transparent)',
  },
  accent: {
    cls: 'bg-accent-tint text-accent-ink',
    ring: '0 0 0 1px color-mix(in oklch, var(--accent) 28%, transparent)',
  },
}

/** Inline value badge — a plain value (a date, a name, a count) set off in
 *  prose. Softer than a StatusPill (no dot) and not a mono token (see Chip). */
export const ValuePill = ({
  children,
  tone = 'neutral',
  className = '',
}: {
  readonly children: ReactNode
  readonly tone?: Tone
  readonly className?: string
}) => {
  const t = TONES[tone]
  return (
    <span
      className={`mx-0.5 inline-flex items-center rounded-full px-1.5 py-0
        align-middle text-[12px] font-medium ${t.cls} ${className}`}
      style={{ boxShadow: t.ring }}
    >
      {children}
    </span>
  )
}
