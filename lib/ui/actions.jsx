import { tree } from './state'

export function openCommand () {
  tree.set(['command', 'visible'], true)
}

export function closeCommand () {
  tree.set(['command', 'visible'], true)
}
