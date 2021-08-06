import { extname, join } from 'https://raw.githubusercontent.com/denoland/deno_std/main/path/mod.ts'
import { esbuild } from '../bundler/esbuild.ts'
import { toLocalPath, computeHash } from '../server/helper.ts'
import { existsFile } from '../shared/fs.ts'
import { Measure } from '../shared/log.ts'
import util from '../shared/util.ts'
import type { Aleph, LoadInput, LoadOutput, Plugin, PostCSSPlugin } from '../types.ts'

const test = /\.(css|pcss|postcss)$/i
const postcssVersion = 'latest'
const postcssModulesVersion = 'latest'
const productionOnlyPostcssPlugins = ['autoprefixer']
const isModulesPluginName = (v: any): v is string => (typeof v === 'string' && /^postcss\-modules(@|$)/i.test(v.trim()))

/** builtin css loader */
export const cssLoader = async ({ specifier, data }: LoadInput, aleph: Aleph): Promise<LoadOutput> => {
  const ms = new Measure()
  const { css: cssConfig } = aleph.config
  const isRemote = util.isLikelyHttpURL(specifier)

  if (isRemote && specifier.endsWith('.css') && !cssConfig.cache) {
    return {
      code: [
        `import { applyCSS } from "https://raw.githubusercontent.com/koumaza/aleph.js/koumaza/bump/framework/core/style.ts"`,
        `export const href = ${JSON.stringify(specifier)}`,
        `export default {}`,
        `applyCSS(${JSON.stringify(specifier)}, { href })`,
      ].join('\n')
    }
  }

  // Don't process .css files in ./public folder
  if (!isRemote && specifier.endsWith('.css') && await existsFile(join(aleph.workingDir, 'public', specifier))) {
    return {
      code: [
        `import { applyCSS } from "https://raw.githubusercontent.com/koumaza/aleph.js/koumaza/bump/framework/core/style.ts"`,
        `export const href = ${JSON.stringify(specifier)}`,
        `export default {}`,
        `applyCSS(${JSON.stringify(specifier)}, { href })`,
      ].join('\n')
    }
  }

  let plugins = cssConfig.postcss?.plugins || []
  let modulesJSON: Record<string, string> = {}
  if (/\.module\.[a-z]+$/.test(specifier)) {
    const options = {
      ...(util.isPlainObject(cssConfig.modules) ? cssConfig.modules : {}),
      getJSON: (_specifier: string, json: Record<string, string>) => {
        modulesJSON = json
      },
    }
    let hasModulesPlugin = false
    plugins = plugins.map(plugin => {
      if (isModulesPluginName(plugin)) {
        hasModulesPlugin = true
        return [plugin.trim().toLowerCase(), options]
      }
      if (Array.isArray(plugin) && isModulesPluginName(plugin[0])) {
        hasModulesPlugin = true
        return [plugin[0].trim().toLowerCase(), { ...options, ...plugin[1] }]
      }
      return plugin
    })
    if (!hasModulesPlugin) {
      plugins.push([`postcss-modules@${postcssModulesVersion}`, options])
    }
  }
  const postcss = await initPostCSS(plugins, aleph.mode === 'development')

  let sourceCode = ''
  let css = ''

  if (data instanceof Uint8Array) {
    sourceCode = (new TextDecoder).decode(data)
  } else if (util.isFilledString(data)) {
    sourceCode = data
  } else {
    const { content } = await aleph.fetchModule(specifier)
    sourceCode = (new TextDecoder).decode(content)
  }

  // do not process remote css files
  if (isRemote && specifier.endsWith('.css')) {
    css = sourceCode
  } else {
    const ret = await postcss.process(sourceCode, { from: specifier }).async()
    css = ret.css
  }

  if (aleph.mode === 'production') {
    const ret = await esbuild({
      stdin: {
        loader: 'css',
        sourcefile: specifier,
        contents: css
      },
      bundle: false,
      minify: true,
      write: false
    })
    css = util.trimSuffix(ret.outputFiles[0].text, '\n')
  }

  ms.stop(`process ${specifier}`)

  if (specifier.startsWith('#inline-style-')) {
    return { type: 'css', code: css }
  }

  const { extract } = cssConfig
  if (extract && (extract === true || css.length > (extract.limit || 8 * 1024))) {
    const ext = extname(specifier)
    const hash = computeHash(css).slice(0, 8)
    const path = util.trimSuffix(isRemote ? toLocalPath(specifier) : specifier, ext) + '.' + hash + ext
    await aleph.addDist(path, (new TextEncoder).encode(css))
    return {
      code: [
        `import { applyCSS } from "https://raw.githubusercontent.com/koumaza/aleph.js/koumaza/bump/framework/core/style.ts"`,
        `export const href = ${JSON.stringify('/_aleph/' + util.trimPrefix(path, '/'))}`,
        `export default ${JSON.stringify(modulesJSON)}`,
        `applyCSS(${JSON.stringify(specifier)}, { href })`
      ].join('\n'),
      // todo: generate map
    }
  }

  return {
    code: [
      `import { applyCSS } from "https://raw.githubusercontent.com/koumaza/aleph.js/koumaza/bump/framework/core/style.ts"`,
      `export const css = ${JSON.stringify(css)}`,
      `export default ${JSON.stringify(modulesJSON)}`,
      `applyCSS(${JSON.stringify(specifier)}, { css })`,
    ].join('\n'),
    // todo: generate map
  }
}

export const isCSS = (specifier: string): boolean => test.test(specifier)

async function initPostCSS(plugins: PostCSSPlugin[], isDev: boolean) {
  const pluginObjects = await Promise.all(plugins.filter(p => {
    if (isDev) {
      if (util.isFilledString(p) && productionOnlyPostcssPlugins.includes(p)) {
        return false
      } else if (Array.isArray(p) && productionOnlyPostcssPlugins.includes(p[0])) {
        return false
      }
    }
    return true
  }).map(async p => {
    if (util.isFilledString(p)) {
      return await importPostcssPluginByName(p)
    } else if (Array.isArray(p)) {
      const Plugin = await importPostcssPluginByName(p[0])
      if (util.isFunction(Plugin)) {
        return Plugin(p[1])
      }
      return null
    } else {
      return p
    }
  }))

  if (pluginObjects.length === 0) {
    return {
      process: (content: string) => ({
        async: async () => {
          return { css: content }
        }
      })
    }
  }

  const { default: PostCSS } = await import(`https://esm.sh/postcss@${postcssVersion}`)
  return PostCSS(pluginObjects)
}

async function importPostcssPluginByName(name: string) {
  const url = `https://esm.sh/${name}?deps=postcss@${postcssVersion}&no-check`
  const { default: Plugin } = await import(url)
  return Plugin
}

export default (): Plugin => {
  return {
    name: 'css-loader',
    setup: aleph => {
      aleph.onResolve(test, () => ({ acceptHMR: true }))
      aleph.onLoad(test, input => cssLoader(input, aleph))
    }
  }
}
