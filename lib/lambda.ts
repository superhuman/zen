import type ChromeWrapper from "./chrome_wrapper"
import type { TestResult } from "./chrome_wrapper"
import { Context } from 'aws-lambda';
import AWS from 'aws-sdk'
// TODO test if this works
let wrapper : ChromeWrapper // store chrome wrapper globally. In theory we could reuse this between runs

type WorkTestOpts = {
  testNames: string[]
  deflakeLimit?: number
  runId: string
}
type WorkTestsResult = {
}
export const workTests = async (opts : WorkTestOpts, context : Context) : Promise<WorkTestsResult | unknown> => {
  const remainingTime = context.getRemainingTimeInMillis()
  try {
    // TODO: the 1s buffer will help, most of the time but the extendRemoteTimeout may cause issues with this

    // 5s to safely setup zen
    const maxRunTime = remainingTime - 5_000
    // 5s more off to have a safe 10s to run a final test
    const cutoff = Date.now() + maxRunTime - 5_000
    const cutoffTimeout = new Promise((res) => setTimeout(res, maxRunTime))
    const results : TestResult[] = []
    const runTests = async () => {
      // Run all tests once, collecting results
      console.log('Starting tests')
      const remaining = opts.testNames.slice()
      while (remaining.length > 0) {
        const testOpts = { runId: opts.runId, testName: remaining.shift() as string }
        const r = await tab.setTest(testOpts)
        if (!r) continue

        r.attempts = 1
        results.push(r)
      }

      // Optionally deflake tests that failed. Attempt all failing tests the same number of times
      // until we run out of time on this lambda worker, or reach our deflake limit.
      // To maximize our chances, we'll reload the tab before each attempt.
      let hasTimeRemaining = true
      let attempts = 1
      const deflakeLimit = opts.deflakeLimit || 1
      while (
        attempts < deflakeLimit &&
        hasTimeRemaining &&
        results.find((r) => r.error)
      ) {
        attempts++
        for (const previousResult of results.filter((r) => r.error)) {
          hasTimeRemaining = Date.now() + previousResult.time * 1.2 < cutoff
          if (!hasTimeRemaining) break

          tab.reload()
          const result = await tab.setTest(
            { runId: opts.runId, testName: previousResult.fullName }
          )
          if (!result) {
            // incrememnt the attempts
            results.splice(results.indexOf(previousResult), 1, { ...previousResult, attempts })
            continue
          }
          result.attempts = attempts
          results.splice(results.indexOf(previousResult), 1, result) // replace previous result
        }
      }
    }

    const tab = await prepareChrome(opts)
    await Promise.race([cutoffTimeout, runTests()])

    // Track the logStreamName, so it's easy to open the logs of a failed test
    results.forEach((r) => (r.logStream = context.logStreamName))

    wrapper.kill()
    return results
  } catch (e) {
    return e
  }
}

export async function listTests(opts): Promise<string[]> {
  let tab = await prepareChrome(opts)
  let names = await tab.getTestNames()
  wrapper.kill()
  return names
}

export const sync = async (manifest) => {
  console.log('bucket', process.env.ASSET_BUCKET)
  let s3 = new AWS.S3({ params: { Bucket: process.env.ASSET_BUCKET } })

  // Write the updated session manifest to S3
  let manifestWrite = s3
    .putObject({
      Bucket: process.env.ASSET_BUCKET,
      Key: `session-${manifest.sessionId}.json`,
      Body: JSON.stringify(manifest),
    })
    .promise()

  // TODO: it might be faster to use listObjectsV2, especially if there are many files
  // to check, and S3 is pruned to have less than 2k files. Blame this comment for an example.
  let needed = []
  let toCheck = manifest.files.filter((f) => f.toCheck)
  console.log(`Checking ${toCheck.length} files`)
  await Promise.all(
    toCheck.map(async (f) => {
      try {
        let resp = await s3
          .headObject({
            Bucket: process.env.ASSET_BUCKET,
            Key: f.versionedPath,
          })
          .promise()
        console.log('Found', f.versionedPath, resp)
      } catch (e) {
        needed.push(f)
        if (e.code !== 'NotFound')
          console.log('Error heading', f.versionedPath, e)
      }
    })
  )

  await manifestWrite
  console.log('Manifest written')
  return { needed }
}

export const routeRequest = async (event) => {
  let [sessionId, ...rest] = event.path.split('/').slice(1)
  let manifest = await getManifest(sessionId)
  let path = decodeURIComponent(rest.join('/'))
  console.log('Routing', sessionId, path)

  if (!manifest) {
    return { statusCode: 404, headers: {}, body: 'manifest not found' }
  }

  if (path === 'index.html') {
    return {
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
      body: manifest.index,
    }
  }

  let key = manifest.fileMap[path]
  if (!key) {
    return { statusCode: 404, headers: {}, body: 'path not found in manifest' }
  }

  return {
    statusCode: 301,
    headers: { Location: `${manifest.assetUrl}/${encodeURIComponent(key)}` },
  }
}

async function prepareChrome(opts) {
  const ChromeWrapper = require('./chrome_wrapper').default
  wrapper = new ChromeWrapper()

  // Start chrome and fetch the manifest in parallel
  console.log('Starting chrome')
  const manifest = await getManifest(opts.sessionId)
  await wrapper.launchLambda()

  // We require a manifest in lambda
  if (!manifest) throw new Error(`Missing manifest for ${opts.sessionId}`)

  console.log('Opening tab')
  // TODO: this api is a bit jank
  let tab = await wrapper.openTab(
    process.env.GATEWAY_URL + '/index.html',
    null,
    {},
    manifest
  )
  return tab
}

async function getManifest(sessionId) {
  try {
    let s3 = new AWS.S3()
    let resp = await s3
      .getObject({
        Bucket: process.env.ASSET_BUCKET,
        Key: `session-${sessionId}.json`,
      })
      .promise()
    let manifest = JSON.parse(resp.Body.toString('utf-8'))
    manifest.fileMap = {}
    manifest.files.forEach(
      (f) => (manifest.fileMap[f.urlPath] = f.versionedPath)
    )
    console.log(manifest)
    manifest.assetUrl = `https://s3-${process.env.AWS_REGION}.amazonaws.com/${process.env.ASSET_BUCKET}`
    return manifest
  } catch (e) {
    console.log(e)
    return null
  }
}
