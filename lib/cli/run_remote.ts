import { invoke, workTests } from '../util'
import * as Profiler from '../profiler'
import { Zen } from '../types'
import { CLIOptions } from './index'
import { encodeXML } from 'entities'
import { writeFileSync } from 'fs'
import { join } from 'path'

type testFailure = {
  resolved?: boolean
  fullName: string
  attempts: number
  error?: string
  time: number
}

type TestResultsMap = Record<string, testFailure>

function resultsToXML(results: TestResultsMap): string {
  const failures = Object.values(results)

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="jest tests" tests="${failures.length}" failures="${
    failures.length
  }" time="0">

${failures
  .map((failure) => {
    return `    <testcase name="${encodeXML(failure.fullName)}" time="${
      failure.time
    }">
      <failure message="${encodeXML(failure.error || '')}"></failure>
    </testcase>`
  })
  .join('\n')}
  </testsuite>
</testsuites>`
  return xml
}

async function runTests(
  zen: Zen,
  opts: CLIOptions,
  tests: string[]
): Promise<TestResultsMap> {
  const groups = zen.journal.groupTests(tests, zen.config.lambdaConcurrency)
  type failedTest = testFailure & { logStream: string }

  const failedTests: failedTest[][] = await Promise.all(
    groups.map(async (group: { tests: string[] }): Promise<failedTest[]> => {
      try {
        const response = await workTests(zen, {
          deflakeLimit: opts.maxAttempts,
          testNames: group.tests,
          sessionId: zen.config.sessionId,
        })
        const logStreamName = response.logStreamName

        // Map back to the old representation and fill in any tests that may have not run
        const results = group.tests.map((test) => {
          const results = response.results[test] || []
          const result = results.at(-1)

          if (!result) {
            console.log(test, response.results, results)
            return {
              fullName: test,
              attempts: 0,
              error: 'Failed to run on remote!',
              time: 0,
              logStream: logStreamName,
            }
          } else {
            return {
              ...result,
              logStream: logStreamName,
              attempts: results.length,
            }
          }
        })

        return results.filter((r: testFailure) => r.error || r.attempts > 1)
      } catch (e) {
        console.error(e)
        return group.tests.map((name: string) => {
          return {
            fullName: name,
            attempts: 0,
            error: 'zen failed to run this group',
            time: 0,
            logStream: '',
          }
        })
      }
    })
  )

  return failedTests
    .flat()
    .reduce((acc: Record<string, testFailure>, result: testFailure) => {
      acc[result.fullName] = result
      return acc
    }, {})
}

function combineFailures(
  currentFailures: TestResultsMap,
  previousFailures?: TestResultsMap
): TestResultsMap {
  if (!previousFailures) return currentFailures

  // Combine the current failures with the previous failures
  const failures = { ...previousFailures }
  // Reset the error state for all the previous tests, that way if they
  // succeed it will report only as a flake
  for (const testName in failures) {
    failures[testName].resolved = true
  }

  for (const testName in currentFailures) {
    const prevFailure = failures[testName]
    const curFailure = currentFailures[testName]

    if (!prevFailure) {
      failures[testName] = {
        ...curFailure,
        resolved: false,
      }
    } else {
      failures[testName] = {
        ...prevFailure,
        resolved: false,
        error: curFailure.error,
        time: prevFailure.time + curFailure.time,
        attempts: prevFailure.attempts + curFailure.attempts,
      }
    }
  }

  return failures
}

export default async function runRemote(
  zen: Zen,
  opts: CLIOptions
): Promise<void> {
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
    let failures: TestResultsMap | undefined
    console.log(`Running ${workingSet.length} tests`)
    while (runsLeft > 0 && workingSet.length > 0) {
      runsLeft--

      const currentFailures = await runTests(zen, opts, workingSet)
      failures = combineFailures(currentFailures, failures)

      const testsToContinue = []
      for (const testName in failures) {
        const failure = failures[testName]
        if (!failure) continue
        if (failure.error && failure.attempts < opts.maxAttempts) {
          testsToContinue.push(failure.fullName)
        }
      }
      workingSet = testsToContinue
      if (workingSet.length > 0)
        console.log(`Trying to rerun ${workingSet.length} tests`)
    }

    const metrics = []
    let failCount = 0
    for (const test of Object.values(failures || {})) {
      metrics.push({
        name: 'log.test_failed',
        fields: {
          value: test.attempts,
          testName: test.fullName,
          time: test.time,
          error: test.error,
        },
      })

      if (test.error) {
        failCount += 1
        console.log(
          `🔴 ${test.fullName} ${test.error} (tried ${
            test.attempts || 1
          } times)`
        )
      } else if (test.attempts > 1) {
        console.log(`⚠️ ${test.fullName} (flaked ${test.attempts - 1}x)`)
      }
    }

    if (opts.logging) Profiler.logBatch(zen, metrics)
    console.log(`Took ${Date.now() - t0}ms`)
    console.log(
      `${failCount ? '😢' : '🎉'} ${failCount} failed test${
        failCount === 1 ? '' : 's'
      }`
    )
    if (opts.junit && failures) {
      const xml = resultsToXML(failures)

      console.log('Writing results to ' + opts.junit)
      writeFileSync(join(process.cwd(), opts.junit), xml)
      process.exit(0)
    } else {
      process.exit(failCount ? 1 : 0)
    }
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
}
