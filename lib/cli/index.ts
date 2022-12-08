// @ts-expect-error server is not typed
import Server from './server'
import initZen from '../index'
import yargs from 'yargs'
import runRemote from './run_remote'

export type CLIOptions = {
  logging: boolean
  maxAttempts: number
  debug: boolean
  configFile: string
}

yargs(process.argv.slice(2))
  .usage('$0 <cmd> [configFile]')
  .command(
    ['local [configFile]', 'server [configFile]'],
    'Run zen with a local server',
    // @ts-expect-error yargs changed their type def but this pattern still works
    (yargs: yargs.Argv) => {
      yargs.positional('file', {
        type: 'string',
        describe: 'Path to the config file',
      })
    },
    async (argv: CLIOptions) => {
      await initZen(argv.configFile)
      new Server()
    }
  )
  .command(
    'remote [configFile]',
    'Run zen in the console',
    // @ts-expect-error yargs changed their type def but this pattern still works
    (yargs: yargs.Argv) => {
      yargs.positional('file', {
        type: 'string',
        describe: 'Path to the config file',
      })
    },
    async (argv: CLIOptions) => {
      const zen = await initZen(argv.configFile)
      runRemote(zen, argv)
    }
  )
  .options({
    logging: { type: 'boolean', default: false },
    maxAttempts: { type: 'number', default: 3 },
    debug: { type: 'boolean', default: false },
  }).argv
