import { dim } from 'https://raw.githubusercontent.com/denoland/deno_std/main/fmt/colors.ts'
import { indexOf, copy, equals } from 'https://raw.githubusercontent.com/denoland/deno_std/main/bytes/mod.ts'
import { ensureDir } from 'https://raw.githubusercontent.com/denoland/deno_std/main/fs/ensure_dir.ts'
import { walk } from 'https://raw.githubusercontent.com/denoland/deno_std/main/fs/walk.ts'
import { createHash } from 'https://raw.githubusercontent.com/denoland/deno_std/main/hash/mod.ts'
import { basename, dirname, extname, join, resolve } from 'https://raw.githubusercontent.com/denoland/deno_std/main/path/mod.ts'
import { Bundler, bundlerRuntimeCode, simpleJSMinify } from '../bundler/mod.ts'
import type { TransformOptions } from '../compiler/mod.ts'
import { wasmChecksum, parseExportNames, SourceType, transform, stripSsrCode } from '../compiler/mod.ts'
import { EventEmitter } from '../framework/core/events.ts'
import { builtinModuleExts, toPagePath, trimBuiltinModuleExts } from '../framework/core/module.ts'
import { Routing } from '../framework/core/routing.ts'
import cssPlugin, { cssLoader, isCSS } from '../plugins/css.ts'
import { ensureTextFile, existsDir, existsFile, lazyRemove } from '../shared/fs.ts'
import log, { Measure } from '../shared/log.ts'
import util from '../shared/util.ts'
import type { Aleph as IAleph, ImportMap, LoadInput, LoadOutput, RouterURL, ResolveResult, TransformOutput, TransformInput } from '../types.ts'
import { VERSION } from '../version.ts'
import { Analyzer } from './analyzer.ts'
import { cache } from './cache.ts'
import type { RequiredConfig } from './config.ts'
import { defaultConfig, fixConfigAndImportMap, getDefaultImportMap, loadConfig, loadImportMap } from './config.ts'
import {
  checkAlephDev, checkDenoVersion, clearBuildCache, computeHash, findFile,
  getAlephPkgUri, getSourceType, isLocalUrl, moduleExclude, toLocalPath, toRelativePath
} from './helper.ts'
import { getContentType } from './mime.ts'
import type { SSRData } from './renderer.ts'
import { createHtml, Renderer } from './renderer.ts'

/** A module includes the compilation details. */
export type Module = {
  specifier: string
  deps: DependencyDescriptor[]
  external?: boolean
  isStyle?: boolean
  externalRemoteDeps?: boolean
  ssrPropsFn?: string
  ssgPathsFn?: boolean
  denoHooks?: string[]
  hash?: string
  sourceHash: string
  jsFile: string
  jsBuffer?: Uint8Array
  ready: Promise<void>
}

type ModuleSource = {
  code: string
  type: SourceType
  isStyle: boolean
  map?: string
}

type DependencyDescriptor = {
  specifier: string
  isDynamic?: boolean
  hashLoc?: number
}

type CompileOptions = {
  source?: ModuleSource,
  forceRefresh?: boolean,
  ignoreDeps?: boolean,
  externalRemoteDeps?: boolean
}

type ResolveListener = {
  test: RegExp,
  resolve(specifier: string): ResolveResult,
}

type LoadListener = {
  test: RegExp,
  load(input: LoadInput): Promise<LoadOutput> | LoadOutput,
}

type TransformListener = {
  test: RegExp | string,
  transform(input: TransformInput): TransformOutput,
}

type SsrListener = (path: string, html: string) => { html: string }

/** The Aleph class for aleph runtime. */
export class Aleph implements IAleph {
  readonly mode: 'development' | 'production'
  readonly workingDir: string
  readonly buildDir: string
  readonly config: RequiredConfig
  readonly importMap: ImportMap
  readonly ready: Promise<void>

  #modules: Map<string, Module> = new Map()
  #appModule: Module | null = null
  #pageRouting: Routing = new Routing()
  #apiRouting: Routing = new Routing()
  #analyzer: Analyzer = new Analyzer(this)
  #bundler: Bundler = new Bundler(this)
  #renderer: Renderer = new Renderer(this)
  #fsWatchListeners: Array<EventEmitter> = []
  #resolverListeners: Array<ResolveListener> = []
  #loadListeners: Array<LoadListener> = []
  #transformListeners: Array<TransformListener> = []
  #ssrListeners: Array<SsrListener> = []
  #dists: Set<string> = new Set()
  #reloading = false

  constructor(
    workingDir = '.',
    mode: 'development' | 'production' = 'production',
    reload = false
  ) {
    checkDenoVersion()
    checkAlephDev()
    this.mode = mode
    this.workingDir = resolve(workingDir)
    this.buildDir = join(this.workingDir, '.aleph', mode)
    this.config = { ...defaultConfig() }
    this.importMap = { imports: {}, scopes: {} }
    this.ready = Deno.env.get('DENO_TESTING') ? Promise.resolve() : this.init(reload)
  }

