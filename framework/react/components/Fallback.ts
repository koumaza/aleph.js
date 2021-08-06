import {
  createElement,
  PropsWithChildren,
  ReactNode
} from 'https://esm.sh/react@experimental'
import { FallbackContext } from '../context.ts'

type FallbackProps = {
  to: ReactNode
}

export default function Fallback(props: PropsWithChildren<FallbackProps>) {
  return createElement(
    FallbackContext.Provider,
    {
      value: { to: props.to },
      children: props.children
    }
  )
}
