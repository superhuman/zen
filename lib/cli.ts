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
import type {
  TestResult,
  TestResults,
  LambdaTestResults,
  TestResultStatistics,
  CLIOptions,
} from './types'

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
  'while waiting for the WS endpoint URL to appear in stdout!',
]

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

      testRunMeasure.mark(`webpack_build_time`)

      console.log('Syncing to S3')
      zen.s3Sync.on(
        'status',
        (msg: string) => (opts.debug || process.env.DEBUG) && console.log(msg)
      )
      await zen.s3Sync.run(zen.indexHtml('worker', true))
      testRunMeasure.mark(`sync_time`)
    }

    console.log('Getting test names')

    let workingSet: string[] = await chromeActions.listTests()

    if (process.env.VERBOSE === 'true') {
      console.log(`Found ${workingSet.length} tests`)
    }

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

    testRunMeasure.mark(`test_name_get_time`)

    console.log(
      `Running ${workingSet.length} test${workingSet.length > 1 ? 's' : ''}`
    )

    let testResults: Record<string, TestResult[]> = {}
    testResults = await Util.runTestsOnRemote({
      zen,
      opts,
      tests: workingSet,
    })

    testRunMeasure.mark('run_tests_time')

    const resultStatistics = generateTestResultStatistics(testResults)

    if (opts.logging) {
      const metrics = []

      for (const testName in testResults) {
        const testRuns = testResults[testName]
        let attempt = 0
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

      const testRunMetric = testRunMeasure.getMetric()
      Object.assign(testRunMetric.fields, {
        result: resultStatistics.failCount === 0 ? 'pass' : 'fail',
        fail_count: resultStatistics.failCount,
        user_flake_count: resultStatistics.userLevelFlakedTests.length,
        framework_flake_count:
        resultStatistics.frameworkLevelFlakedTests.length,
        total_count: resultStatistics.failCount + resultStatistics.passCount,
      })
      metrics.push(testRunMetric)
      try {
        await zen.profiler.logBatch(metrics)
      } catch (e) {
        console.error(e)
      }
    }

    testRunMeasure.mark('collect_statistics_time')

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

  if (process.env.VERBOSE === 'true' && passedTests.length) {
    printHeading('Passed Tests')
    for (const testName of passedTests) {
      const testRuns = testResults[testName]
      console.log(`🟢 ${testName}`)
      testRuns
        .filter((t) => !t.error)
        .forEach((test) => {
          console.log(`logStream: ${test.logStream}`)
        })
    }
  }

  if (process.env.VERBOSE === 'true' && frameworkLevelFlakedTests.length) {
    printHeading('Framework Level Flaked Tests')
    for (const testName of frameworkLevelFlakedTests) {
      const testRuns = testResults[testName]
      const testAttempts = testRuns.filter((t) => !!t.error).length
      console.log(`⚠️ ${testName} (flaked ${testAttempts}x)`)
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
      const testAttempts = testRuns.filter((t) => !!t.error).length
      console.log(`⚠️ ${testName} (flaked ${testAttempts}x)`)
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
      console.log(`- ${mark.name.replace('_', ' ')}: ${getHumanReadableTime(mark.duration)}`)
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
  if (process.env.VERBOSE === 'true' && frameworkFlakeCount > 0) {
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
