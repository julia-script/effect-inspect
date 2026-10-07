import { Message } from '../state/message.ts'
import { selectionOf, type Model } from '../state/model.ts'
import { FocusHelp, MountChart } from '../state/browser.ts'
import { traceStore } from '../state/trace.ts'
import { timings } from '../chart/metrics.ts'
import { formatDuration, formatValue } from './format.ts'
import { button, type H } from './Panel.ts'

const KEYS = [
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
const help = (h: H) =>
  h.div(
    [
      h.Class('absolute inset-0 z-20 flex items-center justify-center bg-page/80'),
      h.OnClick(Message.ClosedHelp()),
    ],
    [
      h.div(
        [
          h.Role('dialog'),
          h.AriaModal(true),
          h.AriaLabel('Keyboard shortcuts'),
          h.OnMount(FocusHelp()),
          h.OnClick(Message.CompletedBrowserAction(), { propagation: 'Stop' }),
          h.Class('w-80 rounded-card bg-surface p-4 text-[11px] shadow-overlay'),
        ],
        [
          h.div(
            [h.Class('flex items-baseline justify-between')],
            [
              h.h2([h.Class('text-xs text-ink')], ['Keyboard']),
              button(h, 'close', Message.ClosedHelp(), [], true),
            ],
          ),
          h.dl(
            [h.Class('mt-3 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5')],
            KEYS.flatMap(([key, description]) => [
              h.dt([h.Class('tabular-nums text-ink')], [key!]),
              h.dd([h.Class('text-ink-2')], [description!]),
            ]),
          ),
        ],
      ),
    ],
  )
const tooltip = (model: Model, h: H) => {
  const hit = model.tooltip
  if (hit === undefined || hit.spanId !== model.hoveredSpanId) return null
  const span = traceStore.spans.get(hit.spanId)
  if (span === undefined) return null
  const { total, self } = timings(traceStore, span, traceStore.stats().duration)
  const left = Math.min(Math.max(hit.x, 4), Math.max(hit.width - 264, 4))
  const pairs = [
    ['total', formatDuration(total)],
    ['self', formatDuration(self)],
    ['start', formatDuration(span.start)],
  ]
  const attributes = Object.entries(span.attributes).slice(0, 6)
  const fields = (values: ReadonlyArray<readonly [string, string]>) =>
    values.flatMap(([key, value]) => [
      h.dt([h.Class('truncate text-[var(--tooltip-muted)]')], [key]),
      h.dd([h.Class('truncate text-right tabular-nums text-[var(--tooltip-fg)]')], [value]),
    ])
  return h.div(
    [
      h.Class(
        'pointer-events-none absolute z-10 w-64 rounded-card border border-[var(--tooltip-border)] bg-[var(--tooltip-bg)] p-2 text-[11px] text-[var(--tooltip-fg)] shadow-overlay',
      ),
      h.Style({ left: `${left}px`, top: `${hit.y + 20}px` }),
    ],
    [
      h.div([h.Class('truncate')], [span.name]),
      h.dl(
        [h.Class('mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5')],
        fields(pairs as Array<[string, string]>),
      ),
      span.outcome?._tag === 'Failure'
        ? h.p(
            [
              h.Class(
                'mt-1.5 line-clamp-3 border-t border-[var(--tooltip-border)] pt-1.5 text-red',
              ),
            ],
            [span.outcome.error],
          )
        : null,
      attributes.length === 0
        ? null
        : h.dl(
            [
              h.Class(
                'mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t border-[var(--tooltip-border)] pt-1.5',
              ),
            ],
            fields(attributes.map(([key, value]) => [key, formatValue(value)])),
          ),
    ],
  )
}
export const flameChart = (model: Model, h: H) =>
  h.div(
    [h.Class('flex min-h-0 flex-1 flex-col')],
    [
      h.div(
        [h.Class('flex h-8 shrink-0 items-center gap-2 border-b border-line bg-surface px-2')],
        [
          h.input([
            h.Value(model.filter),
            h.OnInput((filter) => Message.ChangedFilter({ filter })),
            h.Placeholder('Filter spans…'),
            h.AriaLabel('Filter spans'),
            h.Class(
              'h-6 w-56 rounded-control bg-field px-2 text-xs text-ink shadow-hairline placeholder:text-ink-3',
            ),
          ]),
          h.label(
            [h.Class('flex items-center gap-1.5 text-[11px] text-ink-2')],
            [
              h.input([
                h.Type('checkbox'),
                h.Checked(model.filterHides),
                h.OnChange(() => Message.ToggledFilterHides()),
                h.Class('accent-accent'),
              ]),
              'hide non-matching',
            ],
          ),
          button(
            h,
            'reset zoom',
            Message.PressedChartKey({ key: '0' }),
            [h.Class('ml-auto')],
            true,
          ),
          button(h, '? keys', Message.ClickedHelp(), [h.AriaLabel('Keyboard shortcuts')], true),
          h.span([h.Class('text-[11px] text-ink-3')], ['drag to pan · wheel to zoom · W/A/S/D']),
        ],
      ),
      h.div(
        [h.Class('relative min-h-0 flex-1')],
        [
          h.canvas(
            [
              h.Key('flame-canvas'),
              h.Class('absolute inset-0 size-full touch-none'),
              h.OnMount(MountChart(selectionOf(model))),
            ],
            [],
          ),
          tooltip(model, h),
          model.helpOpen ? help(h) : null,
        ],
      ),
    ],
  )
