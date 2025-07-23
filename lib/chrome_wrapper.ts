// @ts-nocheck
import Puppeteer from 'puppeteer-core'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import fs from 'fs'
import connect from 'connect'
import http from 'http'
import { execSync } from 'child_process'
import { URL } from 'url'

const DEFAULT_BROWSER_WIDTH = 1300
const DEFAULT_BROWSER_HEIGHT = 1000

type WindowSize = {
  width: number
  height: number
}

type ChromeTabConfig = {
  skipHotReload: boolean
  failOnExceptions: boolean
}
type ChromeTabState =
  | 'starting'
  | 'idle'
  | 'badCode'
  | 'running'
  | 'hotReload'
  | 'loading'
type log = { console: string[] }
type Test = {
  testName: string
  logs: { console: string }
}
type FileManifest = {
  index: string
  fileMap: Record<string, undefined | string>
  assetUrl: string
}

const TEST_TIMEOUT = 45_000

class ChromeTab {
  codeHash?: string
  test?: Test
  timeout: NodeJS.Timeout
  state: ChromeTabState
  config: ChromeTabConfig
  requestMap: Record<string, string | undefined>
  browser: Puppeteer.Browser

  constructor({
    browser,
    page,
    id = 'Dev',
    config,
    manifest,
    s3,
    headed,
    testPort,
  }: {
    browser: Puppeteer.Browser
    page: Puppeteer.Page
    id: string
    config: Partial<ChromeTabConfig>
    manifest?: FileManifest
    s3?: S3Client
    headed?: boolean
    testPort?: number
  }) {
    this.browser = browser
    this.page = page
    this.id = id
    this.manifest = manifest
    this.s3 = s3
    this.headed = headed
    this.config = {
      skipHotReload: false,
      failOnExceptions: false,
      ...config,
    }
    this.state = 'starting'
    this.timeout = setTimeout(this.onTimeout, 10_000)

    /*
    this.page.on('console', async (message) => {
      const args = message.args()
      const logValues = await Promise.all(
        args.map(async (arg) => {
          try {
            return await arg.jsonValue()
          } catch {
            return arg.toString()
          }
        })
      )
      console.log(...logValues)
    })
    */

    // Expose functions for direct calls from the page
    this.setupExposedFunctions()
  }

  async setupExposedFunctions() {
    // Expose Zen functions to the page context
    await this.page.exposeFunction('zenIdle', () => {
      if (this.closed) return

      if (this.state === 'loading' || this.state === 'starting') {
        this.becomeIdle()
      }
    })

    await this.page.exposeFunction('zenHotReload', () => {
      if (this.closed) return

      if (this.state === 'hotReload') {
        this.becomeIdle()
      }
    })

    await this.page.exposeFunction('zenResults', (results: any) => {
      if (this.closed) return

      if (this.state === 'running') {
        this.finishTest(results)
        this.becomeIdle()
      }
    })

    await this.page.exposeFunction(
      'zenResizeWindow',
      (args: { width: number; height: number }) => {
        if (this.closed) return
        this.resizeWindow(args)
      }
    )

    await this.page.exposeFunction('zenIsHeaded', () => {
      return this.headed
    })
  }

  async resizeWindow({ width, height }: { width: number; height: number }) {
    return this.page.setViewport({ width, height })
  }

  changeState(state: ChromeTabState) {
    clearTimeout(this.timeout)
    this.state = state
  }

  setCodeHash(codeHash: string) {
    this.codeHash = codeHash
    if (this.state === 'idle' || this.state === 'badCode') {
      this.reload()
    }
  }

  resolveWork?: (value: unknown) => void
  setTest(test: Test) {
    if (this.test) {
      this.resolveWork?.(null)
    }

    const promise = new Promise((resolve, reject) => {
      this.resolveWork = resolve
      this.rejectWork = reject
    })
    this.test = test
    if (this.state === 'idle') {
      this.run()
    } else if (this.state === 'running') {
      this.reload()
    } else if (this.state === 'badCode') {
      this.failTest(this.badCodeError || '', this.badCodeStack || '')
    }

    return promise
  }

  listRequest?: {
    resolve: (value: unknown) => void
    reject: (reason: unknown) => void
  }

  async getTestNames() {
    const promise = new Promise((resolve, reject) => {
      this.listRequest = { resolve, reject }
    })

    if (this.state === 'idle') {
      this.listTests()
    }

    return promise
  }

