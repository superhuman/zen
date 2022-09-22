import type ChromeWrapper from './chrome_wrapper'
import type { ChromeTab } from './chrome_wrapper'
import type { Context } from 'aws-lambda'
import type { FileManifest, File, TestResult } from './types'
import AWS from 'aws-sdk'
// TODO test if this works
let wrapper: ChromeWrapper // store chrome wrapper globally. In theory we could reuse this between runs

type WorkTestOpts = {
  testNames: string[]
  deflakeLimit?: number
  runId: string
  oldResults?: WorkTestsResult
}
export type WorkTestsResult = {
  results: Record<string, TestResult[]>
  logStreamName: string
}
export const workTests = async (
  opts: WorkTestOpts,
  context: Context
): Promise<WorkTestsResult> => {
  const { testNames: tests } = opts
  const remainingTime = context.getRemainingTimeInMillis()
  const results = tests.reduce<Record<string, TestResult[]>>(
    (acc, testName) => {
      acc[testName] = []
      return acc
    },
    {}
  )
  // So we can log lambda errors with the test that caused them
  let activeTest
  const getRemainingTests = () =>
    tests.filter((test) => {
      const testResults = results[test]
      const lastRun = testResults[testResults.length - 1]
      return !lastRun || lastRun.error
    })

  try {
    const timeout = new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(true), remainingTime - 5_000)
    )
    const runTestSet = async (tests: string[], tab: ChromeTab) => {
      for (const testName of tests) {
        activeTest = testName
        const testOpts = { runId: opts.runId, testName }
        let r = await tab.setTest(testOpts)
        if (!r) {
          r = {
            fullName: testName,
            time: 0,
            error: 'Test resolved without running!',
          }
        }

        results[testOpts.testName].push(r)
      }
    }

    const run = async () => {
      const tab = await prepareChrome({ sessionId: '' })
      const deflakeLimit = opts.deflakeLimit || 3
      for (let attempt = 1; attempt <= deflakeLimit; attempt++) {
        const remainingTests = getRemainingTests()
        console.log('REMAINING TESTS', remainingTests)
        if (remainingTests.length === 0) break

        await runTestSet(remainingTests, tab)
      }

      // Return false to indicate no timeout
      return false
    }

    const didTimeout = await Promise.race([run(), timeout])
    if (didTimeout) throw new Error('Lambda Timeout')

    return {
      results,
      logStreamName: context.logStreamName,
    }
  } catch (e) {
    if (e instanceof Error) {
      const message = e.message
      if (
        message.includes('Lambda Timeout') ||
        message.includes('TimeoutError')
      ) {
        const remainingTests = getRemainingTests()
        remainingTests.forEach((test) => {
          results[test].push({
            error: message,
            fullName: test,
            time: 0,
          })
        })
      } else if (activeTest) {
        results[activeTest].push({
          error: e.message,
          fullName: activeTest,
          time: 0, // TODO figure out a good way to get time
        })
      } else {
        console.log('UNKOWN ERROR')
        console.error(e)
      }
    }

    return {
      results,
      logStreamName: context.logStreamName,
    }
  }
}

export async function listTests(opts: {
  sessionId: string
}): Promise<string[]> {
  const tab = await prepareChrome(opts)
  const names = await tab.getTestNames()
  return names
}

export const sync = async (
  manifest: FileManifest
): Promise<{ needed: File[] }> => {
  if (!process.env.ASSET_BUCKET) throw new Error('ASSET_BUCKET not set')
  const bucket = process.env.ASSET_BUCKET
  console.log('bucket', bucket)
  const s3 = new AWS.S3({ params: { Bucket: bucket } })

  // Write the updated session manifest to S3
  const manifestWrite = s3
    .putObject({
      Bucket: bucket,
      Key: `session-${manifest.sessionId}.json`,
      Body: JSON.stringify(manifest),
    })
    .promise()

  // TODO: it might be faster to use listObjectsV2, especially if there are many files
  // to check, and S3 is pruned to have less than 2k files. Blame this comment for an example.
  const needed: File[] = []
  const toCheck = manifest.files.filter((f) => f.toCheck)
  console.log(`Checking ${toCheck.length} files`)
  await Promise.all(
    toCheck.map(async (f) => {
      try {
        const resp = await s3
          .headObject({
            Bucket: bucket,
            Key: f.versionedPath,
          })
          .promise()
        console.log('Found', f.versionedPath, resp)
      } catch (e) {
        if (e instanceof AWS.AWSError) {
          needed.push(f)
          if (e.code !== 'NotFound') {
            console.log('Error heading', f.versionedPath, e)
          }
        }
      }
    })
  )

  await manifestWrite
  console.log('Manifest written')
  return { needed }
}

async function prepareChrome({ sessionId }: { sessionId: string }) {
  const manifest = await getManifest(sessionId)
  if (!manifest) throw new Error(`Missing manifest for ${sessionId}`)

  // Start chrome and fetch the manifest in parallel
  if (!wrapper) {
    console.log('Setting up Chrome')
    const ChromeWrapper = require('./chrome_wrapper').default
    wrapper = new ChromeWrapper()
    await wrapper.launchLambda()
  } else {
    console.log('Chrome is already setup!')
  }

  console.log('Opening tab')
  return await wrapper.openTab(
    process.env.GATEWAY_URL + '/index.html',
    sessionId,
    { logging: true },
    manifest
  )
}

async function getManifest(sessionId: string) {
  if (!process.env.ASSET_BUCKET) throw new Error('ASSET_BUCKET not set')
  const bucket = process.env.ASSET_BUCKET

  try {
    const s3 = new AWS.S3()
    const resp = await s3
      .getObject({
        Bucket: bucket,
        Key: `session-${sessionId}.json`,
      })
      .promise()
    const manifest: FileManifest = {
      ...JSON.parse(resp.Body?.toString('utf-8') || ''),
      fileMap: {},
    }
    manifest.files.forEach(
      (f) => (manifest.fileMap[f.urlPath] = f.versionedPath)
    )
    console.log(manifest)
    manifest.assetUrl = `https://s3-${process.env.AWS_REGION}.amazonaws.com/${bucket}`
    return manifest
  } catch (e) {
    console.log(e)
    return null
  }
}
