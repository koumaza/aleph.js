import { join } from 'https://raw.githubusercontent.com/denoland/deno_std/main/path/mod.ts'
import { cache } from '../server/cache.ts'
import util from '../shared/util.ts'
// @deno-types="https://raw.githubusercontent.com/esbuild/deno-esbuild/mainmod.d.ts"
import { build, stop, Plugin } from 'https://raw.githubusercontent.com/esbuild/deno-esbuild/main/mod.js'

export {
  build as esbuild,
  stop as stopEsbuild
}

export const esbuildUrlLoader: Plugin = {
  name: 'esm-loader',
  setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (util.isLikelyHttpURL(args.path)) {
        return {
          path: args.path,
          namespace: 'http-module',
        }
      }
      if (args.namespace === 'http-module') {
        return {
          path: (new URL(args.path, args.importer)).toString(),
          namespace: 'http-module',
        }
      }
      const [path] = util.splitBy(util.trimPrefix(args.path, 'file://'), '#')
      if (path.startsWith('.')) {
        return { path: join(args.resolveDir, path) }
      }
      return { path }
    })
    build.onLoad({ filter: /.*/, namespace: 'http-module' }, async args => {
      const { content } = await cache(args.path)
      return { contents: content }
    })
  }
}
