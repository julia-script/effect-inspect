import type { Attribute, Html, HtmlBuilder } from 'foldkit/html'
import { Message } from '../state/message.ts'

export type H = HtmlBuilder<Message>
export type Child = Html | string
export const button = (
  h: H,
  label: string,
  message: Message,
  attributes: ReadonlyArray<Attribute<Message>> = [],
  quiet = false,
) =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(message),
      ...attributes.filter((attribute) => attribute._tag !== 'Class'),
      h.Class(
        `inline-flex h-7 items-center justify-center gap-1 rounded-full px-2.5 text-xs font-normal leading-none transition-colors disabled:pointer-events-none disabled:opacity-50 ${quiet ? 'text-ink-2 hover:bg-hover' : 'bg-surface text-ink shadow-btn hover:bg-inset'} ${attributes
          .filter((attribute) => attribute._tag === 'Class')
          .map((attribute) => attribute.value)
          .join(' ')}`,
      ),
    ],
    [label],
  )

export const icon = (h: H, name: string, className = 'size-3.5') => {
  const paths: Record<string, string> = {
    Light:
      'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17m10-10 1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    Dark: 'M20.9 13a9 9 0 1 1-9.9-9.9A7 7 0 0 0 20.9 13',
    System: 'M3 4h18v13H3zM12 17v4m-4 0h8',
    Plug: 'M12 22v-5m-5-5V7h10v5a5 5 0 0 1-10 0m3-5V2m4 5V2',
    Select: 'm4 3 7 17 2-7 7-2Z',
    Search: 'M16 16 21 21M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
    Radio:
      'M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14M8 8a6 6 0 0 0 0 8M16 8a6 6 0 0 1 0 8M12 11v2',
  }
  return h.svg(
    [
      h.Class(className),
      h.Attribute('viewBox', '0 0 24 24'),
      h.Attribute('fill', 'none'),
      h.Attribute('stroke', 'currentColor'),
      h.Attribute('stroke-width', '1.5'),
      h.Attribute('stroke-linecap', 'round'),
      h.Attribute('stroke-linejoin', 'round'),
      h.AriaHidden(true),
    ],
    [h.path([h.Attribute('d', paths[name] ?? paths.Select!)], [])],
  )
}

export const empty = (h: H, title: string, hint: string, name = 'Select', className = '') =>
  h.div(
    [h.Class(`flex flex-col items-center justify-center gap-2 px-4 py-8 text-center ${className}`)],
    [
      icon(h, name, 'size-5 text-ink-3'),
      h.p([h.Class('text-xs text-ink-2')], [title]),
      h.p([h.Class('max-w-56 text-[11px] leading-relaxed text-balance text-ink-3')], [hint]),
    ],
  )

export const panelHeader = (h: H, title: string, controls: ReadonlyArray<Child>) =>
  h.div(
    [h.Class('flex h-8 shrink-0 items-center gap-2 border-b border-line px-2')],
    [
      h.span(
        [h.Class('min-w-0 flex-1 truncate text-[10px] uppercase tracking-wider text-ink-3')],
        [title],
      ),
      ...controls,
    ],
  )
export const collapse = (h: H, panel: 'sessions' | 'detail', collapsed: boolean) => {
  const left = panel === 'sessions'
  const label = `${collapsed ? 'Show' : 'Hide'} ${left ? 'sessions' : 'span detail'}`
  return button(
    h,
    left === collapsed ? '›' : '‹',
    Message.ToggledPanel({ panel }),
    [
      h.AriaLabel(label),
      h.Title(label),
      h.AriaExpanded(!collapsed),
      h.AriaControls(`${panel}-panel`),
    ],
    true,
  )
}
export const rail = (h: H, panel: 'sessions' | 'detail') =>
  h.aside(
    [
      h.Id(`${panel}-panel`),
      h.Class(
        `flex w-7 shrink-0 flex-col items-center gap-2 border-line bg-surface py-1.5 ${panel === 'sessions' ? 'border-r' : 'border-l'}`,
      ),
    ],
    [
      collapse(h, panel, true),
      h.span(
        [
          h.Class('text-[10px] uppercase tracking-wider text-ink-3'),
          h.Style({
            writingMode: 'vertical-rl',
            transform: panel === 'sessions' ? 'rotate(180deg)' : 'none',
          }),
        ],
        [panel === 'sessions' ? 'Sessions' : 'Span'],
      ),
    ],
  )
export const pill = (h: H, text: string | ReadonlyArray<Child>, red = false) =>
  h.span(
    [
      h.Class(
        `mx-0.5 inline-flex items-center gap-1.5 rounded-full px-1.5 text-xs font-medium ${red ? 'bg-red-tint text-red' : 'bg-field text-ink-2'}`,
      ),
      h.Style({
        boxShadow: red
          ? '0 0 0 1px color-mix(in oklch, var(--red) 28%, transparent)'
          : 'var(--shadow-hairline)',
      }),
    ],
    typeof text === 'string' ? [text] : text,
  )
