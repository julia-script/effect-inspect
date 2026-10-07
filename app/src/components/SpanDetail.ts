import { Message } from '../state/message.ts'
import type { Model } from '../state/model.ts'
import { traceStore } from '../state/trace.ts'
import { timings } from '../chart/metrics.ts'
import { formatDuration, formatValue } from './format.ts'
import { button, collapse, empty, panelHeader, rail, type H } from './Panel.ts'

const SECTION = 'border-b border-line px-2.5 py-2'
const LABEL = 'mb-1 text-[10px] uppercase tracking-wider text-ink-3'
export const spanDetail = (model: Model, h: H) => {
  if (model.panels.detail) return rail(h, 'detail')
  const span =
    model.selectedSpanId === undefined ? undefined : traceStore.spans.get(model.selectedSpanId)
  const controls = [collapse(h, 'detail', false)]
  if (model.selectedSpanId !== undefined)
    controls.unshift(
      button(
        h,
        '×',
        Message.SelectedSpan({ spanId: undefined, reveal: false }),
        [h.AriaLabel('Clear selection'), h.Title('Clear selection')],
        true,
      ),
    )
  const frame = (body: ReturnType<H['div']>) =>
    h.aside(
      [
        h.Id('detail-panel'),
        h.Class('flex w-72 shrink-0 flex-col border-l border-line bg-surface text-[11px]'),
      ],
      [
        panelHeader(h, 'Span', controls),
        h.div([h.Class('min-h-0 flex-1 overflow-y-auto')], [body]),
      ],
    )
  if (span === undefined)
    return frame(
      empty(
        h,
        model.selectedSpanId === undefined ? 'No span selected' : 'Span no longer in the trace',
        model.selectedSpanId === undefined
          ? 'Click a bar in the flame chart, or a row in the event log, to see its timings, attributes and logs.'
          : "The collector's backlog rolled past it. Select another span, or reload to start a fresh trace.",
        'Select',
      ),
    )
  const { total, self } = timings(traceStore, span, traceStore.stats().duration)
  const fields = [
    ['start', formatDuration(span.start)],
    ['total', formatDuration(total)],
    ['self', formatDuration(self)],
    ['depth', String(span.depth)],
    ['children', String(span.children.length)],
    ['state', span.end === undefined ? 'running' : 'ended'],
  ]
  if (span.fiberId !== undefined) fields.push(['fiber', String(span.fiberId)])
  const attributes = Object.entries(span.attributes)
  const logs = traceStore.logs.filter((log) => log.spanId === span.spanId)
  return frame(
    h.div(
      [],
      [
        h.div(
          [h.Class(SECTION)],
          [
            h.p([h.Class('break-words text-ink')], [span.name]),
            h.p([h.Class('mt-0.5 text-ink-3')], [span.kind]),
          ],
        ),
        h.dl(
          [h.Class(`grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 ${SECTION}`)],
          fields.flatMap(([label, value]) => [
            h.dt([h.Class('truncate text-ink-3')], [label!]),
            h.dd([h.Class('truncate text-right tabular-nums text-ink')], [value!]),
          ]),
        ),
        span.outcome?._tag === 'Failure'
          ? h.div(
              [
                h.Class(SECTION),
                h.Style({ backgroundImage: 'linear-gradient(var(--red-tint), var(--red-tint))' }),
              ],
              [
                h.p([h.Class('text-ink-2')], [span.outcome.kind]),
                h.p([h.Class('mt-1 break-words text-red')], [span.outcome.error]),
                span.outcome.stack === undefined
                  ? null
                  : h.pre(
                      [
                        h.Class(
                          'mt-1.5 overflow-x-auto rounded-chip bg-inset p-2 text-[10px] leading-relaxed whitespace-pre-wrap text-ink-2',
                        ),
                      ],
                      [span.outcome.stack],
                    ),
              ],
            )
          : null,
        attributes.length === 0
          ? null
          : h.div(
              [h.Class(SECTION)],
              [
                h.p([h.Class(LABEL)], ['Attributes']),
                h.dl(
                  [h.Class('grid grid-cols-[auto_1fr] gap-x-3 gap-y-1')],
                  attributes.flatMap(([key, value]) => [
                    h.dt([h.Class('truncate text-ink-3')], [key]),
                    h.dd([h.Class('break-words text-right text-ink-2')], [formatValue(value)]),
                  ]),
                ),
              ],
            ),
        span.events.length === 0
          ? null
          : h.div(
              [h.Class(SECTION)],
              [
                h.p([h.Class(LABEL)], ['Events']),
                ...span.events.map((event) =>
                  h.div(
                    [h.Class('flex justify-between gap-2 py-0.5')],
                    [
                      h.span([h.Class('truncate text-ink-2')], [event.name]),
                      h.span(
                        [h.Class('shrink-0 tabular-nums text-ink-3')],
                        [formatDuration(event.time - span.start)],
                      ),
                    ],
                  ),
                ),
              ],
            ),
        logs.length === 0
          ? null
          : h.div(
              [h.Class('px-2.5 py-2')],
              [
                h.p([h.Class(LABEL)], ['Logs']),
                ...logs.map((log) =>
                  h.div(
                    [h.Class('py-0.5')],
                    [
                      h.span(
                        [h.Class(log.level === 'Error' ? 'text-red' : 'text-ink-3')],
                        [log.level],
                      ),
                      ' ',
                      h.span([h.Class('text-ink-2')], [formatValue(log.message)]),
                    ],
                  ),
                ),
              ],
            ),
      ],
    ),
  )
}
