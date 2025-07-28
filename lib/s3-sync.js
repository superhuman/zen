import path from 'path'
import EventEmitter from 'events'
import klaw from 'klaw'
import mime from 'mime-types'
import { S3Client, UploadCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import crypto from 'crypto'
import Util from './util'

module.exports = class S3Sync extends EventEmitter {
  constructor(zen) {
    super()
    this.zen = zen
    this.s3 = new S3Client({
      region: zen.config.aws.region,
      maxAttempts: 10,
    })

    // The snapshot makes things faster with a slight risk that we're out of date with s3
    if (zen.config.useSnapshot) {
      this.snapshotPath = path.join(zen.config.tmpDir, 'sync-snapshot.json')
      this.snapshot = JSON.parse(Util.readFile(this.snapshotPath) || '{}')
    } else {
      this.snapshot = {}
    }

    // Invalidate the local cache if someone has changed S3k
    if (
      zen.config.aws.s3CacheVersion &&
      this.snapshot.version !== zen.config.aws.s3CacheVersion
    ) {
      this.snapshot = {}
    }
  }

  async run(index) {
    let compile = this.zen.webpack.compile
    let hashed = 0,
      uploaded = 0
    this.files = {}
    this.announce('Checking directories')

    // first, get all the directories we'd like to sync
    let syncedDirs = [
      {
        filePath: __dirname,
        webPath: '/build',
        filter: (p) => p.match(/worker.js|latte.js/),
      },
    ].concat(this.zen.config.alsoServe || [])

    // recursively stat every directory, getting a list of files
    let diskFiles = await Promise.all(syncedDirs.map(recursiveStat))

    diskFiles.flatten().forEach((f) => {
      // We want to preserve the part of the path relative to the specified filePath, unless that would remove the filename
      f.urlPath =
        f.path === f.dir.filePath
          ? path.basename(f.dir.filePath)
          : f.path.replace(f.dir.filePath, '')
      f.urlPath = path.join(f.dir.webPath || '', f.urlPath).replace(/^\//, '')
      f.mtime = f.stats.mtime.getTime()
      this.files[f.urlPath] = f
      console.log('diskFile:', f.urlPath)
    })

    // include the results from the last webpack compile
    compile.files.forEach((f) => {
      f.urlPath = f.path
      console.log('compileFile:', f.urlPath)
      this.files[f.urlPath] = f
    })

    // Compute the hash, and decide if we want to check for this file in S3.
    // We only need to compute the hash if the mtime of the file has changed,
    // and we only need to check on S3 if the hash has changed.
    // Both of these caches ensure we do the minimum amount of work each run.
    await workInPool(Object.values(this.files), 10, async (f) => {
      let snap = this.snapshot[f.urlPath]
      if (snap && snap.mtime && snap.mtime === f.mtime) f.hash = snap.hash // the mtime is unchanged, so our hash is still valid

      if (!snap || !snap.hash || snap.hash !== f.hash) f.toCheck = true // only check files if the content hash changed

      if (!f.hash) {
        let body = f.body || (await Util.readFileAsync(f.path))
        f.hash = crypto.createHash('md5').update(body).digest('hex')
        if (process.env.VERBOSE === 'true') {
          this.announce(`Hashed ${++hashed} files`)
        }
      }
      let p = path.parse(f.urlPath)
      f.versionedPath = `${p.dir}/${p.name}-${f.hash}${p.ext}`
    })

    // TODO only do this if any files needs checking
    this.announce('Syncing with S3')

    let { needed } = await this.zen.lambdaInvoke('zen-sync', {
      sessionId: this.zen.config.sessionId,
      files: Object.values(this.files).map((f) =>
        Object.select(f, ['urlPath', 'toCheck', 'versionedPath'])
      ),
      index,
    })

    // start uploading changed files
    this.announce(`Uploading 0/${needed.length}`)
    await workInPool(needed, 20, async (need) => {
      let f = this.files[need.urlPath]
      let Key = f.versionedPath

      let Body = f.body || (await Util.readFileAsync(f.path, null))
      Body = Body instanceof Buffer ? Body : Buffer.from(Body)
      let ContentType =
        f.contentType ||
        mime.contentType(path.basename(f.path)) ||
        'application/octet-stream'

      const upload = new Upload({
        client: this.s3,
        params: {
          Bucket: this.zen.config.aws.assetBucket,
          Key,
          Body,
          ContentType,
        },
      })
      let result = await upload.done()

      // TODO handle an individual upload failure
      this.announce({ uploaded: uploaded + 1 })
      this.announce(`Uploading ${++uploaded}/${needed.length}`)
    })

    if (this.zen.config.useSnapshot) {
      this.snapshot = Object.map(this.files, (f) =>
        Object.select(f, ['mtime', 'hash'])
      )
      this.snapshot.version = this.zen.config.aws.s3CacheVersion || 0
      await Util.writeFile(this.snapshotPath, JSON.stringify(this.snapshot))
    }
    this.announce('done')
  }

  announce(msg) {
    this.status = msg
    this.emit('status', msg)
  }
}

function workInPool(list, concurrency, fn) {
  let remaining = list.clone()
  return Promise.all(
    concurrency.times(async function () {
      while (remaining.length > 0) await fn(remaining.pop())
    })
  )
}

function recursiveStat(syncedDir) {
  return new Promise((res, rej) => {
    let files = []
    klaw(syncedDir.filePath)
      .on('data', (item) => {
        if (item.stats.isDirectory()) return
        if (syncedDir.filter && !syncedDir.filter(item.path)) return
        files.push(Object.assign({ dir: syncedDir }, item))
      })
      .on('error', rej)
      .on('end', () => res(files))
  })
}
