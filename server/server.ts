import { join } from 'https://raw.githubusercontent.com/denoland/deno_std/main/path/mod.ts'
import { builtinModuleExts, trimBuiltinModuleExts } from '../framework/core/module.ts'
import { resolveURL } from '../framework/core/routing.ts'
import { existsFile } from '../shared/fs.ts'
import log from '../shared/log.ts'
import util from '../shared/util.ts'
import { APIContext } from '../types.ts'
import { Aleph } from './aleph.ts'
import compress from './compress.ts'
import { getContentType } from './mime.ts'
import { APIResponse } from './response.ts'

/** The Aleph server class. */
export class Server {
  #aleph: Aleph
  #ready: boolean

  constructor(aleph: Aleph) {
    this.#aleph = aleph
    this.#ready = false
  }

  async handle(e: Deno.RequestEvent): Promise<void> {
    if (!this.#ready) {
      await this.#aleph.ready
      this.#ready = true
    }

    const { request: req, respondWith } = e
    const aleph = this.#aleph
    const { basePath, server: { headers, rewrites, middlewares } } = aleph.config
    const url = resolveURL(req.url, basePath, rewrites)
    const pathname = decodeURI(url.pathname)

    try {
      // serve hmr ws
      if (pathname === '/_hmr') {
        const { websocket, response } = Deno.upgradeWebSocket(req)
        const watcher = aleph.createFSWatcher()
        websocket.addEventListener('open', () => {
          watcher.on('add', (mod: any) => websocket.send(JSON.stringify({ ...mod, type: 'add' })))
          watcher.on('remove', (specifier: string) => {
            watcher.removeAllListeners('modify-' + specifier)
            websocket.send(JSON.stringify({ type: 'remove', specifier }))
          })
          log.debug('hmr connected')
        })
        websocket.addEventListener('close', () => {
          aleph.removeFSWatcher(watcher)
          log.debug('hmr closed')
        })
        websocket.addEventListener('message', (e) => {
          if (util.isFilledString(e.data)) {
            try {
              const data = JSON.parse(e.data)
              if (data.type === 'hotAccept' && util.isFilledString(data.specifier)) {
                const mod = aleph.getModule(data.specifier)
                if (mod) {
                  watcher.on(`modify-${mod.specifier}`, (data) => {
                    websocket.send(JSON.stringify({
                      ...data,
                      type: 'update',
                      specifier: mod.specifier,
                      updateUrl: util.cleanPath(`${basePath}/_aleph/${trimBuiltinModuleExts(mod.specifier)}.js`),
                    }))
                  })
                }
              }
            } catch (e) { }
          }
        })

        try {
          await respondWith(response)
        } catch (err) {
          log.warn('http:', err.message)
        }
        return
      }

      const resp = new APIResponse()

      // set server header
      resp.setHeader('Server', 'Aleph.js')

      // set custom headers
      if (headers) {
        for (const key in headers) {
          resp.setHeader(key, headers[key])
        }
      }

      // in dev mode, we use `Last-Modified` and `ETag` header to control cache
      if (aleph.isDev) {
        resp.setHeader('Cache-Control', 'max-age=0')
      }

      // serve dist files
      if (pathname.startsWith('/_aleph/')) {
        if (pathname.startsWith('/_aleph/data/') && pathname.endsWith('.json')) {
          const path = util.atobUrl(util.trimSuffix(util.trimPrefix(pathname, '/_aleph/data/'), '.json'))
          const data = await aleph.getSSRData({ pathname: path })
          if (data === null) {
            resp.json(null).writeTo(e, 404)
          } else {
            resp.json(data).writeTo(e)
          }
          return
        }

        const relPath = util.trimPrefix(pathname, '/_aleph')
        if (relPath == '/main.js') {
          resp.body = aleph.createMainJS(false)
          resp.setHeader('Content-Type', 'application/javascript; charset=utf-8')
          resp.writeTo(e)
          return
        }

        if (relPath.endsWith('.js')) {
          let module = aleph.findModule(({ jsFile }) => jsFile === relPath)
          if (!module && aleph.isDev) {
            for (const ext of [...builtinModuleExts.map(ext => `.${ext}`), '']) {
              const sepcifier = util.trimSuffix(relPath, '.js') + ext
              if (await existsFile(join(aleph.workingDir, sepcifier))) {
                module = await aleph.compile(sepcifier)
                break
              }
            }
          }
          if (module) {
            const content = await aleph.getModuleJS(module, aleph.isDev)
            if (content) {
              const hash = module.hash || module.sourceHash
              if (hash === req.headers.get('If-None-Match')) {
                resp.writeTo(e, 304)
                return
              }

              resp.setHeader('ETag', hash)
              resp.setHeader('Content-Type', 'application/javascript; charset=utf-8')
              resp.body = content
              resp.writeTo(e)
              return
            }
          }
        }

        const filePath = join(aleph.buildDir, relPath)
        if (await existsFile(filePath)) {
          const info = Deno.lstatSync(filePath)
          const lastModified = info.mtime?.toUTCString() ?? (new Date).toUTCString()
          if (lastModified === req.headers.get('If-Modified-Since')) {
            resp.writeTo(e, 304)
            return
          }

          resp.body = await Deno.readFile(filePath)
          resp.setHeader('Last-Modified', lastModified)
          resp.setHeader('Content-Type', getContentType(filePath))
          resp.writeTo(e)
          return
        }

        resp.body = 'file not found'
        resp.writeTo(e, 404)
        return
      }

      // serve public files
      const filePath = join(aleph.workingDir, 'public', pathname)
      if (await existsFile(filePath)) {
        const info = Deno.lstatSync(filePath)
        const lastModified = info.mtime?.toUTCString() ?? (new Date).toUTCString()
        if (lastModified === req.headers.get('If-Modified-Since')) {
          resp.writeTo(e, 304)
          return
        }

        resp.body = await Deno.readFile(filePath)
        resp.setHeader('Last-Modified', lastModified)
        resp.setHeader('Content-Type', getContentType(filePath))
        resp.writeTo(e)
        return
      }

      // serve APIs
      if (pathname.startsWith('/api/')) {
        const route = await aleph.getAPIRoute({
          pathname,
          search: Array.from(url.searchParams.keys()).length > 0 ? '?' + url.searchParams.toString() : ''
        })
        if (route !== null) {
          try {
            const [router, module] = route
            const data = new Map()
            const steps = [...middlewares, async (context: APIContext) => {
              const { default: _handler, handler } = await aleph.importModule(module)
              const h = _handler || handler
              if (util.isFunction(h)) {
                await h(context)
              } else {
                await resp.json({ status: 500, message: 'bad api handler' }).writeTo(e, 500)
              }
            }]
            let pointer = 0
            let responded = false
            const next = async () => {
              if (pointer < steps.length && !responded) {
                let nextPromise: any = null
                const result = steps[pointer]({
                  request: req,
                  response: resp,
                  respondWith: async (r: Response | Promise<Response>) => {
                    responded = true
                    try {
                      await respondWith(r)
                    } catch (err) {
                      log.warn('http:', err.message)
                    }
                  },
                  router,
                  data
                }, () => {
                  pointer++
                  nextPromise = next()
                })
                if (nextPromise) {
                  await nextPromise
                  nextPromise = null
                }
                if (result instanceof Promise) {
                  await result
                }
                if (nextPromise) {
                  await nextPromise
                }
              }
            }
            await next()
            if (!responded) {
              resp.writeTo(e)
            }
          } catch (err) {
            resp.json({ status: 500, message: err.message }).writeTo(e, 500)
            log.error('invoke API:', err)
          }
        } else {
          resp.json({ status: 404, message: 'not found' }).writeTo(e, 404)
        }
        return
      }

      // ssr
      const [status, html] = await aleph.renderPage({
        pathname,
        search: Array.from(url.searchParams.keys()).length > 0 ? '?' + url.searchParams.toString() : ''
      })
      resp.body = html
      resp.setHeader('Content-Type', 'text/html; charset=utf-8')
      resp.writeTo(e, status)
    } catch (err) {
      try {
        // todo: custom error page
        e.respondWith(new Response(
          [
            `<!DOCTYPE html>`,
            `<title>Server Error</title>`,
            `<h1>Error: ${err.message}</h1>`,
            `<p><pre>${err.stack}</pre></p>`
          ].join('\n'),
          {
            status: 500,
            headers: new Headers({ 'Content-Type': 'text/html; charset=utf-8' })
          }
        ))
      } catch (err) {
        log.warn('send:', err.message)
      }
    }
  }
}