  /** initiate runtime */
  private async init(reload: boolean) {
    const ms = new Measure()

    let [importMapFile, configFile] = await Promise.all([
      findFile(this.workingDir, ['import_map', 'import-map', 'importmap', 'importMap'].map(name => `${name}.json`)),
      findFile(this.workingDir, ['ts', 'js', 'mjs', 'json'].map(ext => `aleph.config.${ext}`))
    ])
    if (importMapFile) {
      Object.assign(this.importMap, await loadImportMap(importMapFile))
    } else {
      Object.assign(this.importMap, getDefaultImportMap())
    }
    if (configFile) {
      if (!configFile.endsWith('.json')) {
        const mod = await this.compile(`/${basename(configFile)}`, { externalRemoteDeps: true })
        configFile = join(this.buildDir, mod.jsFile)
      }
      Object.assign(this.config, await loadConfig(configFile))
      this.#pageRouting = new Routing(this.config)
    }

    await fixConfigAndImportMap(this.workingDir, this.config, this.importMap)
    ms.stop('load config')

    // load .env files
    for await (const { path: p, } of walk(this.workingDir, { match: [/(^|\/|\\)\.env(\.|$)/i], maxDepth: 1 })) {
      const text = await Deno.readTextFile(p)
      text.split('\n').forEach(line => {
        let [key, value] = util.splitBy(line, '=')
        key = key.trim()
        if (key) {
          Deno.env.set(key, value.trim())
        }
      })
      log.info('load env from', basename(p))
    }
    Deno.env.set('ALEPH_ENV', this.mode)
    Deno.env.set('ALEPH_FRAMEWORK', this.config.framework)
    Deno.env.set('ALEPH_VERSION', VERSION)

    const alephPkgUri = getAlephPkgUri()
    const srcDir = join(this.workingDir, this.config.srcDir)
    const apiDir = join(srcDir, 'api')
    const pagesDir = join(srcDir, 'pages')
    const buildManifestFile = join(this.buildDir, 'build.manifest.json')
    const importMapString = JSON.stringify(this.importMap)

    let shouldRebuild = !await existsFile(buildManifestFile)
    let saveManifestFile = shouldRebuild
    if (!shouldRebuild) {
      try {
        const v = JSON.parse(await Deno.readTextFile(buildManifestFile))
        shouldRebuild = (
          typeof v !== 'object' ||
          v === null ||
          v.compiler !== wasmChecksum ||
          (v.importMap !== importMapString && confirm('The import-maps has been changed, rebuild modules?'))
        )
        if (!shouldRebuild && v.importMap !== importMapString) {
          saveManifestFile = true
        }
      } catch (e) { }
    }

    this.#reloading = reload
    if (reload || shouldRebuild) {
      if (await existsDir(this.buildDir)) {
        await Deno.remove(this.buildDir, { recursive: true })
      }
      await ensureDir(this.buildDir)
    }

    if (saveManifestFile) {
      log.debug('rebuild...')
      ensureTextFile(buildManifestFile, JSON.stringify({
        aleph: VERSION,
        deno: Deno.version.deno,
        compiler: wasmChecksum,
        importMap: importMapString,
      }, undefined, 2))
    }

    ms.stop(`init env`)

    // apply plugins
    cssPlugin().setup(this)
    await Promise.all(
      this.config.plugins.map(async plugin => {
        await plugin.setup(this)
      })
    )

    ms.stop('apply plugins')

    const mwFile = await findFile(this.workingDir, ['ts', 'js', 'mjs'].map(ext => `${this.config.srcDir}/api/_middlewares.${ext}`))
    if (mwFile) {
      const mwMod = await this.compile(`/api/${basename(mwFile)}`, { externalRemoteDeps: true })
      const { default: _middlewares } = await import('file://' + join(this.buildDir, mwMod.jsFile))
      const middlewares = Array.isArray(_middlewares) ? _middlewares.filter(fn => util.isFunction(fn)) : []
      this.config.server.middlewares.push(...middlewares)
      ms.stop(`load API middlewares (${middlewares.length}) from 'api/${basename(mwFile)}'`)
    }

    // init framework
    const { init } = await import(`../framework/${this.config.framework}/init.ts`)
    await init(this)

    // compile and import framework renderer
    if (this.config.ssr) {
      const mod = await this.compile(`${alephPkgUri}/framework/${this.config.framework}/renderer.ts`)
      const { render } = await this.importModule(mod)
      if (util.isFunction(render)) {
        this.#renderer.setFrameworkRenderer({ render })
      }
    }

    ms.stop(`init ${this.config.framework} framework`)

    const appFile = await findFile(srcDir, builtinModuleExts.map(ext => `app.${ext}`))
    const modules: string[] = []
    const moduleWalkOptions = {
      includeDirs: false,
      skip: moduleExclude
    }

    // pre-compile framework modules
    modules.push(`${alephPkgUri}/framework/${this.config.framework}/bootstrap.ts`)
    if (this.isDev) {
      modules.push(`${alephPkgUri}/framework/core/hmr.ts`)
      modules.push(`${alephPkgUri}/framework/core/nomodule.ts`)
    }
    if (appFile) {
      modules.push(`/${basename(appFile)}`)
    }

    // create API routing
    if (await existsDir(apiDir)) {
      for await (const { path: p } of walk(apiDir, { ...moduleWalkOptions, exts: builtinModuleExts })) {
        const specifier = util.cleanPath('/api/' + util.trimPrefix(p, apiDir))
        if (!specifier.startsWith('/api/_middlewares.')) {
          this.#apiRouting.update(...this.createRouteUpdate(specifier))
        }
      }
    }

    // create Page routing
    if (await existsDir(pagesDir)) {
      for await (const { path: p } of walk(pagesDir, moduleWalkOptions)) {
        const specifier = util.cleanPath('/pages/' + util.trimPrefix(p, pagesDir))
        if (this.isPageModule(specifier)) {
          this.#pageRouting.update(...this.createRouteUpdate(specifier))
          if (!this.isDev) {
            modules.push(specifier)
          }
        }
      }
    }

    // wait all compilation tasks are done
    await Promise.all(modules.map(specifier => this.compile(specifier)))

    // bundle
    if (!this.isDev) {
      await this.bundle()
    }

    // end reload
    if (reload) {
      this.#reloading = false
    }

    ms.stop('init project')

    if (this.isDev) {
      this.watch()
    }
  }

  /** watch file changes, re-compile modules, and send HMR signal to client. */
  private async watch() {
    const srcDir = join(this.workingDir, this.config.srcDir)
    const w = Deno.watchFs(srcDir, { recursive: true })
    log.info('Start watching code changes...')
    for await (const event of w) {
      for (const path of event.paths) {
        const specifier = util.cleanPath(util.trimPrefix(path, srcDir))
        if (this.isScopedModule(specifier)) {
          util.debounceById(
            specifier,
            () => this.watchHandler(path, specifier),
            50
          )
        }
      }
    }
  }

