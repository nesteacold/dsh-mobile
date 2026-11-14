// A model change must never take the gateway down.
//
// WHY this file exists (measured on the beastcore remote-model-diag Host, DSH
// 0.2.2-rc.3): selecting a model — local or remote — is
// `session-controller.selectModel` → `agentDefaultModel.saveSelection` →
// `configEditor.edit`, which writes the profile patch and reconciles the
// `agentDefaultModel` row. Cordis then reloads EVERY plugin whose `inject` names
// that service: `fiber._refresh()` builds the epoch from `fiber._store` for each
// injected NAME, and `{ required: false }` only drops the activation gate (the
// name stays in `fiber.inject`, so the fiber is still reloaded). The gateway used
// to inject it, so one model change logged `plugin stopped, all sockets closed`
// → `startup`: every paired device was disconnected.
//
// This pins the fix at three levels:
//   1 the DECLARATION: `agentDefaultModel` is not in the hard inject list;
//   2 a fake Cordis implementing the measured epoch rule, driving the REAL
//     plugin: a config change AND a provider replacement leave the gateway
//     module untouched (one apply, no dispose);
//   3 the installed @deepseek-ai/cordis (opt-in via DSH_INSTALL_ROOT, the same
//     convention as the gateway's *-official suites and plugins/devices'
//     upload-route.test.mjs), which MEASURES the rule instead of modelling it,
//     including the control fiber that proves the rule still bites.
//
// It also pins the feature: with the service present both ops keep their exact
// behaviour (`gateway.test.mjs` covers the frames end to end); with it absent
// they answer one stable, visible code and no other op is affected.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import plugin, { handleQuery } from '../lib/index.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'

// ---------------------------------------------------------------------------
// Level 1 — the declaration
// ---------------------------------------------------------------------------

test('P-1 agentDefaultModel is not in the hard inject list; the fail-closed set stays', () => {
  assert.ok(Array.isArray(plugin.inject), 'the gateway declares its hard dependencies as an array')
  assert.equal(plugin.inject.includes('agentDefaultModel'), false,
    `a model change must not reload the gateway, so it cannot inject agentDefaultModel: ${JSON.stringify(plugin.inject)}`)
  for (const name of ['typertGateway', 'connection', 'remoteAccess']) {
    assert.ok(plugin.inject.includes(name), `${name} is still a hard dependency`)
  }
  // The web-server row may carry either spelling (spec 031 renames it as the web
  // ingress becomes its own listener), so accept both rather than pin a name
  // another task owns: what this suite pins is the ABSENCE of agentDefaultModel.
  assert.ok(plugin.inject.some((name) => name === 'webServer' || name === 'webIngressServer'),
    `the host web-server row is still a hard dependency: ${JSON.stringify(plugin.inject)}`)
})

// ---------------------------------------------------------------------------
// Shared fixtures: a minimal Host stand-in for the real apply()
// ---------------------------------------------------------------------------

function webServerStub() {
  return { port: 0, register() { return () => {} }, registerUpgrade() { return () => {} } }
}

