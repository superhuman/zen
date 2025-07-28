import connect from 'connect'
import serveStatic from 'serve-static'
import path from 'path'
import fs from 'fs'
const svelte = require('svelte')
import fetch from 'node-fetch'
import WebSocket from 'ws'
import { camelCase, upperFirst } from 'lodash'
import ChromeActions from './chrome_actions'
import { chunk } from 'lodash'

import type { TestResult, CLIOptions, LambdaTestResult } from './types'
import type { Zen } from './index'

let iconCache: string | null = null

function groupTests({
  zen,
  tests,
  deflake,
  maxAttempts,
  concurrency,
  headed,
}: {
  zen: Zen
  tests: string[]
  deflake: boolean
  maxAttempts: number
  concurrency: number
  headed: boolean
}): { tests: string[]; time: number }[] {
  if (headed) {
    // Run all tests in same group to prevent browser closing and
    // opening in headed mode.
    return [{ tests, time: 0 }]
  } else if (deflake) {
    const groups = []
    for (let i = 0; i < maxAttempts; i++) {
      tests.forEach((test) => {
        groups.push({ tests: [test], time: 0 })
      })
    }
    return groups
  } else {
    return chunk(tests, 1).map((testChunk) => {
      return { tests: testChunk, time: 0 }
    })
  }
}

class Util {
  static serveWith404(dir: string) {
    return connect()
      .use(serveStatic(dir))
      .use((i, o) => {
        o.statusCode = 404
        o.end()
      })
  }

  static serveSvelte(req: any, res: any) {
    let name = path.basename(req.url, '.js')
    fs.readFile(
      path.join(__dirname, '../lib', name + '.html'),
      'utf8',
      function (err, data) {
        if (err) throw err
        name = name[0].toUpperCase() + name.slice(1)
        try {
          const { js } = svelte.compile(data, {
            format: 'iife',
            name: name,
            store: true,
          })
          const code = js.code.replace(`var ${name} =`, `Zen.${name} =`)
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
          })
          res.end(code, 'utf8')
        } catch (e) {
          res.statusCode = 500
          console.error(e)
          res.end()
        }
      }
    )
  }

  static async serveIcons(req: any, res: any) {
    if (iconCache) return res.end(iconCache)
    const icons: Record<string, string> = {}
    const root = path.join(__dirname, '../assets')
    await Promise.all(
      fs.readdirSync(root).map(async (fname) => {
        if (!fname.match(/([\w_\-]+)\.svg$/)) return null
        // @ts-expect-error Unclear why this thinks its unknown.
        icons[upperFirst(camelCase(RegExp.$1))] = await Util.readFileAsync(
          path.join(root, fname)
        )
      })
    )

    iconCache = 'Zen.icons = ' + JSON.stringify(icons)
    res.end(iconCache)
  }

  static wsSend(ws: any, obj: any) {
    if (!ws || ws.readyState != WebSocket.OPEN) return
    ws.send(JSON.stringify(obj), (error) => {
      if (error) console.error('Websocket error', error)
    })
  }

  static async post(url: string, obj: any) {
    const resp = await fetch(url, { method: 'POST', body: JSON.stringify(obj) })
    const body = await resp.text()

    if (resp.status === 200) {
      return JSON.parse(body)
    } else {
      throw new Error(`Error on ${url}: ${resp.status} ${body}`)
    }
  }

  static readFile(p: string, encoding?: string) {
    if (encoding === undefined) encoding = 'utf8'
    Util.ensureDir(path.dirname(p))
    if (!fs.existsSync(p)) return ''
    // @ts-expect-error
    return fs.readFileSync(p, encoding)
  }

  static async readFileAsync(p: string, encoding?: string) {
    if (encoding === undefined) encoding = 'utf8'
    Util.ensureDir(path.dirname(p))
    return new Promise((res, rej) => {
      // @ts-expect-error
      fs.readFile(p, encoding, (err, data) => res(data))
    })
  }

  static async writeFile(p: string, data = '') {
    Util.ensureDir(path.dirname(p))
    return new Promise((res, rej) => {
      // @ts-expect-error
      fs.writeFile(p, data, (err) => res())
    })
  }

  static ensureDir(dir: string) {
    const parent = path.dirname(dir)
    fs.existsSync(parent) || Util.ensureDir(parent)
    fs.existsSync(dir) || fs.mkdirSync(dir)
  }

  static verboseLog(...args: any[]) {
    if (process.env.VERBOSE === 'true') {
      console.log(args)
    }
  }

  static last(arr: any[]): any {
    return arr[arr.length - 1]
  }

  static async runTestsOnRemote({
    zen,
    opts,
    tests,
    onResult,
  }: {
    zen: Zen
    opts: {
      maxAttempts: number
      deflake?: boolean
      headed?: boolean
      isLocal?: boolean
    }
    tests: string[]
    onResult?: (result: LambdaTestResult, finalAttempt: boolean) => void
  }): Promise<Record<string, TestResult[]>> {
    const chromeActions = new ChromeActions({ headed: opts.headed, zen })
    const testResults: Record<string, TestResult[]> = {}
    const concurrency = opts.headed ? 1 : zen.config.lambdaConcurrency
    const { default: PQueue } = await import('p-queue')
    const queue = new PQueue({ concurrency })
    const groups = groupTests({
      zen,
      tests,
      deflake: opts.deflake,
      maxAttempts: opts.maxAttempts,
      concurrency,
      headed: opts.headed,
    })

    function runTestGroup(group: { tests: string[] }) {
      queue.add(async () => {
        let lambdaTestResults: LambdaTestResult[] =
          await chromeActions.workTests({ testNames: group.tests })

        const testRetries: string[] = []

        for (const lambdaResult of lambdaTestResults) {
          const testName = lambdaResult.fullName
          if (!testResults[testName]) {
            testResults[testName] = []
          }

          testResults[testName].push({
            name: lambdaResult.fullName,
            result: lambdaResult.error ? 'fail' : 'pass',
            duration: lambdaResult.time,
            error: lambdaResult.error,
            logStream: lambdaResult.logStream,
            requestId: lambdaResult.requestId,
          })
          const testAttempts = testResults[testName].length

          let finalAttempt = true

          // On local zen for skip_ci tests they will show up as test not found.
          // we mark these as ok since we didn't want to run them on ci in the first place.
          // TODO: filter these upstream so we don't need this hack.
          if (opts.isLocal && lambdaResult.error === 'test not found') {
            delete lambdaResult.error
          }

          if (
            !opts.headed &&
            !opts.deflake &&
            lambdaResult.error &&
            testAttempts < opts.maxAttempts
          ) {
            finalAttempt = false
            testRetries.push(testName)
          }

          if (onResult) {
            onResult(lambdaResult, finalAttempt)
          }
        }

        // If the group size hasn't changed. Implying no tests completed
        // we break up the tests into seperate runs in case one test is blocking
        // the others.
        if (testRetries.length) {
          testRetries.forEach((testName) => {
            runTestGroup({ tests: [testName] })
          })
        }
      })
    }

    return new Promise((resolve) => {
      for (const group of groups) {
        runTestGroup(group)
      }

      const intervalId = setInterval(() => {
        if (queue.pending || queue.size) {
          console.log(`${queue.pending} In Flight - ${queue.size} in Queue`)
        }
      }, 1_000)

      queue.on('idle', () => {
        clearInterval(intervalId)
        resolve(testResults)
      })
    })
  }
}

export default Util
