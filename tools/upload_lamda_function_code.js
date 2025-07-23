#!/usr/bin/env node

const { S3Client, UploadCommand } = require('@aws-sdk/client-s3')
const { Upload } = require('@aws-sdk/lib-storage')
const {
  LambdaClient,
  GetFunctionCommand,
  UpdateFunctionCodeCommand,
} = require('@aws-sdk/client-lambda')
const AdmZip = require('adm-zip')
const path = require('path')
const esbuild = require('esbuild')
const fs = require('fs')
const { Command } = require('commander')
const { execSync } = require('child_process')

const NODE_MODULE_LAYER_DEPENDENCIES = [
  'puppeteer',
  'puppeteer-core',
  '@sparticuz/chromium',
  '@aws-sdk/client-s3',
  '@aws-sdk/client-lambda',
  '@aws-sdk/lib-storage',
]

const CHROMIUM_LAYER_DEPENDENCIES = ['@sparticuz/chromium']

const stagingConfig = {
  functionNames: ['zen-workTests-staging', 'zen-listTests-staging'],
}

const productionConfig = {
  functionNames: ['zen-workTests-production', 'zen-listTests-production'],
}

// TODO: automatically upload the layers as well
// Production:
// zen-dependencies-production
// chromium-staging-production

// Staging
// zen-dependencies-staging
// chromium-staging



// Configure Commander.js
const program = new Command()

program
  .description(
    'Update existing AWS Lambda function with new code.'
  )
  .version('1.0.0')
  .requiredOption('--env <env>', 'Environment (production|staging)', 'staging')

// Parse command line arguments
program.parse()
const options = program.opts()

const isProduction = options.env === 'production'

let lambdaConfig = stagingConfig

if (isProduction) {
  lambdaConfig = productionConfig
}

const ZIP_PATH = path.join(__dirname, '../build/lambda_code/lambda-code.zip')

if (!process.env.SECRET_ACCESS_KEY || !process.env.ACCESS_KEY_ID) {
  console.log('You need to set AWS premissions to do the upload')
  process.exit(1)
}

// Configure AWS (uses default region from AWS CLI/environment)
const lambda = new LambdaClient({
  credentials: {
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
    accessKeyId: process.env.ACCESS_KEY_ID,
  },
  region: 'us-west-1',
})

// Colors for console output
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m',
}

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`)
}

// TODO: this should use regular build
function buildAndZipCode() {
  // Create a the zip file
  const zip = new AdmZip()
  const files = ['lambda.js', 'chrome_wrapper.ts']
  files.forEach((file) => {
    const [basename, filetype] = file.split('.')

    esbuild.buildSync({
      bundle: true,
      entryPoints: [path.join(__dirname, `../lib/${basename}.${filetype}`)],
      platform: 'node',
      outfile: path.join(__dirname, '../build/lambda_code', basename + '.js'),
      external: NODE_MODULE_LAYER_DEPENDENCIES.concat(
        CHROMIUM_LAYER_DEPENDENCIES
      ),
    })
    zip.addLocalFile(
      path.join(__dirname, `../build/lambda_code/${basename}.js`)
    )
  })

  zip.writeZip(ZIP_PATH)
}

// Check if Lambda function exists
async function functionExists(functionName) {
  try {
    await lambda.send(new GetFunctionCommand({ FunctionName: functionName }))
    return true
  } catch (error) {
    if (error.code === 'ResourceNotFoundException') {
      log(`Error: Function '${functionName}' does not exist`, 'red')
      log(
        'This script only updates existing functions. Please create the function first.',
        'yellow'
      )
      return false
    }
    throw error
  }
}

// Read ZIP file
function readZipFile() {
  try {
    return fs.readFileSync(ZIP_PATH)
  } catch (error) {
    log(`Error reading ZIP file: ${error.message}`, 'red')
    throw error
  }
}

// Update Lambda function
async function updateFunction(functionName) {
  log(`Updating function code for ${functionName}...`, 'yellow')

  const zipBuffer = readZipFile()

  try {
    const updateCodeParams = {
      FunctionName: functionName,
      ZipFile: zipBuffer,
      Publish: true,
    }

    await lambda.send(new UpdateFunctionCodeCommand(updateCodeParams))
    log(`Function code updated successfully for ${functionName}!`, 'green')
  } catch (error) {
    log(`Error updating function ${functionName}: ${error.message}`, 'red')
    throw error
  }
}

// Wait for function to be ready
async function waitForFunction(functionName) {
  log(`Waiting for function ${functionName} to be ready...`)

  const maxAttempts = 30
  let attempts = 0

  while (attempts < maxAttempts) {
    try {
      const result = await lambda.send(
        new GetFunctionCommand({ FunctionName: functionName })
      )
      if (result.Configuration.State === 'Active') {
        return
      }
    } catch (error) {
      // Continue waiting
    }

    attempts++
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  log(`Warning: Function ${functionName} may not be ready yet`, 'yellow')
}

// Get function information
async function getFunctionInfo(functionName) {
  try {
    const result = await lambda.send(
      new GetFunctionCommand({ FunctionName: functionName })
    )
    const config = result.Configuration

    log(`\nFunction Information for ${functionName}:`, 'yellow')
    console.log(`Function Name: ${config.FunctionName}`)
    console.log(`Runtime: ${config.Runtime}`)
    console.log(`Handler: ${config.Handler}`)
    console.log(`Code Size: ${config.CodeSize} bytes`)
    console.log(`Last Modified: ${config.LastModified}`)
    console.log(`Function ARN: ${config.FunctionArn}`)

    return config.FunctionArn
  } catch (error) {
    log(
      `Error getting function info for ${functionName}: ${error.message}`,
      'red'
    )
    throw error
  }
}

// Main deployment function
async function deploy() {
  try {
    log('AWS Lambda Update Script', 'yellow')
    console.log(`Functions: ${lambdaConfig.functionNames.join(', ')}`)

    buildAndZipCode()

    const functionArns = []
    let allSuccess = true

    let functionNames = []

    // Process each function
    for (const functionName of lambdaConfig.functionNames) {
      try {
        log(`\nProcessing function: ${functionName}`, 'yellow')

        // Check if function exists
        const exists = await functionExists(functionName)

        if (!exists) {
          log(`Update failed: Function ${functionName} does not exist`, 'red')
          allSuccess = false
          continue
        }

        // Update the function
        await updateFunction(functionName)

        // Wait for function to be ready
        await waitForFunction(functionName)

        // Get function info
        const functionArn = await getFunctionInfo(functionName)
        functionArns.push(functionArn)
      } catch (error) {
        log(`Update failed for ${functionName}: ${error.message}`, 'red')
        allSuccess = false
      }
    }

    if (allSuccess) {
      log('\nAll updates completed successfully!', 'green')
    } else {
      log('\nSome updates failed. Check the logs above for details.', 'yellow')
    }

    if (functionArns.length > 0) {
      log('\nSuccessfully updated functions:')
      functionArns.forEach((arn) => console.log(`  ${arn}`))
    }
  } catch (error) {
    log(`Deployment failed: ${error.message}`, 'red')
    process.exit(1)
  }
}

// Run the deployment
if (require.main === module) {
  deploy()
}

module.exports = { deploy }
