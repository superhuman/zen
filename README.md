# Brief Overview of how Zen works

Zen is a test running that runs tests on lambda in a very parallel way. Overview of how this works when running the zen remote command:

- Code in cli.ts handles command line args and sending messages to lambda worker.
- We run the `listTests` function on aws lambda. This gets us all the test names. Test names are gotten by loading the code and all of the it(’’) blocks register the tests.
  - Tests can’t be known statically since we do thingsl like `it(`run thing ${n}, function ()` { … })
- We take all of the test names split them up into groups and run them in parallel. The actual test running happens on the lambda worker via workTests.
  - When we run the test on lambda we are running a full chrome headless browser via puppeteer.
- We gather the results and print them out.

# Publishing a new version

- Log into `npm` with an account that has publish permissions (if you don't have
  this, create one and ask Conrad): `npm login`
- Bump the version number in `package.json`
- Add a line item to `CHANGELOG.md`
- Run `yarn release-new-version`

# Uploading new Lambda Code

## Function Code

To upload new code function code to lambda you can use this script

`SECRET_ACCESS_KEY={insert secret here} ACCESS_KEY_ID={insert access here} yarn run tools:upload-lambda --env staging`

Note if you set --env production this changes the code that all of our tests use in ci. Do this only when things have been fully tested on staging and your corresponding code is merged in.

## Layer Code

For lambda files that change infrequently we have layers. The layers we use are:

- Production:

  - zen-dependencies-production
  - chromium-staging-production

- Staging
  - zen-dependencies-staging
  - chromium-staging

chromium layer is chrome build from @sparticuz/chromium releases x86 arch
zen-dependencies layer is the node dependencies like puppeteer.
Currently no script to upload these just manually use the aws ui. Password can be found in 1pass. Similar to above don't change production until things are fully tested on staging. Production is used by all of our ci.

# Developing Locally

If you want to develop locally against the Superhuman desktop repo you can:

- Run `yarn link` in this repo (you only need to do this once after downloading the repo)
- Go to the Superhuman desktop repo and run `yarn link @superhuman/zen`
- Run `yarn start` in this repo to build the zen library

- When you are done run `yarn unlink @superhuman/zen` in the desktop repo.
