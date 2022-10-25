import * as path from 'path'
import * as https from 'https'
import { ensureDir } from './util'
import * as AWS from 'aws-sdk'
// @ts-expect-error(7016) s3-sync is any
import S3Sync from './s3-sync'
import Journal from './journal'
import { v4 as uuidv4 } from 'uuid'
// @ts-expect-error(7016) webpack is any
import WebpackAdapter from './webpack'
import type { Zen, Config } from './types'

require('sugar').extend()

async function createConfig(configFilePath: string): Promise<Config> {
  let config:
    | Partial<Config>
    | (() => Promise<Partial<Config>>) = require(path.join(
    process.cwd(),
    configFilePath
  ))
  if (typeof config === 'function') {
    config = await config()
  }

  const appRoot = path.resolve(process.cwd(), config.appRoot || '')
  const port = config.port || 3100
  const testDependencies = config.testDependencies || []
  const lambdaConcurrency = config.lambdaConcurrency || 400
  const htmlTemplate = config.htmlTemplate || '<body>ZEN_SCRIPTS</body>'
  const sessionId = config.sessionId || uuidv4()
  const useSnapshot = !!config.useSnapshot
  // tmpDir is where we cache files between runs
  const tmpDir = config.tmpDir || path.join(appRoot, '.zen')
  const lambdaNames = config.lambdaNames || {
    workTests: 'zen-workTests',
    listTests: 'zen-listTests',
  }
  const alsoServe = config.alsoServe || []
  const aws = config.aws
  if (!aws) throw new Error('config.aws must be set in the zen config')

  return {
    ...config,
    appRoot,
    port,
    testDependencies,
    lambdaConcurrency,
    htmlTemplate,
    sessionId,
    useSnapshot,
    tmpDir,
    lambdaNames,
    alsoServe,
    aws,
  }
}

export default async function initZen(configFilePath: string): Promise<Zen> {
  const config = await createConfig(configFilePath)

  let webpack
  if (config.webpack) {
    // boot up webpack (if configured)
    webpack = new WebpackAdapter(config.webpack)
  }

  // Create a partial Zen, with enought to work for s3Sync
  // TODO setup order to make more sense
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(global as any).Zen = { config, webpack }

  AWS.config.update(config.aws)
  ensureDir(config.tmpDir)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const zen: Zen = ((global as any).Zen = {
    config,
    webpack,
    s3Sync: new S3Sync(),
    lambda: new AWS.Lambda(),
    journal: new Journal(config),
    indexHtml: function indexHtml(pageType: string, forS3: boolean) {
      const deps = ['build/latte.js']
      if (pageType == 'head') {
        deps.unshift('icons')
        deps.push(
          'node_modules/svelte/store.umd.js',
          'node_modules/fuzzysort/fuzzysort.js',
          'svelte/mini.js',
          'svelte/command.js'
        )
      }
      deps.push(`build/${pageType}.js`) // after Zen dependencies, but before user code
      const entries =
        (zen.webpack &&
          zen.webpack.compile &&
          zen.webpack.compile.entrypoints) ||
        []

      if (forS3) {
        deps.push(
          ...config.alsoServe
            .filter((as) => as.addToIndex)
            .map((as) => path.basename(as.filePath))
        )
        deps.push(entries.map((e: string) => `webpack/${e}`))
      } else {
        deps.push(
          ...zen.config.testDependencies.map((t: string) =>
            t.replace(zen.config.appRoot, '/base')
          )
        )
        deps.push(entries.map((e: string) => `//localhost:3100/webpack/${e}`))
      }

      const scripts = deps
        .flat()
        .filter((x) => x)
        .map((d) => `<script src='${d}'></script>`)

      // NB it's important that we don't include the config when the index is uploaded to S3
      const cfg = pageType == 'head' ? zen.config : {}
      scripts.unshift(`<script>
      window.Zen = {config: ${JSON.stringify(cfg)}}
    </script>`)

      const html = zen.config.htmlTemplate.replace('ZEN_SCRIPTS', scripts.join('\n'))
      return html
    },
  })

  // Without this, node limits our requests and slows down running on lambda
  https.globalAgent.maxSockets = 2000 // TODO multiplex over fewer connections

  return zen
}
