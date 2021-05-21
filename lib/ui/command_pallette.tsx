import React, { useEffect, useState, useRef } from 'react'
import {useBranch} from 'baobab-react/hooks'
import tinykeys from 'tinykeys'
import {openCommand, closeCommand} from './actions'
import { IconTypes } from './icon'
import styled from 'styled-components'

type Command = {
  title: string,
  altText?: string,
  key?: string,
  action: () => void,
  condition?: () => boolean,
  icon: IconTypes
}

const commands : Command[] = [
  {
    title: 'Run the focused test',
    key: 'Alt+Space',
    condition: () => store.get().focus,
    action: () => focusTest(),
    icon: 'redo'
  }, {
    title: 'Focus the next problem',
    key: 'Alt+ArrowRight',
    condition: () => store.get().failureGroups.length > 0,
    action: () => focusGroup(+1),
    icon: 'arrow-right'
  }, {
    title: 'Focus the previous problem',
    key: 'Alt+ArrowLeft',
    condition: () => store.get().failureGroups.length > 0,
    action: () => focusGroup(-1),
    icon: 'arrow-left'
  // }, {
  //   type: 'command', title: 'Filter to failed tests', key: 'Alt F', keyCode: 70,
  //   condition: () => store.get('failureGroups').length > 0,
  //   action: () => filterTests({failed: true}),
  //   icon:
  }, {
    title: 'Run filtered tests',
    key: 'Alt+Enter',
    action: () => filterTests({run: true}),
    icon: 'redo'
  }, {
    title: 'Run all tests',
    key: 'Alt+A',
    action: () => filterTests({grep: null, run: true}),
    altText: 'Clear the filter to run every suite',
    icon: 'asterisk'
  }, {
    title: 'Debug on S3',
    action: () => runBatchForFocus({s3: true}),
    icon: 'bug'
  }, {
    title: 'Show logs in Amazon CloudWatch',
    action: () => openCloudWatch(),
    icon: 'bug'
  }, {
    title: 'Dev: Reload headless chrome',
    action: () => filterTests({reload: true, force: true}),
    icon: 'bug'
  }
]

// TODO align in the center once the svelte one is deleted
const Wrapper = styled.div`
  line-height: 1.5em;

  width: 80%;
  max-width: 500px;
  position: absolute;
  top: 200px;
  left: 0;

  background: #212121;
  color: #ddd;
  font-size: 12px;
  font-family: 'Lucida Sans', 'Lucida Sans Regular', 'Lucida Grande', 'Lucida Sans Unicode', Geneva, Verdana, sans-serif;

  & :global(svg) {
    fill: #aaa;
    border: 1px solid #ddd;
    border-radius: 50%;
    padding: 5px;
    height: 20px;
    flex: 0 0 20px;
    margin-right: 14px;
  }
`

const SearchBar = styled.input`
  display: inline-block;
  box-sizing: border-box;
  width: 100%;
  border: none;
  background: none;
  padding: 14px 30px 10px 60px;
  border-bottom: 1px solid #313131;
  color: inherit;
  font-size: inherit;
`

const Suggestions = styled.div`
  display: block;
  height: 400px;
  overflow: scroll;
`

const Title = styled.span`
  flex: 1;
`

const Suggestion = styled.div<{ selected: boolean }>`
  display: flex;
  align-items: center;
  padding: 5px 14px;

  ${props => props.selected ? 'background: #313131;' : ''}
`

const Key = styled.div`
  flex: 0 0;
  white-space: nowrap;

  & > span {
    font-size: 10px;
    display: inline-block;
    padding: 1px 5px;
    border: 1px solid #aaa;
    border-radius: 1px;
    margin-left: 5px;
  }
`

export default function CommandPallette () {
  const { command } = useBranch({ command: ['command'] }) 
  const [focus, setFocus] = useState(0)
  const [search, setSearch] = useState("")
  useEffect(() => {
    return tinykeys(
      window,
      commands.filter(c => c.key).reduce((acc, c) => {
        acc[c.key] = c.action
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
      'ArrowDown': e => {
        if (focus < commands.length - 1) setFocus(focus + 1)
        e.stopPropagation()
      },
      'ArrowUp': e => {
        if (focus > 0) setFocus(focus - 1)
        e.stopPropagation()
      }
    })
  })
  const searchBarRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (searchBarRef.current && command.visible) {
      searchBarRef.current.focus()
    }
  }, [command.visible])

  
  if (!command.visible) {
    return null
  }

  return <Wrapper>
    <SearchBar ref={searchBarRef} value={search} onChange={(e : React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)} />
    <Suggestions>
      {commands.map((c, i) =>
        <Suggestion selected={focus === i} key={c.title}>
          <Title>{c.title}</Title>
          {c.key ? <Key>{c.key.split('+').map((k, i) => <span key={k + i}>{k}</span>)}</Key> : null}
        </Suggestion>
      )}
    </Suggestions>
  </Wrapper>
}
