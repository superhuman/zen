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
  flakeCount: number
  passCount: number
  flakedTests: string[]
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
  showRemoteLogs?: boolean
  headed?: boolean
  limit?: number
  csv?: boolean
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
        argv.maxAttempts = argv.deflake ? 10 : 3
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
    showRemoteLogs: { type: 'boolean', default: false },
    headed: { type: 'boolean', description: 'Run in headed mode' },
    limit: { type: 'number', default: undefined },
    verbose: { type: 'boolean', default: false },
    csv: {
      type: 'boolean',
      default: false,
      describe: 'Output test results to CSV file',
    },
    deflake: {
      type: 'boolean',
      default: false,
      describe: 'Run the tests many times to track down flakes.',
    },
  }).argv

const SKIPPED_TESTS = [
  'MessageBody > signature detection > via miscellaneous content > should show content before the dash in this message',
  'ReadStatus > details > regular (non-shared) read statuses > when some of the reads are from the same user, device, and within the same minute > should show only one read',
  'ReadStatus > details > regular (non-shared) read statuses > when the reads are from known email addresses > should show the reads in sorted order on hover',
  'Calendar edit event > keyboard navigation > should clear out the timezone field without prompting for discard when pressing escape',
  'Calendar edit event > keyboard navigation > should close the timezone suggestion dropdown that appears after clearing out the field when pressing escape',
  'ThreadMessages Scroll > On send > should not scroll messages out of view after expanding and collapsing a message',
  'ThreadMessages Scroll > On scroll down > should not scroll messages out of view after expanding and collapsing a message',
  'ThreadMessages Scroll > On jump down > should not scroll messages out of view after expanding and collapsing a message',
  'ThreadMessages Scroll > On compose > when the focused message is near the bottom of the screen > replying to a short message should put the bottom of the compose form 180px from the bottom of the page',
  'ThreadMessages Scroll > On compose > when the compose form would be hidden by the ThreadPane-header > replying should scroll the compose form to the middle of the page',
  'CalendarCreateEvent > Undo > undoing an all-day event > should show the event when undoing an all day event',
  'ImagePreProcessor > should not flip images on chrome >= 81',
  'SplitInbox > (microsoft):  > should correctly handle removing a message from a Starred split',
  `AI TLDR > remote summary updates > should silently update the summary if the summary is updated after the user clicks "show new messages"`,
  `Calendar edit event > submission > (microsoft):  > should correctly submit timezone updates to the backend`,
  `ReadStatus > details > regular (non-shared) read statuses > when some of the reads have a known email, and some do not > should show the reads in sorted order on hover`,
  `ReadStatus > details > regular (non-shared) read statuses > when the readers have similar names > should disambiguate their names as much as possible`,
  `CalendarCreateEvent > Instant Event > With AI enabled > should create an instant event from Command Palette in draft`,
  `ReadStatus > details > regular (non-shared) read statuses > should include the upsell under the footer of the hover tooltip when can add to team`,
  `ReadStatus > details > regular (non-shared) read statuses > when the reads are not associated with any particular email address > should show the reads in sorted order on hover`,
  `AI Agent > Create Calendar Event > should only show the event if there is no more content other than the xml`,
  `ReadStatus > details > shared read statuses > should have a sticky header and footer`,
  `BulkRefer > BulkReferScreen state > should include the referred contact at the top of the list`,
  `Multiplayer shared threads > Share thread dialog > when a thread has been shared > should not filter out non-teammates`,
  `(microsoft): Outlook Calendar > (microsoft): description rendering > shows the description field in the sidebar event`,
  'Delete Events > (microsoft):  > (microsoft): single events > (microsoft): Undoing the deletion > should return the event',
  'Modifier disk > getNextModifierToPersistAsync > should prefer the send_mail even if the delayed modifier is older',
  'Share availability > (google) > invitees > should display an avatar stack with at most 8 avatars (organizer included) in the collapsed menu',
  'Share availability > (google) > invitees > should display an avatar stack with at most 8 avatars (organizer included) in the collapsed menu',
  'Share availability > (google) > invitees > should display an avatar stack with at most 8 avatars (organizer included) in the collapsed menu',
  'features/CalendarInvites > should authorize with Google if a user selects Google within the sidebar',
  'BulkRefer > BulkReferScreen state > should allow dismissing a suggestion with the mouse',
  'BulkRefer > should populate the names from the contact store',
  'improved scrolling > direct share > should scroll to the last message if joined by clicking a link',
  'improved scrolling > direct share > should scroll to the closest message to when the user was added if the thread is fully unread',
  'Meet With > transitions between states > in SYW (google) should allow dragging all-day events to edit even when Meet With has an attendee',
  'features/CalendarInvites > should authorize with Microsoft if a user selects Microsoft within the sidebar',
  'features/CalendarInvites > authorize calendar aliases > should authorize with Microsoft if a user selects Microsoft within the alert',
  'features/CalendarInvites > authorize calendar aliases > should authorize with Google if a user selects Google within the alert',
  'AI Agent > Create Calendar Event > Displays zoom call when link is zoom',
  'AI Agent > AI Agent chat > should go to thread when clicking on source when blank draft is opened',
  'AI Agent > AI Agent chat > should go to thread when clicking on source when draft with content is opened',
  'AI Agent > Create Calendar Event > should show create event UI when there is a calendar event in the response',
  'AI Agent > Create draft card > should show the reply draft card',
  'SeeYourWeek > All Day Events > should render many all day events',
  'AI Agent > AI Agent chat > should show sources in order when retrievals are returned in multiple events',
  'AI Agent > AI Agent chat > should let user expand sources when there is citation',
  'AI Agent > AI Agent chat > should show sources when there are citations in the answer',
  'AI Agent > AI Agent chat > should return answer for the question',
  'AI Agent > AI Agent answer render > should render without triple backtick',
  'ComposeForm > should keep inline images added before editing the subject line in forwards',
  'LoadInlineImages > (microsoft): inline attachments from o365 > should be rendered',
  'RightPane > should reset the right pane when switching matchers',
  'Footer > Recent Opens > should toggle disableActivityFeed when clicked',
  'ThreadList > should support loading a large number of threads',
  'ReadStatus > checkboxes > should show the double checkmark when the message has a reply but no reads',
  'ReadStatus > checkboxes > should show the double checkmark when the message has a draft but no reads',
  'ThreadMessagesHeader > should remove readstatus tooltip when pressing esc in threadlist',
  'ProfilePictureCache > deletes memory and cache storage for Google string based profile pictures',
  'ProfilePictureCache > deletes memory and cache storage for o365 Blob based profile pictures',
  'editor/autocorrection > inside squire > correct casing > two capital letters in token > capitals at start, lower score, contact',
  `AI compose > cleaning response > shouldn't strip signoffs if user has signoff in userdata`,
  `Auto Labels > Edit Auto Label Dialog > should delete an Auto Label`,
  `Auto Label Library > should scroll the category list into view when clicking a particular category`,
  `Debouncer > throttleForOperation > should not call the throttled function again if called after the timeout but before function finished if the operation has finished`,
  `BulkRefer > SendBulkReferAction > should run a SendBulkReferAction when clicking "Send Referrals"`,
  `BulkRefer > BulkReferScreen state > should disallow selecting a dismissed suggestion`,
  `HubspotEditContact > Edit form via cmd+k > should open the contact form via cmd+k edit`,
  `HubspotEditContact > Edit form via cmd+k > should focus correct form field if editing field via cmd+k`,
  `Backdrop > should reload the background image immediately when the network comes back online`,
  `Multiplayer shared threads > Share thread dialog > when a thread hasn't been shared yet > copy link confirmation dialog > shouldn't list anyone if no teammates are on the thread`,
  `features/Quick Tips > Quick Tips > should show thread message tips when navigating back from SYW after creating calendar`,
  `SplitInbox > Auto labels in splits > Auto label creation from split > should preserve changes made to the name and query in an existing split before entering the "create a new auto label flow"`,
  `SplitInbox > Auto labels in splits > Auto label creation from split > should preserve changing the join type in an existing split before entering the create a new auto label flow`,
  `features/snippets > snippets folder > Snippet metrics > sorts by column`,
  `features/snippets > snippets folder > should show the calendar sidebar when requested`,
  `SplitInbox > News split > should not show a thread list top status when defined`,
  `(microsoft): MoveAction > can move a thread from a custom split to another folder`,
  `(microsoft): MoveAction > can undo a move to important`,
  `(microsoft): MoveAction > can move a thread from "Other" to another folder`,
  `(microsoft): MoveAction > supports \`undo\` on moves where only some messages are in the source folder`,
  `(microsoft): MoveAction > can move threads to important`,
  'AI Agent > AI Agent answer render > should render without triple backticks',
  'AI Agent > Create Calendar Event > When create event and press edit, the popout view should move, and when dismissed, the view should return to its original position',
  'Share availability > (google) > invitees > should display at most 8 attendees and a message with the remaining attendees amount',
  'AI Agent > AI Agent chat > should render calendar sources',
  'BulkRefer > BulkReferScreen state > should restore the state when undoing the send including unselected new contacts',
  'BulkRefer > BulkReferScreen state > should keep the state of the refer screen when closing and reopening',
  'HubspotEditContact > Edit form via cmd+k > should focus first field if editing object via cmd+k',
  'Multiplayer shared threads > tooltip > should show the list of participants including the publisher',
  'SplitInbox > Auto labels in splits > Auto label creation from split > should be able to add an auto label before creating a new auto label',
  'AI Agent > AI Agent chat > should show user copy button',
  'AI Agent > AI Agent chat > should show sources when retrievals are returned in a single events',
  'SplitInbox > (microsoft):  > should correctly show messages in important/other',
  'Select All > Hint > should display correct copy on select all',
  'improved scrolling > oldest unread at-mention > should fall back to message unread state if thread bumps are missing',
  'improved scrolling > direct share > should scroll to the closest comment to when the user was added when the thread is fully unread',
  'improved scrolling > direct share > should not scroll to the timestamp in the presence of an unread at-mention',
  'BacktickAsEscape > popup > should open the popup and set the setting on close',
  '(demo account): demo account > Displays the auto-draft auto-reminder in the thread list',
  'AI Agent > AI Agent answer render > should render links with the right attributes',
  '(demo account): demo account > shows the share thread modal on the teams path',
  'SyncBackward > with cached threads > should not call onThreadSaved with threads that were cached',
  'improved scrolling > oldest unread at-mention > should only scroll to unread mentions',
]

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

    let workingSet: string[]
    workingSet = await chromeActions.listTests()
    workingSet = workingSet.filter((testName) => {
      return !SKIPPED_TESTS.includes(testName)
    })

    if (opts.limit) {
      workingSet = workingSet.slice(0, opts.limit)
    }

    if (opts.filter) {
      const filter = opts.filter.trim()
      console.log(`Filtering tests by "${filter}"`)
      workingSet = workingSet.filter((testName) => {
        return testName.includes(filter)
      })
    }

    testRunMeasure.mark(`Test Name Get Time`)

    // In case there is an issue with the lamda retry mechanism we
    // cap the number of times we will try to prevent going into an
    // infinite loop. The actual retrying is happening on the lamdaWorker.
    const INFINITE_LOOP_BREAKER = opts.maxAttempts + 1

    type TestResult = {
      name: string
      result: 'pass' | 'fail'
      duration: number
      error?: string
    }
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
            name: 'log.zen_single_test_run',
            fields: {
              ...testRun,
              attempt,
            },
          })
        }
      }

      metrics.push({
        name: 'log.zen_test_results',
        fields: {
          ...testRunMeasure.getMetric(),
          result: resultStatistics.failCount === 0 ? 'pass' : 'fail',
          fail_count: resultStatistics.failCount,
          flake_count: resultStatistics.flakeCount,
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
      opts,
    })

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
  const flakedTests: string[] = []
  const failedTests: string[] = []
  const passedTests: string[] = []

  for (const testName in testResults) {
    const testRuns = testResults[testName]
    const testAttempts = testRuns.length
    const didPass = testRuns.some((testRun) => testRun.result === 'pass')
    const hasFailed = testRuns.some((testRun) => testRun.result === 'fail')

    if (didPass) {
      passedTests.push(testName)
      if (hasFailed) {
        flakedTests.push(testName)
      }
    } else {
      failedTests.push(testName)
    }
  }

  return {
    passCount: passedTests.length,
    flakeCount: flakedTests.length,
    failCount: failedTests.length,
    flakedTests,
    failedTests,
    passedTests,
  }
}

