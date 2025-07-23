import * as path from 'path'
import Util from './util'
import { LambdaClient } from '@aws-sdk/client-lambda'
import { NodeHttpHandler } from '@aws-sdk/node-http-handler'
import { Agent } from 'https'
import S3Sync from './s3-sync'
import Journal from './journal'
import uuidv4 from 'uuid/v4'
import WebpackAdapter from './webpack'
import Profiler from './profiler'
import { InvokeCommand } from '@aws-sdk/client-lambda'

import type { Logger } from './profiler'

require('sugar').extend()

export type ZenConfig = {
  appRoot: string
  setDevelopmentHeaders: (req: any, res: any) => void
  port: number
  testDependencies: string[]
  lambdaConcurrency: number
  htmlTemplate: string
  sessionId: string
  useSnapshot: boolean
  tmpDir: string
  alsoServe: { addToIndex: boolean; filePath: string }[]
  proxyUrl?: string

  // TODO flesh this out
  aws: any

  // TODO flesh this out
  webpack: any
  chrome?: {
    width?: number
    height?: number
  }
  lambdaNames: {
    // The others are actually never used
    workTests: string
    listTests: string
  }
  runId: string
  log: Logger
}

export type Zen = {
  s3Sync: S3Sync
  journal: Journal
  webpack: WebpackAdapter
  indexHtml: (pageType: string, forS3: boolean) => string
  config: ZenConfig
  profiler: Profiler
  lambdaInvoke: (name: string, args: Record<string, unknown>) => any
}

export default async function initZen(configFilePath: string): Promise<Zen> {
  let configFile = require(path.join(process.cwd(), configFilePath))
  const appRoot = path.resolve(process.cwd(), configFile.appRoot || '')
  if (typeof configFile === 'function') {
    configFile = await configFile()
  }

  const config: ZenConfig = {
    ...configFile,
    appRoot,
    port: configFile.port || 3100,
    testDependencies: configFile.testDependencies || [],
    lambdaConcurrency: configFile.lambdaConcurrency || 400,
    htmlTemplate: configFile.htmlTemplate || '<body>ZEN_SCRIPTS</body>',
    sessionId: configFile.sessionId || uuidv4(),
    runId: uuidv4(),
    useSnapshot:
      configFile.useSnapshot === undefined ? true : !!configFile.useSnapshot,
    lambdaNames: configFile.lambdaNames || {
      workTests: 'zen-workTests',
      listTests: 'zen-listTests',
    },
    headedChromePort: 3333,

    // tmpDir is where we cache files between runs
    tmpDir: configFile.tmpDir || path.join(appRoot, '.zen'),
  }

  const webpack = config.webpack ? new WebpackAdapter(config) : undefined

  function generateIndexHtml(pageType: string, forS3: boolean) {
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
    // @ts-expect-error
    const entries = webpack?.compile?.entrypoints || []

    if (forS3) {
      deps.push(
        ...(config.alsoServe || []).map(
          (as) => as.addToIndex && path.basename(as.filePath)
        )
      )
      deps.push(entries.map((e: string) => `webpack/${e}`))
    } else {
      deps.push(
        ...config.testDependencies.map((t) =>
          t.replace(config.appRoot, '/base')
        )
      )
      deps.push(entries.map((e: string) => `webpack/${e}`))
    }

    let scripts = deps
      .flat()
      .filter((x) => x)
      .map((d) => `<script src='${d}'></script>`)

    // NB it's important that we don't include the config when the index is uploaded to S3
    let cfg =
      pageType == 'head'
        ? {
            aws: config.aws,
            lambdaNames: config.lambdaNames,
            proxyUrl: config.proxyUrl,
          }
        : {}

    scripts.unshift(
      `<script>window.Zen = {config: ${JSON.stringify(cfg)}}</script>`
    )

    return config.htmlTemplate.replace('ZEN_SCRIPTS', scripts.join('\n'))
  }

  const lambdaClient = new LambdaClient({
    region: config.aws.region,
    requestHandler: new NodeHttpHandler({
      httpsAgent: new Agent({
        maxSockets: 2000,
        keepAlive: true,
      }),
    }),
  })

  async function lambdaInvoke(name: string, args: Record<string, unknown>) {
    const command = new InvokeCommand({
      FunctionName: name,
      Payload: JSON.stringify(args),
    })

    const result = await lambdaClient.send(command)

    if (result.StatusCode != 200) {
      throw new Error(`Invoke Error ${name}${args}: ${result}`)
    }

    const payload = JSON.parse(new TextDecoder().decode(result.Payload))

    if (payload.errorMessage) {
      const err = new Error(payload.errorMessage)
      err.stack = payload.trace ? payload.trace.join('\n') : err.stack
      err.stack += `\nRequest Id: ${result['$metadata'].requestId}`
      throw err
    }

    return payload
  }

  const zen: Partial<Zen> = {
    config,
    lambdaInvoke,
    indexHtml: generateIndexHtml,
    webpack,
    profiler: new Profiler({ runId: config.runId, logger: config.log }),
  }

  // TODO: remove zen global
  globalThis.Zen = zen

  zen.s3Sync = new S3Sync(zen)
  zen.journal = new Journal()

  Util.ensureDir(zen.config.tmpDir)
  console.log('Using tmpDir', zen.config.tmpDir)

  return zen as Zen
}
