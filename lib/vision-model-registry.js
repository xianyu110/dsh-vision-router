import { createHash } from 'node:crypto'

/**
 * Vision Router's settings picker has three independent sources of model ids:
 *
 * 1. DSH's adapter catalog (`llm.models`) — authoritative when present.
 * 2. The provider's live `/models` listing — endpoint evidence, kept private to
 *    Vision Router by the client prelude.
 * 3. A model already saved in Vision Router settings — compatibility evidence
 *    only. A saved id must remain visible/editable even when a provider does
 *    not expose a list endpoint, but it must NOT be promoted to live evidence
 *    for the UNKNOWN_MODEL compatibility bridge.
 *
 * PR #225 already owns source (2). This module decorates that private snapshot
 * with source labels and source (3), without changing DSH's global catalog or
 * `liveDiscovery.hasModel()` semantics.
 */

export const VISION_MODEL_REGISTRY_REVISION = 1

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function configFromSettings(ctx) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function excludedProvider(provider, config = {}) {
  if (provider === 'vision-http') return true
  const wrapperRoute = nonEmpty(config.wrapperRoute) ?? 'deepseek-vision'
  const chainRoute = nonEmpty(config.chainRoute) ?? 'vision-chain'
  if (provider === wrapperRoute || provider === chainRoute) return true
  return provider.endsWith('-vision')
}

function addPair(target, seen, providerValue, modelValue, config) {
  const provider = nonEmpty(providerValue)
  const model = nonEmpty(modelValue)
  if (provider === undefined || model === undefined || excludedProvider(provider, config)) return
  const key = `${provider}\u0000${model}`
  if (seen.has(key)) return
  seen.add(key)
  target.push({ provider, model })
}

/**
 * Current saved vision backends, normalized to exact provider/model pairs.
 * Host settings win over the composition-time config: combining both would
 * resurrect a model the user intentionally removed after startup.
 */
export function configuredVisionPairs(ctx, fallbackConfig = {}) {
  const current = configFromSettings(ctx) ?? fallbackConfig
  const pairs = []
  const seen = new Set()
  const rows = Array.isArray(current?.providers) ? current.providers : []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    addPair(pairs, seen, row.provider, row.model, current)
    for (const fallback of Array.isArray(row.fallbacks) ? row.fallbacks : []) {
      addPair(pairs, seen, row.provider, fallback, current)
    }
  }

  // Legacy single-provider shorthand is still part of the public schema. Use
  // it only when the multi-provider form has no usable rows, mirroring core's
  // providersOf() precedence rather than creating duplicate/ghost entries.
  if (pairs.length === 0) {
    addPair(pairs, seen, current?.provider, current?.model, current)
    for (const fallback of Array.isArray(current?.fallbacks) ? current.fallbacks : []) {
      addPair(pairs, seen, current?.provider, fallback, current)
    }
  }
  return pairs
}

export function isProviderActive(ctx, provider) {
  if (nonEmpty(provider) === undefined) return false
  try {
    return ctx?.llm?.registration?.(provider) !== undefined
  } catch {
    return false
  }
}

function modelId(model) {
  return nonEmpty(model?.id)
}

function sourceName(model, source) {
  const id = modelId(model)
  if (id === undefined) return undefined
  const base = nonEmpty(model?.name) ?? id
  return `${base} [${source}]`
}

function normalizedLiveEntry(entry) {
  const provider = nonEmpty(entry?.provider)
  if (provider === undefined) return undefined
  const stale = entry?.stale === true
  const source = stale ? 'cached' : 'live'
  const seen = new Set()
  const models = []
  for (const model of Array.isArray(entry?.models) ? entry.models : []) {
    const id = modelId(model)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    models.push({
      ...model,
      id,
      name: sourceName(model, source),
      visionRouterSource: source,
    })
  }
  return {
    ...entry,
    provider,
    models,
    stale,
    visionRouterSource: source,
  }
}

