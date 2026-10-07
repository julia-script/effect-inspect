/** Case-insensitive substring match, shared by canvas, event log and aggregations. */
export const matches = (name: string, filter: string): boolean =>
  filter === '' || name.toLowerCase().includes(filter)
