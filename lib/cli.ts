#!/usr/bin/env node

import { execSync } from 'child_process'
import * as fs from 'fs'
import Server from './server'
import initZen, { Zen } from './index'
import yargs from 'yargs'
import ChromeActions from './chrome_actions'
import Util from './util.js'
import { chunk } from 'lodash'

import type { Measure } from './profiler'

type TestResult = {
  name: string
  result: 'pass' | 'fail'
  duration: number
  error?: string
  logStream?: string
  requestId?: string
}
type TestResults = Record<string, TestResult[]>
type LambdaTestResult = {
  fullName: string
  time: number
  error?: string
  stack?: string
  logStream?: string
  requestId?: string
}
type LambdaTestResults = Record<string, LambdaTestResult>
type TestResultStatistics = {
  failCount: number
  passCount: number
  userLevelFlakedTests: string[]
  frameworkLevelFlakedTests: string[]
  failedTests: string[]
  passedTests: string[]
}

export type CLIOptions = {
  logging: boolean
  maxAttempts: number
  debug: boolean
  configFile: string
  reuseBuild?: boolean
  filter?: string
  headed?: boolean
  limit?: number
  verbose?: boolean
  deflake?: boolean
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

      if (argv.maxAttempts === undefined) {
        argv.maxAttempts = argv.deflake ? 20 : 3
      }

      if (argv.headed) {
        process.env.ASSET_BUCKET = zen.config.aws.assetBucket
        process.env.AWS_REGION = zen.config.aws.region
      }

      if (argv.verbose) {
        process.env.VERBOSE = 'true'
      }

      run(zen, argv)
    }
  )
  .options({
    logging: { type: 'boolean', default: false },
    maxAttempts: { type: 'number', default: undefined },
    debug: { type: 'boolean', default: false },
    filter: {
      type: 'string',
      default: undefined,
      describe: 'Runs tests that contain the passed filter string.',
    },
    reuseBuild: {
      type: 'boolean',
      default: false,
      describe:
        'Skips the test repo build and upload process and uses built files on disk. Useful for iterating on zen library changes.',
    },
    headed: { type: 'boolean', description: 'Run in headed mode' },
    limit: { type: 'number', default: undefined },
    verbose: { type: 'boolean', default: false },
    deflake: {
      type: 'boolean',
      default: false,
      describe: 'Run the tests many times to track down flakes.',
    },
  }).argv

const COMMON_FRAMEWORK_ERRORS = [
  'Puppeteer stalled',
  'Lambda Timeout Exceeded',
  'Chrome-level test timeout',
  'while waiting for the WS endpoint URL to appear in stdout!',
]

