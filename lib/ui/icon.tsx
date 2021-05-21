export type IconTypes =
  | 'arrow-left'
  | 'arrow-right'
  | 'asterisk'
  | 'bug'
  | 'desktop'
  | 'file'
  | 'filter'
  | 'lambda'
  | 'redo'
  | 'test-tube'

type Props = {
  type: IconTypes
}

export default function Icon ({ type } : Props) {
  return <div>{type}</div>
}
