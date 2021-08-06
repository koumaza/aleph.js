import { createElement } from 'https://esm.sh/react@experimental'
import { hydrateRoot, render } from 'https://esm.sh/react-dom@experimental'
import { importModule } from '../core/module.ts'
import { Routing, RoutingOptions } from '../core/routing.ts'
import Router, { createPageRoute } from './components/Router.ts'
import { loadSSRDataFromTag, setStaticSsrRoutes } from './pagedata.ts'

type BootstrapOptions = Required<RoutingOptions> & {
  ssrRoutes?: string[],
  appModule?: string,
  renderMode: 'ssr' | 'spa'
}

export default async function bootstrap(options: BootstrapOptions) {
  const { basePath, defaultLocale, locales, appModule: appModuleSpcifier, routes, ssrRoutes, rewrites, renderMode } = options
  const { document } = window as any
  const appModule = appModuleSpcifier ? await importModule(basePath, appModuleSpcifier) : {}
  const routing = new Routing({ routes, rewrites, basePath, defaultLocale, locales })
  const [url, nestedModules] = routing.createRouter()
  const pageRoute = await createPageRoute(url, nestedModules)
  const routerEl = createElement(Router, { appModule, pageRoute, routing })
  const mountPoint = document.getElementById('__aleph')

  if (renderMode === 'ssr') {
    if (ssrRoutes) {
      setStaticSsrRoutes(ssrRoutes)
    }
    loadSSRDataFromTag(url)
    let root = hydrateRoot(routerEl, mountPoint)
    root.render(mountpoint)
  } else {
    render(routerEl, mountPoint)
  }

  // remove ssr head elements
  await Promise.resolve()
  Array.from(document.head.children).forEach((el: any) => {
    const tag = el.tagName.toLowerCase()
    if (
      el.hasAttribute('ssr') &&
      tag !== 'style' &&
      !(tag === 'link' && el.getAttribute('rel') === 'stylesheet')
    ) {
      document.head.removeChild(el)
    }
  })
}