function groupTests({
  zen,
  tests,
  deflake,
  maxAttempts,
  concurrency,
}: {
  zen: Zen
  tests: string[]
  deflake: boolean
  maxAttempts: number
  concurrency: number
}): { tests: string[]; time: number }[] {
  if (deflake) {
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

// TODO: just put this inside chrome actions
async function runTestGroupOnLambda(chromeActions, group) {
  try {
    const result = await chromeActions.workTests({
      testNames: group.tests,
    })
    return result
  } catch (e) {
    console.error(e)
    return group.tests.map((name: string) => {
      return {
        fullName: name,
        error: `zen failed to run this group: ${e.stack || e.message}`,
        frameworkError: true,
        time: 0,
      }
    })
  }
}

async function runTests(
  zen: Zen,
  opts: CLIOptions,
  tests: string[]
): Promise<Record<string, TestResult[]>> {
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
  })

  function runTestGroup(group: { tests: string[] }) {
    queue.add(async () => {
      let lambdaTestResults: LambdaTestResult[] = await runTestGroupOnLambda(
        chromeActions,
        group
      )

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

        if (
          !opts.deflake &&
          lambdaResult.error &&
          testAttempts < opts.maxAttempts
        ) {
          testRetries.push(testName)
        }
      }

      // If the group size hasn't changed. Implying no tests completed
      // we break up the tests into seperate runs in case one test is blocking
      // the others.
      if (testRetries.length === group.tests.length) {
        testRetries.forEach((testName) => {
          runTestGroup({ tests: [testName] })
        })
      } else if (testRetries.length) {
        runTestGroup({ tests: testRetries })
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

async function run(zen: Zen, opts: CLIOptions) {
  const testRunMeasure = zen.profiler.start('log.zen_test_run')
  const chromeActions = new ChromeActions({ headed: opts.headed, zen })

  try {
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
      testRunMeasure.mark(`Webpack Build Time`)

      console.log('Syncing to S3')
      zen.s3Sync.on(
        'status',
        (msg: string) => (opts.debug || process.env.DEBUG) && console.log(msg)
      )
      await zen.s3Sync.run(zen.indexHtml('worker', true))
      testRunMeasure.mark(`Sync Time`)
    }

    console.log('Getting test names')

    let workingSet: string[] = await chromeActions.listTests()

    if (opts.filter) {
      const filter = opts.filter.trim()
      console.log(`Filtering tests by "${filter}"`)
      workingSet = workingSet.filter((testName) => {
        return testName.includes(filter)
      })
    }

    if (opts.limit) {
      workingSet = workingSet.slice(0, opts.limit)
    }

    testRunMeasure.mark(`Test Name Get Time`)

    console.log(
      `Running ${workingSet.length} test${workingSet.length > 1 ? 's' : ''}`
    )
    const testResults: Record<string, TestResult[]> = await runTests(
      zen,
      opts,
      workingSet
    )

    testRunMeasure.mark('Run Tests')

    const resultStatistics = generateTestResultStatistics(testResults)

    if (opts.logging) {
      const metrics = []

      for (const testName in testResults) {
        const testRuns = testResults[testName]
        let attempt
        for (const testRun of testRuns) {
          attempt++
          metrics.push({
            name: 'log.zen_single_test_result',
            fields: {
              ...testRun,
              attempt,
            },
          })
        }
      }

      metrics.push({
        name: 'log.zen_test_run',
        fields: {
          ...testRunMeasure.getMetric(),
          result: resultStatistics.failCount === 0 ? 'pass' : 'fail',
          fail_count: resultStatistics.failCount,
          user_flake_count: resultStatistics.userLevelFlakedTests.length,
          framework_flake_count:
            resultStatistics.frameworkLevelFlakedTests.length,
          total_count: resultStatistics.failCount + resultStatistics.passCount,
        },
      })
      try {
        await zen.profiler.logBatch(metrics)
      } catch (e) {
        console.error(e)
      }
    }

    testRunMeasure.mark('Collect Statistics')

    printRunStatistics({
      resultStatistics,
      testResults,
      testRunMeasure,
    })

    // Prevent process from exiting in headed so developer can
    // freely interact with chrome devtools.
    if (opts.headed) {
      const forever = new Promise(() => {})
      await forever
    }

    process.exit(resultStatistics.failCount ? 1 : 0)
  } catch (e) {
    if (opts.headed) {
      const forever = new Promise(() => {})
      await forever
    }

    console.error(e)
    process.exit(1)
  }
}

function printHeading(headingName: string) {
  console.log('')
  console.log(headingName)
  console.log('-'.repeat(headingName.length))
}

function getHumanReadableTime(timeInMs: number): string {
  const totalSeconds = timeInMs / 1000
  const minutes = totalSeconds / 60

  if (minutes >= 1) {
    return `${minutes.toFixed(2)} minutes`
  }
  if (totalSeconds >= 1) {
    return `${totalSeconds.toFixed(2)} seconds`
  }
  return `${timeInMs.toFixed(2)} ms`
}

function generateTestResultStatistics(
  testResults: TestResults
): TestResultStatistics {
  // Flakes that came from within the zen framework.
  const frameworkLevelFlakedTests: string[] = []
  // Flakes that came from the user written test level.
  const userLevelFlakedTests: string[] = []
  const failedTests: string[] = []
  const passedTests: string[] = []

  for (const testName in testResults) {
    const testRuns = testResults[testName]
    const testAttempts = testRuns.length
    const didPass = testRuns.some((testRun) => testRun.result === 'pass')
    const hasFailed = testRuns.some((testRun) => testRun.result === 'fail')
    // TODO: get a more robust way of identifying framework vs user error instead of string matching.
    const hasUserLevelFail = testRuns.some((testRun) => {
      return (
        testRun.result === 'fail' &&
        COMMON_FRAMEWORK_ERRORS.every(
          (frameworkError) => !testRun.error.includes(frameworkError)
        )
      )
    })

    if (didPass) {
      passedTests.push(testName)
      if (hasFailed && hasUserLevelFail) {
        userLevelFlakedTests.push(testName)
      } else if (hasFailed) {
        frameworkLevelFlakedTests.push(testName)
      }
    } else {
      failedTests.push(testName)
    }
  }

  return {
    passCount: passedTests.length,
    failCount: failedTests.length,
    frameworkLevelFlakedTests,
    userLevelFlakedTests,
    failedTests,
    passedTests,
  }
}

function printRunStatistics({
  resultStatistics,
  testResults,
  testRunMeasure,
}: {
  resultStatistics: TestResultStatistics
  testResults: TestResults
  testRunMeasure: Measure
}) {
  const {
    frameworkLevelFlakedTests,
    userLevelFlakedTests,
    failedTests,
    passedTests,
  } = resultStatistics
  const performanceMetric = testRunMeasure.getMetric()

  if (process.env.VERBOSE === 'true' && frameworkLevelFlakedTests.length) {
    printHeading('Framework Level Flaked Tests')
    for (const testName of frameworkLevelFlakedTests) {
      const testRuns = testResults[testName]
      const testAttempts = testRuns.length
      console.log(`⚠️ ${testName} (flaked ${testAttempts - 1}x)`)
      testRuns.forEach((test) => {
        if (
          test.error &&
          COMMON_FRAMEWORK_ERRORS.some((frameworkError) =>
            test.error.includes(frameworkError)
          )
        ) {
          console.log(test.error)

          if (test.logStream) {
            console.log(`logStream: ${test.logStream}`)
          }
          console.log('')
        }
      })
    }
  }

  if (userLevelFlakedTests.length) {
    printHeading('Flaked Tests')
    for (const testName of userLevelFlakedTests) {
      const testRuns = testResults[testName]
      const testAttempts = testRuns.length
      console.log(`⚠️ ${testName} (flaked ${testAttempts - 1}x)`)
      testRuns.forEach((test) => {
        if (
          test.error &&
          COMMON_FRAMEWORK_ERRORS.every(
            (frameworkError) => !test.error.includes(frameworkError)
          )
        ) {
          console.log(test.error)

          if (test.logStream) {
            console.log(`logStream: ${test.logStream}`)
          }
          console.log('')
        }
      })
    }
  }

  if (failedTests.length) {
    printHeading('Errored Tests')
    for (const testName of failedTests) {
      const testRuns = testResults[testName]
      const testAttempts = testRuns.length
      const mostRecentTest = testRuns.findLast((test) => {
        return !!test.error
      })
      console.log(`🔴 ${testName} (tried ${testAttempts} times)`)
      console.log(mostRecentTest.error)
      if (mostRecentTest.logStream) {
        console.log(`logStream: ${mostRecentTest.logStream}`)
      }
    }
  }

  if (process.env.VERBOSE === 'true') {
    printHeading('Performance Report')
    testRunMeasure.getMarks().forEach((mark) => {
      console.log(`- ${mark.name}: ${getHumanReadableTime(mark.duration)}`)
    })
  }

  printHeading('Results')
  console.log(
    '⏰ Total Time:',
    getHumanReadableTime(performanceMetric.fields.value)
  )
  if (passedTests.length) {
    console.log(`🟢 ${passedTests.length} successful tests!`)
  }

  const frameworkFlakeCount = frameworkLevelFlakedTests.length
  if (frameworkFlakeCount > 0) {
    console.log(
      `⚠️🛠️ ${frameworkFlakeCount} framework level flaked test${
        frameworkFlakeCount === 1 ? '' : 's'
      }.`
    )
  }

  const userFlakeCount = userLevelFlakedTests.length
  if (userFlakeCount > 0) {
    console.log(
      `⚠️🫵 ${userFlakeCount} user level flaked test${
        userFlakeCount === 1 ? '' : 's'
      }.`
    )
  }

  const failCount = failedTests.length
  console.log(
    `${failCount ? '😢' : '🎉'} ${failCount} failed test${
      failCount === 1 ? '' : 's'
    }`
  )
}
