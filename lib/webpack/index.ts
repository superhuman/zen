import path from 'path'
import webpackDevMiddleware, { type OutputFileSystem } from 'webpack-dev-middleware'
import EventEmitter from 'events'

import webpack, { type Configuration as WebpackConfig, type Compiler, type Stats, Module } from 'webpack'
import type { Server } from 'connect'
import type { ZenConfig } from '../index'
import isFunction from 'lodash/isFunction'

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

type webpackStats = {
  hash?: string
  compilation: Stats['compilation']
  files: File[]
  entrypoints: string[]
  errors: string[]
  status: 'error' | 'done'
}

type state = CompilingState | FailedState | webpackStats

class WebpackAdapter extends EventEmitter {
  compiler: Compiler
  compile?: state
  status?: state['status']
  private zenConfig?: ZenConfig
  private lastDoneTime?: number

  constructor(zenConfig: ZenConfig) {
    super()

    this.zenConfig = zenConfig
    const webpackConfig: WebpackConfig = zenConfig.webpack
    this.addWebpackClient(webpackConfig)

    if (!webpackConfig.plugins) webpackConfig.plugins = []
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
    this.compiler = webpack(webpackConfig)

    this.compiler.hooks.beforeCompile.tap('Zen', () => {
      this.onStateChange({ status: 'start_compile' })
    })

    this.compiler.hooks.invalid.tap('Zen', () => {
      this.onStateChange({ status: 'compiling' })
    })
    this.compiler.hooks.compile.tap('Zen', () => {
      this.onStateChange({ status: 'compiling' })
    })
    this.compiler.hooks.failed.tap('Zen', (error: Error) => {
      this.onStateChange({ status: 'error', errors: [error] })
    })
    this.compiler.hooks.done.tap('Zen', (stats) => {
      this.onStats(stats)
    })
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

  startDevServer(server: Server) {
    const zenConfig = this.zenConfig
    // publicPath is '/' because Connect strips the mount path '/webpack'
    const middleware = webpackDevMiddleware(this.compiler, {
      publicPath: '/',
      writeToDisk: false,
    })

    // Add custom headers middleware if configured
    if (zenConfig?.setDevelopmentHeaders) {
      server.use((req, res, next) => {
        zenConfig.setDevelopmentHeaders(req, res)
        next()
      })
    }

    server.use('/webpack', middleware)
  }

  onStats(stats: Stats) {
    const hash = stats.hash
    const errors = (stats.compilation.errors || []).map((e) => {
      const mod = e && 'module' in e ? (e.module as Module | undefined) : undefined
      return mod ? `${mod.id}: ${e.message}` : e.message
    })

    // Get files from compilation assets
    // In Webpack 5, we need to use getAsset() and handle different source types
    const files: File[] = []
    const outputPath = stats.compilation.outputOptions.path || ''
    const outputFileSystem = this.compiler.outputFileSystem as OutputFileSystem

    const assetNames = Object.keys(stats.compilation.assets)

    for (const name of assetNames) {
      try {
        let content: string | Buffer | null = null

        // Try reading from compiler's outputFileSystem (set by webpack-dev-middleware)
        if (isFunction(outputFileSystem?.readFileSync)) {
          try {
            const filePath = path.join(outputPath, name)
            content = outputFileSystem.readFileSync(filePath)
          } catch (e) {
            console.log(`[Webpack] File not available in outputFileSystem: ${name}`, e)
          }
        }

        // Fall back to getting source from compilation asset
        if (!content) {
          const asset = stats.compilation.getAsset(name)
          if (asset?.source) {
            // Check if it's a readable source (not SizeOnlySource)
            const sourceName = asset.source.constructor?.name || 'unknown'
            if (sourceName !== 'SizeOnlySource') {
              try {
                content = asset.source.source()
              } catch (e) {
                console.log(`[Webpack] Failed to read source for asset: ${name}`, e)
              }
            }
          }
        }
        files.push({ path: `webpack/${name}`, body: content })
      } catch (e) {
        console.log(`[Webpack] Error processing asset: ${name}`, e)
      }
    }

    // Get first file from each chunk in 'bundle' entry (typically the main .js file)
    // Fall back to first entrypoint if 'bundle' doesn't exist
    const bundleEntry = stats.compilation.entrypoints.get('bundle')
      || stats.compilation.entrypoints.values().next().value
    const entrypoints = bundleEntry
      ? bundleEntry.chunks.map(chunk => chunk.files.values().next().value).filter(Boolean)
      : []

    // Create new object since stats.hash is a read-only getter
    const state: state = {
      hash,
      compilation: stats.compilation,
      files,
      entrypoints,
      errors,
      status: errors.length ? 'error' : 'done'
    }

    this.onStateChange(state)
  }

  onStateChange(state: state) {
    if (state.status == 'start_compile') {
      this._isCompiling = true
    }

    if (state.status === 'done' || state.status === 'error') {
      this._isCompiling = false
    }

    // Progress plugin can fire compile events after compile finishes
    // so we guard against that here.
    if (!this._isCompiling && state.status === 'compiling') {
      return
    }

    this.compile = state
    this.status = state.status
    this.emit('status', this.status, state)
  }
}

export default WebpackAdapter