function typertGatewayStub() {
  return {
    async invoke() { throw new Error('unexpected Remote invocation') },
    async stream(request) {
      return (async function* () {
        if (request.namespace === 'workspace' && request.method === 'follow') {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
          while (!request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
        }
        if (request.namespace === 'session' && request.method === 'control') {
          yield { type: 'baseline', value: { projections: {} } }
          while (!request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
        }
      })()
    },
  }
}

/**
 * A live gateway config that binds no listener: the switch is on and the mode is
 * persistent, but `lanEnabled: false` means nothing listens, so this fixture never
 * touches a port or the real `~/.dsh` registry. (The same shape as
 * test/session-authoring-defaults.test.mjs's route fixture.)
 */
function gatewayConfig(directory) {
  return {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    gatewayName: `default-model-optional-${path.basename(directory)}`,
    pairingTtlMs: 60_000,
    lanEnabled: false,
    // Both files stay inside this fixture's temp directory: apply() must never
    // fall back to the real ~/.dsh device registry.
    deviceFile: path.join(directory, 'devices.json'),
    tlsCertificateDir: path.join(directory, 'tls'),
  }
}

/**
 * The gateway row, with its REAL declaration; counts apply() and the disposer.
 *
 * `disposes` is vacuous on its own: the gateway returns no disposer at all. It
 * registers its teardown as a `ctx.effect` callback (lib/index.mjs ~6016, the one
 * that logs `plugin stopped, all sockets closed`), so "it was never torn down" is
 * measured by the fake's `teardowns` counter, which every executed effect disposer
 * bumps. P-4b runs this row's disposer by hand to show the counter moves; P-2/P-3
 * read it as zero; P-4c moves it through a provider replacement.
 */
function gatewayRow(config) {
  const applies = []
  const disposes = []
  return {
    applies, disposes,
    row: {
      name: 'mobile-gateway',
      Config: plugin.Config,
      inject: plugin.inject,
      async apply(ctx) {
        applies.push(ctx)
        // The ONE `ctx.effect` this row registered, so its disposer can be run by
        // hand after an assertion: a control that proves idle teardowns are counted.
        if (!ctx.__ownerEffects) Object.defineProperty(ctx, '__ownerEffects', { value: [] })
        const registerEffect = ctx.effect
        ctx.effect = (factory) => {
          const dispose = registerEffect(factory)
          ctx.__ownerEffects.push(dispose)
          return dispose
        }
        const dispose = await plugin.apply(ctx, config)
        if (typeof dispose === 'function') disposes.push(dispose)
        return dispose
      },
    },
  }
}

function tempDir(t, label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${label}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

// ---------------------------------------------------------------------------
// Level 2 — a fake Cordis with exactly the measured epoch rule
// ---------------------------------------------------------------------------

/**
 * Service store + reload rule of the installed Cordis (`lib/index.js`:
 * `_refresh` at 611, `notify` at 1422). `fiber.inject` is matched by NAME only;
 * a provider that is withdrawn and re-provided, or whose implementation
 * identity is replaced, changes the epoch, so the fiber unloads and re-applies.
 * A value set in place keeps the uid, so the conservative branch is reload-free
 * too — either branch must leave the gateway untouched.
 */
function createFakeCordis() {
  const store = new Map() // name -> { uid, value, provider }
  const fibers = []
  // Incremented for every `ctx.effect` disposer the fake EXECUTES. The gateway
  // returns no disposer; its ONE `ctx.effect` callback (lib/index.mjs ~6016) is
  // what logs `plugin stopped, all sockets closed`, so this is the only measurable
  // form of "the gateway was torn down". `listeners` counts the `ctx.on` disposers
  // its teardown body calls in turn (12 of them) and is reported, not asserted.
  const teardowns = { effect: 0, listeners: 0 }
  let implCounter = 0
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 2)) }

  const epochOf = (fiber) => {
    let epoch = ''
    for (const name of fiber.inject) {
      const impl = store.get(name)
      if (!impl) return 'inactive'
      epoch += ':' + impl.uid
    }
    return epoch
  }

  const reload = async (fiber) => {
    const epoch = epochOf(fiber)
    if (epoch === fiber.epoch) return
    fiber.epoch = epoch
    if (fiber.active) {
      fiber.active = false
      if (typeof fiber.dispose === 'function') await fiber.dispose()
      // Cordis owns every `ctx.effect` disposer and runs them on unload. The fake
      // must too: apply() opens background follow streams through `ctx.effect`,
      // and leaving them open keeps the test process alive after the assertions.
      for (const dispose of fiber.effects.splice(0)) {
        teardowns.effect += 1
        try { await dispose() } catch { /* a teardown error is not this test's subject */ }
      }
    }
    if (epoch === 'inactive') return
    fiber.active = true
    fiber.effects.length = 0
    // Cordis populates only INJECTED names on the context; the fake reproduces
    // that, so a lazily-read service cannot be seen through a property by accident.
    for (const name of fiber.inject) {
      Object.defineProperty(fiber.ctx, name, { configurable: true, enumerable: true,
        get: () => { const impl = store.get(name); return impl ? impl.value : undefined } })
    }
    const effect = await fiber.apply(fiber.ctx, fiber.config)
    fiber.dispose = typeof effect === 'function' ? effect : undefined
  }

  const notify = async (name) => {
    for (const fiber of fibers) {
      if (!fiber.inject.includes(name)) continue
      await reload(fiber)
    }
  }

  return {
    settle,
    /** `{ effect, listeners }` — how many effect / listener disposers the fake has executed. */
    teardowns,
    /** Unload every row, the way Cordis does when the plugin's parent goes away. */
    async disposeAll() {
      for (const fiber of fibers) {
        fiber.epoch = 'inactive'
        if (!fiber.active) continue
        fiber.active = false
        if (typeof fiber.dispose === 'function') await fiber.dispose()
        for (const dispose of fiber.effects.splice(0)) {
          teardowns.effect += 1
          try { await dispose() } catch { /* teardown only */ }
        }
      }
    },
    async plugin(row, config) {
      const fiber = { ctx: null, config, inject: row.inject ?? [], epoch: null, active: false,
        dispose: undefined, apply: row.apply, effects: [] }
      const ctx = {
        // A `ctx.on` disposer is called by the gateway's own effect teardown; counted
        // separately so the effect count stays "did the plugin unload", not "how many
        // listeners it held".
        on() { const dispose = () => { teardowns.listeners += 1 }; return dispose },
        effect(factory) {
          const dispose = factory()
          if (typeof dispose === 'function') fiber.effects.push(dispose)
          return () => { if (typeof dispose === 'function') { teardowns.effect += 1; dispose() } }
        },
        // The lazy, non-injecting reader. `strict` is Cordis's own: an inactive
        // provider's value is not returned.
        get(name, strict = true) {
          const impl = store.get(name)
          if (!impl) return undefined
          if (strict && impl.provider !== null && impl.provider.active === false) return undefined
          return impl.value
        },
      }
      fiber.ctx = ctx
      fibers.push(fiber)
      await reload(fiber)
      return fiber
    },
    provide(name, value) {
      const provider = { active: true }
      const impl = { uid: ++implCounter, value, provider }
      store.set(name, impl)
      // `ctx.provide()` notifies dependents when its owning fiber is active
      // (`reflect.provide`, lib/index.js:1403), so a waiting row wakes up here.
      void notify(name)
      return {
        impl,
        /** A config write in place: the implementation keeps its identity. */
        async setValue(next) {
          impl.value = next
          await notify(name)
        },
        /** A plugin-row restart: the name is re-registered with a NEW identity. */
        async replace(next) {
          store.set(name, { uid: ++implCounter, value: next, provider })
          await notify(name)
        },
        async withdraw() {
          store.delete(name)
          provider.active = false
          await notify(name)
        },
      }
    },
  }
}

