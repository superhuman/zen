import React from 'react'
import styled from 'styled-components'
import {useBranch} from 'baobab-react/hooks'

const Wrapper = styled.div`
`

const Grep = styled.span`
`

const Progress = styled.span`
`

export default function RunDetails () {
  const { socketDisconnected, grep, workingSetLength, isLambda, results, workerCount } = useBranch({
    socketDisconnected: ['socketDisconnected'],
    grep: ['grep'],
    workingSetLength: ['workingSetLength'],
    isLambda: ['isLambda'],
    results: ['results'],
    workerCount: ['workerCount']
  })

  let content
  if (socketDisconnected) {
    content = 'Disconnected (check server and reload)'
  } else if (workingSetLength && grep) {
    content = <Grep>
      {/* TODO use svgs */}
      {grep ? 'filter' : 'asterisk'}
      {grep || 'All tests'}
    </Grep>
  } else {
    content = 'Please alt to get started :)'
  }

  return <Wrapper>
    {content}
    {workingSetLength ? <Progress title={isLambda ? `Running on ${workerCount} lambda workers` : 'Running locally on headless Chrome'}>
      {results.length}/{workingSetLength}
      {/* TODO use svgs */}
      {isLambda ? 'lambda' : 'desktop'}
    </Progress> : null}
  </Wrapper>
}
