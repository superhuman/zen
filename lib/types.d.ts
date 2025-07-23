export type TestResult = {
  name: string
  result: 'pass' | 'fail'
  duration: number
  error?: string
  logStream?: string
  requestId?: string
}
export type TestResults = Record<string, TestResult[]>
export type LambdaTestResult = {
  fullName: string
  time: number
  error?: string
  stack?: string
  logStream?: string
  requestId?: string
}
export type LambdaTestResults = Record<string, LambdaTestResult>
export type TestResultStatistics = {
  failCount: number
  passCount: number
  userLevelFlakedTests: string[]
  frameworkLevelFlakedTests: string[]
  failedTests: string[]
  passedTests: string[]
}
export type CLIOptions = {
  logging: boolean
  maxAttempts: number
  debug: boolean
  configFile: string
  reuseBuild?: boolean
  filter?: string
  headed?: boolean
  limit?: number
  verbose?: boolean
  deflake?: boolean
}
