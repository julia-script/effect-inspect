import { Option } from 'effect'
import { Message } from '../state/message.ts'
import { type Model, type SortKey, type Tab } from '../state/model.ts'
import { MeasureLog, ResizeDrawer } from '../state/browser.ts'
import { matches } from '../chart/selection.ts'
import type { TreeNode } from '../chart/aggregate.ts'
import { formatDuration } from './format.ts'
import { button, empty, type H } from './Panel.ts'
import { aggregationFor, eventRows } from './data.ts'

export const ROW_HEIGHT = 22
const HEAD = 'flex shrink-0 border-b border-line-strong bg-surface px-2 text-ink-3'
const sortArrow = (desc: boolean) => (desc ? ' ↓' : ' ↑')
const SELECTED = 'color-mix(in srgb, var(--accent) 10%, var(--surface))'
const TABS: ReadonlyArray<readonly [typeof Tab.Type, string]> = [
  ['log', 'Event log'],
  ['summary', 'Summary'],
  ['bottom-up', 'Bottom-up'],
  ['call-tree', 'Call tree'],
]
const cell = (h: H, value: string) => h.span([h.Class('w-20 shrink-0 pr-3 text-right')], [value])
const rowClass = (matched: boolean) =>
  `flex w-full items-center px-2 text-left tabular-nums transition-colors odd:bg-[var(--stripe)] hover:bg-[var(--hover)] ${matched ? 'text-ink-2' : 'text-ink-3'}`
const sortHeader = (
  h: H,
  model: Model,
  table: 'log' | 'summary',
  columns: ReadonlyArray<readonly [typeof SortKey.Type, string]>,
) => {
  const sort = table === 'log' ? model.logSort : model.summarySort
  return h.div(
    [h.Class(HEAD)],
    columns.map(([key, label]) =>
      h.button(
        [
          h.Type('button'),
          h.Class(
            `py-1 text-left transition-colors hover:text-ink ${sort.key === key ? 'text-ink' : ''} ${key === 'name' ? 'flex-1 pl-3' : 'w-20 pr-3 text-right'}`,
          ),
          h.OnClick(Message.SortedTable({ table, key })),
        ],
        [label, sort.key === key ? sortArrow(sort.desc) : ''],
      ),
    ),
  )
}
export const eventLog = (model: Model, h: H) => {
  const rows = eventRows(model)
  const first = Math.min(
    Math.max(Math.floor(model.logScrollTop / ROW_HEIGHT) - 8, 0),
    Math.max(rows.length - 1, 0),
  )
  const last = Math.min(
    Math.ceil((model.logScrollTop + model.logViewHeight) / ROW_HEIGHT) + 8,
    rows.length,
  )
  return h.div(
    [h.Class('flex min-h-0 flex-1 flex-col text-[11px]')],
    [
      sortHeader(h, model, 'log', [
        ['start', 'Start'],
        ['self', 'Self'],
        ['total', 'Total'],
        ['name', 'Name'],
      ]),
      h.div(
        [
          h.Id('event-log-scroll'),
          h.Class('min-h-0 flex-1 overflow-y-auto'),
          h.OnMount(MeasureLog()),
          h.OnScroll((top) => Message.ScrolledLog({ top })),
        ],
        [
          rows.length === 0
            ? h.p([h.Class('px-3 py-2 text-ink-3')], ['No spans match.'])
            : h.div(
                [h.Style({ height: `${rows.length * ROW_HEIGHT}px`, position: 'relative' })],
                [
                  h.div(
                    [h.Style({ transform: `translateY(${first * ROW_HEIGHT}px)` })],
                    rows.slice(first, last).map((row) => {
                      const id = row.span.spanId
                      const selected = id === model.selectedSpanId
                      const hovered = id === model.hoveredSpanId
                      const background = selected ? SELECTED : 'var(--hover)'
                      return h.button(
                        [
                          h.Key(id),
                          h.Type('button'),
                          h.AriaPressed(String(selected)),
                          h.OnClick(Message.SelectedSpan({ spanId: id, reveal: true })),
                          h.OnMouseEnter(Message.HoveredSpan({ spanId: id })),
                          h.OnMouseLeave(Message.HoveredSpan({ spanId: undefined })),
                          h.Class(rowClass(row.matched)),
                          h.Style({
                            height: `${ROW_HEIGHT}px`,
                            ...(selected || hovered ? { background } : {}),
                          }),
                        ],
                        [
                          cell(h, formatDuration(row.span.start)),
                          cell(h, formatDuration(row.self)),
                          cell(h, formatDuration(row.total)),
                          h.span(
                            [
                              h.Class(
                                `flex-1 truncate pl-3 ${row.span.outcome?._tag === 'Failure' ? 'text-red' : ''}`,
                              ),
                            ],
                            [row.span.name],
                          ),
                        ],
                      )
                    }),
                  ),
                ],
              ),
        ],
      ),
    ],
  )
}

