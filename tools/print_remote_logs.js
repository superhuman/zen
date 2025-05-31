const { program } = require('commander')
const { execSync } = require('child_process')

program
  .name('view-lambda-logs')
  .option('--requestId <requestId>')
  .option('--logStream <logStream>')
  .action((options) => {
    let logStream
    if (options.requestId) {
      logStream = getLogStreamFromRequestId(options.requestId)
    } else if (options.logStream) {
      logStream = options.logStream
    }

    printLogs(logStream)
  })

program.parse(process.argv)

function printLogs(logStream) {
  const logs = execSync(
    `aws logs get-log-events --output=json --log-group-name "/aws/lambda/zen-workTests-staging" --log-stream-name '${logStream}'`,
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 100 }
  )

  const parsedLogs = JSON.parse(logs)

  parsedLogs.events.forEach((log) => {
    const splitLog = log.message.split('\t')
    if (
      splitLog.some((part) => part === 'INFO') ||
      splitLog.some((part) => part === 'ERROR')
    ) {
      const logType = splitLog[2]
      const message = splitLog.slice(2).join(' ')
      console.log(`[${logType}] ${message}`)
    } else {
      console.log(log.message)
    }
  })
}

function getLogStreamFromRequestId(requestId) {
  const result = execSync(
    [
      'aws logs filter-log-events',
      `--log-group-name "/aws/lambda/zen-workTests-staging"`,
      `--filter-pattern '"${requestId}"'`,
      `--query 'events[0].logStreamName'`,
      `--output text`,
    ].join(' '),
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 100 }
  )

  console.log('result:', result.split('\n'))
  return result.split('\n').filter((line) => !!line && line !== 'None')[0]
}
