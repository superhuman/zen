const path = require('path')
const http = require('http')
const connect = require('connect')
const WebSocket = require('ws')
const {
  serveWith404,
  serveSvelte,
  serveIcons,
  workTests,
  wsSend,
} = require('./util')

module.exports = class Server {
  constructor() {
    this.runId = 1
    this.head = null
    this.isLambda = false
    this.workerCount = 0
    this.workingSet = []
    this.results = [] // results of all tests run
    this.passedFocus = [] // all tests that passed after running

    // start up the local webserver for `head` to connect to
    let app = connect()
    let server = http.createServer(app).listen(Zen.config.port)
    app.use('/build', serveWith404(path.join(__dirname))) // serve up stuff out of lib
    app.use(
      '/node_modules',
      serveWith404(path.resolve(Zen.config.appRoot, './node_modules'))
    ) // serve up stuff out of lib
    app.use('/base', serveWith404(Zen.config.appRoot)) // base serves things out of the application's root
    app.use('/svelte', serveSvelte)
    app.use('/icons', serveIcons)

    if (Zen.webpack) {
      Zen.webpack.startDevServer(app)
      Zen.webpack.on('status', () => {
        this.sendStatus() 
      })
    }

    Zen.s3Sync.on('status', this.sendStatus.bind(this))

    new WebSocket.Server({ server }).on(
      'connection',
      this.onWebsocket.bind(this)
    )

    // host worker and head. NB this should go last after all other `app.use()` calls
    app.use(async (req, resp) => {
      resp.end(Zen.indexHtml(req.url.match(/^\/worker/) ? 'worker' : 'head'))
    })
  }
  
  filterTests(msg) {
    // If nothing has changed and we're not running, leave the state unchanged.
    // When you refresh `head`, we don't want to run or clear out results unless the grep changed.
    if (!msg.run && this.grep === msg.grep) return

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

    if (msg.run && Zen.webpack.status == 'done') {
      this.runId++
      this.runTests(msg)
      this.sendStatus()
    }
  }

  async runTests({ logs }) {
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

    runGroups.forEach(async (group) => {
      const testNames = group.tests
      try {
        let response = await workTests(Zen, {
          testNames,
          sessionId: Zen.config.sessionId,
          logs,
        })
        const logStreamName = response.logStreamName

        // Map back to the old representation and fill in any tests that may have not run
        const results = testNames.map((test) => {
          const results = response.results[test] || []
          const result = results.at(-1)

          if (!result) {
            console.log(test, response.results, results)
            return {
              fullName: test,
              attempts: 0,
              error: 'Failed to run on remote!',
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

        if (startingRunId !== this.runId) return
        this.onResults(results)
      } catch (e) {
        if (startingRunId !== this.runId) return

        this.onResults(
          testNames.map((fullName, testNumber) => {
            return {
              error: e.message,
              fullName,
              // batchId: workerId,
              testNumber,
            }
          })
        )
      }
    })
  }

  onWebsocket(ws) {
    this.head = ws
    ws.on('message', (msg) => {
      msg = JSON.parse(msg)
      if (msg.type === 'filterTests') this.filterTests(msg)
      if (msg.type === 'passedFocus') this.passedFocus.push(msg.test)
      this.sendStatus()
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
    wsSend(this.head, { results: step })
  }

  sendStatus() {
    wsSend(
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
