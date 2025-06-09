#!/usr/bin/env node

import { execSync } from 'child_process'
import Server from './server'
import initZen, { Zen } from './index'
import yargs, { fail } from 'yargs'
import * as Util from './util.js'
import * as Profiler from './profiler'

type TestFailure = {
  fullName: string
  attempts: number
  error: string
  time: number
  stack?: string
}

export type CLIOptions = {
  logging: boolean
  maxAttempts: number
  debug: boolean
  reuseBuild: boolean
  configFile: string
}

yargs(process.argv.slice(2))
  .usage('$0 <cmd> [configFile]')
  .command(
    ['local [configFile]', 'server [configFile]'],
    'Run zen with a local server',
    (yargs) => {
      yargs.positional('file', {
        type: 'string',
        describe: 'Path to the config file',
      })
    },
    async (argv: CLIOptions) => {
      await initZen(argv.configFile)
      new Server()
    }
  )
  .command(
    'remote [configFile]',
    'Run zen in the console',
    (yargs) => {
      yargs.positional('file', {
        type: 'string',
        describe: 'Path to the config file',
      })
    },
    async (argv: CLIOptions) => {
      const zen = await initZen(argv.configFile)
      run(zen, argv)
    }
  )
  .options({
    logging: { type: 'boolean', default: false },
    maxAttempts: { type: 'number', default: 3 },
    debug: { type: 'boolean', default: false },
    reuseBuild: { type: 'boolean', default: false },
    showRemoteLogs: { type: 'boolean', default: false },
    filter: { type: 'string' },
  }).argv

type TestResultsMap = Record<string, TestFailure>

async function runTests(
  zen: Zen,
  opts: CLIOptions,
  tests: string[]
): Promise<TestResultsMap> {
  const groups = zen.journal.groupTests(tests, zen.config.lambdaConcurrency)

  const failedTests: TestFailure[][] = await Promise.all(
    groups.map(async (group: { tests: string[] }): Promise<TestFailure[]> => {
      try {
        const response = await Util.invoke(zen.config.lambdaNames.workTests, {
          deflakeLimit: opts.maxAttempts,
          testNames: group.tests,
          sessionId: zen.config.sessionId,
        })

        // errors or more than one attempt
        return response.filter((r: TestFailure) => r.error || r.attempts > 1)
      } catch (e) {
        console.error(e)
        return group.tests.map((name: string) => {
          return {
            fullName: name,
            attempts: 0,
            error: 'zen failed to run this group',
            time: 0,
          }
        })
      }
    })
  )

  return failedTests
    .flat()
    .reduce((acc: Record<string, TestFailure>, result: TestFailure) => {
      acc[result.fullName] = result
      return acc
    }, {})
}

async function run(zen: Zen, opts: CLIOptions) {
  try {
    let t0 = Date.now()
    if (zen.webpack && !opts.reuseBuild) {
      console.log('Webpack building')
      let previousPercentage = 0
      zen.webpack.on(
        'status',
        (_status: string, stats: { message: string; percentage: number }) => {
          if (stats.percentage && stats.percentage > previousPercentage) {
            previousPercentage = stats.percentage
            console.log(`${stats.percentage}% ${stats.message}`)
          }
        }
      )
      await zen.webpack.build()
      console.log(`Took ${Date.now() - t0}ms`)
      t0 = Date.now()
      console.log('Syncing to S3')
      zen.s3Sync.on(
        'status',
        (msg: string) => (opts.debug || process.env.DEBUG) && console.log(msg)
      )
      await zen.s3Sync.run(zen.indexHtml('worker', true))
      console.log(`Took ${Date.now() - t0}ms`)
    } else {
      console.log('Reusing existing build.')
    }

    t0 = Date.now()
    console.log('Getting test names')
    let workingSet: string[] = await Util.invoke(
      zen.config.lambdaNames.listTests,
      {
        sessionId: zen.config.sessionId,
      }
    )

    if (opts.filter) {
      console.log('Filtering tests by "', opts.filter, '"')
      workingSet = workingSet.filter((testName) => {
        return testName.includes(opts.filter)
      })
    }

    // In case there is an issue with the lamda retry mechanism we
    // cap the number of times we will try to prevent going into an
    // infinite loop. The actual retrying is happening on the lamdaWorker.
    const MAX_ATTEMPTS = opts.maxAttempts
    const runFailures: TestResultsMap = {}
    const runFlakes: TestResultsMap = {}
    let attempt = 0
    console.log(`Running ${workingSet.length} tests`)
    while (attempt < MAX_ATTEMPTS && workingSet.length > 0) {
      const currentRunFailures = await runTests(zen, opts, workingSet)

      workingSet = []
      for (const failure of Object.values(currentRunFailures)) {
        if (failure.attempts < opts.maxAttempts) {
          runFlakes[failure.fullName] = failure
          workingSet.push(failure.fullName)
        } else {
          delete runFlakes[failure.fullName]
          runFailures[failure.fullName] = failure
        }
      }

      if (workingSet.length > 0)
        console.log(`Trying to rerun ${workingSet.length} tests`)

      attempt++
    }

    const metrics = []
    for (const test of Object.values(runFlakes)) {
      metrics.push(createTestFailLog(test))

      const remoteLoggingCommand = `aws logs get-log-events --log-group-name "/aws/lambda/${zen.config.lambdaNames.workTests}" --log-stream-name '${test.logStream}'`
      if (opts.showRemoteLogs) {
        execSync(remoteLoggingCommand, { stdio: 'inherit', encoding: 'utf8' })
      }

      console.log(`⚠️ ${test.fullName} (flaked ${test.attempts - 1}x)\n ${test.stack || test.error}\nTo View Logs Run: ${remoteLoggingCommand}`)
    }

    for (const test of Object.values(runFailures)) {
      metrics.push(createTestFailLog(test))

      const remoteLoggingCommand = `aws logs get-log-events --query 'events[*].message' --log-group-name "/aws/lambda/${zen.config.lambdaNames.workTests}" --log-stream-name '${test.logStream}'`
      if (opts.showRemoteLogs) {
        execSync(remoteLoggingCommand, { stdio: 'inherit', encoding: 'utf8' })
      }

      console.log(`🔴 ${test.fullName} (tried ${test.attempts || 1} times)\n ${test.stack || test.error}\nTo View Logs Run: ${remoteLoggingCommand}`)
    }

    if (opts.logging) Profiler.logBatch(metrics)

    const failCount = Object.values(runFailures).length
    const flakeCount = Object.values(runFlakes).length
    console.log(`Took ${Date.now() - t0}ms`)
    if (flakeCount > 0) {
      console.log(`⚠️ ${flakeCount} flaked test${flakeCount === 1 ? '' : 's'}.`)
    }
    console.log(`${failCount ? '😢' : '🎉'} ${failCount} failed test${failCount === 1 ? '' : 's'}`)
    process.exit(failCount ? 1 : 0)
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
}

function createTestFailLog(test: TestFailure) {
  return {
    name: 'log.test_failed',
    fields: {
      value: test.attempts,
      testName: test.fullName,
      time: test.time,
      error: test.error,
    }
  }
}