function printRunStatistics({
  resultStatistics,
  testResults,
  testRunMeasure,
  opts,
}: {
  resultStatistics: TestResultStatistics
  testResults: TestResults
  testRunMeasure: Measure
  opts: CLIOptions
}) {
  const { flakedTests, failedTests, passedTests } = resultStatistics
  const performanceMetric = testRunMeasure.getMetric()

  if (flakedTests.length) {
    printHeading('Flaked Tests')
    for (const testName of flakedTests) {
      const testRuns = testResults[testName]
      const testAttempts = testRuns.length
      console.log(`⚠️ ${testName} (flaked ${testAttempts - 1}x)`)
      testRuns.forEach((test) => {
        if (test.error) {
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

    // TODO: output statistics on the groups ran. Slowest group in run etc.
  }

  if (opts.deflake && flakedTests.length) {
    printHeading('Deflake Report')
    flakedTests.forEach((testName) => {
      const testRuns = testResults[testName]

      // Filter out framework level flakes.
      const testLevelFlakes = testRuns.filter((testRun) => {
        return (
          !!testRun.error &&
          COMMON_FRAMEWORK_ERRORS.every(
            (frameworkError) => !testRun.error.includes(frameworkError)
          )
        )
      })
      const testAttempts = testLevelFlakes.length

      if (testLevelFlakes.length) {
        console.log('')
        console.log(`🗿 ${testName}`)
        testLevelFlakes.forEach((testRun) => {
          console.log(testRun.error)
          if (testRun.logStream) {
            console.log(`logStream: ${testRun.logStream}`)
          }
        })
      }
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

  const flakeCount = flakedTests.length
  if (flakeCount > 0) {
    console.log(`⚠️ ${flakeCount} flaked test${flakeCount === 1 ? '' : 's'}.`)
  }

  const failCount = failedTests.length
  console.log(
    `${failCount ? '😢' : '🎉'} ${failCount} failed test${
      failCount === 1 ? '' : 's'
    }`
  )

  return {
    flakeCount,
    failCount,
    passCount: passedTests.length,
  }
}
