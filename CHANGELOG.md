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
