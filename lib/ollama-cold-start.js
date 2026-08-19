import { normalizeRuntimeVisionConfig } from './runtime-config-normalizer.js'

export const OLLAMA_WARMUP_KEEP_ALIVE = '30m'
export const OLLAMA_WARMUP_TIMEOUT_MS = 120000
export const OLLAMA_PROBE_TIMEOUT_MS = 1500

function errorText(error) {
  return error && error.message ? error.message : String(error)
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/**
 * Convert the configured OpenAI-compatible Ollama base URL into a native API
 * endpoint without losing a reverse-proxy path prefix.
 *
 *   http://127.0.0.1:11434/v1        -> /api/generate
 *   https://host.example/ollama/v1   -> /ollama/api/generate
 */
export function ollamaNativeApiUrl(baseURL, endpoint) {
  let url
  try {
    url = new URL(
      typeof baseURL === 'string' && baseURL !== ''
        ? baseURL
        : 'http://127.0.0.1:11434/v1',
    )
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  let prefix = url.pathname.replace(/\/+$/, '')
  if (prefix.endsWith('/v1')) prefix = prefix.slice(0, -3)
  else if (prefix.endsWith('/api')) prefix = prefix.slice(0, -4)
  url.pathname = `${prefix}/api/${endpoint}`.replace(/\/{2,}/g, '/')
  url.search = ''
  url.hash = ''
  return url
}

export function isAutomaticOllamaWarmupAllowed(provider) {
  const url = ollamaNativeApiUrl(provider?.baseURL, 'generate')
  return url !== undefined && isLoopbackHost(url.hostname)
}

function providerKey(provider) {
  const url = ollamaNativeApiUrl(provider?.baseURL, 'generate')
  if (!url || typeof provider?.model !== 'string' || provider.model === '') return undefined
  return `${url.href}\n${provider.model}`
}

function timeoutSignal(ms, controllers) {
  const controller = new AbortController()
  controllers.add(controller)
  const timer = setTimeout(() => controller.abort(new Error('Ollama warmup timed out')), ms)
  timer.unref?.()
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer)
      controllers.delete(controller)
    },
  }
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel?.()
  } catch {
    /* a warmup response body is diagnostics-only */
  }
}

/**
 * Host-owned Ollama cold-start manager.
 *
 * A lightweight /api/ps probe distinguishes "Ollama is not reachable" from
 * "the selected model is merely cold". Only a reachable loopback Ollama gets
 * the long preload allowance; a dead/hung local service therefore cannot add a
 * new 120s stall in front of the existing fallback chain.
 *
 * Concurrent warmups for the same route/model are coalesced. The native empty
 * /api/generate request is Ollama's documented preload mechanism and carries a
 * 30-minute keep_alive so normal image turns do not repeatedly pay the model
 * load cost after the server's default five-minute residency expires.
 */