async function startGateway(cordis, t) {
  const directory = tempDir(t, 'default-model')
  t.after(() => cordis.disposeAll())
  const web = webServerStub()
  // Both spellings of the host web-server row are provided, so this fixture
  // survives spec 031 renaming the injected name without changing the subject.
  cordis.provide('webServer', web)
  cordis.provide('webIngressServer', web)
  cordis.provide('connection', createTestConnection())
  cordis.provide('remoteAccess', createTestRemoteAccess())
  cordis.provide('typertGateway', typertGatewayStub())
  const fixture = gatewayRow(gatewayConfig(directory))
  await cordis.plugin(fixture.row)
  await cordis.settle()
  assert.equal(fixture.applies.length, 1, 'the gateway applied once, with the four hard services')
  return { fixture, directory }
}

/** The one call `apply()`'s own late resolver makes (lib/index.mjs `resolveAgentDefaultModel`). */
const lateModel = (ctx) => ctx.get('agentDefaultModel', false) ?? ctx.get('agentDefaultModel')

test('P-2 a config change of the agentDefaultModel provider does not reload the gateway', async (t) => {
  const cordis = createFakeCordis()
  const { fixture } = await startGateway(cordis, t)
  const model = cordis.provide('agentDefaultModel', {
    currentSelection() { return { provider: 'deepseek', model: 'deepseek-chat' } },
    async saveSelection() {},
  })
  await cordis.settle()
  assert.equal(fixture.applies.length, 1, 'the provider appearing is not a reload')
  await model.setValue({
    currentSelection() { return { provider: 'deepseek', model: 'deepseek-reasoner' } },
    async saveSelection() {},
  })
  await cordis.settle()
  assert.equal(fixture.applies.length, 1, 'a config change did not re-apply the gateway')
  assert.equal(fixture.disposes.length, 0, 'no dispose ran: no socket could have closed')
  // The gateway returns no disposer, so the real evidence is the effect teardown
  // (lib/index.mjs ~6016) still NOT having run. Read before `t.after` cleanup.
  assert.equal(cordis.teardowns.effect, 0, 'the gateway effect teardown ran: the plugin unloaded')
  assert.equal(cordis.teardowns.listeners, 0, 'and none of its listener disposers ran either')
  // The late read sees the NEW selection with no reload — the point of reading it per call.
  const frame = await handleQuery(null, null, lateModel(fixture.applies[0]), { type: 'default-model' })
  assert.deepEqual(frame, { kind: 'default-model', selection: { provider: 'deepseek', model: 'deepseek-reasoner' } })
})

