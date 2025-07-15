import type { Zen } from './index'

export type Metric = {
  name: string
  fields: Record<string, string | number>
}

type Logger = (metrics: Metric[]) => Promise<void>

class Profiler {
  zen: Zen
  sessionId: string
  logger: Logger

  constructor ({ sessionId, logger }: { sessionId: string, logger: Logger }) {
    this.sessionId = sessionId
    this.logger = logger
  }

  log(name: metric['name'], fields: metric['fields'] = {}) {
    return this.logBatch([{ name, fields }])
  }

  logBatch (metrics: metric[]) {
    return this.logger(
      metrics.map((metric) => {
        metric.fields = metric.fields || {}
        metric.fields.sessionId = this.zen.config.sessionId
        return metric
      })
    )
  }
}

export default Profiler