export function createOllamaWarmupManager({
  fetchImpl = (...args) => globalThis.fetch(...args),
  logger,
  probeTimeoutMs = OLLAMA_PROBE_TIMEOUT_MS,
  warmupTimeoutMs = OLLAMA_WARMUP_TIMEOUT_MS,
  keepAlive = OLLAMA_WARMUP_KEEP_ALIVE,
} = {}) {
  const inFlight = new Map()
  const controllers = new Set()
  let disposed = false

  const run = async (provider, reason) => {
    const key = providerKey(provider)
    if (!key || disposed) return { ok: false, skipped: true, reason: 'invalid-or-disposed' }
    if (!isAutomaticOllamaWarmupAllowed(provider)) {
      return { ok: false, skipped: true, reason: 'non-loopback' }
    }

    const generateUrl = ollamaNativeApiUrl(provider.baseURL, 'generate')
    const psUrl = ollamaNativeApiUrl(provider.baseURL, 'ps')
    const startedAt = Date.now()

    const probe = timeoutSignal(probeTimeoutMs, controllers)
    try {
      const response = await fetchImpl(psUrl, { method: 'GET', signal: probe.signal })
      if (!response?.ok) {
        await cancelBody(response)
        return { ok: false, reason: `probe-http-${response?.status ?? 'unknown'}` }
      }
      await cancelBody(response)
    } catch (error) {
      return { ok: false, reason: 'probe-failed', error }
    } finally {
      probe.release()
    }

    const warm = timeoutSignal(warmupTimeoutMs, controllers)
    try {
      const response = await fetchImpl(generateUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: provider.model,
          prompt: '',
          stream: false,
          keep_alive: keepAlive,
        }),
        signal: warm.signal,
      })
      if (!response?.ok) {
        await cancelBody(response)
        return { ok: false, reason: `warmup-http-${response?.status ?? 'unknown'}` }
      }
      await cancelBody(response)
      const durationMs = Date.now() - startedAt
      if (durationMs >= 1000) {
        try {
          logger?.info?.(
            'vision-router: local Ollama warmup ready [%s] reason=%s duration=%dms keep_alive=%s',
            provider.model,
            reason || 'unspecified',
            durationMs,
            keepAlive,
          )
        } catch {
          /* diagnostics must not affect warmup */
        }
      }
      return { ok: true, durationMs, keepAlive }
    } catch (error) {
      return { ok: false, reason: 'warmup-failed', error }
    } finally {
      warm.release()
    }
  }

  const ensure = (provider, { reason = 'unspecified' } = {}) => {
    const key = providerKey(provider)
    if (!key || disposed) return Promise.resolve({ ok: false, skipped: true, reason: 'invalid-or-disposed' })
    const current = inFlight.get(key)
    if (current) return current
    const promise = run(provider, reason)
      .catch((error) => ({ ok: false, reason: 'unexpected', error }))
      .finally(() => {
        if (inFlight.get(key) === promise) inFlight.delete(key)
      })
    inFlight.set(key, promise)
    return promise
  }

  const background = (provider, options = {}) => {
    void ensure(provider, options).then((result) => {
      if (result.ok || result.skipped || disposed) return
      try {
        logger?.warn?.(
          'vision-router: local Ollama warmup skipped/failed [%s] reason=%s detail=%s',
          provider?.model || 'unknown',
          result.reason || 'unknown',
          result.error ? errorText(result.error) : 'no response',
        )
      } catch {
        /* diagnostics only */
      }
    })
  }

  const dispose = () => {
    disposed = true
    for (const controller of controllers) {
      try { controller.abort(new Error('Vision Router disposed')) } catch { /* best effort */ }
    }
    controllers.clear()
    inFlight.clear()
  }

  return { ensure, background, dispose }
}

function messagesContainImage(messages, core) {
  if (!Array.isArray(messages)) return false
  return messages.some((message) => {
    const content = message && Array.isArray(message.content) ? message.content : []
    if (typeof core?.blocksHaveImage === 'function') {
      try { return core.blocksHaveImage(content) } catch { /* fall through */ }
    }
    const stack = [...content]
    while (stack.length > 0) {
      const block = stack.pop()
      if (!block || typeof block !== 'object') continue
      if (block.type === 'image') return true
      if (Array.isArray(block.content)) stack.push(...block.content)
    }
    return false
  })
}

function configuredRows(config) {
  if (Array.isArray(config?.providers) && config.providers.length > 0) {
    return config.providers.filter((row) => row && typeof row.provider === 'string' && row.provider !== '')
  }
  if (typeof config?.provider === 'string' && config.provider !== '') {
    return [{ provider: config.provider, model: config.model }]
  }
  return []
}

/**
 * routingPairs() places all explicit non-vision-http adapters before local
 * Ollama/LM Studio, then the ordinary vision-http rows. Therefore local Ollama
 * is the first real backend only when no explicit native adapter row exists.
 */
export function localOllamaIsPrimary(config) {
  return !configuredRows(config).some((row) => row.provider !== 'vision-http')
}

/**
 * Add cold-start handling around the existing local-vision stabilizer without
 * changing core routing semantics.
 *
 * Install this guard BEFORE installLocalVisionStabilizer(). That ordering lets
 * the guard observe the stabilizer's final vision-http adapter, so successful
 * local Ollama calls can cheaply renew residency in the background.
 */
