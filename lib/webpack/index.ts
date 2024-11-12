import path from 'path'
import webpack, { Chunk } from 'webpack'
import WebpackDevServer from 'webpack-dev-server'
import EventEmitter from 'events'

import type { Configuration as WebpackConfig, Compiler, Stats } from 'webpack'
import type { Server } from 'connect'
import type { ZenConfig } from '../index'

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
  private zenConfig?: ZenConfig

  constructor(zenConfig: Configuration) {
    super()

    this.zenConfig = zenConfig
    const webpackConfig: WebpackConfig = zenConfig.webpack
    this.addWebpackClient(webpackConfig)

    if (!webpackConfig.plugins) webpackConfig.plugins = []
    webpackConfig.plugins.push(new webpack.ExtendedAPIPlugin())
    webpackConfig.plugins.push(
      new webpack.ProgressPlugin((pct, message) => {
        if (pct > 0 && pct < 1)
          this.onStateChange({
            status: 'compiling',
            percentage: Math.round(pct * 100),
            message,
          })
      })
    )

    webpackConfig.plugins.push(new webpack.NamedModulesPlugin())
    this.compiler = webpack(webpackConfig)

    this.compiler.hooks.invalid.tap('Zen', () =>
      this.onStateChange({ status: 'compiling' })
    )
    this.compiler.hooks.compile.tap('Zen', () =>
      this.onStateChange({ status: 'compiling' })
    )
    this.compiler.hooks.failed.tap('Zen', (error: Error) =>
      this.onStateChange({ status: 'error', errors: [error] })
    )
    this.compiler.hooks.done.tap('Zen', this.onStats.bind(this))
  }

  // TODO this will most likely break once webpack is updated
  // bundle has been removed from the types at this point
  addWebpackClient(config: any) {
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
    const zenConfig = this.zenConfig
    if (zenConfig?.setDevelopmentHeaders) {
      WebpackDevServer.prototype.setContentHeaders = function (req, res, next) {
        if (this.headers) {
          for (var name in this.headers) {
            res.setHeader(name, this.headers[name])
          }
        }

        zenConfig.setDevelopmentHeaders(req, res)
        next()
      }
    }

    const devServer = new WebpackDevServer({
      client: {
        logging: 'none',
      },
      devMiddleware: {
        stats: {
          preset: 'minimal', // Only output when errors or new compilation
          moduleTrace: false,
          errorDetails: false
        },
        publicPath: '/'
      },
      // Silence server startup logs
      setupMiddlewares: (middlewares, devServer) => {
        devServer.logger.info = () => {};

        return middlewares;
      },
      hot: true,
      static: {
        directory: path.resolve(__dirname, '../build')
      },
      port: 9000
    }, this.compiler)
    await devServer.start()
    console.log('devServer.app', !!devServer.app)
    server.use('/webpack', devServer.app)
  }

  onStats(stats: Stats) {
    const errors = (stats.compilation.errors || []).map((e) => {
      return e.module ? `${e.module.id}: ${e.message}` : e.message
    })

    const files = Object.keys(stats.compilation.assets).map((name) => {
      const source = stats.compilation.assets[name].source()
      return { path: `webpack/${name}`, body: source }
    })
    const entrypoints = stats.compilation.entrypoints
      .get('bundle')
      ?.chunks.map((chunk: Chunk) => chunk.files.values().next().value) ||
      []

    console.log('files', files)
    console.log('entrypoints', entrypoints)

    const state = Object.assign(stats, {
      files,
      entrypoints,
      errors,
      status: errors.length ? ('error' as const) : ('done' as const),
    })

    this.onStateChange(state)
  }

  onStateChange(state: state) {
    this.compile = state
    this.status = state.status
    this.emit('status', this.status, state)
  }
}
