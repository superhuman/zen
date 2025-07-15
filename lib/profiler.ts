export type Metric = {
  name: string
  fields: Record<string, string | number>
}

type Logger = (metrics: Metric[]) => Promise<void>

class Profiler {
  runId: string
  logger: Logger

  constructor ({ runId, logger }: { runId: string, logger: Logger }) {
    this.runId = runId
    this.logger = logger
  }

  log(name: Metric['name'], fields: Metric['fields'] = {}): Promise<void> {
    return this.logBatch([{ name, fields }])
  }

  logBatch (metrics: Metric[]): Promise<void> {
    return this.logger(
      metrics.map((metric) => {
        metric.fields = metric.fields || {}
        metric.fields.runId = this.runId
        return metric
      })
    )
  }
}

export default Profiler