/** Options for creating a native server. */
export type ServeOptions = {
  /** The Aleph to serve. */
  aleph: Aleph
  /** The port to listen on. */
  port: number
  /** A literal IP address or host name that can be resolved to an IP address. Defaults to `0.0.0.0`. */
  hostname?: string
  /** The certificate file for TLS connection. */
  certFile?: string
  /** The public key file for TLS connection. */
  keyFile?: string
  /* The signal to close the server. */
  signal?: AbortSignal
}

/** Create a standard Aleph server. */
export async function serve({ aleph, port, hostname, certFile, keyFile, signal }: ServeOptions) {
  const server = new Server(aleph)
  await aleph.ready

  while (true) {
    try {
      let listener: Deno.Listener
      if (certFile && keyFile)
        listener = Deno.listenTls({ port, hostname, certFile, keyFile })
      else {
        listener = Deno.listen({ port, hostname })
      }
      signal?.addEventListener('abort', () => {
        listener.close()
      })
      if (!aleph.isDev && aleph.config.server.compress) {
        compress.enable()
      }
      log.info(`Server ready on http://${hostname || 'localhost'}:${port}${aleph.config.basePath}`)

      for await (const conn of listener) {
        // In order to not be blocking, we need to handle each connection individually
        // in its own async function.
        (async () => {
          try {
            const httpConn = Deno.serveHttp(conn)
            // Each request sent over the HTTP connection will be yielded as an async
            // iterator from the HTTP connection.
            for await (const e of httpConn) {
              await server.handle(e)
            }
          } catch (err) {
            log.warn(err.message)
          }
        })()
      }
    } catch (err) {
      if (err instanceof Deno.errors.AddrInUse) {
        if (!aleph.isDev) {
          log.fatal(`port ${port} already in use!`)
        }
        log.warn(`port ${port} already in use, try ${port + 1}...`)
        port++
      } else {
        log.fatal(err.message)
      }
    }
  }
}
