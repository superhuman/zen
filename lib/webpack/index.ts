import path from 'path'
import webpack, { Chunk } from 'webpack'
import WebpackDevServer from 'webpack-dev-server'
import type { Configuration, Compiler, Stats } from 'webpack'
import type { Server } from 'connect'
import EventEmitter from 'events'

type CompilingState = {
  status: 'compiling'
  percentage?: number
  message?: string
}

type FailedState = {
  status: 'error'
  errors: Error[]
}

type File = {
  path: string
  body: string | Buffer
}

type webpackStats = Stats & {
  files: File[]
  entrypoints: string[]
  errors: string[]
  status: 'error' | 'done'
}

type state = CompilingState | FailedState | webpackStats

module.exports = class WebpackAdapter extends EventEmitter {
  compiler: Compiler
  compile?: state
  status?: state['status']

  constructor(config: Configuration) {
    super()
    this.addWebpackClient(config)

    if (!config.plugins) config.plugins = []
    config.plugins.push(new webpack.HotModuleReplacementPlugin())
    config.plugins.push(
      new webpack.ProgressPlugin((pct, message) => {
        if (pct > 0 && pct < 1)
          this.onStateChange({
            status: 'compiling',
            percentage: Math.round(pct * 100),
            message,
          })
      })
    )

    if (!config.optimization) {
      config.optimization = { moduleIds: 'named' }
    }
    this.compiler = webpack(config)

    this.compiler.hooks.invalid.tap('Zen', () =>
      this.onStateChange({ status: 'compiling' })
    )
    this.compiler.hooks.compile.tap('Zen', () =>
      this.onStateChange({ status: 'compiling' })
    )
    this.compiler.hooks.failed.tap('Zen', (error: Error) =>
      this.onStateChange({ status: 'error', errors: [error] })
    )
  }

  // TODO this will most likely break once webpack is updated
  // bundle has been removed from the types at this point
  addWebpackClient(config: any) {
    console.log('=============== addWebpackClient', config)
    if (!config.entry.bundle) throw Error('Zen config requires an entry bundle')

    config.entry.bundle.push(path.join(__dirname, '../build/webpack-client.js'))
  }

  async build() {
    return await new Promise((resolve, reject) => {
      this.compiler.run((error, stats) => {
        if (error) {
          return reject(error)
        } else if (stats?.hasErrors()) {
          const info = stats.toJson()
          return reject(new Error(info.errors.join('\n')))
        }

        resolve(stats)
      })
    })
  }

  async startDevServer(server: Server) {
    const options = {
      ...this.compiler.options.devServer,
      hot: true,
    }
    const devServer = new WebpackDevServer(options, this.compiler)

    await devServer.start()
    server.use('/webpack', devServer.app)
  }

  onStateChange(state: state) {
    this.compile = state
    this.status = state.status
    this.emit('status', this.status, state)
  }
}
