// @ts-expect-error(7016) s3-sync is any
import type S3Sync from './s3-sync'
// @ts-expect-error(7016) journal is any
import Journal from './journal'
// @ts-expect-error(7016) webpack is any
import WebpackAdapter from './webpack'
import type { metric } from './profiler'

export type Config = {
  log?: (metrics: metric[]) => Promise<void>
  appRoot: string
  port: number
  testDependencies: string[]
  lambdaConcurrency: number
  htmlTemplate: string
  sessionId: string
  useSnapshot: boolean
  tmpDir: string
  alsoServe: { addToIndex: boolean; filePath: string }[]

  aws: AWS.config.update

  // TODO flesh this out
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  webpack?: any
  chrome?: {
    width?: number
    height?: number
  }
  lambdaNames: {
    // The others are actually never used
    workTests: string
    listTests: string
  }
}

export type Zen = {
  s3Sync: S3Sync
  lambda: AWS.Lambda
  journal: Journal
  webpack?: WebpackAdapter
  indexHtml: (pageType: string, forS3: boolean) => string
  config: ZenConfig
}

export type File = {
  toCheck: boolean
  versionedPath: string
  urlPath: string
}

export type FileManifest = {
  files: File[]
  sessionId: string
  index: string
  fileMap: Record<string, undefined | string>
  assetUrl: string
}
