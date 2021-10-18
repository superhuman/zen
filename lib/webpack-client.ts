import.meta.webpackHot?.accept((err) => {
  // TODO I think this might be the source of refresh looping
  if (err) location.reload()
})

function needsUpdate(hash : string) : boolean {
  return !!hash && hash.indexOf(__webpack_hash__) == -1
}

type ModuleId = string | number
function update() : Promise<ModuleId[]> {
  let resolve : (value: ModuleId[]) => void
  let reject : (error: unknown) => void
  const promise = new Promise<ModuleId[]>((res, rej) => {
    resolve = res
    reject = rej
  })

  // TODO make sure this works
  import.meta.webpackHot?.check(true, (err, outdatedModules) => {
    if (!err) {
      location.reload()
      resolve(outdatedModules)
    } else {
      reject(err)
    }
  })

  return promise
}

export default { needsUpdate, update }
