import path from 'path'
import http from 'http'
import connect from 'connect'
import WebSocket from 'ws'
import Util from './util'
import ChromeWrapper from './chrome_wrapper'
import ChromeActions from './chrome_actions'

// For debugging worker issues
const HEADED_WORKERS = false

class Server {
  constructor() {
    console.log('[Zen Server] Initializing server...')
    const numWorkers = 4
    this.runId = 1
    this.head = null
    this.workers = Array.construct(numWorkers, (id) => ({ id: id + 1 }))
    this.isLambda = false
    this.workerCount = 0
    this.workingSet = []
    this.results = [] // results of all tests run
    this.passedFocus = [] // all tests that passed after running
    this.chromeActions = new ChromeActions({ zen: Zen })

    // start up the local webserver for `head` to connect to
    let app = connect()
    let server = http.createServer(app).listen(Zen.config.port)
    app.use('/build', Util.serveWith404(path.join(__dirname))) // serve up stuff out of lib
    app.use(
      '/node_modules',
      Util.serveWith404(path.resolve(Zen.config.appRoot, './node_modules'))
    ) // serve up stuff out of lib
    app.use('/base', Util.serveWith404(Zen.config.appRoot)) // base serves things out of the application's root
    app.use('/svelte', Util.serveSvelte)
    app.use('/icons', Util.serveIcons)

    if (Zen.webpack) {
      console.log('[Zen Server] Starting webpack dev server...')
      Zen.webpack.startDevServer(app)
      Zen.webpack.on('status', (status) => {
        console.log(`[Zen Server] Webpack status changed: ${status}`)
        if (Zen.webpack.status == 'done') {
          console.log(`[Zen Server] Webpack done, updating ${this.workers.length} workers with hash`)
          this.workers.forEach(
            (w) => w.tab && w.tab.setCodeHash(Zen.webpack.compile.hash)
          )
        }
        this.sendStatus() // notify head of the compile status
      })
    } else {
      console.log('[Zen Server] No webpack configured')
    }

    Zen.s3Sync.on('status', this.sendStatus.bind(this))

    console.log('[Zen Server] Launching Chrome...')
    this.chrome = new ChromeWrapper({ headed: HEADED_WORKERS })
    this.chrome.launchLocal({ port: 9222, headed: HEADED_WORKERS })
    new WebSocket.Server({ server }).on(
      'connection',
      this.onWebsocket.bind(this)
    )

    // create a server for each worker. This gives us different origins and isolates things like localStorage
    console.log(`[Zen Server] Creating ${this.workers.length} worker tabs...`)
    this.workersPromises = []
    this.workers = Array.construct(this.workers.length, (id) => {
      id = id + 1
      let port = Zen.config.port + id
      http.createServer(app).listen(port)
      let worker = { id, port }
      console.log(`[Zen Server] Opening tab for worker ${id} on port ${port}`)
      this.workersPromises.push(
        this.chrome
          .openTab({
            url: `http://localhost:${port}/worker?id=${id}`,
            id: `w${id}`,
            config: Zen.config,
          })
          .then((t) => {
            console.log(`[Zen Server] Worker ${id} tab created, state: ${t.state}`)
            worker.tab = t
          })
          .catch((err) => {
            console.error(`[Zen Server] Failed to create worker ${id} tab:`, err)
          })
      )
      return worker
    })

    // host worker and head. NB this should go last after all other `app.use()` calls
    app.use(async (req, resp) => {
      const isRemote = req.url.match(/^\/worker/)

      // Required to use WASM Sqlite.
      // Currently wasm sqlite is only running on local dev.
      resp.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      resp.setHeader('Cross-Origin-Opener-Policy', 'same-origin')

      resp.end(Zen.indexHtml(isRemote ? 'worker' : 'head'))
    })
  }

  filterTests(msg) {
    console.log(`[Zen Server] filterTests called: run=${msg.run}, grep=${msg.grep}, testNames=${msg.testNames?.length || 0}`)
    
    // If nothing has changed and we're not running, leave the state unchanged.
    // When you refresh `head`, we don't want to run or clear out results unless the grep changed.
    if (!msg.run && this.grep === msg.grep) {
      console.log('[Zen Server] filterTests: no changes, returning early')
      return
    }

    if (msg.failed) {
      this.workingSet = this.results
        .filter((r) => r.error)
        .map((r) => r.fullName)
    } else {
      this.workingSet = msg.testNames
    }

    this.grep = msg.grep
    this.results = []
    this.passedFocus = []

    console.log(`[Zen Server] workingSet has ${this.workingSet?.length || 0} tests, webpack status: ${Zen.webpack?.status}`)

    if (msg.run && Zen.webpack.status == 'done') {
      console.log(`[Zen Server] Starting test run, reload=${msg.reload}`)
      if (msg.reload) {
        this.workers.forEach((w) => w.tab.reload())
      }

      this.runId++

      if (this.workingSet.length < 25) {
        console.log(`[Zen Server] Running ${this.workingSet.length} tests locally`)
        this.runLocally()
      } else {
        console.log(`[Zen Server] Running ${this.workingSet.length} tests on Lambda`)
        this.runOnLambda(msg)
      }

      this.sendStatus()
    } else {
      console.log(`[Zen Server] Not running tests: run=${msg.run}, webpack.status=${Zen.webpack?.status}`)
    }
  }

