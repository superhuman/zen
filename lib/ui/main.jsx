import React from 'react'
import ReactDOM from 'react-dom'

import { useRoot } from 'baobab-react/hooks'
import { tree } from './state'
import App from './app'

function Main () {
  const Root = useRoot(tree)
  return <Root>
    <App />
  </Root>
}

let target = document.querySelector('#zen')
ReactDOM.render(<Main />, target)
