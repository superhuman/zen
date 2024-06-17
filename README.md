# Publishing a new version

* Log into `npm` with an account that has publish permissions (if you don't have
  this, create one and ask Conrad): `npm login`
* Bump the version number in `package.json`
* Add a line item to `CHANGELOG.md`
* Run `npm publish`

# Developing Locally

If you want to develop locally against the Superhuman desktop repo you can:

- Run `yarn link` in this repo (you only need to do this once after downloading the repo)
- Go to the Superhuman desktop repo and run `yarn link @superhuman/zen`
- Run `yarn start` in this repo to build the zen library

- When you are done run `yarn unlink @superhuman/zen` in the desktop repo.

## Local Dev Tips

-