  private async watchHandler(path: string, specifier: string): Promise<void> {
    if (await existsFile(path)) {
      if (this.#modules.has(specifier)) {
        try {
          const prevModule = this.#modules.get(specifier)!
          const module = await this.compile(specifier, {
            forceRefresh: true,
            ignoreDeps: true,
            externalRemoteDeps: specifier.startsWith('/api/')
          })
          const refreshPage = (
            this.config.ssr &&
            (
              (module.denoHooks !== undefined && JSON.stringify(prevModule.denoHooks) !== JSON.stringify(module.denoHooks)) ||
              (module.ssrPropsFn !== undefined && prevModule.ssrPropsFn !== module.ssrPropsFn)
            )
          )
          const hmrable = this.isHMRable(specifier)
          if (hmrable) {
            this.#fsWatchListeners.forEach(e => {
              e.emit('modify-' + module.specifier, { refreshPage: refreshPage || undefined })
            })
          }
          this.applyCompilationSideEffect(module, ({ specifier, hash }) => {
            if (!hmrable && this.isHMRable(specifier)) {
              log.debug(`compilation side-effect: ${specifier}(${hash?.substr(0, 6)}) ${dim('<-')} ${module.specifier}(${module.hash?.substr(0, 6)})`)
              this.#fsWatchListeners.forEach(e => {
                e.emit('modify-' + specifier, { refreshPage: refreshPage || undefined })
              })
            }
            this.clearSSRCache(specifier)
          })
          this.clearSSRCache(specifier)
          log.info('modify', specifier)
        } catch (err) {
          log.error(`compile(${specifier}):`, err.message)
        }
      } else {
        let routePath: string | undefined = undefined
        let isIndex: boolean | undefined = undefined
        let emit = false
        if (this.isPageModule(specifier)) {
          let isNew = true
          this.#pageRouting.lookup(routes => {
            routes.forEach(({ module }) => {
              if (module === specifier) {
                isNew = false
                return false // break loop
              }
            })
          })
          if (isNew) {
            const [_routePath, _specifier, _isIndex] = this.createRouteUpdate(specifier)
            routePath = _routePath
            specifier = _specifier
            isIndex = _isIndex
            emit = true
            this.#pageRouting.update(routePath, specifier, isIndex)
          }
        } else if (specifier.startsWith('/api/') && !specifier.startsWith('/api/_middlewares.')) {
          this.#apiRouting.update(...this.createRouteUpdate(specifier))
        }
        if (trimBuiltinModuleExts(specifier) === '/app') {
          await this.compile(specifier)
          emit = true
        }
        if (emit) {
          this.#fsWatchListeners.forEach(e => {
            e.emit('add', { specifier, routePath, isIndex })
          })
        }
        log.info('add', specifier)
      }
    } else {
      if (this.#modules.has(specifier)) {
        this.#modules.delete(specifier)
      }
      if (trimBuiltinModuleExts(specifier) === '/app') {
        this.#fsWatchListeners.forEach(e => e.emit('remove', specifier))
      } else if (this.isPageModule(specifier)) {
        this.#pageRouting.removeRouteByModule(specifier)
        this.#fsWatchListeners.forEach(e => e.emit('remove', specifier))
      } else if (specifier.startsWith('/api/')) {
        this.#apiRouting.removeRouteByModule(specifier)
      }
      this.clearSSRCache(specifier)
      log.info('remove', specifier)
    }
  }

  /** check the file whether it is a scoped module. */
  private isScopedModule(specifier: string) {
    if (moduleExclude.some(r => r.test(specifier))) {
      return false
    }

    // is compiled module
    if (this.#modules.has(specifier)) {
      return true
    }

    // is page module by plugin
    if (this.isPageModule(specifier)) {
      return true
    }

    // is api or app module
    for (const ext of builtinModuleExts) {
      if (
        specifier.endsWith('.' + ext) &&
        (
          specifier.startsWith('/api/') ||
          util.trimSuffix(specifier, '.' + ext) === '/app'
        )
      ) {
        return true
      }
    }

    return false
  }

  get isDev() {
    return this.mode === 'development'
  }

  /** get the module by given specifier. */
  getModule(specifier: string): Module | null {
    if (specifier === 'app') {
      return this.#appModule
    }
    if (this.#modules.has(specifier)) {
      return this.#modules.get(specifier)!
    }
    return null
  }

  /** get the first module in the modules map where predicate is true, and null otherwise. */
  findModule(predicate: (module: Module) => boolean): Module | null {
    for (const specifier of this.#modules.keys()) {
      const module = this.#modules.get(specifier)!
      if (predicate(module)) {
        return module
      }
    }
    return null
  }

  /** get api route by the given location. */
  async getAPIRoute(location: { pathname: string, search?: string }): Promise<[RouterURL, Module] | null> {
    const router = this.#apiRouting.createRouter(location)
    if (router !== null) {
      const [url, nestedModules] = router
      if (url.routePath !== '') {
        const specifier = nestedModules.pop()!
        if (this.#modules.has(specifier)) {
          return [url, this.#modules.get(specifier)!]
        }
        const module = await this.compile(specifier, { externalRemoteDeps: true })
        return [url, module]
      }
    }
    return null
  }

  onResolve(test: RegExp, callback: (specifier: string) => ResolveResult): void {
    this.#resolverListeners.push({ test, resolve: callback })
  }

  onLoad(test: RegExp, callback: (input: LoadInput) => LoadOutput | Promise<LoadOutput>): void {
    this.#loadListeners.push({ test, load: callback })
  }

  onTransform(test: RegExp | string, callback: (input: TransformInput) => TransformOutput): void {
    this.#transformListeners.push({ test, transform: callback })
  }

  onSSR(callback: (path: string, html: string) => { html: string }): void {
    this.#ssrListeners.push(callback)
  }

  /** add a module by given path and optional source code. */
  async addModule(specifier: string, sourceCode?: string): Promise<void> {
    const source = sourceCode ? {
      code: sourceCode,
      type: SourceType.TSX,
      external: false,
      isStyle: false,
    } : undefined
    if (source !== undefined) {
      const type = getSourceType(specifier)
      if (type !== SourceType.Unknown) {
        source.type = type
      }
    }
    await this.compile(specifier, { source })
    if (specifier.startsWith('/pages/')) {
      this.#pageRouting.update(...this.createRouteUpdate(specifier))
    } else if (specifier.startsWith('/api/') && !specifier.startsWith('/api/_middlewares.')) {
      this.#apiRouting.update(...this.createRouteUpdate(specifier))
    }
    return
  }

  /** add a dist. */
  async addDist(path: string, content: Uint8Array): Promise<void> {
    const pathname = util.cleanPath(path)
    const savePath = join(this.buildDir, pathname)
    if (!await existsFile(savePath)) {
      const saveDir = dirname(savePath)
      await ensureDir(saveDir)
      await clearBuildCache(savePath, extname(savePath).slice(1))
      await Deno.writeFile(savePath, content)
    }
    this.#dists.add(pathname)
  }

  /** get ssr data by the given location(page), return `null` if no data defined */
  async getSSRData(loc: { pathname: string, search?: string }): Promise<Record<string, SSRData> | null> {
    const [router, nestedModules] = this.#pageRouting.createRouter(loc)
    const { routePath } = router
    if (routePath === '' || !this.isSSRable(router.pathname)) {
      return null
    }

    // pre-compile modules to check ssr options
    await Promise.all(
      nestedModules
        .filter(specifier => !this.#modules.has(specifier))
        .map(specifier => this.compile(specifier))
    )

    let shouldRender = false
    const pageModule = this.getModule(nestedModules[nestedModules.length - 1])
    if (pageModule && pageModule.ssrPropsFn) {
      shouldRender = true
    }
    if (!shouldRender) {
      for (const specifier of ['app', ...nestedModules]) {
        const mod = this.getModule(specifier)
        if (mod) {
          if (mod.denoHooks?.length) {
            shouldRender = true
          } else {
            this.lookupDeps(mod.specifier, dep => {
              const depMod = this.getModule(dep.specifier)
              if (depMod?.denoHooks?.length) {
                shouldRender = true
                return false
              }
            })
          }
          if (shouldRender) {
            break
          }
        }
      }
    }
    if (!shouldRender) {
      return null
    }

    const path = loc.pathname + (loc.search || '')
    const [_, data] = await this.#renderer.cache(routePath, path, async () => {
      return await this.#renderer.renderPage(router, nestedModules)
    })
    return data
  }

  /** render page to HTML by the given location */
  async renderPage(loc: { pathname: string, search?: string }): Promise<[number, string]> {
    const [router, nestedModules] = this.#pageRouting.createRouter(loc)
    const { routePath } = router
    const path = loc.pathname + (loc.search || '')

    if (!this.isSSRable(loc.pathname)) {
      const [html] = await this.#renderer.cache('-', 'spa-index', async () => {
        return [this.createSPAIndexHtml(), null]
      })
      return [200, html]
    }

    if (routePath === '') {
      const [html] = await this.#renderer.cache('404', path, async () => {
        const [_, nestedModules] = this.#pageRouting.createRouter({ pathname: '/404' })
        return await this.#renderPage(router, nestedModules.slice(0, 1))
      })
      return [404, html]
    }

    const [html] = await this.#renderer.cache(routePath, path, async () => {
      return await this.#renderPage(router, nestedModules)
    })
    return [200, html]
  }

  async #renderPage(url: RouterURL, nestedModules: string[]): Promise<[string, Record<string, SSRData> | null]> {
    const href = url.toString()
    let [html, data] = await this.#renderer.renderPage(url, nestedModules)
    for (const callback of this.#ssrListeners) {
      const ret = callback(href, html)
      html = ret.html
    }
    return [html, data]
  }

  /** create a fs watcher.  */
  createFSWatcher(): EventEmitter {
    const e = new EventEmitter()
    this.#fsWatchListeners.push(e)
    return e
  }

  /** remove the fs watcher.  */
  removeFSWatcher(e: EventEmitter) {
    e.removeAllListeners()
    const index = this.#fsWatchListeners.indexOf(e)
    if (index > -1) {
      this.#fsWatchListeners.splice(index, 1)
    }
  }

  /** create main bootstrap script in javascript. */
  createMainJS(bundleMode = false): string {
    const alephPkgUri = getAlephPkgUri()
    const alephPkgPath = alephPkgUri.replace('https://', '').replace('http://localhost:', 'http_localhost_')
    const { framework, basePath: basePath, i18n: { defaultLocale } } = this.config
    const { routes } = this.#pageRouting
    const config: Record<string, any> = {
      basePath,
      appModule: this.#appModule?.specifier,
      routes,
      renderMode: this.config.ssr ? 'ssr' : 'spa',
      defaultLocale,
      locales: [],
      rewrites: this.config.server.rewrites,
    }

    if (bundleMode) {
      return [
        `__ALEPH__.basePath = ${JSON.stringify(basePath)};`,
        `__ALEPH__.pack["${alephPkgUri}/framework/${framework}/bootstrap.ts"].default(${JSON.stringify(config)});`
      ].join('')
    }

    let code = [
      `import bootstrap from "./-/${alephPkgPath}/framework/${framework}/bootstrap.js";`,
      this.isDev && `import { connect } from "./-/${alephPkgPath}/framework/core/hmr.js";`,
      this.isDev && `connect(${JSON.stringify(basePath)});`,
      `bootstrap(${JSON.stringify(config, undefined, this.isDev ? 2 : undefined)});`
    ].filter(Boolean).join('\n')
    this.#transformListeners.forEach(({ test, transform }) => {
      if (test === 'main.js') {
        const ret = transform({ specifier: '/main.js', code })
        code = ret.code
      }
    })
    return code
  }

  /** create the index html for SPA mode. */
  private createSPAIndexHtml(): string {
    // todo: render custom fallback page
    return createHtml({
      lang: this.config.i18n.defaultLocale,
      head: [],
      scripts: this.getScripts(),
      body: '<div id="__aleph"></div>',
      minify: !this.isDev
    })
  }

  /** get scripts for html output */
  getScripts(entryFile?: string) {
    const { framework } = this.config
    const basePath = util.trimSuffix(this.config.basePath, '/')
    const alephPkgPath = getAlephPkgUri().replace('https://', '').replace('http://localhost:', 'http_localhost_')
    const syncChunks = this.#bundler.getSyncChunks()

    if (this.isDev) {
      const preload: string[] = [
        `/framework/core/module.js`,
        `/framework/core/events.js`,
        `/framework/core/routing.js`,
        `/framework/core/hmr.js`,
        `/framework/${framework}/bootstrap.js`,
        `/shared/util.js`,
      ].map(p => `${basePath}/_aleph/-/${alephPkgPath}${p}`)

      if (this.#appModule) {
        preload.push(`${basePath}/_aleph/app.js`)
      }

      if (entryFile) {
        preload.push(`${basePath}/_aleph${entryFile}`)
      }

      return [
        ...preload.map(src => ({ src, type: 'module', preload: true })),
        { src: `${basePath}/_aleph/main.js`, type: 'module' },
        { src: `${basePath}/_aleph/-/${alephPkgPath}/nomodule.js`, nomodule: true },
      ]
    }

    return [
      simpleJSMinify(bundlerRuntimeCode),
      ...syncChunks.map(filename => ({
        src: `${basePath}/_aleph/${filename}`
      }))
    ]
  }

  /** parse the export names of the module. */
  async parseModuleExportNames(specifier: string): Promise<string[]> {
    const { content, contentType } = await this.fetchModule(specifier)
    const sourceType = getSourceType(specifier, contentType || undefined)
    if (sourceType === SourceType.Unknown || sourceType === SourceType.CSS) {
      return []
    }
    const code = (new TextDecoder).decode(content)
    const names = await parseExportNames(specifier, code, { sourceType })
    return (await Promise.all(names.map(async name => {
      if (name.startsWith('{') && name.startsWith('}')) {
        return await this.parseModuleExportNames(name.slice(1, -1))
      }
      return name
    }))).flat()
  }

  /** common compiler options */
  get commonCompilerOptions(): TransformOptions {
    return {
      workingDir: this.workingDir,
      alephPkgUri: getAlephPkgUri(),
      importMap: this.importMap,
      inlineStylePreprocess: async (key: string, type: string, tpl: string) => {
        if (type !== 'css') {
          for (const { test, load } of this.#loadListeners) {
            if (test.test(`.${type}`)) {
              const { code, type: codeType } = await load({ specifier: key, data: (new TextEncoder).encode(tpl) })
              if (codeType === 'css') {
                type = 'css'
                tpl = code
                break
              }
            }
          }
        }
        const { code } = await cssLoader({ specifier: key, data: (new TextEncoder).encode(tpl) }, this)
        return code
      },
      isDev: this.isDev,
      react: this.config.react,
    }
  }

  analyze() {
    this.#analyzer.reset()
    this.#pageRouting.lookup(routes => {
      routes.forEach(({ module: specifier }) => {
        const module = this.getModule(specifier)
        if (module) {
          this.#analyzer.addEntry(module)
        }
      })
    })
    return this.#analyzer.entries
  }

  /** build the application to a static site(SSG) */
  async build() {
    const start = performance.now()

    // wait for app ready
    await this.ready

    const outputDir = join(this.workingDir, this.config.build.outputDir)
    const distDir = join(outputDir, '_aleph')

    // clean previous build
    if (await existsDir(outputDir)) {
      for await (const entry of Deno.readDir(outputDir)) {
        await Deno.remove(join(outputDir, entry.name), { recursive: entry.isDirectory })
      }
    }

    // copy bundle dist
    await this.#bundler.copyDist()

    // ssg
    await this.ssg()

    // copy public assets
    const publicDir = join(this.workingDir, 'public')
    if (await existsDir(publicDir)) {
      for await (const { path: p } of walk(publicDir, { includeDirs: false, skip: [/(^|\/|\\)\./] })) {
        const rp = util.trimPrefix(p, publicDir)
        const fp = join(outputDir, rp)
        await ensureDir(dirname(fp))
        await Deno.copyFile(p, fp)
      }
    }

    // copy custom dist files
    if (this.#dists.size > 0) {
      Promise.all(Array.from(this.#dists.values()).map(async path => {
        const src = join(this.buildDir, path)
        if (await existsFile(src)) {
          const dest = join(distDir, path)
          await ensureDir(dirname(dest))
          return Deno.copyFile(src, dest)
        }
      }))
    }

    log.info(`Done in ${Math.round(performance.now() - start)}ms`)
  }

  private createRouteUpdate(specifier: string): [string, string, boolean | undefined] {
    const isBuiltinModuleType = builtinModuleExts.some(ext => specifier.endsWith('.' + ext))
    let routePath = isBuiltinModuleType ? toPagePath(specifier) : util.trimSuffix(specifier, '/pages')
    let isIndex: boolean | undefined = undefined

    if (!isBuiltinModuleType) {
      for (const { test, resolve } of this.#resolverListeners) {
        if (test.test(specifier)) {
          const { specifier: _specifier, asPage } = resolve(specifier)
          if (asPage) {
            const { path: pagePath, isIndex: _isIndex } = asPage
            if (util.isFilledString(pagePath)) {
              routePath = pagePath
              if (_specifier) {
                specifier = _specifier
              }
              if (_isIndex) {
                isIndex = true
              }
              break
            }
          }
        }
      }
    } else if (routePath !== '/') {
      for (const ext of builtinModuleExts) {
        if (specifier.endsWith(`/index.${ext}`)) {
          isIndex = true
          break
        }
      }
    }

    return [routePath, specifier, isIndex]
  }

  /** fetch module content by the specifier. */
  async fetchModule(specifier: string): Promise<{ content: Uint8Array, contentType: string | null }> {
    if (!util.isLikelyHttpURL(specifier)) {
      const filepath = join(this.workingDir, this.config.srcDir, util.trimPrefix(specifier, 'file://'))
      if (await existsFile(filepath)) {
        const content = await Deno.readFile(filepath)
        return { content, contentType: getContentType(filepath) }
      } else {
        return Promise.reject(new Error(`No such file: ${util.trimPrefix(filepath, this.workingDir + '/')}`))
      }
    }

    // append `dev` query for development mode
    if (this.isDev && specifier.startsWith('https://esm.sh/')) {
      const u = new URL(specifier)
      if (!u.searchParams.has('dev')) {
        u.searchParams.set('dev', '')
        u.search = u.search.replace('dev=', 'dev')
        specifier = u.toString()
      }
    }

    return await cache(specifier, {
      forceRefresh: this.#reloading,
      retryTimes: 10
    })
  }

  async importModule<T = any>({ jsFile, hash, sourceHash }: Module): Promise<T> {
    return await import(`file://${join(this.buildDir, jsFile)}#${(hash || sourceHash).slice(0, 6)}`)
  }

  async getModuleJS(module: Module, injectHMRCode = false): Promise<Uint8Array | null> {
    const { specifier, jsFile, jsBuffer } = module
    if (!jsBuffer) {
      const cacheFp = join(this.buildDir, jsFile)
      if (await existsFile(cacheFp)) {
        module.jsBuffer = await Deno.readFile(cacheFp)
        log.debug(`load '${jsFile}'` + dim(' • ' + util.formatBytes(module.jsBuffer.length)))
      }
    }

    if (!module.jsBuffer) {
      return null
    }

    if (!injectHMRCode || !this.isHMRable(specifier)) {
      return module.jsBuffer
    }

    let code = new TextDecoder().decode(module.jsBuffer)
    if (module.denoHooks?.length || module.ssrPropsFn || module.ssgPathsFn) {
      if ('csrCode' in module) {
        code = (module as any).csrCode
      } else {
        [code] = util.splitBy(code, '\n//# sourceMappingURL=', true)
        const { code: csrCode } = await stripSsrCode(specifier, code, { sourceMap: true, swcOptions: { sourceType: SourceType.JS } })
        // cache csr code
        Object.assign(module, { csrCode })
        code = csrCode
        // todo: merge source map
      }
    }
    this.#transformListeners.forEach(({ test, transform }) => {
      if (test === 'hmr') {
        const ret = transform({ specifier, code })
        code = ret.code
        // todo: merge source map
      }
    })
    return new TextEncoder().encode([
      `import.meta.hot = $createHotContext(${JSON.stringify(specifier)});`,
      '',
      code,
      '',
      'import.meta.hot.accept();'
    ].join('\n'))
  }

  async loadModuleSource(specifier: string, data?: any): Promise<ModuleSource> {
    let sourceCode: string = ''
    let sourceType: SourceType = SourceType.Unknown
    let sourceMap: string | null = null
    let loader = this.#loadListeners.find(l => l.test.test(specifier))
    let isStyle = isCSS(specifier)

    if (loader) {
      const { code, type = 'js', map } = await loader.load({ specifier, data })
      switch (type) {
        case 'js':
          sourceType = SourceType.JS
          break
        case 'jsx':
          sourceType = SourceType.JSX
          break
        case 'ts':
          sourceType = SourceType.TS
          break
        case 'tsx':
          sourceType = SourceType.TSX
          break
        case 'css':
          sourceType = SourceType.CSS
          break
      }
      sourceCode = code
      sourceMap = map || null
    } else {
      const source = await this.fetchModule(specifier)
      sourceType = getSourceType(specifier, source.contentType || undefined)
      if (sourceType !== SourceType.Unknown) {
        sourceCode = (new TextDecoder).decode(source.content)
      }
    }

    if (sourceType === SourceType.CSS) {
      isStyle = true
      // todo: covert source map
      const { code, type = 'js' } = await cssLoader({ specifier, data: sourceCode }, this)
      if (type === 'js') {
        sourceCode = code
        sourceType = SourceType.JS
      }
    }

    return {
      code: sourceCode,
      type: sourceType,
      isStyle,
      map: sourceMap ? sourceMap : undefined
    }
  }

  /** compile the module by given specifier */
  async compile(specifier: string, options: CompileOptions = {}) {
    const [module, source] = await this.initModule(specifier, options)
    if (!module.external) {
      await this.transpileModule(module, source, options.ignoreDeps)
    }
    return module
  }

  private async initModule(specifier: string, { source: customSource, forceRefresh, externalRemoteDeps }: CompileOptions = {}): Promise<[Module, ModuleSource | null]> {
    let external = false
    let data: any = null

    if (customSource === undefined) {
      for (const { test, resolve } of this.#resolverListeners) {
        if (test.test(specifier)) {
          const ret = resolve(specifier)
          if (ret.specifier) {
            specifier = ret.specifier
          }
          external = Boolean(ret.external)
          data = ret.data
          break
        }
      }
    }

    if (external) {
      return [{
        specifier,
        deps: [],
        external,
        sourceHash: '',
        jsFile: '',
        ready: Promise.resolve()
      }, null]
    }

    let mod = this.#modules.get(specifier)
    if (mod && !forceRefresh && !(!externalRemoteDeps && mod.externalRemoteDeps)) {
      await mod.ready
      return [mod, null]
    }

    const isRemote = util.isLikelyHttpURL(specifier) && !isLocalUrl(specifier)
    const localPath = toLocalPath(specifier)
    const name = trimBuiltinModuleExts(basename(localPath))
    const jsFile = join(dirname(localPath), `${name}.js`)
    const cacheFp = join(this.buildDir, jsFile)
    const metaFp = cacheFp.slice(0, -3) + '.meta.json'

    let defer = (err?: Error) => { }
    let source: ModuleSource | null = null
    mod = {
      specifier,
      deps: [],
      sourceHash: '',
      externalRemoteDeps,
      jsFile,
      ready: new Promise((resolve) => {
        defer = (err?: Error) => {
          if (err) {
            this.#modules.delete(specifier)
            log.error(err.message)
          }
          resolve()
        }
      })
    }

    this.#modules.set(specifier, mod)
    if (trimBuiltinModuleExts(specifier) === '/app') {
      this.#appModule = mod
    }

    if (await existsFile(metaFp)) {
      try {
        const { specifier: _specifier, sourceHash, deps, isStyle, ssrPropsFn, ssgPathsFn, denoHooks } = JSON.parse(await Deno.readTextFile(metaFp))
        if (_specifier === specifier && util.isFilledString(sourceHash) && util.isArray(deps)) {
          mod.sourceHash = sourceHash
          mod.deps = deps
          mod.isStyle = Boolean(isStyle) || undefined
          mod.ssrPropsFn = util.isFilledString(ssrPropsFn) ? ssrPropsFn : undefined
          mod.ssgPathsFn = Boolean(ssgPathsFn) || undefined
          mod.denoHooks = util.isFilledArray(denoHooks) ? denoHooks : undefined
        } else {
          log.warn(`removing invalid metadata '${name}.meta.json'`)
          Deno.remove(metaFp)
        }
      } catch (e) { }
    }

    const shouldLoad = !(
      (isRemote && !this.#reloading && mod.sourceHash !== '') &&
      await existsFile(cacheFp)
    )
    if (shouldLoad) {
      try {
        const src = customSource || await this.loadModuleSource(specifier, data)
        const sourceHash = computeHash(src.code)
        if (mod.sourceHash === '' || mod.sourceHash !== sourceHash) {
          mod.sourceHash = sourceHash
          source = src
        }
        mod.isStyle = src.isStyle
      } catch (err) {
        defer(err)
        return [mod, null]
      }
    }

    defer()
    return [mod, source]
  }

  private async transpileModule(
    module: Module,
    source: ModuleSource | null,
    ignoreDeps = false,
    __tracing: Set<string> = new Set()
  ): Promise<void> {
    const { specifier, jsFile, externalRemoteDeps } = module

    // ensure the module only be transppiled once in current compilation context,
    // to avoid dead-loop caused by cicular imports
    if (__tracing.has(specifier)) {
      return
    }
    __tracing.add(specifier)

    if (source) {
      if (source.type === SourceType.Unknown) {
        log.error(`Unsupported module '${specifier}'`)
        return
      }

      const ms = new Measure()
      const encoder = new TextEncoder()
      const { code, deps, denoHooks, ssrPropsFn, ssgPathsFn, starExports, map } = await transform(specifier, source.code, {
        ...this.commonCompilerOptions,
        sourceMap: this.isDev,
        swcOptions: {
          sourceType: source.type
        },
        externalRemoteDeps
      })

      let jsCode = code
      let sourceMap = map

      // in production(bundle) mode we need to replace the star export with names
      if (!this.isDev && starExports && starExports.length > 0) {
        for (let index = 0; index < starExports.length; index++) {
          const exportSpecifier = starExports[index]
          const names = await this.parseModuleExportNames(exportSpecifier)
          jsCode = jsCode.replace(
            `export * from "[${exportSpecifier}]:`,
            `export {${names.filter(name => name !== 'default').join(',')}} from "`
          )
        }
      }

      // revert external imports
      if (deps && this.#resolverListeners.length > 0) {
        deps.forEach(({ specifier }) => {
          if (specifier !== module.specifier && util.isLikelyHttpURL(specifier)) {
            let external = false
            for (const { test, resolve } of this.#resolverListeners) {
              if (test.test(specifier)) {
                const ret = resolve(specifier)
                if (ret.specifier) {
                  specifier = ret.specifier
                }
                external = Boolean(ret.external)
                break
              }
            }
            if (external) {
              const importSpecifier = toRelativePath(
                dirname(toLocalPath(module.specifier)),
                toLocalPath(specifier)
              )
              jsCode.replaceAll(`"${importSpecifier}"`, `"${specifier}"`)
            }
          }
        })
      }

      this.#transformListeners.forEach(({ test, transform }) => {
        if (test instanceof RegExp ? test.test(specifier) : test === '*') {
          const { code, map } = transform({ specifier, code: jsCode, map: sourceMap })
          jsCode = code
          if (map) {
            sourceMap = map
          }
        }
      })

      // add source mapping url
      if (sourceMap) {
        jsCode += `\n//# sourceMappingURL=${basename(jsFile)}.map`
      }

      module.jsBuffer = encoder.encode(jsCode)
      module.deps = deps?.filter(({ specifier }) => specifier !== module.specifier).map(({ specifier, resolved, isDynamic }) => {
        const dep: DependencyDescriptor = { specifier }
        if (isDynamic) {
          dep.isDynamic = true
        }
        if (specifier.startsWith('/')) {
          const mark = encoder.encode(resolved)
          const idx = indexOf(module.jsBuffer!, mark)
          if (idx > 0) {
            dep.hashLoc = idx + mark.length - 6
          }
        }
        return dep
      }) || []

      module.ssrPropsFn = ssrPropsFn
      module.ssgPathsFn = ssgPathsFn
      if (util.isFilledArray(denoHooks)) {
        module.denoHooks = denoHooks.map(id => util.trimPrefix(id, 'useDeno-'))
        if (!this.config.ssr) {
          log.error(`'useDeno' hook in SPA mode is illegal: ${specifier}`)
        }
      }

      ms.stop(`transpile '${specifier}'`)

      const cacheFp = join(this.buildDir, jsFile)
      const metaFp = cacheFp.slice(0, -3) + '.meta.json'
      const metaJSON = JSON.stringify({
        specifier,
        sourceHash: module.sourceHash,
        isStyle: module.isStyle,
        ssrPropsFn: module.ssrPropsFn,
        ssgPathsFn: module.ssgPathsFn,
        denoHooks: module.denoHooks,
        deps: module.deps,
      }, undefined, 2)
      await ensureDir(dirname(cacheFp))
      await Promise.all([
        Deno.writeFile(cacheFp, module.jsBuffer),
        Deno.writeTextFile(metaFp, metaJSON),
        sourceMap ? Deno.writeTextFile(`${cacheFp}.map`, sourceMap) : Promise.resolve(),
      ])
    }

    if (module.deps.length > 0) {
      let fsync = false
      const hasher = createHash('md5').update(module.sourceHash)
      await Promise.all(module.deps.map(async ({ specifier, hashLoc }) => {
        let depModule: Module | null
        if (ignoreDeps) {
          depModule = this.getModule(specifier)
        } else {
          const [mod, src] = await this.initModule(specifier, { externalRemoteDeps })
          if (!mod.external) {
            await this.transpileModule(mod, src, false, __tracing)
          }
          depModule = mod
        }
        if (depModule) {
          const hash = depModule.hash || depModule.sourceHash
          if (hashLoc !== undefined) {
            if (await this.replaceDepHash(module, hashLoc, hash)) {
              fsync = true
            }
          }
          hasher.update(hash)
        } else {
          log.error(`transpile '${module.specifier}': missing dependency module '${specifier}'`)
        }
      }))
      module.hash = hasher.toString()
      if (fsync) {
        await this.cacheModule(module)
      }
    } else {
      module.hash = module.sourceHash
    }
  }

  /** apply compilation side-effect caused by updating dependency graph. */
  private async applyCompilationSideEffect(by: Module, callback: (mod: Module) => void, __tracing = new Set<string>()) {
    if (__tracing.has(by.specifier)) {
      return
    }
    __tracing.add(by.specifier)

    const hash = by.hash || by.sourceHash
    for (const mod of this.#modules.values()) {
      const { deps } = mod
      if (deps.length > 0) {
        let fsync = false
        for (const dep of deps) {
          const { specifier, hashLoc } = dep
          if (specifier === by.specifier && hashLoc !== undefined) {
            if (await this.replaceDepHash(mod, hashLoc, hash)) {
              fsync = true
            }
          }
        }
        if (fsync) {
          const hasher = createHash('md5').update(mod.sourceHash)
          deps.forEach(({ specifier }) => {
            const depMod = specifier === by.specifier ? by : this.#modules.get(specifier)
            if (depMod) {
              hasher.update(depMod.hash || depMod.sourceHash)
            }
          })
          mod.hash = hasher.toString()
          callback(mod)
          this.applyCompilationSideEffect(mod, callback)
          this.cacheModule(mod)
        }
      }
    }
  }

  /** replace dep hash in the `jsBuffer` and remove `csrCode` cache if it exits */
  private async replaceDepHash(module: Module, hashLoc: number, hash: string) {
    const hashData = (new TextEncoder()).encode(hash.substr(0, 6))
    const jsBuffer = await this.getModuleJS(module)
    if (jsBuffer && !equals(hashData, jsBuffer.slice(hashLoc, hashLoc + 6))) {
      copy(hashData, jsBuffer, hashLoc)
      if ('csrCode' in module) {
        Reflect.deleteProperty(module, 'csrCode')
      }
      return true
    }
    return false
  }

  private clearSSRCache(specifier: string) {
    if (trimBuiltinModuleExts(specifier) === '/app') {
      this.#renderer.clearCache()
    } else if (this.isPageModule(specifier)) {
      const [routePath] = this.createRouteUpdate(specifier)
      this.#renderer.clearCache(routePath)
    }
  }

  private async cacheModule(module: Module) {
    const { specifier, jsBuffer, jsFile } = module
    if (jsBuffer) {
      const cacheFp = join(this.buildDir, jsFile)
      const metaFp = cacheFp.slice(0, -3) + '.meta.json'
      await ensureDir(dirname(cacheFp))
      await Promise.all([
        Deno.writeFile(cacheFp, jsBuffer),
        Deno.writeTextFile(metaFp, JSON.stringify({
          specifier,
          sourceHash: module.sourceHash,
          isStyle: module.isStyle,
          ssrPropsFn: module.ssrPropsFn,
          ssgPathsFn: module.ssgPathsFn,
          denoHooks: module.denoHooks,
          deps: module.deps,
        }, undefined, 2)),
        lazyRemove(cacheFp.slice(0, -3) + '.bundling.js'),
      ])
    }
  }

  /** create bundled chunks for production. */
  private async bundle() {
    const entries = this.analyze()
    await this.#bundler.bundle(entries)
  }

  /** render all pages in routing. */
  private async ssg() {
    const { ssr } = this.config
    const outputDir = join(this.workingDir, this.config.build.outputDir)

    if (ssr === false) {
      const html = this.createSPAIndexHtml()
      await ensureTextFile(join(outputDir, 'index.html'), html)
      await ensureTextFile(join(outputDir, '404.html'), html)
      // todo: 500 page
      return
    }

    // render pages
    const paths: Set<{ pathname: string, search?: string }> = new Set(this.#pageRouting.paths.map(pathname => ({ pathname })))
    const locales = this.config.i18n.locales.filter(l => l !== this.config.i18n.defaultLocale)
    for (const specifier of this.#modules.keys()) {
      const module = this.#modules.get(specifier)!
      if (module.ssgPathsFn) {
        const { ssr } = await this.importModule(module)
        let ssrPaths = ssr.paths
        if (util.isFunction(ssrPaths)) {
          ssrPaths = ssrPaths()
          if (ssrPaths instanceof Promise) {
            ssrPaths = await ssrPaths
          }
        }
        if (util.isFilledArray(ssrPaths)) {
          ssrPaths.forEach(path => {
            if (util.isFilledString(path)) {
              const parts = path.split('?')
              const pathname = util.cleanPath(parts.shift()!)
              const search = parts.length > 0 ? '?' + (new URLSearchParams('?' + parts.join('?'))).toString() : undefined
              const [router, nestedModules] = this.#pageRouting.createRouter({ pathname, search })
              if (router.routePath !== '' && nestedModules.pop() === specifier) {
                paths.add({ pathname, search })
              } else {
                log.warn(`Invalid SSG path '${path}'`)
              }
            }
          })
        }
      }
    }

    // render route pages
    await Promise.all(Array.from(paths).map(loc => ([loc, ...locales.map(locale => ({ ...loc, pathname: locale + loc.pathname }))])).flat().map(async ({ pathname, search }) => {
      if (this.isSSRable(pathname)) {
        const [router, nestedModules] = this.#pageRouting.createRouter({ pathname, search })
        if (router.routePath !== '') {
          const href = router.toString()
          const [html, data] = await this.#renderPage(router, nestedModules)
          await ensureTextFile(join(outputDir, pathname, 'index.html' + (search || '')), html)
          if (data) {
            const dataFile = join(
              outputDir,
              `_aleph/data/${util.btoaUrl(href)}.json`
            )
            await ensureTextFile(dataFile, JSON.stringify(data))
          }
          log.debug('SSR', href, dim('• ' + util.formatBytes(html.length)))
        }
      }
    }))

    // render 404 page
    {
      const [router, nestedModules] = this.#pageRouting.createRouter({ pathname: '/404' })
      if (nestedModules.length > 0) {
        await this.compile(nestedModules[0])
      }
      const [html] = await this.#renderPage(router, nestedModules.slice(0, 1))
      await ensureTextFile(join(outputDir, '404.html'), html)
    }
  }

  /** check the module whether it is page. */
  private isPageModule(specifier: string): boolean {
    if (!specifier.startsWith('/pages/')) {
      return false
    }
    if (builtinModuleExts.some(ext => specifier.endsWith('.' + ext))) {
      return true
    }

    return this.#resolverListeners.some(({ test, resolve }) => test.test(specifier) && !!resolve(specifier).asPage)
  }

  /** check the module whether it is hmrable. */
  private isHMRable(specifier: string): boolean {
    if (util.isLikelyHttpURL(specifier)) {
      return false
    }

    for (const ext of builtinModuleExts) {
      if (specifier.endsWith('.' + ext)) {
        return (
          specifier.startsWith('/pages/') ||
          specifier.startsWith('/components/') ||
          util.trimSuffix(specifier, '.' + ext) === '/app'
        )
      }
    }

    const mod = this.#modules.get(specifier)
    if (mod && mod.isStyle) {
      return true
    }

    return this.#resolverListeners.some(({ test, resolve }) => (
      test.test(specifier) && this.acceptHMR(resolve(specifier))
    ))
  }

  /** check the page whether it supports SSR. */
  private isSSRable(pathname: string): boolean {
    const { ssr } = this.config
    if (util.isPlainObject(ssr)) {
      if (ssr.include) {
        for (let r of ssr.include) {
          if (!r.test(pathname)) {
            return false
          }
        }
      }
      if (ssr.exclude) {
        for (let r of ssr.exclude) {
          if (r.test(pathname)) {
            return false
          }
        }
      }
      return true
    }
    return ssr
  }

  private acceptHMR(ret: ResolveResult): boolean {
    return ret.acceptHMR || !!ret.asPage
  }

  /** lookup app deps recurively. */
  lookupDeps(
    specifier: string,
    callback: (dep: DependencyDescriptor) => false | void,
    __tracing: Set<string> = new Set()
  ) {
    const mod = this.getModule(specifier)
    if (mod === null) {
      return
    }
    if (__tracing.has(specifier)) {
      return
    }
    __tracing.add(specifier)
    for (const dep of mod.deps) {
      if (callback(dep) === false) {
        return false
      }
    }
    for (const { specifier } of mod.deps) {
      if ((this.lookupDeps(specifier, callback, __tracing)) === false) {
        return false
      }
    }
  }
}
