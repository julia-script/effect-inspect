/**
 * The one selection model, shared by the flame chart and the event log.
 *
 * Both views read and write **these** atoms; neither holds a selection of its
 * own that it then syncs. That is the difference between "selection-synced"
 * and "two views of one value" — the latter cannot drift.
 *
 * These hold span **ids**, not spans: a span object is mutable and can be
 * re-depthed by a late-arriving parent, so holding a reference would pin a
 * stale depth. Both views resolve the id against `traceStore` at read time.
 */
import { Atom } from 'effect/unstable/reactivity'

/** The clicked span, or `undefined`. Drives the detail panel and both views' highlight. */
export const selectedSpanIdAtom = Atom.make<string | undefined>(undefined)

/** The span under the cursor, or `undefined`. Written by whichever view is hovered. */
export const hoveredSpanIdAtom = Atom.make<string | undefined>(undefined)

/** Free-text span-name filter. Non-matching spans are dimmed in both views. */
export const filterAtom = Atom.make('')

/** Whether the filter hides non-matching spans outright rather than dimming them. */
export const filterHidesAtom = Atom.make(false)

/**
 * Case-insensitive substring match, with an empty filter matching everything.
 *
 * Substring rather than fuzzy or regex: Chrome's own filter is a substring
 * match, and a regex in a per-frame draw loop is a performance trap.
 */
export const matches = (name: string, filter: string): boolean =>
  filter === '' || name.toLowerCase().includes(filter)

/**
 * Whether the memory track is collapsed away.
 *
 * Lives here rather than in the renderer because the toggle is DOM chrome and
 * the track is canvas; an atom is the seam they already share. Collapsed means
 * the track takes zero height, which is the same thing a session with no
 * samples gets — so there is only one "no track" code path.
 */
export const memoryCollapsedAtom = Atom.make(false)
