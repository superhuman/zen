/*eslint-env node*/

import { build } from 'esbuild'
import yargs from 'yargs'
import { nodeExternalsPlugin } from 'esbuild-node-externals'

const argv = yargs(process.argv)
  .alias('w', 'watch')
  .describe('w', 'toggle watch mode').argv

let watch
if (argv.watch) {
  watch = {
    onRebuild(error, result) {
      if (error) console.error('watch build failed:', error)
      else console.log('watch build succeeded:', result)
    },
  }
}

// // Build the CLI
build({
  entryPoints: ['lib/cli/index.ts'],
  outfile: 'build/cli.js',
  bundle: true,
  platform: 'node',
  plugins: [nodeExternalsPlugin()],
  watch,
  external: ['chrome-aws-lambda', 'puppeteer-core'],
}).catch(() => process.exit(1))

function buildSimpleFile(file, outfile, platform = 'browser') {
  build({
    entryPoints: [file],
    outfile: `build/${outfile}.js`,
    platform,
    bundle: true,
    plugins: [nodeExternalsPlugin()],
    external: ['chrome-aws-lambda', 'puppeteer-core'],
    watch,
  }).catch(() => process.exit(1))
}

buildSimpleFile('lib/webpack/webpack-client.ts', 'webpack-client', 'node')
buildSimpleFile('lib/latte.ts', 'latte')
buildSimpleFile('lib/worker.js', 'worker')
buildSimpleFile('lib/head.js', 'head')
