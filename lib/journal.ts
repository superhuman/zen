import path from 'path'
import { Config, TestResult } from './types'
import { readFile, writeFile } from './util'

type Test = {
  tFail?: number
  tPass?: number
  error?: boolean
}
type State = {
  [key in string]: Test | undefined
}
export default class Journal {
  path: string
  state: State

  constructor(config: Config) {
    this.path = path.join(config.tmpDir, 'journal.json')
    this.state = JSON.parse(readFile(this.path) || '{}')
  }

  record(test: TestResult): void {
    const entry = this.state[test.fullName] || {}
    this.state[test.fullName] = entry

    entry.error = !!test.error
    if (test.error) {
      entry.tFail = test.time
    } else {
      entry.tPass = test.time
    }

    this.lazyFlush()
  }

  guessRuntime(fullName: string): number {
    const entry = this.state[fullName] || {}

    if (entry.error) {
      return Math.max(entry.tPass || 0, entry.tFail || 0)
    } else {
      return entry.tPass || 200
    }
  }

  groupTests(
    tests: string[],
    concurrency: number
  ): { time: number; tests: string[] }[] {
    const runGroups: { time: number; tests: string[] }[] = []
    tests
      .sort((testA: string, testB: string) => {
        const a = this.guessRuntime(testA)
        const b = this.guessRuntime(testB)

        if (a > b) {
          return -1
        } else if (a < b) {
          return 1
        } else {
          return 0
        }
      })
      .forEach((fullName) => {
        let min = runGroups[0]
        const time = this.guessRuntime(fullName)
        const newTime = min ? min.time + time : time

        // Assign tests to whichever group has the lowest total time. Groups can grow to about 500ms
        // before we create a new one, and never create more than the concurrency limit.
        if ((!min || newTime > 500) && runGroups.length < concurrency)
          min = { tests: [], time: 0 }
        else runGroups.shift()

        min.tests.push(fullName)
        min.time += time

        // sorted insert into runGroups
        const pos = runGroups.findIndex((g) => g.time > min.time)
        pos == -1 ? runGroups.push(min) : runGroups.splice(pos, 0, min)
      })
    return runGroups
  }

  flushTimeout?: NodeJS.Timeout
  lazyFlush(): void {
    this.flushTimeout =
      this.flushTimeout || setTimeout(this.flush.bind(this), 5000)
  }

  async flush(): Promise<void> {
    if (this.flushTimeout) clearTimeout(this.flushTimeout)

    this.flushTimeout = undefined
    await writeFile(this.path, JSON.stringify(this.state))
  }
}
