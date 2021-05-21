import React, { useEffect, useState } from 'react'
import {useBranch} from 'baobab-react/hooks'
import tinykeys from 'tinykeys'
import {openCommand, closeCommand} from './actions'

const commands = [
  {
    type: 'command',
    title: 'Run the focused test',
    key: 'Alt+Space',
    condition: () => store.get().focus,
    action: () => focusTest(),
    icon: Zen.icons.Redo
  }, {
    type: 'command',
    title: 'Focus the next problem',
    key: 'Alt+ArrowRight',
    condition: () => store.get().failureGroups.length > 0,
    action: () => focusGroup(+1),
    icon: Zen.icons.ArrowRight
  }, {
    type: 'command', title: 'Focus the previous problem', key: 'Alt+ArrowLeft',
    condition: () => store.get().failureGroups.length > 0,
    action: () => focusGroup(-1),
    icon: Zen.icons.ArrowLeft
  // }, {
  //   type: 'command', title: 'Filter to failed tests', key: 'Alt F', keyCode: 70,
  //   condition: () => store.get('failureGroups').length > 0,
  //   action: () => filterTests({failed: true}),
  //   icon:
  }, {
    type: 'command', title: 'Run filtered tests', key: 'Alt+Enter', keyCode: 13,
    action: () => filterTests({run: true}),
    icon: Zen.icons.Redo
  }, {
    type: 'command', title: 'Run all tests', key: 'Alt+A', keyCode: 65,
    action: () => filterTests({grep: null, run: true}),
    altText: 'Clear the filter to run every suite',
    icon: Zen.icons.Asterisk
  }, {
    type: 'command', title: 'Debug on S3',
    action: () => runBatchForFocus({s3: true}),
    icon: Zen.icons.Bug
  }, {
    type: 'command', title: 'Show logs in Amazon CloudWatch',
    action: () => openCloudWatch(),
    icon: Zen.icons.Bug
  }, {
    type: 'command', title: 'Dev: Reload headless chrome',
    action: () => filterTests({reload: true, force: true}),
    icon: Zen.icons.Bug
  }
]

export default function CommandPallette () {
  const { command } = useBranch({ command: ['command'] }) 
  const [focus, setFocus] = useState(0)
  useEffect(() => {
    return tinykeys(
      window,
      commands.filter(c => c.shortcut).reduce((acc, c) => {
        acc[c.shortcut] = action
        return acc
      }, {})
    )
  })
  useEffect(() => {
    return tinykeys(window, {
      'Alt': () => {
        openCommand()
        setFocus(0)
      },
      'Escape': () => {
        if (command.visible) closeCommand()
      },
      'ArrowDown': () => {
        if (focus < commands.length - 1) setFocus(focus + 1)
      },
      'ArrowUp': () => {
        if (focus > 0) setFocus(focus - 1)
      }
    })
  })
  
  if (!command.visible) {
    return null
  }

  return <div>
    Command
    <ol>
      {commands.map((c, i) => <li key={c.title}>{focus === i ? '*' : ''}{c.title}</li>)}
    </ol>
  </div>
}
