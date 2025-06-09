const { execSync } = require('child_process')

const logFileName = process.argv[2]

const logs = execSync(`aws logs get-log-events --output=json --log-group-name "/aws/lambda/zen-workTests-staging" --log-stream-name '${logFileName}'`, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 100  })

const parsedLogs = JSON.parse(logs)

parsedLogs.events.forEach((log) => {
  const splitLog = log.message.split('\t')
  if (splitLog.some((part) => part === 'INFO')) {
    const logType = splitLog[2]
    const message = splitLog[3]
    console.log(`[${logType}] ${message}`)
  } else {
    console.log(log.message)
  }
})
