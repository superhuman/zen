#!/usr/bin/env node

// @ts-expect-error server is not typed
import Server from './server'
import initZen from './index'
import yargs from 'yargs'
import { invoke, workTests } from './util'
import * as Profiler from './profiler'
import { TestResultCollection, Zen } from './types'

export type CLIOptions = {
  logging: boolean
  maxAttempts: number
  debug: boolean
  configFile: string
}

yargs(process.argv.slice(2))
  .usage('$0 <cmd> [configFile]')
  .command(
    ['local [configFile]', 'server [configFile]'],
    'Run zen with a local server',
    // @ts-expect-error yargs changed their type def but this pattern still works
    (yargs: yargs.Argv) => {
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
    // @ts-expect-error yargs changed their type def but this pattern still works
    (yargs: yargs.Argv) => {
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
  }).argv

async function runTests(
  zen: Zen,
  opts: CLIOptions,
  tests: string[]
): Promise<TestResultCollection> {
  const groups = zen.journal.groupTestsWithDuplication(
    tests,
    zen.config.lambdaConcurrency
  )

  const testResultGroups: TestResultCollection[] = await Promise.all(
    groups.map(
      async (group: { tests: string[] }): Promise<TestResultCollection> => {
        const testNames = group.tests
        try {
          const response = await workTests(zen, {
            deflakeLimit: opts.maxAttempts,
            sessionId: zen.config.sessionId,
            testNames,
          })
          const logStream = response.logStreamName

          // Map back to the old representation and fill in any tests that may have not run
          const results = testNames.reduce<TestResultCollection>(
            (col, fullName) => {
              const results = response.results[fullName] || []
              let success = true
              if (results.length === 0) {
                success = false
              } else if (results.at(-1)?.error) {
                success = false
              }

              col[fullName] = {
                fullName: fullName,
                logStream,
                success,
                results,
              }

              return col
            },
            {}
          )

          return results
        } catch (e) {
          let message = 'Failed to run on remote!'
          if (e instanceof Error) message = e.message

          return testNames.reduce<TestResultCollection>((col, fullName) => {
            col[fullName] = {
              fullName,
              logStream: '',
              success: false,
              results: [
                {
                  fullName,
                  error: message,
                  time: 0,
                },
              ],
            }

            return col
          }, {})
        }
      }
    )
  )

  const testResults = testResultGroups.reduce<TestResultCollection>(
    (acc, results) => {
      for (const testName in results) {
        if (acc[testName]) {
          acc[testName].results = acc[testName].results.concat(
            results[testName].results
          )
          // If the test has ever succeeded, then it is a success
          acc[testName].success =
            acc[testName].success || results[testName].success
        } else {
          acc[testName] = results[testName]
        }
      }
      return acc
    },
    {}
  )

  const testErrors: TestResultCollection = {}
  for (const testName in testResults) {
    const result = testResults[testName]
    if (!result.success) {
      testErrors[testName] = result
    }
  }

  return testErrors
}

function combineFailures(
  currentFailures: TestResultCollection,
  previousFailures?: TestResultCollection
): TestResultCollection {
  if (!previousFailures) return currentFailures

  // Combine the current failures with the previous failures
  const failures = { ...previousFailures }
  // Reset the success flag, if they are not being added to that means they succeded
  for (const testName in failures) {
    failures[testName].success = true
  }

  for (const testName in currentFailures) {
    const prevFailure = failures[testName]
    const curFailure = currentFailures[testName]

    if (!prevFailure) {
      failures[testName] = curFailure
    } else {
      failures[testName] = {
        ...prevFailure,
        results: prevFailure.results.concat(curFailure.results),
        success: false,
      }
    }
  }

  return failures
}

async function run(zen: Zen, opts: CLIOptions) {
  try {
    let t0 = Date.now()
    if (zen.webpack) {
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
    }

    t0 = Date.now()
    console.log('Syncing to S3')
    zen.s3Sync.on(
      'status',
      (msg: string) => (opts.debug || process.env.DEBUG) && console.log(msg)
    )
    await zen.s3Sync.run(zen.indexHtml('worker', true))
    console.log(`Took ${Date.now() - t0}ms`)

    t0 = Date.now()
    console.log('Getting test names')
    // @ts-expect-error(2322) invoke return is not typed right now
    let workingSet: string[] = await invoke(
      zen,
      zen.config.lambdaNames.listTests,
      {
        sessionId: zen.config.sessionId,
      }
    )

    // In case there is an infinite loop, this should brick the test running
    let runsLeft = 5
    let failures: TestResultCollection | undefined
    console.log(`Running ${workingSet.length} tests`)
    while (runsLeft > 0 && workingSet.length > 0) {
      runsLeft--

      const currentFailures = await runTests(zen, opts, workingSet)
      failures = combineFailures(currentFailures, failures)

      const testsToContinue = []
      for (const testName in failures) {
        const failure = failures[testName]
        if (!failure) continue
        if (!failure.success && failure.results.length < opts.maxAttempts) {
          testsToContinue.push(failure.fullName)
        }
      }
      workingSet = testsToContinue
      if (workingSet.length > 0)
        console.log(`Trying to rerun ${workingSet.length} tests`)
    }

    let failCount = 0
    for (const test of Object.values(failures || {})) {
      const lastResult = test.results.at(-1)
      const attempts = test.results.length || 1
      if (!lastResult) continue

      if (lastResult.error) {
        failCount += 1
        console.log(
          `🔴 ${test.fullName} ${lastResult.error} (tried ${
            attempts || 1
          } times)`
        )
      } else if (test.results.length > 1) {
        console.log(`⚠️ ${test.fullName} (flaked ${attempts - 1}x)`)
      }
    }

    console.log(`Took ${Date.now() - t0}ms`)
    console.log(
      `${failCount ? '😢' : '🎉'} ${failCount} failed test${
        failCount === 1 ? '' : 's'
      }`
    )
    process.exit(failCount ? 1 : 0)
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
}
