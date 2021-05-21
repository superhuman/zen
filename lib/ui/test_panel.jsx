import React from 'react'
import styled from 'styled-components'
import RunDetails from './run_details'

const Wrapper = styled.div`
  all: initial;
  position: fixed;
  bottom: 0;
  width: 400px;
  left: 0;
  padding: 8px 5px 4px 5px;
  border: 1px solid #ddd;
  background: #fff;
  font-size: 12px;
  font-family: 'Lucida Sans', 'Lucida Sans Regular', 'Lucida Grande', 'Lucida Sans Unicode', Geneva, Verdana, sans-serif;
  z-index: 9999;
  overflow: hidden;

  & > div {
    min-height: 16px; padding-bottom: 4px; 
  }

  & :global(svg) {
    width: 14px; height: 14px;
    position: relative;
    top: 2px;
  }

  & :global(svg path) {
    fill: #434353; 
  }
`

const FailureGroups = styled.div`
`

const GroupDetails = styled.div`
`

const FocusDetails = styled.div`
`

export default function TestPanel () {
  return <Wrapper>
    <RunDetails />
  </Wrapper>
}
