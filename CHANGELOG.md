# 2026-04-01 0.5.6
- Update Zen to use Webpack v5

# 2025-07-28 0.5.5

- Fixup logging

# 2025-07-28 0.5.4

- Add reload for local dev worker

# 2025-07-28 0.5.3

- Update queue reporting interval in ci
- Downgrade timeout to 30 seconds.
- Add error if extendRemoteTimeout exceeds max.

# 2025-07-28 0.5.2

- Fix aws credential passing
- Reformat code

# 2025-07-28 0.5.1

- Empty version bump to debug issue.

# 2025-07-21 0.5.0

- Add new command line flags:
  - `--filter` filter for specific test when running zen remote.
  - `--headed` opens headed browser with tests. This is the same puppeteer browser as remote so this can be useful for using devtools to inspect dom in enviorment matching remote.
  - `--deflake` run the tests many times and report back if it ever fails.
  - `--reuseBuild` reuses existing built code instead of running webpack build. This is mostly useful for iterating on zen framework changes.
  - `--limit` limit number of tests ran. Mostly useful for iterating on zen framework changes.
  - `--verbose` more logs.
- Fix bug where failing tests were marked as passed.
  - Previously there were 2 retry mechanisms: one on the lambda worker, one in the node script of zen remote. What used to happen is if the a test did all of its retries and errored, sent its results back to node script, then the node script did a retry it would mark all of those errored tests as passing.
  - New logic only has retry mechanism in the node script. Lambda has "dumber" logic in that it just runs the tests given to it. No retries.
- Add promise queue for test retries.
  - This is much faster since we can immediately retry.
- Only run 1 test at a time on lambda.
  - I would like to run multiple tests at a time for performance but I found running multiple tests leads to framework level timeouts on lambda. So it actually ends up being faster to just do one at a time.
- Upgrade the chrome version we use on aws lambda to the latest chrome.
  - Previous chrome was 4+ years old leading to local vs remote issues.
  - This also switches us from using websql to wasm sqlite in remote. Removing our last websql dependency.
  - We are now using `@sparticuz/chromium` for our lambda compatible chrome build.
- Upgrade aws-sdk and other required libraries.
  - These libraries didn't work with the latest node and I had to upgrade off of node 14 since that is deprecated on lambda.
- Add `yarn typecheck` command and get types passing.
  - I took the shortest path here allowing `any` etc. Existing types were failing badly and I wanted typing for my changes but didn't want to spend much time on it.
- Switches asset serving strategy to use local dev server instead of request interception. I found request interception stall on serving wasm files.
- Remove .eslintrc. Tons of linting was failing so I'm removing it for now.
- Add `>` in between different test parts so its easier to grep for test.
- Add display of remote logs url in output + other terminal output display changes.

# 2025-07-14 0.3.33

- Fix logging option
- Add --filter option to filter tests when debugging.
- Add --reuseBuild option for speeding up debugging of zen library changes
- Add sourcemaps to build output for clearer library stacktraces

# 2024-11-06 0.3.32

- reset dev server calling args to old format

# 2024-11-06 0.3.31

- Update aws-sdk and serve-static deps and update dev server to new format.

# 2024-08-28 0.3.30

- Wrap websocket json parsing in a try/catch

# 2024-08-28 0.3.29

- Correctly capture and log page errors
- Remove unhelpful console log
- Fix console log stack traces in `debug` (local) mode
- Capture and log errors in afterEach blocks on `headless` (remote) mode
- Run linter / formatter

# 2024-06-17 0.3.28

- Minor logging changes

# 2024-06-17 0.3.27

- Minor logging changes

# 2024-06-17 0.3.26

- Reset worker reloading logic to original logic from 0.3.23
- Don't use COEP headers when running on remote since this breaks the fetching of the s3 files.

# 2024-06-17 0.3.25

- Test release. No changes.

# 2024-06-07 0.3.24

- Modify webpack to work with wasm sqlite for local dev.
- Adds security headers to server for wasm.
- Adds `setDevelopmentHeaders` config option so we can modify the dev response headers with
  the correct csp.
- Removes `HotModuleReplacementPlugin` we can't use this with webworkers for our currentl webpack setup since this module depends on `window` existing. The zen will still hard reload the page on file change.

# 2023-06-12 0.3.23

- Add timeout configuration option to Latte

# 2023-05-19 0.3.22

- revert base code back to last stable version 0.3.18
- fix S3Sync flake issue by adding retry
- fix puppeteer timeout issue by increasing timeout for navigation

# 2022-5-5 0.3.21

- Fix Zen puppeteer navigation timeout flake

# 2022-5-5 0.3.20

- Fix Zen AWS S3 upload sync flakiness

# 2022-5-5 0.3.19

- Fix eslint environment issues
- Make Zen bottom status bar movable

# 2022-5-26 0.3.17

- Update Util.writeFile (#27)

  - Update Util.writeFile
    Ensure it handles undefined data gracefully
    Set the function to async
    Set function Util.readFileAsync to async

  - Update chrome-remote-interface to v0.31.2
    Attempting to resolve issues for Node v16

  - Default data to empty string for Util.writeFile for writing
    empty pid files to directory
    Add some catches to handle errors from chrome-remote-interface that
    weren't being caught
    Enforce some amount of synchronicity in opening tabs for workers

  - Upgrade ws to 8.5.0

  - Remove catch statements that don't seem to provide value
    and don't stop the uncaught errors from chrome-remote-interface
    It's likely originating from some of the usage of this.cdp

  - Based on logging in the chrome-remote-interface package
    I was able to determine that the Fetch.continueRequest function was throwing an
    uncaught error.
    Handling this error fixes test running for Node v16

- Remove runtime error and actually start tests for race (#26)

  - Remove runtime error and actually start tests for race

  - remove 5s more from cutoff

# 2021-10-19 0.3.13

- fix `store` reference
