/**
 * The keyboard-shortcut overlay, opened with `?`.
 *
 * Undiscoverable shortcuts may as well not exist, so this is paired with a
 * permanent `? keys` hint in the chart toolbar — the overlay is the detail, the
 * hint is how anyone finds out the overlay is there.
 */
const KEYS: ReadonlyArray<readonly [string, string]> = [
  ['W / S', 'zoom in / out around the cursor'],
  ['A / D', 'pan left / right'],
  ['Q / E', 'scroll rows up / down'],
  ['0', 'reset zoom, follow live data'],
  ['← / →', 'previous / next sibling span'],
  ['↑ / ↓', 'parent / first child span'],
  ['Enter', 'reveal the selected span'],
  ['Esc', 'clear the selection'],
  ['?', 'this list'],
]

export const Shortcuts = ({ onClose }: { readonly onClose: () => void }) => (
  <div
    // Clicking anywhere dismisses, which is what every overlay of this kind
    // does. Escape is handled by the key hook, which owns Escape already.
    onClick={onClose}
    className="absolute inset-0 z-20 flex items-center justify-center bg-neutral-950/80"
  >
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      className="w-80 rounded border border-neutral-800 bg-neutral-950 p-4 text-[11px]"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs text-neutral-300">Keyboard</h2>
        <button type="button" onClick={onClose} className="text-neutral-600 hover:text-neutral-300">
          close
        </button>
      </div>
      <dl className="mt-3 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5">
        {KEYS.map(([key, description]) => (
          <div key={key} className="contents">
            <dt className="tabular-nums text-neutral-400">{key}</dt>
            <dd className="text-neutral-600">{description}</dd>
          </div>
        ))}
      </dl>
    </div>
  </div>
)
