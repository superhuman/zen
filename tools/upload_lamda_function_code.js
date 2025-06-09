#!/usr/bin/env node

const AWS = require('aws-sdk')
const AdmZip = require('adm-zip')
const path = require('path')
const esbuild = require('esbuild')
const fs = require('fs')
const { Command } = require('commander')

// Configure Commander.js
const program = new Command()

program
    .description('Update existing AWS Lambda function with new code')
    .version('1.0.0')
    .requiredOption('-f, --function-name <name>', 'Lambda function name')
    .option('-p, --publish', 'Publish a new version after updating code', false)

// Parse command line arguments
program.parse()
const options = program.opts()

const ZIP_PATH = path.join(__dirname, '../build/lambda_code/lambda-code.zip')

if (!process.env.SECRET_ACCESS_KEY || !process.env.ACCESS_KEY_ID) {
  console.log('You need to set AWS premissions to do the upload')
  process.exit(1)
}

// Configure AWS (uses default region from AWS CLI/environment)
AWS.config.update({
  secretAccessKey: process.env.SECRET_ACCESS_KEY,
  accessKeyId: process.env.ACCESS_KEY_ID,
  region: 'us-west-1',
})
const lambda = new AWS.Lambda()

// Colors for console output
const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    reset: '\x1b[0m'
}

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`)
}

function buildAndZipCode () {
  // Create a the zip file
  const zip = new AdmZip()
  const files = ['lambda.js', 'chrome_wrapper.ts']
  files.forEach((file) => {
    const [basename, filetype] = file.split('.')
    // TODO make this use partial esbuild config
    let bundleConfig = {
      bundle: false,
    }
    if (file !== 'lambda') {
      bundleConfig = {
        bundle: true,
        // These are in the lambda layer we use and do not need to be bundled
        external: ['chrome-aws-lambda', 'puppeteer-core', 'aws-sdk'],
      }
    }
    esbuild.buildSync({
      entryPoints: [path.join(__dirname, `../lib/${basename}.${filetype}`)],
      platform: 'node',
      outfile: path.join(__dirname, '../build/lambda_code', basename + '.js'),
      ...bundleConfig,
    })
    zip.addLocalFile(path.join(__dirname, `../build/lambda_code/${basename}.js`))
  })

  zip.writeZip(ZIP_PATH)
}


// Check if Lambda function exists
async function functionExists() {
    try {
        await lambda.getFunction({ FunctionName: options.functionName }).promise()
        return true
    } catch (error) {
        if (error.code === 'ResourceNotFoundException') {
            log(`Error: Function '${options.functionName}' does not exist`, 'red')
            log('This script only updates existing functions. Please create the function first.', 'yellow')
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
async function updateFunction() {
    log('Updating function code...', 'yellow')

    const zipBuffer = readZipFile()

    try {
        const updateCodeParams = {
            FunctionName: options.functionName,
            ZipFile: zipBuffer,
            Publish: options.publish
        }

        await lambda.updateFunctionCode(updateCodeParams).promise()
        log('Function code updated successfully!', 'green')

    } catch (error) {
        log(`Error updating function: ${error.message}`, 'red')
        throw error
    }
}

// Wait for function to be ready
async function waitForFunction() {
    log('Waiting for function to be ready...')

    const maxAttempts = 30
    let attempts = 0

    while (attempts < maxAttempts) {
        try {
            const result = await lambda.getFunction({ FunctionName: options.functionName }).promise()
            if (result.Configuration.State === 'Active') {
                return
            }
        } catch (error) {
            // Continue waiting
        }

        attempts++
        await new Promise(resolve => setTimeout(resolve, 2000))
    }

    log('Warning: Function may not be ready yet', 'yellow')
}

// Get function information
async function getFunctionInfo() {
    try {
        const result = await lambda.getFunction({ FunctionName: options.functionName }).promise()
        const config = result.Configuration

        log('\nFunction Information:', 'yellow')
        console.log(`Function Name: ${config.FunctionName}`)
        console.log(`Runtime: ${config.Runtime}`)
        console.log(`Handler: ${config.Handler}`)
        console.log(`Code Size: ${config.CodeSize} bytes`)
        console.log(`Last Modified: ${config.LastModified}`)
        console.log(`Function ARN: ${config.FunctionArn}`)

        return config.FunctionArn
    } catch (error) {
        log(`Error getting function info: ${error.message}`, 'red')
        throw error
    }
}

// Main deployment function
async function deploy() {
    try {
        log('AWS Lambda Update Script', 'yellow')
        console.log(`Function: ${options.functionName}`)

        buildAndZipCode()

        // Check if function exists
        const exists = await functionExists()

        if (!exists) {
            log('Update failed: Function does not exist', 'red')
            process.exit(1)
        }

        // Update the function
        await updateFunction()

        // Wait for function to be ready
        await waitForFunction()

        // Get function info
        const functionArn = await getFunctionInfo()

        log('\nUpdate completed successfully!', 'green')
        log(`Function ARN: ${functionArn}`)

    } catch (error) {
        log(`Update failed: ${error.message}`, 'red')
        process.exit(1)
    }
}

// Run the deployment
if (require.main === module) {
    deploy()
}

module.exports = { deploy }