test('P-3 replacing the agentDefaultModel provider does not reload the gateway', async (t) => {
  const cordis = createFakeCordis()
  const { fixture } = await startGateway(cordis, t)
  const model = cordis.provide('agentDefaultModel', {
    currentSelection() { return { provider: 'r9-fallback', model: 'ds41-cmc-ccsonnet' } },
    async saveSelection() {},
  })
  await cordis.settle()
  await model.replace({
    currentSelection() { return { provider: 'r9-commandcode', model: 'cc/claude-opus-5-5' } },
    async saveSelection() {},
  })
  await cordis.settle()
  assert.equal(fixture.applies.length, 1, 'a provider replacement did not re-apply the gateway')
  assert.equal(fixture.disposes.length, 0, 'no dispose ran: no socket could have closed')
  assert.equal(cordis.teardowns.effect, 0, 'the gateway effect teardown ran: the plugin unloaded')
  assert.equal(cordis.teardowns.listeners, 0, 'and none of its listener disposers ran either')
  const frame = await handleQuery(null, null, lateModel(fixture.applies[0]), { type: 'default-model' })
  assert.deepEqual(frame.selection, { provider: 'r9-commandcode', model: 'cc/claude-opus-5-5' })
})

test('P-4 the fake is faithful: a hard-injected provider still reloads the row', async (t) => {
  // So P-2/P-3 cannot pass vacuously.
  const cordis = createFakeCordis()
  const applies = []
  await cordis.plugin({ name: 'hard-fixture', inject: ['remoteAccess'], apply() { applies.push(1) } })
  await cordis.settle()
  assert.deepEqual(applies, [], 'it waits for the hard service before applying')
  const provider = cordis.provide('remoteAccess', createTestRemoteAccess())
  await cordis.settle()
  assert.deepEqual(applies, [1], 'the service appearing, then a single apply')
  await provider.replace(createTestRemoteAccess())
  await cordis.settle()
  assert.deepEqual(applies, [1, 1], 'a replaced hard dependency re-applies the fiber')
})

test('P-4b the teardown counter is live: the gateway\'s own effect disposer is counted when run', async (t) => {
  // The other half of P-4: P-2/P-3 assert a count of ZERO, so the counter must be
  // shown to move. Run the gateway's real `ctx.effect` disposer (lib/index.mjs
  // ~6016 — the teardown that closes every socket) by hand, after the assertions
  // it would falsify and before fixture cleanup.
  const cordis = createFakeCordis()
  const { fixture } = await startGateway(cordis, t)
  assert.deepEqual(cordis.teardowns, { effect: 0, listeners: 0 }, 'nothing torn down while the gateway is live')
  const effects = fixture.applies[0].__ownerEffects
  assert.equal(effects.length, 1, 'the gateway registered exactly one effect')
  await effects[0]()
  // The gateway's teardown body calls its own `ctx.on` disposers (lib/index.mjs
  // 6062-6073), which is why the listener count follows the effect count.
  assert.equal(cordis.teardowns.effect, 1, 'running the gateway teardown is counted')
  assert.ok(cordis.teardowns.listeners > 0, 'and it drained its listeners')
})

