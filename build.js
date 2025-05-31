const esbuild = require('esbuild')
const yargs = require('yargs')
const { nodeExternalsPlugin } = require('esbuild-node-externals')

const argv = yargs(process.argv)
  .alias('w', 'watch')
  .describe('w', 'toggle watch mode').argv

async function build() {
  // Build the CLI
  const ctx = await esbuild.context({
    entryPoints: ['lib/cli.ts'],
    outfile: 'build/cli.js',
    bundle: true,
    platform: 'node',
    sourcemap: true,
    plugins: [nodeExternalsPlugin()],
    external: ['chrome-aws-lambda', 'puppeteer-core'],
  })

  if (argv.watch) {
    await ctx.watch()
    console.log('Watching for changes...')
  } else {
    await ctx.rebuild()
    await ctx.dispose()
  }
}

async function buildSimpleFile(file, outfile, platform = 'browser') {
  const ctx = await esbuild.context({
    entryPoints: [file],
    outfile: `build/${outfile}.js`,
    platform,
    bundle: true,
    sourcemap: true,
    plugins: [nodeExternalsPlugin()],
    external: ['chrome-aws-lambda', 'puppeteer-core'],
  })

  if (argv.watch) {
    await ctx.watch()
  } else {
    await ctx.rebuild()
    await ctx.dispose()
  }
}

build().catch(() => process.exit(1))

buildSimpleFile(
  'lib/webpack/webpack-client.ts',
  'webpack-client',
  'node'
).catch(() => process.exit(1))
buildSimpleFile('lib/latte.ts', 'latte').catch(() => process.exit(1))
buildSimpleFile('lib/worker.js', 'worker').catch(() => process.exit(1))
buildSimpleFile('lib/head.js', 'head').catch(() => process.exit(1))