function registryFingerprint(baseVersion, configured, activeConfigured) {
  return createHash('sha256')
    .update(JSON.stringify({
      revision: VISION_MODEL_REGISTRY_REVISION,
      baseVersion: baseVersion ?? 0,
      configured,
      activeConfigured,
    }))
    .digest('hex')
    .slice(0, 12)
}

/**
 * Decorate one raw live-discovery snapshot for the browser-only registry.
 *
 * Saved-only models are injected only when the provider route is actually
 * registered. This keeps a stale/deleted provider from looking callable while
 * preserving dynamic/private adapters that intentionally do not enumerate all
 * accepted ids. Saved-only entries remain distinct from live evidence:
 * `liveDiscovery.hasModel()` is untouched and therefore cannot authorize the
 * direct UNKNOWN_MODEL bridge from this compatibility source alone.
 */
export function decorateVisionModelSnapshot(snapshot, {
  ctx,
  config = {},
} = {}) {
  if (!snapshot || snapshot.ok !== true) return snapshot

  const ordered = []
  const byProvider = new Map()
  for (const raw of Array.isArray(snapshot.providers) ? snapshot.providers : []) {
    const entry = normalizedLiveEntry(raw)
    if (!entry || byProvider.has(entry.provider)) continue
    byProvider.set(entry.provider, entry)
    ordered.push(entry)
  }

  const configured = configuredVisionPairs(ctx, config)
  const activeConfigured = []
  for (const pair of configured) {
    if (!isProviderActive(ctx, pair.provider)) continue
    activeConfigured.push(pair)
    let entry = byProvider.get(pair.provider)
    if (!entry) {
      entry = {
        provider: pair.provider,
        models: [],
        discoveredAt: 0,
        stale: true,
        configuredOnly: true,
        visionRouterSource: 'configured',
      }
      byProvider.set(pair.provider, entry)
      ordered.push(entry)
    }
    if (entry.models.some((model) => modelId(model) === pair.model)) continue
    entry.models.push({
      id: pair.model,
      name: `${pair.model} [saved]`,
      visionRouterSource: 'configured',
    })
  }

  const fingerprint = registryFingerprint(snapshot.version, configured, activeConfigured)
  return {
    ...snapshot,
    // The client prelude already uses `version` as its invalidation key. Include
    // saved-settings membership so changing the vision chain refreshes the
    // private picker even when the provider's live listing itself did not move.
    version: `${String(snapshot.version ?? 0)}:vr${VISION_MODEL_REGISTRY_REVISION}:${fingerprint}`,
    providers: ordered,
    registry: {
      revision: VISION_MODEL_REGISTRY_REVISION,
      configuredCount: configured.length,
      activeConfiguredCount: activeConfigured.length,
      sources: ['dsh-catalog', 'provider-live', 'saved-compat'],
    },
  }
}

/**
 * Patch only the manager's browser snapshot. The raw discovery store and
 * `hasModel()` remain untouched, so execution policy still requires genuine
 * endpoint evidence before bypassing a local UNKNOWN_MODEL admission failure.
 */
export function installVisionModelRegistry(ctx, liveDiscovery, options = {}) {
  if (!liveDiscovery || typeof liveDiscovery.snapshot !== 'function') return liveDiscovery
  if (liveDiscovery.snapshot.__visionRouterRegistry === true) return liveDiscovery

  const originalSnapshot = liveDiscovery.snapshot.bind(liveDiscovery)
  const wrappedSnapshot = async (request) => decorateVisionModelSnapshot(
    await originalSnapshot(request),
    { ctx, config: options.config ?? {} },
  )
  Object.defineProperty(wrappedSnapshot, '__visionRouterRegistry', { value: true })
  liveDiscovery.snapshot = wrappedSnapshot

  try {
    ctx?.effect?.(() => () => {
      if (liveDiscovery.snapshot === wrappedSnapshot) liveDiscovery.snapshot = originalSnapshot
    }, 'vision-router: private model registry sources')
  } catch {
    // The manager itself is disposed with the plugin; restoration is hygiene.
  }
  return liveDiscovery
}