  async listTests() {
    try {
      const results = await this._evaluate(
        `Latte.flatten().map(t => t.fullName)`
      )
      if (!this.listRequest) {
        throw new Error('this.listRequest is not defined when listing tests')
      }
      this.listRequest.resolve(results)
    } catch (e) {
      this.listRequest.reject(e.message)
    }
  }

  _evaluate(code: string) {
    return this.page.evaluate(code)
  }

  // Attempt to hot reload the latest code
  hotReload() {
    if (this.config.skipHotReload) {
      return this.reload()
    }

    this.changeState('hotReload')
    this.timeout = setTimeout(this.onTimeout, 5_000)
    this._evaluate(`Zen.upgrade(${JSON.stringify(this.codeHash)})`)
    this.codeHash = undefined
  }

  startAt?: Date
  async run() {
    this.changeState('running')
    this.startAt = new Date()
    this.timeout = setTimeout(this.onTimeout, TEST_TIMEOUT)

    try {
      await this.page.focus('body')
      await this.page.evaluate(`Zen.run(${JSON.stringify(this.test)})`)
    } catch (e) {
      this.failTest('Error during test execution', e.stack || '')
    }
  }

  badCodeError?: string
  badCodeStack?: string
  badCode(msg: string, stack: string[]) {
    this.changeState('badCode')
    this.badCodeError = msg
    this.badCodeStack = stack.join('\n')

    if (this.test) {
      this.failTest(msg, stack.join('\n'))
    }
    if (this.listRequest) {
      this.listRequest.reject(msg)
    }
  }

  becomeIdle() {
    this.changeState('idle')
    if (this.codeHash) this.hotReload()
    else if (this.test) this.run()
    else if (this.listRequest) this.listTests()
  }

  async reload() {
    this.changeState('loading')
    this.timeout = setTimeout(this.onTimeout, TEST_TIMEOUT)
    this.codeHash = undefined
    console.log(`[${this.id}] reloading`)
    this.page.reload()
  }

  onTimeout = () => {
    if (this.headed) {
      return
    }

    if (this.state === 'loading' && this.rejectWork) {
      console.log(`[${this.id}] timeout while loading`)
      // In the case we timed out on loading this indicates our browser
      // process isn't loading at all. In this case we want to kill and restart
      // our chrome process.
      this.rejectWork(new Error('Puppeteer stalled'))
      return
    }

    if (this.state == 'running') {
      this.failTest('Chrome-level test timeout')
    } else if (this.state == 'hotReload') {
      console.log(`[${this.id}] timeout while hotReloading`)
    }

    // If we hit a timeout, the page is likely stuck and we don't really know
    // if it's safe to run tests. The best we can do is reload.
    this.reload()
  }

  failTest(error: string, stack = '') {
    const result = { error, stack, fullName: this.test?.testName || '' }

    this.finishTest(result)
  }

  finishTest(rawMessage: {
    error?: string
    stack?: string
    fullName: string
    log?: log
  }) {
    const message = {
      ...rawMessage,
      time: this.startAt && new Date().getTime() - this.startAt.getTime(),
    }

    if (!this.test?.logs || !this.test.logs.console) {
      delete message.log
    }

    if (this.resolveWork) {
      this.resolveWork(message)
    }

    this.resolveWork = undefined
    this.test = undefined
  }

  onExceptionThrown(opts) {
    let ex = opts.exceptionDetails,
      message

    if (ex.exception && ex.exception.className)
      message = `${ex.exception.className} ${
        ex.exception.description.split('\n')[0]
      }`
    else if (ex.exception.value) message = ex.exception.value
    else message = ex.text

    let stack = (ex.stackTrace && ex.stackTrace.callFrames) || []
    stack = stack.map((f) => `${f.functionName} ${f.url}:${f.lineNumber}`)
    console.log(`[${this.id}]`, message, stack)

    // If an error happens while loading, your code is bad and we can't run anything
    if (this.state === 'loading') {
      this.badCode(message, stack)
    }

    // Some test suites (ie Superhuman) throw random errors that don't actually fail the test promise.
    // I'd like to track these all down and fix, but until then let us silently ignore, like karma.
    // Since we don't know which exceptions are safe to ignore, just reload.
    else if (this.state === 'running' && this.config.failOnExceptions) {
      this.failTest(message, stack.join('\n'))
      this.reload()
    } else if (this.state == 'hotReload') this.reload()
  }

