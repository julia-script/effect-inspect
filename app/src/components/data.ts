import { aggregate, type Aggregation } from '../chart/aggregate.ts'
import { timings } from '../chart/metrics.ts'
import { matches } from '../chart/selection.ts'
import type { Model } from '../state/model.ts'
import { traceStore } from '../state/trace.ts'
import type { TraceSpan } from '../trace/TraceStore.ts'

export interface LogRow {
  readonly span: TraceSpan
  readonly self: number
  readonly total: number
  readonly matched: boolean
}
let logKey = ''
let logRows: ReadonlyArray<LogRow> = []
/** Cache dense derivations by sampled trace version, filter and sort; hover costs no scan. */
export type EventRowsInput = Pick<Model, 'traceVersion' | 'filter' | 'filterHides' | 'logSort'>
export const eventRows = (model: EventRowsInput): ReadonlyArray<LogRow> => {
  const key = JSON.stringify([model.traceVersion, model.filter, model.filterHides, model.logSort])
  if (key === logKey) return logRows
  logKey = key
  const now = traceStore.stats().duration
  const rows: Array<LogRow> = []
  for (const span of traceStore.spans.values()) {
    const matched = matches(span.name, model.filter.toLowerCase())
    if (model.filterHides && !matched) continue
    rows.push({ span, matched, ...timings(traceStore, span, now) })
  }
  const sort = model.logSort
  rows.sort((a, b) => {
    let compared = a.span.start - b.span.start
    if (sort.key === 'name') compared = a.span.name.localeCompare(b.span.name)
    if (sort.key === 'self') compared = a.self - b.self
    if (sort.key === 'total') compared = a.total - b.total
    return (sort.desc ? -1 : 1) * compared
  })
  logRows = rows
  return rows
}
let aggregationKey = ''
let aggregation: Aggregation = { summary: [], callTree: [], bottomUp: [], timings: [] }
export const aggregationFor = (model: Model): Aggregation => {
  const key = JSON.stringify([model.traceVersion, model.filter, model.filterHides, model.viewport])
  if (key !== aggregationKey) {
    aggregationKey = key
    aggregation = aggregate(
      traceStore,
      model.viewport.from,
      model.viewport.to,
      model.filter,
      model.filterHides,
    )
  }
  return aggregation
}