test('P-4c a hard-dependency replacement DOES move the teardown counter (the P-2/P-3 zero is not vacuous)', async (t) => {
  // The same fake, the same counter, read the same way as P-2/P-3 — but against a
  // row that keeps injecting one of the warning's four hard services. It reloads,
  // which runs the effect teardown P-2/P-3 assert stays at zero. The row injects
  // exactly the service this test replaces, so the 1 → 2 apply count is unambiguous.
  const cordis = createFakeCordis()
  const applies = []
  await cordis.plugin({
    name: 'hard-effect-fixture',
    inject: ['connection'],
    async apply(ctx) {
      applies.push(1)
      ctx.effect(() => () => {})
    },
  })
  await cordis.settle()
  assert.equal(applies.length, 0, 'it waits for the hard service before applying')
  const provider = cordis.provide('connection', createTestConnection())
  await cordis.settle()
  assert.equal(applies.length, 1, 'the service appearing, then a single apply')
  assert.deepEqual(cordis.teardowns, { effect: 0, listeners: 0 }, 'live before the replacement')
  await provider.replace(createTestConnection())
  await cordis.settle()
  assert.equal(applies.length, 2, 'a replaced hard dependency re-applied the row')
  assert.equal(cordis.teardowns.effect, 1, 'its effect teardown ran: the counter P-2/P-3 read as 0 moves')
})

// ---------------------------------------------------------------------------
// The feature when the service exists
// ---------------------------------------------------------------------------

test('P-5 with the service present both ops keep their exact behaviour', async () => {
  const saved = []
  const model = {
    currentSelection() { return { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } },
    async saveSelection(next) { saved.push(next) },
  }
  assert.deepEqual(await handleQuery(null, null, model, { type: 'default-model' }),
    { kind: 'default-model', selection: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } })
  assert.deepEqual(await handleQuery(null, null, model, { type: 'save-default-model', provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'medium' }),
    { kind: 'save-default-model', saved: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'medium' } })
  assert.deepEqual(saved, [{ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'medium' }])
})

// ---------------------------------------------------------------------------
// The degrade path — a Host without the service
// ---------------------------------------------------------------------------

test('P-6 without the service the two ops answer one stable code, and the gateway still runs', async (t) => {
  for (const msg of [{ type: 'default-model' }, { type: 'save-default-model', provider: 'deepseek', model: 'x' }]) {
    const frame = await handleQuery(null, null, undefined, msg)
    assert.equal(frame.kind, 'error')
    assert.equal(frame.code, 'default-model-unavailable', 'one stable code, so the app can name the cause')
    assert.equal(frame.requestType, msg.type, 'the frame names the request, so the app can match it')
    assert.match(frame.message, /agentDefaultModel is not loaded/, 'the reason is visible, never a TypeError')
  }
  // …and a LIVE gateway on a Host that loads no `agentDefaultModel` at all:
  // it ACTIVATES (the service is no longer a gate — the other half of removing it
  // from `inject`), and the two ops answer the same frame through its own late
  // resolver, with no throw during apply or dispatch.
  const cordis = createFakeCordis()
  t.after(() => cordis.disposeAll())
  const { fixture } = await startGateway(cordis, t) // four hard services only
  const ctx = fixture.applies[0]
  assert.equal(lateModel(ctx), undefined, 'the service really is absent from this Host')
  const frame = await handleQuery(null, null, lateModel(ctx), { type: 'default-model' })
  assert.equal(frame.code, 'default-model-unavailable')
  // The rest of the surface is unaffected: the same live ctx serves a read op.
  const api = { workspace: { list: async () => ({ items: [] }) } }
  assert.equal((await handleQuery(api, null, lateModel(ctx), { type: 'workspaces' })).kind, 'workspaces')
})

test('P-7 every op that does not touch the default model is unaffected by its absence', async () => {
  const api = { workspace: { list: async () => ({ items: [] }) } }
  const frame = await handleQuery(api, null, undefined, { type: 'workspaces' })
  assert.equal(frame.kind, 'workspaces', 'a read op still answers normally')
})

test('P-7b a malformed request is still bad-request, even with the service absent', async () => {
  // A request-level error is about the request, not the Host: it keeps the code it
  // would have had with the service present, so an app cannot mistake a client bug
  // for a missing feature (the same validate-then-act order every branch uses).
  const frame = await handleQuery(null, null, undefined, { type: 'save-default-model', provider: 'deepseek' })
  assert.equal(frame.code, 'bad-request')
  assert.equal(frame.requestType, 'save-default-model')
  const present = await handleQuery(null, null, { async saveSelection() {} }, { type: 'save-default-model', provider: 'deepseek' })
  assert.deepEqual(frame, present, 'the answer is identical to the one a Host WITH the service gives')
})

