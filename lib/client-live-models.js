export const LIVE_MODELS_PATH = '/_dsh/vision-router/live-models'

function catalogValue(body) {
  if (body && typeof body === 'object' && body.result && typeof body.result === 'object') {
    if (body.result.ok !== true) return undefined
    return body.result.value
  }
  return body
}

function replaceCatalogValue(body, value) {
  if (body && typeof body === 'object' && body.result && typeof body.result === 'object') {
    return { ...body, result: { ...body.result, value } }
  }
  return value
}

function cleanLiveProviders(snapshot) {
  return snapshot && snapshot.ok === true && Array.isArray(snapshot.providers) ? snapshot.providers : []
}

/**
 * Merge endpoint-discovered IDs into DSH's catalog without changing DSH's own
 * model metadata. Existing entries always win; live-only entries are appended
 * so a background refresh cannot move the option the user was about to click.
 */
export function mergeLiveModelsIntoCatalog(body, snapshot) {
  const value = catalogValue(body)
  if (!value || typeof value !== 'object') return body
  const originalGroups = Array.isArray(value.groups) ? value.groups : []
  const byProvider = new Map(cleanLiveProviders(snapshot).map((entry) => [entry?.provider, entry]))
  if (byProvider.size === 0) return body

  const groups = originalGroups.map((group) => {
    const live = byProvider.get(group?.id)
    if (!live || !Array.isArray(live.models) || live.models.length === 0) return group
    byProvider.delete(group.id)
    const originalModels = Array.isArray(group.models) ? group.models : []
    const seen = new Set(originalModels.map((model) => model?.id).filter((id) => typeof id === 'string'))
    const appended = live.models.flatMap((model) => {
      if (!model || typeof model.id !== 'string' || model.id === '' || seen.has(model.id)) return []
      seen.add(model.id)
      return [{
        id: model.id,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
        provider: group.id,
        // Deliberately absent: inputModalities. Endpoint discovery proves only
        // existence; Vision Router's capability layer will show the unknown /
        // runtime-verification advisory instead of inventing image support.
      }]
    })
    return appended.length === 0 ? group : { ...group, models: [...originalModels, ...appended] }
  })

  // A configured provider normally already has a DSH group. Keep this fallback
  // for a route whose static catalog is entirely empty: discovery can still
  // make its real models selectable without making a global Host adapter alias.
  for (const live of byProvider.values()) {
    if (!live || typeof live.provider !== 'string' || live.provider === '' || !Array.isArray(live.models)) continue
    const models = live.models.flatMap((model) => {
      if (!model || typeof model.id !== 'string' || model.id === '') return []
      return [{
        id: model.id,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
        provider: live.provider,
      }]
    })
    if (models.length > 0) groups.push({ id: live.provider, name: live.provider, models })
  }
  return replaceCatalogValue(body, { ...value, groups })
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms)
  }
  return undefined
}

export function createLiveCatalogClient({
  fetchImpl = globalThis.fetch,
  pollMs = 400,
  requestTimeoutMs = 800,
  maxPolls = 25,
} = {}) {
  const listeners = new Set()
  let disposed = false
  let pollTimer
  let polling = false
  let lastVersion
  let lastSnapshot

  const emit = () => {
    for (const listener of [...listeners]) {
      try { listener() } catch { /* isolate the settings card */ }
    }
  }

  const read = async (refresh = true) => {
    if (typeof fetchImpl !== 'function' || disposed) return undefined
    try {
      const response = await fetchImpl(`${LIVE_MODELS_PATH}?refresh=${refresh ? '1' : '0'}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: timeoutSignal(requestTimeoutMs),
      })
      if (!response?.ok) return undefined
      const body = await response.json()
      if (!body || body.ok !== true) return undefined
      lastSnapshot = body
      return body
    } catch {
      return undefined
    }
  }

  const stopPolling = () => {
    if (pollTimer !== undefined) clearTimeout(pollTimer)
    pollTimer = undefined
    polling = false
  }

  const schedulePolling = (snapshot) => {
    if (disposed || !snapshot?.refreshing || polling) return
    polling = true
    if (lastVersion === undefined) lastVersion = snapshot.version
    let remaining = Math.max(1, Math.floor(Number(maxPolls) || 25))
    const tick = async () => {
      if (disposed || remaining-- <= 0) {
        stopPolling()
        return
      }
      const next = await read(false)
      if (next && next.version !== lastVersion) {
        lastVersion = next.version
        emit()
      }
      if (!next?.refreshing) {
        stopPolling()
        return
      }
      pollTimer = setTimeout(tick, pollMs)
    }
    pollTimer = setTimeout(tick, pollMs)
  }

  return {
    async augment(body) {
      const snapshot = await read(true)
      if (snapshot) {
        if (lastVersion === undefined) lastVersion = snapshot.version
        schedulePolling(snapshot)
      }
      return mergeLiveModelsIntoCatalog(body, snapshot)
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot() {
      return lastSnapshot
    },
    dispose() {
      disposed = true
      stopPolling()
      listeners.clear()
    },
  }
}

function wrapRemote(remote, live) {
  if (!remote || (typeof remote !== 'object' && typeof remote !== 'function')) return remote
  return new Proxy(remote, {
    get(target, property) {
      if (property === '$on') {
        const on = Reflect.get(target, property, target)
        if (typeof on !== 'function') return on
        return (event, listener, ...rest) => {
          const disposeRemote = on.call(target, event, listener, ...rest)
          const disposeLive = event === 'llm/adapters-updated' ? live.subscribe(listener) : () => {}
          return () => {
            try { if (typeof disposeRemote === 'function') disposeRemote() } catch { /* best effort */ }
            try { disposeLive() } catch { /* best effort */ }
          }
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function wrapConnection(connection, live) {
  if (!connection || (typeof connection !== 'object' && typeof connection !== 'function')) return connection
  const api = connection.api
  const llm = api && api.llm
  const models = llm && llm.models
  if (typeof models !== 'function') return connection
  const wrappedLlm = new Proxy(llm, {
    get(target, property) {
      if (property === 'models') {
        return async (...args) => live.augment(await models.apply(target, args))
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const wrappedApi = new Proxy(api, {
    get(target, property) {
      if (property === 'llm') return wrappedLlm
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return new Proxy(connection, {
    get(target, property) {
      if (property === 'api') return wrappedApi
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Private client context: only Vision Router sees the augmented model catalog. */
export function contextWithLiveModelCatalog(ctx, options = {}) {
  if (!ctx || typeof ctx !== 'object') return ctx
  const live = createLiveCatalogClient(options)
  const connectionCache = new WeakMap()
  const remote = wrapRemote(ctx.remote, live)
  try {
    ctx.effect?.(() => () => live.dispose(), 'vision-router: live model catalog client')
  } catch {
    // Browser teardown will release timers even if the host lacks effect().
  }
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'remote') return remote
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (name, ...args) => {
          const value = get.call(target, name, ...args)
          if (name !== 'connection' || !value || (typeof value !== 'object' && typeof value !== 'function')) return value
          let wrapped = connectionCache.get(value)
          if (wrapped === undefined) {
            wrapped = wrapConnection(value, live)
            connectionCache.set(value, wrapped)
          }
          return wrapped
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
