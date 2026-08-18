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

test('rc7 settings bridge uses the public helper, masks legacy stealth, and preserves live updates', () => {
  let hooks
  let registeredNs
  let observed
  const ctx = {
    inject() {
      throw new Error('real settings inject must not be used on rc7')
    },
  }
  const wrapped = installRc7SettingsCompatibility(
    ctx,
    { foo: 'base', stealth: true },
    {
      Config: { name: 'fake-schema' },
      namespace: 'vision-router',
      installSettingsSection(_ctx, ns, _schema, _entry, nextHooks) {
        registeredNs = ns
        hooks = nextHooks
        hooks.setSource(() => ({ foo: 'user', stealth: true }))
      },
    },
  )
  wrapped.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register('vision-router')
    assert.deepEqual(scope.get(), { foo: 'user', stealth: false })
    scope.watch((next) => {
      observed = next
    })
  })
  assert.equal(registeredNs, 'vision-router')
  hooks.setSource(() => ({ foo: 'changed', stealth: true }))
  hooks.onChange()
  assert.deepEqual(observed, { foo: 'changed', stealth: false })
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

test('manifest keeps rc6 host peers while adding the rc6+ public settings seam', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.engines.node, '^22.19.0 || >=24.0.0')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-settings'], '^0.1.0-rc.6')
  assert.equal(pkg.peerDependenciesMeta['@deepseek-ai/dsh-settings'].optional, true)
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-llm-deepseek'], '^0.1.0-rc.6')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-anonymous-user-id'], '^0.1.0-rc.6')
})

test('bundle patch no longer mutates host attachment-local limits', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(patch, /^\s*- id:\s*attachment-local/m)
})
