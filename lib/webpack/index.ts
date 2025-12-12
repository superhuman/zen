import path from 'path'
import webpack, { Chunk } from 'webpack'
import webpackDevMiddleware from 'webpack-dev-middleware'
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

type webpackStats = {
  hash: string | undefined
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
  private readonly RECOMPILE_DEBOUNCE_MS = 5000 // Ignore recompilations within 5s of done

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
      return e.module ? `${e.module.id}: ${e.message}` : e.message
    })

    // Get files from compilation assets
    // In Webpack 5, we need to use getAsset() and handle different source types
    const files: File[] = []
    const outputPath = stats.compilation.outputOptions.path || ''
    const outputFileSystem = this.compiler.outputFileSystem
    
    const assetNames = Object.keys(stats.compilation.assets)
    console.log(`[Zen Webpack] Processing ${assetNames.length} assets, outputPath: ${outputPath}`)
    console.log(`[Zen Webpack] outputFileSystem available: ${!!outputFileSystem}, has readFileSync: ${!!(outputFileSystem && typeof (outputFileSystem as any).readFileSync === 'function')}`)
    
    for (const name of assetNames) {
      try {
        let content: string | Buffer | null = null
        
        // Try reading from compiler's outputFileSystem (set by webpack-dev-middleware)
        if (outputFileSystem && typeof (outputFileSystem as any).readFileSync === 'function') {
          try {
            const filePath = path.join(outputPath, name)
            content = (outputFileSystem as any).readFileSync(filePath)
            if (content) {
              console.log(`[Zen Webpack] Read ${name} from outputFileSystem (${content.length} bytes)`)
            }
          } catch (e) {
            // File not available in outputFileSystem
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
                if (content) {
                  console.log(`[Zen Webpack] Read ${name} from asset.source (${typeof content === 'string' ? content.length : (content as Buffer).length} bytes, source type: ${sourceName})`)
                }
              } catch (e) {
                console.log(`[Zen Webpack] Failed to read ${name} from asset.source (${sourceName}): ${e}`)
              }
            } else {
              console.log(`[Zen Webpack] Skipping ${name} - SizeOnlySource`)
            }
          }
        }
        
        if (content) {
          files.push({ path: `webpack/${name}`, body: content })
        }
      } catch (e) {
        console.log(`[Zen Webpack] Error processing ${name}: ${e}`)
      }
    }

    console.log(`[Zen Webpack] Total files collected: ${files.length}`)

    // Create new object since stats.hash is a read-only getter
    const state: webpackStats = {
      hash,
      compilation: stats.compilation,
      files,

      entrypoints:
        stats.compilation.entrypoints
          .get('bundle')
          ?.chunks.map((chunk: Chunk) => chunk.files.values().next().value) ||
        [],

      errors,
      status: errors.length ? ('error' as const) : ('done' as const),
    } as webpackStats

    console.log(`[Zen Webpack] State: status=${state.status}, files=${state.files.length}, entrypoints=${state.entrypoints}`)

    this.onStateChange(state)
  }

  onStateChange(state: state) {
    // Debounce rapid recompilations after done (workers reloading can trigger rebuilds)
    if (state.status === 'compiling' && this.lastDoneTime) {
      const timeSinceDone = Date.now() - this.lastDoneTime
      if (timeSinceDone < this.RECOMPILE_DEBOUNCE_MS) {
        return
      }
    }
    
    if (state.status === 'done') {
      this.lastDoneTime = Date.now()
    }
    
    this.compile = state
    this.status = state.status
    this.emit('status', this.status, state)
  }
}

export default WebpackAdapter
