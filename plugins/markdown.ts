import type { Aleph, LoadInput, LoadOutput, ResolveResult, Plugin } from '../types.ts'
import marked from 'https://esm.sh/marked'
import { safeLoadFront } from 'https://esm.sh/yaml-front-matter@latest'
import util from '../shared/util.ts'

export const test = /\.(md|markdown)$/i

export const markdownResovler = (specifier: string): ResolveResult => {
  let pagePath = util.trimPrefix(specifier.replace(/\.(md|markdown)$/i, ''), '/pages')
  let isIndex = pagePath.endsWith('/index')
  if (isIndex) {
    pagePath = util.trimSuffix(pagePath, '/index')
    if (pagePath === '') {
      pagePath = '/'
    }
  }
  return { asPage: { path: pagePath, isIndex } }
}

export const markdownLoader = async ({ specifier }: LoadInput, aleph: Aleph): Promise<LoadOutput> => {
  const { framework } = aleph.config
  const { content } = await aleph.fetchModule(specifier)
  const { __content, ...meta } = safeLoadFront((new TextDecoder).decode(content))
  const html = marked.parse(__content)
  const props = {
    id: util.isString(meta.id) ? meta.id : undefined,
    className: util.isString(meta.className) ? meta.className : undefined,
    style: util.isPlainObject(meta.style) ? meta.style : undefined,
  }

  if (framework === 'react') {
    return {
      code: [
        `import { createElement } from 'https://esm.sh/react@experimental'`,
        `import HTMLPage from 'https://raw.githubusercontent.com/koumaza/aleph.js/koumaza/bump/framework/react/components/HTMLPage.ts'`,
        `export default function MarkdownPage(props) {`,
        `  return createElement(HTMLPage, {`,
        `    ...${JSON.stringify(props)},`,
        `    ...props,`,
        `    html: ${JSON.stringify(html)}`,
        `  })`,
        `}`,
        `MarkdownPage.meta = ${JSON.stringify(meta)}`,
      ].join('\n')
    }
  }

  throw new Error(`markdown-loader: don't support framework '${framework}'`)
}

export default (): Plugin => {
  return {
    name: 'markdown-loader',
    setup: aleph => {
      aleph.onResolve(test, markdownResovler)
      aleph.onLoad(test, input => markdownLoader(input, aleph))
    }
  }
}
