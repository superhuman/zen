import * as path from 'path'
import * as https from 'https'
import { ensureDir } from './util'
import * as AWS from 'aws-sdk'
// @ts-expect-error(7016) s3-sync is any
import S3Sync from './s3-sync'
// @ts-expect-error(7016) s3-sync is any
import Journal from './journal'
import uuidv4 from 'uuid/v4'
// @ts-expect-error(7016) webpack is any
import WebpackAdapter from './webpack'
import type {Zen} from './types'

require('sugar').extend()


export default async function initZen(configFilePath: string): Promise<Zen> {
  // TODO fix the arg part, the order for shifting was broken because of import order
  //
  let configFile = require(path.join(process.cwd(), configFilePath))
  if (typeof configFile === 'function') {
    configFile = await configFile()
  }

  const Zen: Partial<Zen> = ((global as any).Zen = {
    config: configFile,
  })

  // load the config with some defaults
  let config = Zen.config
  config.appRoot = path.resolve(process.cwd(), config.appRoot || '')
  config.port = config.port || 3100
  config.testDependencies = config.testDependencies || []
  config.lambdaConcurrency = config.lambdaConcurrency || 400
  config.htmlTemplate = config.htmlTemplate || '<body>ZEN_SCRIPTS</body>'
  config.sessionId = config.sessionId || uuidv4()
  config.useSnapshot === undefined ? true : !!config.useSnapshot
  config.lambdaNames = config.lambdaNames || {
    workTests: 'zen-workTests',
    listTests: 'zen-listTests',
  }

  // tmpDir is where we cache files between runs
  config.tmpDir = config.tmpDir || path.join(config.appRoot, '.zen')
  ensureDir(config.tmpDir)
  console.log('Using tmpDir', config.tmpDir)

  AWS.config.update(config.aws)
  Zen.s3Sync = new S3Sync() // Keeps our local files in sync with S3
  Zen.lambda = new AWS.Lambda()
  Zen.journal = new Journal()

  // Without this, node limits our requests and slows down running on lambda
  https.globalAgent.maxSockets = 2000 // TODO multiplex over fewer connections

  Zen.indexHtml = function indexHtml(pageType, forS3) {
    let deps = ['build/latte.js']
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
    let entries =
      (Zen.webpack && Zen.webpack.compile && Zen.webpack.compile.entrypoints) ||
      []

    if (forS3) {
      deps.push(
        ...(config.alsoServe || []).map(
          (as) => as.addToIndex && path.basename(as.filePath)
        )
      )
      deps.push(entries.map((e: string) => `webpack/${e}`))
    } else {
      deps.push(
        ...Zen.config.testDependencies.map((t) =>
          t.replace(Zen.config.appRoot, '/base')
        )
      )
      deps.push(entries.map((e: string) => `//localhost:3100/webpack/${e}`))
    }

    let scripts = deps
      .flat()
      .filter((x) => x)
      .map((d) => `<script src='${d}'></script>`)

    // NB it's important that we don't include the config when the index is uploaded to S3
    let cfg = pageType == 'head' ? Zen.config : {}
    scripts.unshift(`<script>
      window.Zen = {config: ${JSON.stringify(cfg)}}
    </script>`)

    return Zen.config.htmlTemplate.replace('ZEN_SCRIPTS', scripts.join('\n'))
  }

  if (config.webpack) {
    // boot up webpack (if configured)
    Zen.webpack = new WebpackAdapter(config.webpack)
  }

  // TODO clean this up to remove the casting
  return Zen
}
