import Baobab, { monkey } from 'baobab'

function failureGroups(results, focus, passedFocus) {
  let groups = {}
  results.forEach(t => {
    if (!t.error) return
    if (!t.stack) t.stack = 'unknown \n unknown'
    let key = t.error + t.stack.split('\n')[1]
    groups[key] = groups[key] || []
    groups[key].key = key
    groups[key].error = t.error
    groups[key].passedFocus = groups[key].passedFocus || !!passedFocus.find(p => p.fullName === t.fullName)
    groups[key].push(t)
  })

  return Object.values(groups).map(g => {
    g.shade = Math.min(Math.floor(Math.sqrt(g.length)), 5)
    g.containsFocus = !!g.find(r => focus === r.fullName)
    return g
  }).sort((a, b) => b.length - a.length)
}

function batchForFocus(results, focus) {
  let focusedResult = results.find(r => r.fullName === focus)
  if (!focusedResult) return [{fullName: focus}]
  return results
    .filter(r => r.batchId === focusedResult.batchId)
    .filter(r => r.testNumber >= focusedResult.testNumber)
    .sort((a, b) => parseInt(b.testNumber) - parseInt(a.testNumber))
}

export const tree = new Baobab({
  results: [],
  focus: null,
  focusStatus: 'none',
  compile: { errors: [] },
  grep: '',
  failureGroups: monkey('results', 'focus', 'passedFocus', failureGroups),
  groupForFocus: monkey('failureGroups', groups => groups.find(g => g.containsFocus) || []),
  batchForFocus: monkey('results', 'focus', batchForFocus),
  socketDisconnected: false,
  command: {
    visible: false
  }
})

function onUrlChange() {
  let params = new URLSearchParams(location.search)
  // filterTests({grep: params.get('grep')})
  // focusTest(params.get('focus') || '')
}

function handleMessage(msg) {
  let data = JSON.parse(msg.data)

  if (data.results && !data.runId) { // incremental update of results
    console.log(data.results)
    // store.set({results: store.get().results.concat(data.results)})
  } else {
    console.log(data)
    // store.set(data)
    // runIfCodeChanged()
  }
}

const socket = new WebSocket(`ws://${location.host}/head`)
socket.onopen = () => onUrlChange()
socket.onmessage = handleMessage
socket.onclose = () => tree.set('socketDisconnected', true)