  async kill({ skipCDP } = {}) {
    clearTimeout(this.timeout)
    this.closed = true

    try {
      // Remove all event listeners first
      this.page.removeAllListeners()

      // Add timeout to prevent hanging
      await Promise.race([
        this.page.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Page close timeout')), 10000)
        ),
      ])
    } catch (e) {
      // If page.close() fails or times out, try to force close via browser
      try {
        const browser = this.browser
        if (browser && browser.process()) {
          console.log('Force killing browser process')
          const pid = browser.process().pid
          if (pid) {
            execSync(`kill -9 ${pid}`)
          }
        }
      } catch (killError) {
        console.log('Force kill also failed:', killError.message)
      }
    }
  }
}

export default class ChromeWrapper {
  constructor({ headed = false, awsRegion = process.env.AWS_REGION } = {}) {
    this.headed = headed
    this.awsRegion = awsRegion
    this.tab = null
    this.tabTestCount = 0
  }

  browser?: Promise<Puppeteer.Browser>
  s3?: S3Client
  testPort?: number
  assetServer?: http.Server
  assetServerPort?: number
  currentManifest?: FileManifest

  async launchLocal({
    port,
    headed = false,
  }: {
    port: number
    windowSize: WindowSize
    headed?: boolean
  }): Promise<void> {
    let devtoolsWidth = 0
    // Add a little width for the devtools
    if (headed) {
      devtoolsWidth = 400
    }
    const localChromeFlags = [
      '--headless',
      '--disable-gpu',
      `--window-size=${
        DEFAULT_BROWSER_WIDTH + devtoolsWidth
      },${DEFAULT_BROWSER_HEIGHT}`,
    ]

    this.s3 = new S3Client({ region: this.awsRegion })

    try {
      // When running locally, just use puppeteer because it bundles chromium with it
      const Puppeteer = require('puppeteer')
      const chromeFlags = headed
        ? localChromeFlags.filter((flag) => flag !== '--headless')
        : localChromeFlags

      this.browser = Puppeteer.launch({
        debuggingPort: port,
        headless: !this.headed,
        devtools: this.headed,
        env: { ...process.env, TZ: 'America/New_York' },
        args: [...chromeFlags],
      })
    } catch (e) {
      console.error(e)
    }
  }

  async launchLambda(): Promise<Puppeteer.Browser | undefined> {
    try {
      this.s3 = new S3Client({ region: this.awsRegion })
      const chromium = (await import('@sparticuz/chromium')).default
      const executablePath = await chromium.executablePath()

      this.browser = Puppeteer.launch({
        debuggingPort: 9222,
        executablePath: executablePath,
        env: { ...process.env, TZ: 'America/New_York' },
        args: chromium.args.concat([
          '--enable-logging',
          '--log-level=0',
          `--window-size=${DEFAULT_BROWSER_WIDTH},${DEFAULT_BROWSER_HEIGHT}`,
        ]),
        ignoreHTTPSErrors: true,
        headless: true,
      })

      return await this.browser
    } catch (e) {
      console.error(e)
    }
  }

  async createAssetServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      const app = connect()

