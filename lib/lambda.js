import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import ChromeWrapper from './chrome_wrapper.ts'

// Remove default unhandled rejection terminating the whole process.
process.removeAllListeners('unhandledRejection')
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Promise Rejection at:', promise, 'reason:', reason)
})

module.exports.workTests = async (opts, context = {}) => {
  try {
    const maxRunTime = (opts.lambdaCutoff || 90) * 1000
    const cutoffTime = Date.now() + maxRunTime

    const testResults = await withChromeProcess(
      opts,
      async (chromeWrapper) => {
        const results = await runTests({ chromeWrapper, opts, cutoffTime })

        // Track the logStreamName, so it's easy to open the logs of a failed test
        results.forEach((r) => (r.logStream = context.logStreamName))

        return results
      },
      { skipKill: opts.headed }
    )

    return testResults
  } catch (e) {
    const errorString = e.stack || `${e.name}: ${e.message}`
    return opts.testNames.map((testName) => {
      return {
        fullName: testName,
        attempts: 0,
        error: `[Test Group Failed] ${errorString}`,
        time: 0,
        logStream: context.logStreamName,
      }
    })
  }
}

module.exports.listTests = async function (opts, context) {
  return withChromeProcess(opts, async (chromeWrapper) => {
    const names = await chromeWrapper.getTestNames()
    return names
  })
}

module.exports.sync = async (manifest) => {
  console.log('bucket', process.env.ASSET_BUCKET)
  let s3 = new S3Client({ region: process.env.AWS_REGION })

  // Write the updated session manifest to S3
  let manifestWrite = s3.send(
    new PutObjectCommand({
      Bucket: process.env.ASSET_BUCKET,
      Key: `session-${manifest.sessionId}.json`,
      Body: JSON.stringify(manifest),
    })
  )

  // TODO: it might be faster to use listObjectsV2, especially if there are many files
  // to check, and S3 is pruned to have less than 2k files. Blame this comment for an example.
  let needed = []
  let toCheck = manifest.files.filter((f) => f.toCheck)
  console.log(`Checking ${toCheck.length} files`)
  await Promise.all(
    toCheck.map(async (f) => {
      try {
        let resp = await s3.send(
          new HeadObjectCommand({
            Bucket: process.env.ASSET_BUCKET,
            Key: f.versionedPath,
          })
        )
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

module.exports.routeRequest = async (event) => {
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

async function withChromeProcess(opts, callback, { skipKill = false } = {}) {
  const manifest = await getManifest(opts.sessionId)

  // We require a manifest in lambda
  if (!manifest) throw new Error(`Missing manifest for ${opts.sessionId}`)

  const wrapper = new ChromeWrapper({
    headed: opts.headed,
    awsRegion: opts.awsRegion || process.env.AWS_REGION,
  })
  try {
    if (opts.headed) {
      await wrapper.launchLocal({ port: opts.localPort, headed: opts.headed })
    } else {
      await wrapper.launchLambda()
    }

    console.log('Opening tab')
    const tab = await wrapper.openTab({
      url: process.env.GATEWAY_URL + '/index.html',
      id: null,
      config: { useAssetServer: true },
      manifest,
    })

    const result = await callback(wrapper)
    return result
  } finally {
    if (!skipKill) {
      await wrapper.kill()
    } else {
      console.log('KILL SKIPPED')
    }
  }
}

const runTests = async ({ opts, chromeWrapper, cutoffTime }) => {
  const results = []
  // Run all tests once, collecting results
  console.log('Starting tests')
  let remaining = opts.testNames.slice()
  while (remaining.length > 0) {
    const testName = remaining.shift()
    let testOpts = Object.assign({}, opts, { testName })

    let result
    try {
      result = await chromeWrapper.runTest(testOpts)
      results.push(result)
    } catch (e) {
      results.push({
        fullName: testName,
        error: e.stack || message,
        time: 0,
      })
      remaining.forEach((remainingTest) => {
        results.push({
          fullName: remainingTest,
          error: e.stack || message,
          time: 0,
        })
      })
      remaining = []
      break
    }

    if (Date.now() + result.time * 1.2 > cutoffTime) {
      remaining.forEach((remainingTest) => {
        results.push({
          fullName: remainingTest,
          error: 'Lambda Timeout Exceeded',
          time: 0,
        })
      })
      remaining = []
      break
    }
  }

  return results
}

async function getManifest(sessionId) {
  try {
    let s3 = new S3Client({ region: process.env.AWS_REGION })
    let resp = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.ASSET_BUCKET,
        Key: `session-${sessionId}.json`,
      })
    )
    let manifest = JSON.parse(await resp.Body.transformToString())
    manifest.fileMap = {}
    manifest.files.forEach(
      (f) => (manifest.fileMap[f.urlPath] = f.versionedPath)
    )
    manifest.assetUrl = `https://s3-${process.env.AWS_REGION}.amazonaws.com/${process.env.ASSET_BUCKET}`
    return manifest
  } catch (e) {
    console.log(e)
    return null
  }
}