const summary = (model: Model, h: H) => {
  const sort = model.summarySort
  const rows = [...aggregationFor(model).summary].sort((a, b) => {
    let value = a.self - b.self
    if (sort.key === 'name') value = a.name.localeCompare(b.name)
    if (sort.key === 'count') value = a.count - b.count
    if (sort.key === 'total') value = a.total - b.total
    if (sort.key === 'average') value = a.average - b.average
    return (sort.desc ? -1 : 1) * value
  })
  if (rows.length === 0)
    return empty(
      h,
      'No spans in view',
      "These tabs aggregate the chart's visible range. Reset the zoom, or clear the filter, to widen it.",
      'Search',
    )
  return h.div(
    [h.Class('flex min-h-0 flex-1 flex-col')],
    [
      sortHeader(h, model, 'summary', [
        ['count', 'Count'],
        ['total', 'Total'],
        ['self', 'Self'],
        ['average', 'Avg'],
        ['name', 'Name'],
      ]),
      h.div(
        [h.Class('min-h-0 flex-1 overflow-y-auto text-[11px]')],
        rows.map((row) =>
          h.button(
            [
              h.Key(row.name),
              h.Type('button'),
              h.OnClick(Message.SelectedSpan({ spanId: row.spanId, reveal: false })),
              h.Class(rowClass(matches(row.name, model.filter.toLowerCase()))),
              h.Style({
                height: '22px',
                ...(row.spanId === model.selectedSpanId ? { background: SELECTED } : {}),
              }),
            ],
            [
              cell(h, String(row.count)),
              cell(h, formatDuration(row.total)),
              cell(h, formatDuration(row.self)),
              cell(h, formatDuration(row.average)),
              h.span([h.Class(`flex-1 truncate pl-3 ${row.failed ? 'text-red' : ''}`)], [row.name]),
            ],
          ),
        ),
      ),
    ],
  )
}
const treeRow = (
  model: Model,
  h: H,
  node: TreeNode,
  depth: number,
): ReadonlyArray<ReturnType<H['button']>> => {
  const open = model.expanded.includes(node.id)
  let marker = ''
  if (node.children.length > 0) marker = open ? '▾' : '▸'
  return [
    h.button(
      [
        h.Key(node.id),
        h.Type('button'),
        h.OnClick(Message.ToggledTree({ id: node.id, spanId: node.spanId })),
        h.Class(rowClass(matches(node.name, model.filter.toLowerCase()))),
        h.Style({
          height: '22px',
          ...(node.spanId === model.selectedSpanId ? { background: SELECTED } : {}),
        }),
        ...(node.children.length > 0 ? [h.AriaExpanded(open)] : []),
      ],
      [
        cell(h, String(node.count)),
        cell(h, formatDuration(node.total)),
        cell(h, formatDuration(node.self)),
        h.span(
          [
            h.Class(`flex-1 truncate ${node.failed ? 'text-red' : ''}`),
            h.Style({ paddingLeft: `${depth * 12 + 12}px` }),
          ],
          [h.span([h.Class('inline-block w-3 text-ink-3')], [marker]), node.name],
        ),
      ],
    ),
    ...(open ? node.children.flatMap((child) => treeRow(model, h, child, depth + 1)) : []),
  ]
}
const tree = (model: Model, h: H) => {
  const data = aggregationFor(model)
  const roots = model.tab === 'bottom-up' ? data.bottomUp : data.callTree
  if (roots.length === 0)
    return empty(
      h,
      'No spans in view',
      "These tabs aggregate the chart's visible range. Reset the zoom, or clear the filter, to widen it.",
      'Search',
    )
  return h.div(
    [h.Class('flex min-h-0 flex-1 flex-col')],
    [
      h.div(
        [h.Class(`${HEAD} py-1 text-[11px]`)],
        [
          cell(h, 'Count'),
          cell(h, 'Total'),
          cell(h, 'Self'),
          h.span([h.Class('flex-1 pl-3')], ['Name']),
        ],
      ),
      h.div(
        [h.Class('min-h-0 flex-1 overflow-y-auto text-[11px]')],
        roots.flatMap((node) => treeRow(model, h, node, 0)),
      ),
    ],
  )
}
export const drawer = (model: Model, h: H) =>
  h.div(
    [
      h.Class('flex shrink-0 flex-col border-t border-line bg-surface'),
      h.Style({ height: model.drawerCollapsed ? 'auto' : `${model.drawerHeight}px` }),
    ],
    [
      h.div(
        [
          h.Class(
            `flex h-8 shrink-0 items-center gap-1 px-2 ${model.drawerCollapsed ? '' : 'cursor-row-resize'}`,
          ),
          h.OnMount(ResizeDrawer()),
        ],
        [
          h.div(
            [
              h.Role('tablist'),
              h.AriaLabel('Trace views'),
              h.Class('flex items-center gap-1'),
              h.OnKeyDownFocus((key) => {
                const delta = { ArrowLeft: -1, ArrowRight: 1, Home: 0, End: 0 }[key]
                if (delta === undefined) return Option.none()
                let index =
                  (TABS.findIndex(([tab]) => tab === model.tab) + delta + TABS.length) % TABS.length
                if (key === 'Home') index = 0
                if (key === 'End') index = TABS.length - 1
                const tab = TABS[index]![0]
                return Option.some({
                  focusSelector: `[data-tab="${tab}"]`,
                  message: Message.ChangedTab({ tab }),
                })
              }),
            ],
            TABS.map(([tab, label]) =>
              h.button(
                [
                  h.Key(tab),
                  h.Type('button'),
                  h.Role('tab'),
                  h.Id(`drawer-tab-${tab}`),
                  h.DataAttribute('tab', tab),
                  h.AriaSelected(model.tab === tab),
                  h.AriaControls('drawer-panel'),
                  h.Tabindex(model.tab === tab ? 0 : -1),
                  h.OnClick(Message.ChangedTab({ tab })),
                  h.Class(
                    `rounded-chip px-2 py-1 text-[11px] transition-colors ${model.tab === tab ? 'bg-hover text-ink' : 'text-ink-3 hover:bg-hover hover:text-ink-2'}`,
                  ),
                ],
                [label],
              ),
            ),
          ),
          button(
            h,
            model.drawerCollapsed ? 'expand' : 'collapse',
            Message.ToggledDrawer(),
            [
              h.AriaExpanded(!model.drawerCollapsed),
              h.AriaControls('drawer-panel'),
              h.Class('ml-auto'),
            ],
            true,
          ),
        ],
      ),
      model.drawerCollapsed
        ? null
        : h.div(
            [
              h.Id('drawer-panel'),
              h.Role('tabpanel'),
              h.AriaLabelledBy(`drawer-tab-${model.tab}`),
              h.Class('flex min-h-0 flex-1 flex-col'),
            ],
            [drawerBody(model, h)],
          ),
    ],
  )
const drawerBody = (model: Model, h: H) => {
  if (model.tab === 'log') return eventLog(model, h)
  if (model.tab === 'summary') return summary(model, h)
  return tree(model, h)
}