// ---------------------------------------------------------------------------
// Level 3 — the installed Cordis, measured (opt-in)
// ---------------------------------------------------------------------------

test('P-8 real cordis: neither a provider config update nor a replacement reloads the gateway row', async (t) => {
  // The fake above MODELS the rule; this MEASURES it against the installed
  // @deepseek-ai/cordis, so a change in how rc.x folds a provider's identity into
  // a fiber's epoch fails here instead of silently reintroducing the disconnect.
  // Opt-in like the gateway's *-official tests and plugins/devices'
  // upload-route.test.mjs: DSH_INSTALL_ROOT holds the installed DSH package root,
  // and importing cordis is read-only.
  const installRoot = process.env.DSH_INSTALL_ROOT
  if (!installRoot) {
    t.skip('DSH_INSTALL_ROOT is not set: no installed @deepseek-ai/cordis to measure against')
    return
  }
  const r = createRequire(path.join(installRoot, 'package.json'))
  const { Context, Service } = await import(pathToFileURL(r.resolve('@deepseek-ai/cordis')).href)
  class ModelService extends Service {
    constructor(ctx) { super(ctx, 'agentDefaultModel'); this.value = { provider: 'a', model: 'b' } }
    currentSelection() { return this.value }
  }
  const settles = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)) }
  // `ctx.plugin()` returns the fiber (a thenable), which is the addressable handle:
  // `fiber.name`, `fiber.state`, `fiber.update(config)`, `fiber.dispose()`.
  const provideService = (app, name) => app.plugin({ name, apply(ctx) { new Service(ctx, name) } })

  const app = new Context()
  // The four hard dependencies, so the gateway row can actually activate here.
  for (const name of plugin.inject) provideService(app, name)
  const modelFiber = app.plugin({ name: 'agentDefaultModel', apply(ctx) { new ModelService(ctx) } })
  await settles()

  const applies = []
  const disposes = []
  app.plugin({ name: 'mobile-gateway-fiber', inject: plugin.inject,
    apply() { applies.push(1); return () => disposes.push(1) } })
  const control = []
  app.plugin({ name: 'control-fiber', inject: ['agentDefaultModel'], apply() { control.push(1) } })
  await settles()
  assert.deepEqual([applies.length, control.length], [1, 1], 'both rows applied against real Cordis')

  // 1. A model change: the row's config is updated (what `configEditor.edit` ends in).
  await modelFiber.update({ provider: 'changed', model: 'changed' })
  await settles()
  assert.deepEqual([applies.length, disposes.length], [1, 0], 'a provider CONFIG UPDATE did not reload the gateway')
  assert.deepEqual(control, [1, 1], 'CONTROL: a fiber that injects the service reloaded on the same update (measured)')

  // 2. A provider replacement: withdraw, then re-provide under a new row.
  await modelFiber.dispose()
  await settles()
  app.plugin({ name: 'agentDefaultModel', apply(ctx) { new ModelService(ctx) } })
  await settles()
  assert.deepEqual([applies.length, disposes.length], [1, 0], 'a provider REPLACEMENT did not reload the gateway')
  assert.deepEqual(control, [1, 1, 1], 'CONTROL: the injecting fiber reloaded again on the replacement (measured)')
})

test('P-9 textual guard: no other lib module reaches agentDefaultModel', () => {
  // The regression above is only complete if nothing else reads the service
  // through `ctx.agentDefaultModel` (an injected property). The two files that
  // mention it are the resolver site and the two handlers; anything else would
  // reintroduce a property read that is undefined without the injection.
  const lib = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', 'lib')
  const offenders = []
  for (const name of fs.readdirSync(lib)) {
    if (!name.endsWith('.mjs') && !name.endsWith('.js')) continue
    if (name === 'index.mjs' || name === 'query-handlers.mjs') continue
    const text = fs.readFileSync(path.join(lib, name), 'utf8')
    if (text.includes('agentDefaultModel')) offenders.push(name)
  }
  assert.deepEqual(offenders, [], 'agentDefaultModel is read only by the lazy resolver and its two handlers')
})
