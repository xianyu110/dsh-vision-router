import { contextWithLiveModelCatalog } from './client-live-models.js'

/**
 * Intercept only this package's module registration, then immediately restore
 * DSH's loader. The large legacy client stays byte-for-byte untouched; its
 * apply() receives a private context whose model-catalog call is augmented
 * with Vision Router's Host-owned endpoint discovery.
 */
export function installVisionRouterClientCatalogWrapper(loader = globalThis.window?.__ModuleLoader__) {
  if (!loader || typeof loader.load !== 'function') return () => {}
  const originalLoad = loader.load
  let active = true
  const wrappedLoad = function loadWithLiveVisionCatalog(spec) {
    let next = spec
    if (active && spec && spec.id === 'dsh-vision-router' && typeof spec.factory === 'function') {
      const factory = spec.factory
      next = {
        ...spec,
        factory(require) {
          const exports = factory(require)
          if (exports && typeof exports.apply === 'function') {
            const apply = exports.apply
            exports.apply = (ctx, ...args) => apply(contextWithLiveModelCatalog(ctx), ...args)
          }
          return exports
        },
      }
    }
    return originalLoad.call(this, next)
  }
  loader.load = wrappedLoad
  return () => {
    active = false
    if (loader.load === wrappedLoad) loader.load = originalLoad
  }
}

const restore = installVisionRouterClientCatalogWrapper()
try {
  await import('./client.js')
} finally {
  restore()
}