export function installOllamaColdStartGuard(ctx, config = {}, core, options = {}) {
  config = normalizeRuntimeVisionConfig(config)
  if (!ctx || typeof ctx !== 'object') return ctx

  let rawScope
  let scopeUnwatch
  const manager = options.manager || createOllamaWarmupManager({ logger: ctx.logger })
  const rawInject = typeof ctx.inject === 'function' ? ctx.inject.bind(ctx) : undefined
  const rawOn = typeof ctx.on === 'function' ? ctx.on.bind(ctx) : undefined
  const rawLlm = ctx.llm

  const actualConfig = () => {
    try {
      const value = rawScope && typeof rawScope.get === 'function' ? rawScope.get() : config
      return normalizeRuntimeVisionConfig(value && typeof value === 'object' ? value : config)
    } catch {
      return config
    }
  }

  const providerOf = () => {
    try {
      return core?.localOllamaProvidersOf?.(actualConfig())?.[0]
    } catch {
      return undefined
    }
  }

  const backgroundWarm = (reason) => {
    const provider = providerOf()
    if (provider) manager.background(provider, { reason })
  }

  const bindScope = (scope, ownerCtx) => {
    if (!scope || typeof scope !== 'object') return
    rawScope = scope
    if (typeof scopeUnwatch === 'function') {
      try { scopeUnwatch() } catch { /* best effort */ }
      scopeUnwatch = undefined
    }
    backgroundWarm('settings-ready')
    if (typeof scope.watch === 'function') {
      try {
        scopeUnwatch = scope.watch(() => backgroundWarm('settings-changed'))
      } catch {
        scopeUnwatch = undefined
      }
    }
    try {
      ownerCtx?.effect?.(
        () => () => {
          if (rawScope === scope) rawScope = undefined
          if (typeof scopeUnwatch === 'function') {
            try { scopeUnwatch() } catch { /* best effort */ }
            scopeUnwatch = undefined
          }
        },
        'vision-router: Ollama warmup settings lifecycle',
      )
    } catch {
      /* lifecycle registration is best effort */
    }
  }

  const wrapSettings = (settings, ownerCtx) =>
    new Proxy(settings, {
      get(target, property) {
        if (property !== 'register') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return (namespace, schema, registerOptions = {}) => {
          const scope = target.register(namespace, schema, registerOptions)
          if (namespace === 'vision-router') bindScope(scope, ownerCtx)
          return scope
        }
      },
    })

  const inject = rawInject
    ? (deps, callback) =>
        rawInject(deps, (childCtx) => {
          if (!Array.isArray(deps) || !deps.includes('settings') || !childCtx?.settings) {
            return callback(childCtx)
          }
          const wrapped = new Proxy(childCtx, {
            get(target, property) {
              if (property === 'settings') return wrapSettings(target.settings, childCtx)
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
          return callback(wrapped)
        })
    : undefined

  const on = rawOn
    ? (event, handler) => {
        if (event !== 'agent/pre-step') return rawOn(event, handler)
        return rawOn(event, async (...args) => {
          const current = actualConfig()
          const provider = providerOf()
          const payload = args[0]
          if (provider && messagesContainImage(payload?.messages, core)) {
            if (localOllamaIsPrimary(current)) {
              // This wait happens before the core pre-step handler starts the
              // visual tool/task budget. A 5.6GB cold model can therefore load
              // once instead of being misclassified as a 45s inference timeout.
              await manager.ensure(provider, { reason: 'image-pre-step-primary' })
            } else {
              // A user-selected native provider runs first. Warm Ollama in the
              // background so it is ready if that provider falls through,
              // without delaying the healthy primary backend.
              manager.background(provider, { reason: 'image-pre-step-fallback' })
            }
          }
          return handler(...args)
        })
      }
    : undefined

  const wrapVisionHttpAdapter = (adapter) =>
    new Proxy(adapter, {
      get(target, property) {
        if (property !== 'stream') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async function* stream(options) {
          const isLocalOllama =
            typeof options?.model === 'string' && options.model.startsWith('local-ollama/')
          let succeeded = false
          for await (const chunk of target.stream(options)) {
            if (
              isLocalOllama &&
              chunk?.type === 'finish' &&
              chunk?.reason?.kind === 'stop'
            ) {
              succeeded = true
            }
            yield chunk
          }
          if (succeeded) backgroundWarm('post-success-renewal')
        }
      },
    })

  const llm = rawLlm && typeof rawLlm === 'object'
    ? new Proxy(rawLlm, {
        get(target, property) {
          if (property !== 'registerAdapter') {
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return (providers, adapter) => {
            const list = Array.isArray(providers) ? providers : []
            const wrapped = list.includes('vision-http') ? wrapVisionHttpAdapter(adapter) : adapter
            return target.registerAdapter(providers, wrapped)
          }
        },
      })
    : rawLlm

  try {
    ctx.effect?.(
      () => () => {
        rawScope = undefined
        if (typeof scopeUnwatch === 'function') {
          try { scopeUnwatch() } catch { /* best effort */ }
          scopeUnwatch = undefined
        }
        manager.dispose()
      },
      'vision-router: Ollama cold-start guard',
    )
  } catch {
    /* cleanup registration is best effort */
  }

  // Composition-level localOllama may already be enabled before Settings
  // mounts. Preload it immediately in the background; settings-ready will
  // coalesce with the same route/model if it arrives while this is still live.
  backgroundWarm('plugin-start')

  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'inject' && inject) return inject
      if (property === 'on' && on) return on
      if (property === 'llm') return llm
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
