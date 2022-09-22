import type { Zen } from './index'

export type metric = {
  name: string
  fields: Record<string, unknown>
}

export async function logBatch(zen: Zen, metrics: metric[]): Promise<void> {
  const log = zen.config.log
  if (!log) return

  return log(metrics)
}

export function log(
  zen: Zen,
  name: metric['name'],
  fields: metric['fields']
): Promise<void> {
  return logBatch(zen, [{ name, fields }])
}