  async runOnLambda({ logs }) {
    let startingRunId = this.runId
    let runGroups = Zen.journal.groupTests(
      this.workingSet,
      Zen.config.lambdaConcurrency
    )
    this.isLambda = true
    this.workerCount = runGroups.length

    // send manifest to proxy
    await Zen.s3Sync.run(Zen.indexHtml('worker', true))
    this.sendStatus()

    await Util.runTestsOnRemote({
      zen: Zen,
      opts: {
        isLocal: true,
        headed: false,
        deflake: false,
        maxAttempts: 3,
      },
      tests: this.workingSet,
      onResult: (testResult, finalAttempt) => {
        if (finalAttempt && startingRunId === this.runId) {
          if (startingRunId !== this.runId) return
          this.onResults([testResult])
        }
      },
    })
  }

  async runLocally() {
    console.log(`[Zen Server] runLocally starting, runId=${this.runId}`)
    const startingRunId = this.runId
    const remaining = this.workingSet.clone()
    this.isLambda = false
    this.workerCount = this.workers.length

    console.log(`[Zen Server] Waiting for ${this.workersPromises.length} worker promises...`)
    await Promise.all(this.workersPromises)
    console.log(`[Zen Server] All worker tabs ready. Workers:`, this.workers.map(w => ({ id: w.id, hasTab: !!w.tab, tabState: w.tab?.state })))
    
    // Run all workers in parallel, properly awaiting each worker's test loop
    const workerPromises = this.workers.map(async (w) => {
      console.log(`[Worker ${w.id}] Starting test loop, tab state: ${w.tab?.state}`)
      try {
        while (remaining.length > 0) {
          const nextTest = remaining.pop()
          if (!nextTest) {
            console.log(`[Worker ${w.id}] No more tests`)
            break
          }
          
          console.log(`[Worker ${w.id}] Running test: ${nextTest}, remaining: ${remaining.length}`)
          
          // Start reload (don't await - completion is signaled via zenIdle)
          w.tab.reload()
          console.log(`[Worker ${w.id}] Reload started, calling setTest...`)
          
          // setTest returns a promise that resolves when the test completes
          let result = await w.tab.setTest({ testName: nextTest })
          console.log(`[Worker ${w.id}] setTest resolved:`, result ? 'got result' : 'null result')
          
          if (!result || startingRunId !== this.runId) {
            console.log(`[Worker ${w.id}] Breaking: result=${!!result}, runId match=${startingRunId === this.runId}`)
            break
          }
          this.onResults([result])
        }
        console.log(`[Worker ${w.id}] Test loop complete`)
      } catch (err) {
        console.error(`[Worker ${w.id}] Error running tests:`, err)
      }
    })
    
    // Wait for all workers to complete (don't block the main thread though)
    Promise.all(workerPromises)
      .then(() => console.log('[Zen Server] All worker promises resolved'))
      .catch(err => {
        console.error('[Zen Server] Error in runLocally workers:', err)
      })
  }

  onWebsocket(ws) {
    this.head = ws
    ws.on('message', (msg) => {
      try {
        msg = JSON.parse(msg)
        if (msg.type === 'filterTests') this.filterTests(msg)
        if (msg.type === 'passedFocus') this.passedFocus.push(msg.test)
        this.sendStatus()
      } catch (e) {
        console.error(e)
      }
    })
    ws.on('error', (err) => {
      console.error('Websocket error', err)
      this.head = null
    })
    this.sendStatus()
  }

  onResults(step) {
    this.results.push.apply(this.results, step)
    step.forEach((r) => Zen.journal.record(r))
    Util.wsSend(this.head, { results: step })
  }

  sendStatus() {
    Util.wsSend(
      this.head,
      Object.assign(
        Object.select(
          this,
          'runId results isLambda workerCount passedFocus'.split(' ')
        ),
        {
          workingSetLength: this.workingSet.length,
          s3: Zen.s3Sync.status,
          compile: Object.select(Zen.webpack.compile, [
            'hash',
            'status',
            'errors',
            'percentage',
            'message',
          ]), // exclude files array, which has contains content
        }
      )
    )
  }
}

export default Server
