import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  attachmentContextForContract,
  installRc7SettingsCompatibility,
  isRc7ContractRuntime,
  protectRc7ProviderOwnership,
} from '../lib/dsh-contract-compat.js'

test('contract detection distinguishes rc6 from rc7 by the configurable-provider directory seam', () => {
  assert.equal(isRc7ContractRuntime({ llm: {} }), false)
  assert.equal(isRc7ContractRuntime({ llm: { registerConfigurableProviders() {} } }), true)
})

test('rc7 provider ownership blocks only synthetic official routes', () => {
  const registered = []
  const ctx = {
    llm: {
      registerConfigurableProviders() {},
      registerAdapter(routes, adapter) {
        registered.push({ routes, adapter })
        return () => {}
      },
    },
  }
  const wrapped = protectRc7ProviderOwnership(ctx)
  const adapter = {}
  wrapped.llm.registerAdapter(['vision-http'], adapter)
  assert.deepEqual(registered, [{ routes: ['vision-http'], adapter }])
  assert.throws(
    () => wrapped.llm.registerAdapter(['deepseek-official-native'], {}),
    (error) => error?.code === 'DSH_RC7_PROVIDER_OWNERSHIP',
  )
  assert.throws(
    () => wrapped.llm.registerAdapter(['deepseek-official'], {}),
    (error) => error?.code === 'DSH_RC7_PROVIDER_OWNERSHIP',
  )
})

test('rc7 settings bridge uses the common public SettingsProvider seam and masks legacy stealth', () => {
  let value = { foo: 'user', stealth: true }
  let serviceWatcher
  let observed
  let cleanup
  const scope = {
    get() {
      return value
    },
    watch(callback) {
      serviceWatcher = callback
      return () => {
        serviceWatcher = undefined
      }
    },
  }
  const ctx = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['settings'])
      callback({
        settings: {
          register(namespace, _Config, options) {
            assert.equal(namespace, 'vision-router')
            assert.deepEqual(options.base, { foo: 'base', stealth: true })
            return scope
          },
        },
        effect(factory) {
          cleanup = factory()
        },
      })
    },
  }
  const wrapped = installRc7SettingsCompatibility(ctx, { foo: 'base', stealth: true }, {
    Config: { name: 'fake-schema' },
    namespace: 'vision-router',
  })
  wrapped.inject(['settings'], (sctx) => {
    const compatScope = sctx.settings.register('vision-router')
    assert.deepEqual(compatScope.get(), { foo: 'user', stealth: false })
    compatScope.watch((next) => {
      observed = next
    })
  })
  value = { foo: 'changed', stealth: true }
  serviceWatcher()
  assert.deepEqual(observed, { foo: 'changed', stealth: false })
  cleanup()
  assert.equal(serviceWatcher, undefined)
})

test('attachment compatibility remains rc6-only and rc7 keeps host-owned refs', () => {
  const rc6 = { llm: {} }
  const rc7 = { llm: { registerConfigurableProviders() {} } }
  let installs = 0
  const installAndroidAttachmentCompat = (ctx) => {
    installs += 1
    return { ...ctx, compat: true }
  }
  const wrappedRc6 = attachmentContextForContract(rc6, undefined, { installAndroidAttachmentCompat })
  const wrappedRc7 = attachmentContextForContract(rc7, undefined, { installAndroidAttachmentCompat })
  assert.equal(wrappedRc6.compat, true)
  assert.equal(wrappedRc7, rc7)
  assert.equal(installs, 1)
})

test('manifest keeps the rc6 host peers and does not add an rc7-only package edge', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.engines.node, '^22.19.0 || >=24.0.0')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-llm-deepseek'], '^0.1.0-rc.6')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-anonymous-user-id'], '^0.1.0-rc.6')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-settings'], undefined)
})

test('bundle patch no longer mutates host attachment-local limits', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(patch, /^\s*- id:\s*attachment-local/m)
})
