const RC7_OWNED_ROUTES = new Set(['deepseek-official', 'deepseek-official-native'])

/**
 * DSH rc.7 added the configurable-provider directory used by Settings -> Models.
 * Older rc.6 runtimes do not expose this seam. Capability detection is more
 * reliable than parsing package versions for source builds and patched hosts.
 */
export function isRc7ContractRuntime(ctx) {
  return !!ctx?.llm && typeof ctx.llm.registerConfigurableProviders === 'function'
}

/**
 * Preserve rc.7 provider ownership: Vision Router may wrap/delegate the
 * official provider, but cannot synthesize or replace it. Other adapters pass
 * through unchanged.
 */
export function protectRc7ProviderOwnership(ctx) {
  if (!ctx || typeof ctx !== 'object' || !ctx.llm || typeof ctx.llm !== 'object') return ctx
  const llm = new Proxy(ctx.llm, {
    get(target, property) {
      if (property === 'registerAdapter') {
        return (routes, adapter) => {
          const list = Array.isArray(routes) ? routes : [routes]
          if (list.some((route) => RC7_OWNED_ROUTES.has(String(route)))) {
            const error = new Error(
              'vision-router: DSH rc.7 owns deepseek-official; use the auto-vision wrapper instead of provider takeover',
            )
            error.code = 'DSH_RC7_PROVIDER_OWNERSHIP'
            throw error
          }
          return target.registerAdapter(routes, adapter)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'llm') return llm
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * The common rc.6/rc.7 SettingsProvider service is the stable public seam.
 * This helper mirrors installSettingsSection's attach/detach semantics without
 * forcing a new package-resolution edge into older rc.6 profiles.
 */
export function installSettingsSectionCompat(ctx, namespace, Config, entryConfig, hooks) {
  hooks.setSource(() => entryConfig)
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(namespace, Config, { base: entryConfig })
    hooks.setSource(() => scope.get())
    hooks.onChange()
    const disposeWatch = scope.watch(() => hooks.onChange())
    sctx.effect(
      () => () => {
        if (typeof disposeWatch === 'function') disposeWatch()
        hooks.setSource(() => entryConfig)
        hooks.onChange()
      },
      'vision-router: rc7 settings compatibility source',
    )
  })
}

/**
 * Bridge rc.7's public settings-section semantics to core's rc.6-shaped
 * `ctx.inject(['settings']) -> settings.register()` callback. The stored rc.6
 * `stealth` flag is masked on rc.7 because provider takeover is not supported.
 */
export function installRc7SettingsCompatibility(ctx, entryConfig, options = {}) {
  const install = options.installSettingsSection ?? installSettingsSectionCompat
  const ns = options.namespace
  const Config = options.Config
  if (Config === undefined) {
    throw new TypeError('vision-router: rc7 settings compatibility requires Config')
  }

  let activeSource = () => ({ ...entryConfig, stealth: false })
  const watchers = new Set()

  install(ctx, ns, Config, entryConfig, {
    setSource(source) {
      activeSource = () => {
        const value = typeof source === 'function' ? source() : source
        if (!value || typeof value !== 'object') return { ...entryConfig, stealth: false }
        return { ...value, stealth: false }
      }
    },
    onChange() {
      const next = activeSource()
      for (const watcher of [...watchers]) {
        try {
          watcher(next, undefined)
        } catch {
          // Settings observer failures are isolated by the host as well.
        }
      }
    },
  })

  const scope = {
    get() {
      return activeSource()
    },
    watch(callback) {
      if (typeof callback !== 'function') return () => {}
      watchers.add(callback)
      return () => watchers.delete(callback)
    },
  }
  const settingsFacade = {
    register(namespace) {
      if (namespace !== 'vision-router') {
        throw new Error(`vision-router: unexpected settings namespace ${String(namespace)}`)
      }
      return scope
    },
  }

  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'inject') {
        return (dependencies, callback) => {
          if (
            Array.isArray(dependencies) &&
            dependencies.length === 1 &&
            dependencies[0] === 'settings' &&
            typeof callback === 'function'
          ) {
            const settingsCtx = new Proxy(target, {
              get(inner, key) {
                if (key === 'settings') return settingsFacade
                const value = Reflect.get(inner, key, inner)
                return typeof value === 'function' ? value.bind(inner) : value
              },
            })
            callback(settingsCtx)
            return undefined
          }
          return target.inject(dependencies, callback)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * rc.6 keeps the narrow Termux fallback. rc.7 formalizes AttachmentId as
 * store-owned, so the host context must pass through untouched there.
 */
export function attachmentContextForContract(ctx, logger, options = {}) {
  if (isRc7ContractRuntime(ctx)) return ctx
  const install = options.installAndroidAttachmentCompat
  if (typeof install !== 'function') return ctx
  return install(ctx, logger, options.android)
}
