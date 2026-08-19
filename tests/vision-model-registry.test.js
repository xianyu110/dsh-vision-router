import assert from 'node:assert/strict'
import test from 'node:test'

import {
  configuredVisionPairs,
  decorateVisionModelSnapshot,
  installVisionModelRegistry,
  isProviderActive,
} from '../lib/vision-model-registry.js'

function fakeContext({ visionSettings, active = [] } = {}) {
  const activeSet = new Set(active)
  const settings = {
    get(namespace) {
      return namespace === 'vision-router' ? visionSettings : undefined
    },
  }
  const effects = []
  return {
    effects,
    ctx: {
      get(name) {
        return name === 'settings' ? settings : undefined
      },
      llm: {
        registration(provider) {
          return activeSet.has(provider) ? { provider: { id: provider } } : undefined
        },
      },
      effect(factory) {
        const dispose = factory()
        effects.push(dispose)
        return dispose
      },
    },
  }
}

test('configuredVisionPairs prefers current Host settings and mirrors multi-provider fallback precedence', () => {
  const { ctx } = fakeContext({
    visionSettings: {
      providers: [
        { provider: 'zhipu', model: 'glm-4.6v', fallbacks: ['glm-flash', 'glm-flash'] },
        { provider: 'vision-http', model: 'builtin', fallbacks: [] },
        { provider: 'custom-vision', model: 'generated', fallbacks: [] },
      ],
      provider: 'legacy-provider',
      model: 'legacy-model',
      wrapperRoute: 'deepseek-vision',
      chainRoute: 'vision-chain',
    },
  })
  const fallbackConfig = {
    providers: [{ provider: 'boot-only', model: 'stale-model', fallbacks: [] }],
  }

  assert.deepEqual(configuredVisionPairs(ctx, fallbackConfig), [
    { provider: 'zhipu', model: 'glm-4.6v' },
    { provider: 'zhipu', model: 'glm-flash' },
  ])
})

test('configuredVisionPairs keeps legacy shorthand only when the multi-provider form is empty', () => {
  const { ctx } = fakeContext({
    visionSettings: {
      providers: [],
      provider: 'legacy-provider',
      model: 'legacy-model',
      fallbacks: ['legacy-fallback'],
    },
  })
  assert.deepEqual(configuredVisionPairs(ctx), [
    { provider: 'legacy-provider', model: 'legacy-model' },
    { provider: 'legacy-provider', model: 'legacy-fallback' },
  ])
})

test('provider activity is a structural registry fact, not inferred from settings', () => {
  const { ctx } = fakeContext({ active: ['zhipu'] })
  assert.equal(isProviderActive(ctx, 'zhipu'), true)
  assert.equal(isProviderActive(ctx, 'removed-provider'), false)
})

test('registry decorates live/cached sources and preserves saved ids under active providers', () => {
  const { ctx } = fakeContext({
    active: ['zhipu', 'private-gateway'],
    visionSettings: {
      providers: [
        { provider: 'zhipu', model: 'glm-flash', fallbacks: [] },
        { provider: 'private-gateway', model: 'future-vl', fallbacks: [] },
        { provider: 'removed-provider', model: 'ghost', fallbacks: [] },
      ],
    },
  })
  const snapshot = decorateVisionModelSnapshot({
    ok: true,
    version: 7,
    refreshing: false,
    providers: [
      {
        provider: 'zhipu',
        discoveredAt: 123,
        stale: false,
        models: [
          { id: 'glm-4.6v', name: 'GLM 4.6V' },
          { id: 'glm-flash' },
        ],
      },
      {
        provider: 'cached-provider',
        discoveredAt: 50,
        stale: true,
        models: [{ id: 'cached-vl' }],
      },
    ],
  }, { ctx })

  const zhipu = snapshot.providers.find((entry) => entry.provider === 'zhipu')
  assert.deepEqual(zhipu.models, [
    { id: 'glm-4.6v', name: 'GLM 4.6V [live]', visionRouterSource: 'live' },
    { id: 'glm-flash', name: 'glm-flash [live]', visionRouterSource: 'live' },
  ])

  const cached = snapshot.providers.find((entry) => entry.provider === 'cached-provider')
  assert.equal(cached.models[0].name, 'cached-vl [cached]')
  assert.equal(cached.models[0].visionRouterSource, 'cached')

  const configured = snapshot.providers.find((entry) => entry.provider === 'private-gateway')
  assert.deepEqual(configured.models, [
    { id: 'future-vl', name: 'future-vl [saved]', visionRouterSource: 'configured' },
  ])
  assert.equal(configured.configuredOnly, true)

  assert.equal(snapshot.providers.some((entry) => entry.provider === 'removed-provider'), false)
  assert.deepEqual(snapshot.registry, {
    revision: 1,
    configuredCount: 3,
    activeConfiguredCount: 2,
    sources: ['dsh-catalog', 'provider-live', 'saved-compat'],
  })
})

test('saved membership changes the browser invalidation version without changing live evidence', () => {
  const state = {
    providers: [{ provider: 'zhipu', model: 'one', fallbacks: [] }],
  }
  const { ctx } = fakeContext({ active: ['zhipu'], visionSettings: state })
  const base = {
    ok: true,
    version: 3,
    refreshing: false,
    providers: [{ provider: 'zhipu', discoveredAt: 100, stale: false, models: [] }],
  }
  const first = decorateVisionModelSnapshot(base, { ctx })
  state.providers = [{ provider: 'zhipu', model: 'two', fallbacks: [] }]
  const second = decorateVisionModelSnapshot(base, { ctx })

  assert.notEqual(first.version, second.version)
  assert.equal(first.providers[0].models[0].id, 'one')
  assert.equal(second.providers[0].models[0].id, 'two')
})

test('installVisionModelRegistry patches snapshot only and restores it on disposal', async () => {
  const { ctx, effects } = fakeContext({
    active: ['zhipu'],
    visionSettings: { providers: [{ provider: 'zhipu', model: 'saved-vl', fallbacks: [] }] },
  })
  let rawCalls = 0
  const manager = {
    async snapshot() {
      rawCalls += 1
      return { ok: true, version: 1, refreshing: false, providers: [] }
    },
    hasModel(provider, model) {
      return provider === 'zhipu' && model === 'live-only'
    },
  }
  const originalSnapshot = manager.snapshot
  installVisionModelRegistry(ctx, manager)

  const decorated = await manager.snapshot({ schedule: false })
  assert.equal(rawCalls, 1)
  assert.equal(decorated.providers[0].models[0].id, 'saved-vl')
  // Saved compatibility rows never mutate the execution evidence channel.
  assert.equal(manager.hasModel('zhipu', 'saved-vl'), false)
  assert.equal(manager.hasModel('zhipu', 'live-only'), true)

  assert.equal(typeof effects[0], 'function')
  effects[0]()
  assert.notEqual(manager.snapshot, originalSnapshot)
  const raw = await manager.snapshot()
  assert.deepEqual(raw, { ok: true, version: 1, refreshing: false, providers: [] })
})
