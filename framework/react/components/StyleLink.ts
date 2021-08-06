import { useEffect, useLayoutEffect } from 'https://esm.sh/react@experimental'
import { recoverCSS, removeCSS } from '../../core/style.ts'
import { inDeno } from '../helper.ts'

const useIsomorphicLayoutEffect = inDeno ? useEffect : useLayoutEffect

export default function StyleLink({ href }: { href: string }) {
  useIsomorphicLayoutEffect(() => {
    recoverCSS(href)
    return () => removeCSS(href, true)
  }, [])

  return null
}
