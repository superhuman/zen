const AWS = require('aws-sdk')
const AdmZip = require('adm-zip')
const path = require('path')
const esbuild = require('esbuild')

const assetBucket = process.env.ASSET_BUCKET
const secretAccessKey = process.env.SECRET_ACCESS_KEY
const accessKeyId = process.env.ACCESS_KEY_ID
if (!assetBucket || !secretAccessKey || !accessKeyId) {
  console.log('You need to set AWS premissions to do the upload')
  process.exit(1)
}

// Setup AWS
AWS.config.update({
  secretAccessKey,
  accessKeyId,
  region: 'us-west-1',
  apigateway: {
    endpoint: 'https://14lcmc9k91.execute-api.us-west-1.amazonaws.com/pub',
  },
  // s3CacheVersion: 1
})
const s3 = new AWS.S3({ params: { Bucket: assetBucket } })

// Create a the zip file
const zip = new AdmZip()
const files = ['lambda', 'chrome']
files.forEach(file => {
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, `../lib/${file}.js`)],
    platform: 'node',
    bundle: file !== 'lambda',
    outfile: path.join(__dirname, '../build/lambda_code', file + '.js')
  })
  zip.addLocalFile(path.join(__dirname, `../build/lambda_code/${file}.js`))
})

zip.writeZip(path.join(__dirname, '../build/lambda_code/lambda-code.zip'))

// Send the zip up to S3
const key = 'lambda-code.zip'
const body = zip.toBuffer()
const contentType = 'application/zip, application/octet-stream'
s3.upload({ Key: key, Body: body, ContentType: contentType } as any)
  .promise()
  .then((result: unknown) => {
    console.log('Upload finished!', result)
  })
  .catch((e: unknown) => {
    console.error(e)
    process.exit(1)
  })
