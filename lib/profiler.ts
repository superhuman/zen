export type Metric = {
  name: string
  fields: Record<string, string | number>
}

export type Logger = (metrics: Metric[]) => Promise<void>

class Profiler {
  runId: string
  logger: Logger

  constructor({ runId, logger }: { runId: string; logger: Logger }) {
    this.runId = runId
    this.logger = logger
  }

  log(name: Metric['name'], fields: Metric['fields'] = {}): Promise<void> {
    return this.logBatch([{ name, fields }])
  }

  start(name: Metric['name'], fields: Metric['fields'] = {}) {
    return new Measure({
      name,
      fields,
    })
  }

  logBatch(metrics: Metric[]): Promise<void> {
    return this.logger(
      metrics.map((metric) => {
        metric.fields = metric.fields || {}
        metric.fields.runId = this.runId
        return metric
      })
    )
  }
}

export class Measure {
  name: string
  fields: Record<string, unknown>
  startTime: number
  lastMarkTime: number
  marks: { name: string; duration: number }[]

  constructor({ name, fields }) {
    this.name = name
    this.fields = fields || {}
    this.startTime = performance.now()
    this.lastMarkTime = this.startTime
    this.marks = []
  }

  mark(name) {
    const currentTime = performance.now()
    const mark = { name, duration: currentTime - this.lastMarkTime }
    this.marks.push(mark)
    this.lastMarkTime = currentTime
    return mark
  }

  getMarks() {
    return this.marks
  }

  getMetric(finishFields: Metric['fields'] = {}) {
    const fields = {
      ...finishFields,
      ...this.fields,
      value: performance.now() - this.startTime,
    }

    this.marks.forEach((mark) => {
      fields[mark.name] = mark.duration
    })

    return { name: this.name, fields }
  }
}

export default Profiler