      app.use(async (req, res, next) => {
        try {
          const url = new URL(req.url!, `http://localhost`)
          const path = decodeURIComponent(url.pathname.slice(1)).replace(
            'pub/',
            ''
          )

          if (!this.currentManifest) {
            res.writeHead(500, { 'Content-Type': 'text/plain' })
            res.end('No manifest available')
            return
          }

          if (path.match(/^index\.html$/)) {
            res.writeHead(200, {
              'Content-Type': 'text/html',
              'Cross-Origin-Embedder-Policy': 'require-corp',
              'Cross-Origin-Opener-Policy': 'same-origin',
              'Cache-Control': 'public, max-age=31536000, immutable',
            })
            res.end(this.currentManifest.index)
            return
          }

          const key = this.currentManifest.fileMap[path]
          if (key) {
            if (!this.s3) throw new Error('s3 not defined')
            if (!process.env.ASSET_BUCKET)
              throw new Error('ASSET_BUCKET is not defined')

            const response = await this.s3.send(
              new GetObjectCommand({
                Bucket: process.env.ASSET_BUCKET,
                Key: key,
              })
            )

            let body = await response.Body?.transformToByteArray()
            let headers: Record<string, string> = {
              'Cross-Origin-Embedder-Policy': 'require-corp',
              'Cross-Origin-Opener-Policy': 'same-origin',
              'Cache-Control': 'public, max-age=31536000, immutable',
            }

            if (response.ContentType === 'application/wasm') {
              body = Buffer.from(body!)
              headers[
                'content-security-policy'
              ] = `script-src 'self' 'wasm-unsafe-eval'`
              headers['Content-Length'] = body.length.toString()
            }

            if (response.ContentType) {
              headers['Content-Type'] = response.ContentType
            }

            res.writeHead(200, headers)
            res.end(Buffer.from(body!))
          } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('Missing from manifest')
          }
        } catch (e) {
          console.error('Asset server error:', e)
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('Internal server error')
        }
      })

      this.assetServer = http.createServer(app)

      // Find an available port starting from 3003
      let port = 3003
      const tryPort = () => {
        this.assetServer!.listen(port, (err?: Error) => {
          // TODO: I don't think this works
          if (err && (err as any).code === 'EADDRINUSE') {
            port++
            tryPort()
          } else if (err) {
            reject(err)
          } else {
            this.assetServerPort = port
            console.log(`Asset server listening on port ${port}`)
            resolve(port)
          }
        })
      }

      tryPort()
    })
  }

  async ensureAssetServer(manifest: FileManifest): Promise<number> {
    // Update the current manifest
    this.currentManifest = manifest
    // If server already exists, just return the port
    if (this.assetServer && this.assetServerPort) {
      console.log(
        `Reusing existing asset server on port ${this.assetServerPort}`
      )
      return this.assetServerPort
    }

    // Create server if it doesn't exist
    console.log('Creating new asset server')
    return await this.createAssetServer()
  }

  async getTestNames() {
    return this.tab.getTestNames()
  }

  async runTest(testOpts) {
    await this.tab.reload()
    const result = await this.tab.setTest(testOpts)
    return result
  }

  async closeTab(opts) {
    await this.tab.kill(opts)
    this.tab = null
    this.tabConfig = null
  }

  async resetTab(opts) {
    const tabConfig = this.tabConfig
    await this.closeTab(opts)
    return this.openTab(tabConfig)
  }

  async openTab(tabConfig: {
    url: string
    id: string
    config: ChromeTabConfig
    manifest?: FileManifest
  }): Promise<ChromeTab> {
    const { url, id, config, manifest } = tabConfig
    this.tabConfig = tabConfig
    this.tabTestCount = 0

    // TODO: kill on fail
    if (!this.browser) throw new Error('Browser not setup')
    if (this.tab)
      throw new Error(
        'Tab already exists. Close existing tab before opening new one.'
      )

    const browser = await this.browser
    const page = await browser.newPage()
    page.setViewport({
      width: DEFAULT_BROWSER_WIDTH,
      height: DEFAULT_BROWSER_HEIGHT,
    })
    // set 5 mins timeout to reduce test flake on navigation timeout
    await page.setDefaultNavigationTimeout(5 * 60 * 1000)

    const tab = new ChromeTab({
      browser,
      page,
      id,
      config,
      manifest,
      s3: this.s3,
      headed: this.headed,
    })
    this.tab = tab

    let navigateUrl = url

    if (manifest) {
      // Ensure asset server is running and modify URL to point to it
      const serverPort = await this.ensureAssetServer(manifest)
      navigateUrl = `http://localhost:${serverPort}/index.html`
    }

    await page.goto(navigateUrl)

    return tab
  }

  async forceKill() {
    if (this.browser) {
      const browser = await this.browser
      const process = browser.process()
      if (process && process.pid) {
        const pid = process.pid
        execSync(`kill -9 ${pid}`)
      }
    }
    this.closed = true
  }

  async kill(): Promise<void> {
    if (this.closed) {
      return
    }

    this.closed = true

    const gracefulShutdown = async () => {
      if (this.assetServer) {
        console.log('Closing asset server')
        this.assetServer.close()
        this.assetServer = undefined
        this.assetServerPort = undefined
      }

      // Close tab first
      if (this.tab) {
        await this.tab.kill()
      }

      // Close browser with timeout
      if (this.browser) {
        console.log('Closing browser')
        const browser = await this.browser

        await browser.close()
        console.log('Browser closed successfully')
      }
    }

    try {
      await Promise.race([
        gracefulShutdown(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Browser close timeout')), 10000)
        }),
      ])
    } catch (e) {
      // Force kill if normal close fails
      try {
        console.warn(
          'Graceful Close Failed. Forcefully killing Chrome process.'
        )
        await this.forceKill()
      } catch (forceKillError) {
        console.log('Force kill failed:', forceKillError.message)
      }
    }
  }
}
