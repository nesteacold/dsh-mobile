// Client half: slot registration, same-origin-only fetches, vi/en labels, the
// toggle's call sequence, pairing code + edit-permissions flow and the remote
// session/approval UI. Loads lib/client.js in a vm with a fake __ModuleLoader__,
// the way plugins/mobile-gateway/test/connection-choice-ui.test.cjs does.
// React + react-test-renderer come from the gateway's node_modules (no install here).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { check, finish } from './helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const React = require('../../mobile-gateway/node_modules/react')
const { create, act } = require('../../mobile-gateway/node_modules/react-test-renderer')
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const source = fs.readFileSync(path.join(here, '../lib/client.js'), 'utf8')

console.log('client')

function load({ locale = 'en-US', status, devices = [], remotes = [], pending, fail = {}, sessions, listenFailure, controlPersists, uploads, menu = false } = {}) {
  let api
  const calls = []
  const state = {
    status: status ?? { remoteControl: { enabled: false, accepting: false }, lan: { listening: false, urls: [] } },
    devices, remotes, pending: pending ?? [], pairing: null,
    // POST /mgw/remote-control answers `persists` (the real route reports whether
    // the switch position reached the state file); a test can make the save fail.
    controlPersists: controlPersists ?? true,
    // POST /mgw/listen: one queued failure, and an optional gate a test holds to
    // observe the in-flight state before the rebind answers.
    listenFailure: listenFailure ?? null, listenGate: null,
    // POST /devices/remotes/:id/connect: same two levers, so a test can see the row
    // while the dial is in flight and the reason the route answers with.
    connectGate: null, connectFailure: null,
    // PATCH /devices/remotes/:id (address edit): the same two levers.
    patchGate: null, patchFailure: null,
    // Left undefined unless a test names it: the older-Host read, with no
    // `uploads` key at all (see the /devices/remotes route below).
    uploads,
    // POST /mgw/devices/:id/scopes: one queued refusal, and the calls the page made.
    scopeFailure: null,
  }
  const fetch = async (url, options = {}) => {
    const target = new URL(url)
    const route = target.pathname + target.search
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({ method: options.method ?? 'GET', route, body, origin: target.origin, credentials: options.credentials })
    const reply = (data, ok = true, status = ok ? 200 : 400) => ({ ok, status, json: async () => data })
    if (fail[route]) return reply({ message: fail[route] }, false)
    if (route === '/mgw/status') return reply(state.status)
    // Fresh row objects on every poll, the way JSON over HTTP really delivers them: React cannot
    // bail out of a re-render, so a test sees the rows the route persisted.
    if (route === '/mgw/devices') {
      return reply({ devices: state.devices.map((row) => ({ ...row, scopes: [...(row.scopes || [])] })) })
    }
    // The connection plan: rebind the listener, and move the status the next poll
    // reads too — otherwise a test could pass on a bind the gateway never applied.
    if (route === '/mgw/listen' && options.method === 'POST') {
      if (state.listenGate) await state.listenGate
      if (state.listenFailure) {
        const failure = state.listenFailure
        state.listenFailure = null
        return reply(failure.body, false, failure.status)
      }
      const known = (state.status && state.status.tailscale && state.status.tailscale.addresses) || []
      const host = body.target === 'loopback' ? '127.0.0.1' : body.target === 'tailscale' ? known[0] : '192.168.1.20'
      if (!host) return reply({ error: `${body.target}/not-detected`, message: 'No address on this machine.' }, false, 409)
      const port = 30081
      const urls = [`wss://${host}:${port}/ws/mobile`]
      const lan = { ...(state.status && state.status.lan), enabled: true, listening: true, host, port, urls, error: null }
      const tailscale = { ...(state.status && state.status.tailscale), urls: body.target === 'tailscale' ? urls : [] }
      state.status = { ...state.status, lan, tailscale }
      return reply({ applied: host, port, lan, tailscale })
    }
    if (route === '/mgw/remote-control') {
      state.status = { ...state.status, remoteControl: { enabled: body.enabled, accepting: state.status.remoteControl.accepting },
        lan: body.enabled ? { listening: true, urls: ['wss://192.168.1.20:3081/ws/mobile'] } : { listening: false, urls: [] } }
      return reply({ ...state.status, persists: state.controlPersists })
    }
    if (route === '/mgw/gateway') { state.status.remoteControl.accepting = body.mode !== 'disabled'; return reply({ gatewayMode: body.mode }) }
    if (route === '/mgw/connection') return reply({ pairingRoute: body.route })
    if (route === '/mgw/pair' && body.mode === 'otp') return reply({ mode: 'otp', otp: '12345678', pairing: { expiresAt: Date.now() + 590_000, kind: body.kind, scopes: body.scopes }, addresses: ['10.0.0.5:3081'] })
    if (route === '/mgw/pending') return reply({ pending: state.pending })
    if (/^\/mgw\/pending\/[^/]+\/(approve|reject)$/.test(route)) { state.pending = []; return reply({ approved: true }) }
    if (route === '/devices/pairings' && options.method === 'POST') { state.pairing = { id: 'p-1', state: 'connecting', address: body.address, verificationCode: null, error: null }; return reply({ pairing: state.pairing }, true) }
    if (/^\/devices\/pairings\/p-1$/.test(route) && (options.method ?? 'GET') === 'GET') return reply({ pairing: state.pairing })
    if (/^\/devices\/pairings\/p-1$/.test(route) && options.method === 'DELETE') { state.pairing = { ...state.pairing, state: 'cancelled' }; return reply({ pairing: state.pairing }) }
    if (route === '/mgw/pair') return reply({ pairing: { expiresAt: Date.now() + 90_000, kind: body.kind, scopes: body.scopes }, pairingString: 'PAIRSTRING' + (body.scopes ? '-' + body.scopes.join('+') : ''), payload: {} })
    if (/^\/mgw\/devices\/.+\/revoke$/.test(route)) return reply({ revoked: true })
    // POST /mgw/devices/:id/scopes (spec 025 R5): apply the diff the page sends to the row the
    // test seeded, the way the gateway persists it, and answer the route's own shape.
    if (/^\/mgw\/devices\/[^/]+\/scopes$/.test(route) && options.method === 'POST') {
      if (state.scopeFailure) {
        const failure = state.scopeFailure
        state.scopeFailure = null
        return reply(failure.body, false, failure.status)
      }
      const id = decodeURIComponent(route.split('/')[3])
      const row = state.devices.find((entry) => entry.id === id)
      if (!row) return reply({ error: 'not-found', message: 'no such device' }, false, 404)
      const before = [...(row.scopes || [])]
      const added = (body.add ?? []).filter((scope) => !before.includes(scope))
      const removed = (body.remove ?? []).filter((scope) => before.includes(scope))
      row.scopes = [...before.filter((scope) => !removed.includes(scope)), ...added]
      return reply({ device: { ...row }, added, removed })
    }
    if (route === '/devices/remotes' && (options.method ?? 'GET') === 'GET') {
      // `uploads` is only present when a test sets it: omitting the key is the
      // older-Host case, and the page must then claim nothing about attachments.
      if (state.uploads === undefined) return reply({ remotes: state.remotes })
      return reply({ remotes: state.remotes, uploads: state.uploads })
    }
    if (route === '/devices/remotes' && options.method === 'POST') return reply({ remote: { id: 'r-new' } })
    if (/^\/devices\/remotes\/[^/]+\/connect$/.test(route) && options.method === 'POST') {
      if (state.connectGate) await state.connectGate
      if (state.connectFailure) {
        const failure = state.connectFailure
        state.connectFailure = null
        return reply(failure.body, false, failure.status)
      }
      const id = route.split('/')[3]
      return reply({ remote: state.remotes.find((entry) => entry.id === id) ?? null, state: 'online' })
    }
    // PATCH /devices/remotes/:id: the address edit. Same two levers as connect.
    if (/^\/devices\/remotes\/[^/]+$/.test(route) && options.method === 'PATCH') {
      if (state.patchGate) await state.patchGate
      if (state.patchFailure) {
        const failure = state.patchFailure
        state.patchFailure = null
        return reply(failure.body, false, failure.status)
      }
      const id = route.split('/')[3]
      return reply({ remote: { ...(state.remotes.find((entry) => entry.id === id) ?? { id }), address: body.url }, state: 'online' })
    }
    if (/\/sessions$/.test(route)) return reply({ sessions: sessions ?? [{ sessionId: 's1', projections: { values: { title: 'Fix the build' } } }], approvals: state.remotes[0]?.approvals ?? [] })
    if (/\/history\?/.test(route)) return reply({ history: { kind: 'history', items: [{ seq: 1, role: 'user', text: 'hello remote' }] } })
    if (/\/prompt$/.test(route)) return reply({ sent: { kind: 'sent' } })
    if (/\/approval$/.test(route)) return reply({ receipt: { accepted: true } })
    return reply({ message: 'not found' }, false)
  }
  const registered = []
  // The shell's slot ledger, as rc.1's SlotCore.register implements it: a `single`
  // slot refuses a second registration at an already-taken priority and accepts a
  // lower one ("lowest renders"). `sidebar.workspaces` ships occupied by the stock
  // browser (`tk`) at priority 0; client-p2b.test.mjs is where that slot is exercised,
  // but the rule lives here too so no fake in this package can pass a collision.
  // The kinds are the shipped catalog's (client-ui-settings-general declares both
  // settings.section slots `list`), and `register` below carries the rest of the
  // rule: a `list`/`keyed` entry must carry its key option before a seat is even
  // looked for, and a `list` seat is (id, priority).
  const SLOT_KINDS = {
    'sidebar.workspaces': 'single',
    'settings.section': 'list',
    'settings.section.icon': 'list',
    'conversation.input.left': 'list',
    'conversation.input.dock': 'list',
    'conversation.input.right': 'list',
    // The sidebar's own row list and the layout's keyed main slot, as rc.1 declares
    // them (client-ui-sidebar children table, client-ui-layout root children table).
    'sidebar.panellist': 'list',
    'main': 'keyed',
  }
  const occupants = new Map(Object.keys(SLOT_KINDS).map((slot) => [slot, []]))
  occupants.get('sidebar.workspaces').push({ meta: { name: 'sidebar.workspaces', priority: 0, registrant: 'tk' } })
  const injects = []
  const localeListeners = new Set()
  let snapshot = { active: locale }
  const styles = []
  const intervals = new Map()
  let sequence = 0
  const window = {
    __ModuleLoader__: { load: ({ id, factory }) => { api = { id, ...factory((name) => { assert.equal(name, 'react'); return React }) } } },
    setInterval: (fn) => { intervals.set(++sequence, fn); return sequence },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn) => { fn(); return 0 },
    confirm: () => true,
  }
  const clipboard = []
  const document = { baseURI: 'http://127.0.0.1:3080/', head: { appendChild: (node) => styles.push(node) }, createElement: () => ({ remove() {} }) }
  vm.runInNewContext(source, { window, document, fetch, URL, console, setTimeout, clearTimeout,
    navigator: { language: locale, clipboard: { writeText: async (text) => { clipboard.push(text) } } } })
  const disposers = []
  // The shell's context-menu registry (client-ui-context-menu), with the one rule that
  // matters here: `${target}/${id}` is unique, so a second contribution must mint a
  // fresh id instead of re-registering the shipped row.
  const menuProviders = []
  const contextMenus = {
    register(input) {
      if (menuProviders.some((entry) => entry.target === input.target && entry.id === input.id)) {
        throw new Error(`Duplicate menu contribution: ${input.target}/${input.id}`)
      }
      menuProviders.push(input)
      return () => { const at = menuProviders.indexOf(input); if (at >= 0) menuProviders.splice(at, 1) }
    },
  }
  // The client services the shell would hand over. Only the menu is modelled here; the
  // rest stay absent, which installRemoteSurfaces already copes with.
  const services = { contextMenus }
  const ctx = {
    locale: { getSnapshot: () => snapshot, subscribe: (listener) => { localeListeners.add(listener); return () => localeListeners.delete(listener) } },
    effect(fn) { disposers.push(fn()) },
    // Only a `menu` shell hands out client services, the way rc.1's ctx.inject does
    // (an optional service arrives as the scope's property, and the callback's return
    // value is the disposer). Without it the fake is a shell that provides none, which
    // is what the other tests assert.
    ...(menu ? {
      inject(deps, callback) {
        const scope = {}
        for (const dep of deps) scope[dep] = services[dep]
        const out = callback(scope)
        return typeof out === 'function' ? out : () => {}
      },
    } : {}),
    slots: {
      inject(slot, fn) { injects.push(slot); registered.push(fn()) },
      register(meta, component) {
        const kind = SLOT_KINDS[meta.name]
        if (!kind) throw new Error(`slot "${meta.name}" is not declared (a parent entry's children table must declare it)`)
        const priority = meta.priority ?? 0
        const held = occupants.get(meta.name)
        // SlotCore.register switches on the declared kind: the mandatory option is
        // checked BEFORE any collision (a `list` entry with no id throws on an empty
        // slot too), the collision key is that option paired with the priority — so
        // two entries at one priority are legal when their ids differ and the same id
        // at the same priority throws — and `chain` is keyed by its own `select` with
        // no collision seat at all.
        let taken
        if (kind === 'single') {
          taken = held.find((occupant) => (occupant.meta.priority ?? 0) === priority)
        } else if (kind === 'list' || kind === 'keyed') {
          const option = kind === 'list' ? 'id' : 'key'
          if (meta[option] === undefined) throw new Error(`${kind} slot "${meta.name}" requires options.${option}`)
          taken = held.find((occupant) => (occupant.meta.priority ?? 0) === priority && occupant.meta[option] === meta[option])
        } else if (meta.select === undefined) {
          throw new Error(`chain slot "${meta.name}" requires options.select`)
        }
        if (taken) {
          const by = taken.meta.registrant !== undefined ? ` (registered by ${taken.meta.registrant})` : ''
          const what = kind === 'single' ? 'a registration'
            : kind === 'keyed' ? `an entry for key "${meta.key}"` : `an entry with id "${meta.id}"`
          throw new Error(`${kind} slot "${meta.name}" already has ${what} at priority ${priority}${by} — register at a different priority to shadow it (lowest renders)`)
        }
        held.push({ meta })
        return { meta, component }
      },
    },
  }
  api.apply(ctx)
  return { api, calls, registered, injects, clipboard, state, intervals, menuProviders,
    setLocale(active) { snapshot = { active }; for (const listener of localeListeners) listener() } }
}

// The contract's scope list and presets: client.js is a plain script and keeps a mirror,
// so the tests compare it with packages/mobile-protocol and fail on drift.
const { SCOPES: CONTRACT_SCOPES, SCOPE_PRESETS: CONTRACT_PRESETS, DESKTOP_ONLY_SCOPES } =
  await import('../../../packages/mobile-protocol/src/index.mjs')
// Order of the checkboxes in the UI (safe scopes first), as the contract lists the full desktop set.
const ALL = ['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote',
  'files:write', 'settings:write', 'commands:execute', 'workspace:manage',
  'credentials:write', 'plugins:manage', 'schedule:write', 'schedule:read', 'terminal', 'sessions:author',
  'attachments:write', 'browser:control', 'stats:read', 'web:unlock', 'permission:lower']

const text = (renderer) => JSON.stringify(renderer.toJSON())
async function mount(element) {
  let renderer
  await act(async () => { renderer = create(element) })
  return renderer
}
const flush = async () => { await act(async () => { await new Promise((resolve) => setImmediate(resolve)) }) }
const find = (renderer, predicate) => renderer.root.findAll((node) => typeof node.type === 'string' && predicate(node))
const button = (renderer, label) => find(renderer, (node) => node.type === 'button' && node.children.join('') === label)[0]
const click = async (node) => { await act(async () => { await node.props.onClick({ preventDefault() {}, target: {} }) }) }

await check('registers settings.section and settings.section.icon for the same id, order ~80, label "Devices"', () => {
  const ui = load()
  assert.equal(ui.api.id, '@dsh-ext/devices')
  assert.deepEqual([...ui.api.inject], ['slots', 'locale'])
  assert.deepEqual(ui.injects, ['settings.section', 'settings.section.icon', 'sidebar.panellist', 'main'])
  const [section, icon] = ui.registered
  // JSON round trip: the objects were created inside the vm realm.
  assert.deepEqual(JSON.parse(JSON.stringify(section.meta)), { name: 'settings.section', id: 'dsh-ext.devices', order: 80, label: 'Devices' })
  assert.deepEqual(JSON.parse(JSON.stringify(icon.meta)), { name: 'settings.section.icon', id: 'dsh-ext.devices', order: 80, label: 'Devices' })
  assert.equal(typeof section.component, 'function')
})

await check('sidebar row: a `sidebar.panellist` entry directly below Repo Wiki, labelled in both languages', async () => {
  const ui = load({ locale: 'vi' })
  const row = ui.registered.find((entry) => entry.meta.name === 'sidebar.panellist')
  assert.ok(row, 'the row is registered')
  assert.equal(row.meta.id, 'dsh-ext.devices')
  // The shipped rows sort ascending by `order`: Plugins 0
  // (client-ui-plugin-manager), Automation tasks 10 (client-ui-schedule), Repo Wiki
  // 20 (plugins/dsh-wiki). 21 is the next seat after Repo Wiki, so the list renders
  // Plugins, Automation tasks, Repo Wiki, Devices — and the "More" launcher is not a
  // row, so it still comes last.
  assert.equal(ui.api.testing.PANEL_ORDER, 21)
  assert.equal(row.meta.order, 21, 'one past Repo Wiki’s 20')
  // A function label, because the shell re-resolves it on every locale change: the
  // row must say "Thiết bị" on a Vietnamese Host and "Devices" on any other.
  assert.equal(typeof row.meta.label, 'function')
  assert.equal(row.meta.label(), 'Thiết bị')
  ui.setLocale('en')
  assert.equal(row.meta.label(), 'Devices')
  const { DICT } = ui.api.testing
  assert.equal(DICT.en.title, 'Devices', 'the row reuses the page title, not a second string')
  assert.notEqual(DICT.vi.title, DICT.en.title)
  // The glyph honours the size the shell asks for (16 wide, 18 on the rail).
  const icon = await mount(React.createElement(row.component, { size: 18, active: false }))
  const svg = icon.root.findAll((node) => node.type === 'svg')[0]
  assert.equal(svg.props.width, 18)
  assert.equal(svg.props.height, 18)
  assert.equal(svg.props['aria-hidden'], true)
})

await check('sidebar panel: a `main` entry keyed by the same id renders the one DevicesPage', async () => {
  const ui = load()
  const { DevicesPage, PANEL_ID, DICT } = ui.api.testing
  const panel = ui.registered.find((entry) => entry.meta.name === 'main')
  assert.ok(panel, 'the main panel body is registered')
  // The row's `layout.selectPanel(id)` only resolves an id that a `main` entry
  // carries as its key, so the two halves must name the same value.
  assert.deepEqual(JSON.parse(JSON.stringify(panel.meta)), { name: 'main', key: PANEL_ID })
  assert.equal(PANEL_ID, 'dsh-ext.devices')
  const page = await mount(React.createElement(panel.component))
  // A seat, not a second page: the real DevicesPage is inside it exactly once, and
  // its own header and tabs prove the page itself — not a copy — rendered.
  assert.equal(page.root.findAllByType(DevicesPage).length, 1)
  assert.equal(find(page, (node) => node.props['data-testid'] === 'devices-panel').length, 1)
  assert.equal(find(page, (node) => node.props['data-testid'] === 'page-subtitle')[0].children.join(''), DICT.en.subtitle)
  const tabs = page.root.findAll((node) => node.props.role === 'tab')
  assert.deepEqual(tabs.map((tab) => tab.children.join('')), [DICT.en.tabAllow, DICT.en.tabConnect])
})

await check('static: the only fetch is the same-origin request() helper; no external URLs, sockets or beacons', () => {
  const fetches = [...source.matchAll(/\bfetch\s*\(([^)]*)\)/g)].map((match) => match[1])
  assert.equal(fetches.length, 1)
  assert.deepEqual([...source.matchAll(/['"`](https?:\/\/[^'"`\s]+)['"`]/g)].map((match) => match[1]), [])
  assert.doesNotMatch(source, /XMLHttpRequest|sendBeacon|EventSource|new WebSocket|localStorage/)
  const paths = [...source.matchAll(/\b(?:request|post)\(\s*[`'"](\/[^`'"$]*)/g)].map((match) => match[1])
  for (const route of paths) assert.match(route, /^\/(mgw|devices)\//, route)
  assert.ok(paths.length >= 8)
})

await check('labels follow the host locale: vi for vi*, en otherwise, and switch live', async () => {
  const ui = load({ locale: 'vi' })
  const page = await mount(React.createElement(ui.registered[0].component))
  assert.match(text(page), /Thiết bị/)
  assert.match(text(page), /Cho phép kết nối tới thiết bị này/)
  await act(async () => { ui.setLocale('en') })
  assert.match(text(page), /Allow connections to this device/)
  assert.match(text(page), /Connect to other devices/)
  assert.equal(ui.registered[0].meta.label, 'Thiết bị')
  await act(async () => { ui.setLocale('de-DE') })
  assert.match(text(page), /Devices/, 'unknown locales fall back to English')
  // Every English key has a Vietnamese twin (and vice versa), so no label is silently English.
  const { DICT } = ui.api.testing
  assert.deepEqual(Object.keys(DICT.vi).sort(), Object.keys(DICT.en).sort())
})

await check('session menu: a second "Copy original ID" row only for a remote session, and it copies the untagged id', async () => {
  const ui = load({ menu: true })
  const { DICT } = ui.api.testing
  // One contribution, its own `${target}/${id}`: the shipped copy row is `session.id`
  // at order 450 (dsh-client-ui-workspace lib/client.js:4375-4381) and the registry
  // throws on a repeated pair, so this row is an addition, never a replacement.
  assert.equal(ui.menuProviders.length, 1)
  const provider = ui.menuProviders[0]
  assert.equal(provider.target, 'session')
  assert.equal(provider.id, 'session.devices-copy-raw')
  assert.notEqual(provider.id, 'session.id')
  // 451 renders directly BELOW the shipped 450 row (a smaller order would put it above).
  assert.equal(provider.order, 451)
  assert.equal(typeof provider.resolve, 'function')

  // A remote session's id is tagged (`h:<hostId>:<rawId>`), so exactly one row appears
  // and its label is the row's own string in the page language.
  const remote = provider.resolve({ sessionId: 'h:r1:sess-42', displayTitle: 'Fix the build' })
  assert.equal(remote.length, 1, 'exactly one row, not one per host')
  assert.equal(remote[0].label, DICT.en.copyOriginalId)
  assert.equal(DICT.en.copyOriginalId, 'Copy original ID')
  assert.equal(remote[0].separatorBefore, undefined, 'it shares the shipped row\'s group instead of splitting it')

  // Pressing it writes the Host's own id — the tag comes off, nothing else changes.
  await remote[0].run()
  assert.deepEqual(ui.clipboard, ['sess-42'], 'the clipboard holds only the untagged id')
  // The tag is `<hostId>:` up to the FIRST colon (lib/host-router.mjs hostIdOfId), so a
  // raw id that contains one keeps all of it.
  const colon = provider.resolve({ sessionId: 'h:r9:a:b' })
  assert.equal(colon.length, 1)
  await colon[0].run()
  assert.deepEqual(ui.clipboard, ['sess-42', 'a:b'])

  // The same row in Vietnamese, resolved live because the label is read per opening.
  ui.setLocale('vi')
  const vi = provider.resolve({ sessionId: 'h:r1:sess-42', displayTitle: 'Fix the build' })
  assert.equal(vi.length, 1)
  assert.equal(vi[0].label, DICT.vi.copyOriginalId)
  assert.equal(DICT.vi.copyOriginalId, 'Sao chép ID gốc')
  assert.notEqual(DICT.vi.copyOriginalId, DICT.en.copyOriginalId, 'a real translation, not a copy')
  assert.deepEqual(Object.keys(DICT.vi).sort(), Object.keys(DICT.en).sort(), 'vi and en stay twins')

  // A Local session carries no tag: no row at all, so the shipped copy row is the only one.
  assert.equal(provider.resolve({ sessionId: 'local-1', displayTitle: 'Local' }).length, 0)
  assert.equal(provider.resolve({}).length, 0)
  assert.equal(provider.resolve(undefined).length, 0)
  assert.equal(ui.clipboard.length, 2, 'resolving never copies anything by itself')
})

await check('toggle on: remote-control, gateway (persistent), connection (lan); off: remote-control only', async () => {
  const ui = load()
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  const toggle = () => find(page, (node) => node.props.role === 'switch')[0]
  assert.equal(toggle().props['aria-checked'], false)
  assert.equal(button(page, 'Generate pairing code').props.disabled, true, 'pairing needs the switch on')
  await click(toggle())
  const posts = ui.calls.filter((call) => call.method === 'POST').map((call) => `${call.route} ${JSON.stringify(call.body)}`)
  assert.deepEqual(posts, ['/mgw/remote-control {"enabled":true}', '/mgw/gateway {"mode":"persistent"}', '/mgw/connection {"route":"lan"}'])
  await flush()
  assert.equal(toggle().props['aria-checked'], true)
  // LAN is on, Internet is disabled with a "later" note.
  const checkboxes = find(page, (node) => node.type === 'input' && node.props.type === 'checkbox')
  assert.deepEqual(checkboxes.map((node) => [node.props.checked, node.props.disabled]), [[true, true], [false, true]])
  assert.match(text(page), /Later — not available yet/)
  // The address chip comes from /mgw/status.
  assert.match(text(page), /192\.168\.1\.20:3081/)
  ui.calls.length = 0
  await click(toggle())
  assert.deepEqual(ui.calls.filter((call) => call.method === 'POST').map((call) => call.route), ['/mgw/remote-control'])
  assert.deepEqual(ui.calls.find((call) => call.method === 'POST').body, { enabled: false })
  page.unmount()
})

await check('toggle: a switch the gateway could not save shows one notice; a saved one shows none', async () => {
  // The owner's OFF must stick. When the gateway answers `persists:false` the
  // switch still applied, but the state file did not take it — say so inline.
  const unsaved = load({ controlPersists: false,
    status: { remoteControl: { enabled: true, accepting: true }, lan: { listening: true, urls: ['wss://192.168.1.20:3081/ws/mobile'] } } })
  const page = await mount(React.createElement(unsaved.api.testing.AllowTab))
  await flush()
  const toggle = () => find(page, (node) => node.props.role === 'switch')[0]
  assert.equal(toggle().props['aria-checked'], true)
  await click(toggle())
  await flush()
  assert.equal(toggle().props['aria-checked'], false, 'the switch still moves even when the save failed')
  assert.match(text(page), /could not save it/, 'the owner must learn the switch was not saved')

  // A switch the gateway did save adds no notice.
  const saved = load()
  const other = await mount(React.createElement(saved.api.testing.AllowTab))
  await flush()
  await click(find(other, (node) => node.props.role === 'switch')[0])
  await flush()
  assert.doesNotMatch(text(other), /could not save it/, 'a saved switch adds no notice')
  page.unmount(); other.unmount()
})

await check('every fetch is same-origin with credentials, and honours the document base', async () => {
  const ui = load()
  const page = await mount(React.createElement(ui.api.testing.DevicesPage))
  await flush()
  for (const call of ui.calls) {
    assert.equal(call.origin, 'http://127.0.0.1:3080')
    assert.equal(call.credentials, 'same-origin')
  }
  page.unmount()
})

await check('generate pairing code (Window 1): an 8-digit OTP grouped 4-4, a countdown, address chips; no pairing string', async () => {
  const ui = load({ status: { remoteControl: { enabled: true, accepting: true }, lan: { listening: true, urls: ['wss://10.0.0.5:3081/ws/mobile'] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  await click(button(page, 'Generate pairing code'))
  const body = ui.calls.find((call) => call.route === '/mgw/pair').body
  assert.equal(body.mode, 'otp'); assert.equal(body.kind, 'desktop')
  assert.ok(body.scopes.includes('harness:remote'))
  assert.match(text(page), /1234 5678/)
  assert.doesNotMatch(text(page), /12345678/, 'only the grouped form is rendered')
  assert.match(text(page), /Expires in 9:/)
  const copies = find(page, (node) => node.type === 'button' && node.children.join('') === 'Copy')
  assert.ok(copies.length >= 2, 'Copy for the code and for the address chip')
  for (const copy of copies) await click(copy)
  assert.ok(ui.clipboard.includes('12345678') && ui.clipboard.includes('10.0.0.5:3081'))
  await click(find(page, (node) => node.type === 'button' && node.props['aria-label'] === 'Close')[0])
  assert.doesNotMatch(text(page), /1234 5678/, 'closing the dialog drops the code from the page')
  page.unmount()
})

await check('pending requests (Window 2): polled every 2 s; name, IP, editable scopes incl. harness:remote, big code; Approve sends the narrowed scopes; Reject', async () => {
  const item = { id: 'req-1', name: 'Anh laptop', clientIp: '192.168.1.44', kind: 'desktop', createdAt: 1_700_000_000_000, verificationCode: '123456',
    requestedScopes: ['sessions:read', 'prompt:send', 'harness:remote'] }
  const ui = load({ pending: [item], status: { remoteControl: { enabled: true, accepting: true }, lan: { listening: true, urls: [] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  const rendered = text(page)
  for (const expected of ['Anh laptop', '192\\.168\\.1\\.44', '123 456', 'Use this host remotely']) assert.match(rendered, new RegExp(expected))
  assert.ok([...ui.intervals.values()].length >= 2, 'a 2 s poll is registered next to the 3 s status refresh')
  ui.calls.length = 0
  for (const tick of [...ui.intervals.values()]) await act(async () => { await tick() })
  assert.ok(ui.calls.some((call) => call.route === '/mgw/pending'), 'the poll hits /mgw/pending')
  // Every desktop scope is listed; only those the device requested can be ticked.
  const boxes = () => find(page, (node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.onChange)
  assert.equal(boxes().length, ALL.length)
  // Approve defaults to Standard narrowed to the offer: the three requested standard scopes.
  assert.deepEqual(boxes().filter((node) => node.props.checked).length, 3)
  assert.deepEqual(boxes().map((node) => node.props.disabled), ALL.map((scope) => !item.requestedScopes.includes(scope)))
  await act(async () => { boxes()[ALL.indexOf('prompt:send')].props.onChange({ target: { checked: false } }) })   // drop prompt:send
  await click(button(page, 'Approve'))
  const approve = ui.calls.find((call) => call.route === '/mgw/pending/req-1/approve')
  assert.deepEqual(approve.body, { scopes: ['sessions:read', 'harness:remote'] })
  assert.equal(approve.method, 'POST')
  page.unmount()
  const again = load({ pending: [item], status: { remoteControl: { enabled: true, accepting: true }, lan: { listening: true, urls: [] } } })
  const second = await mount(React.createElement(again.api.testing.AllowTab))
  await flush()
  await click(button(second, 'Reject'))
  assert.deepEqual(again.calls.find((call) => call.route === '/mgw/pending/req-1/reject').body, {})
  second.unmount()
})
await check('authorized devices: shows name/kind/scopes/last used/Connected here; Remove revokes; Edit re-pairs with chosen scopes', async () => {
  const device = { id: 'dev-1', name: 'Work PC', displayName: 'Work PC', kind: 'desktop', scopes: ['sessions:read', 'prompt:send'], lastSeenAt: 1_700_000_000_000, online: true }
  const ui = load({ devices: [device], status: { remoteControl: { enabled: true, accepting: true }, lan: { listening: true, urls: [] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  const rendered = text(page)
  for (const expected of ['Work PC', 'desktop', 'See sessions and history', 'Send prompts', 'Connected here', 'Last used']) assert.match(rendered, new RegExp(expected))
  // The grant is a chip list now, not the run-on "Permissions: a, b" sentence that
  // squeezed the row into a few words per line. Every scope is still there.
  assert.doesNotMatch(rendered, /Permissions: /, 'no comma sentence')
  const chips = find(page, (node) => typeof node.props['data-scope'] === 'string')
  assert.deepEqual(chips.map((node) => node.props['data-scope']), ['sessions:read', 'prompt:send'], 'one chip per scope, in the granted order')
  assert.equal(chips[0].children.join(''), 'See sessions and history', 'the chip carries the scope label')
  // Last use keeps its own row (label + the value), never glued to the grant.
  const when = find(page, (node) => node.props['data-testid'] === 'last-used')[0].children.join('')
  assert.match(when, /2023/, 'the last use is a date')
  assert.match(when, /\d{1,2}:\d{2}/, 'with a time, not just a day')
  await click(button(page, 'Edit permissions'))
  assert.match(text(page), /device must pair again/)
  const boxes = () => find(page, (node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.onChange)
  assert.equal(boxes().length, ALL.length, 'every desktop scope is editable')
  assert.deepEqual(boxes().filter((node) => node.props.checked).length, 2)
  assert.equal(boxes()[ALL.indexOf('sessions:read')].props.checked, true)
  assert.equal(boxes()[ALL.indexOf('prompt:send')].props.checked, true)
  await act(async () => { boxes()[ALL.indexOf('approval:respond')].props.onChange({ target: { checked: true } }) })
  await click(button(page, 'Generate new pairing code'))
  assert.deepEqual(ui.calls.find((call) => call.route === '/mgw/pair').body, { kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'approval:respond'] })
  assert.match(text(page), /PAIRSTRING-sessions:read\+prompt:send\+approval:respond/)
  await click(button(page, 'Remove access'))
  assert.ok(ui.calls.some((call) => call.method === 'POST' && call.route === '/mgw/devices/dev-1/revoke'))
  page.unmount()
})

await check('permissions editor (spec 025 R5): per-device in-place scope change, kind-limited list, explicit confirm, route codes; the missing-upload hint; vi + en', async () => {
  // A record paired before spec 013: no `attachments:write`, so the row carries the hint.
  const device = { id: 'dev-1', name: 'Work PC', displayName: 'Work PC', kind: 'desktop', scopes: ['sessions:read', 'prompt:send'], lastSeenAt: 1_700_000_000_000, online: true }
  const ui = load({ devices: [device], status: { remoteControl: { enabled: true, accepting: true }, lan: { listening: true, urls: [] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  assert.match(text(page), /Re-grant file upload permission/, 'a grant without attachments:write is flagged')
  // The row has three actions now: Permissions, Edit (re-pair) and Remove.
  await click(button(page, 'Permissions'))
  assert.ok(find(page, (node) => node.props['data-testid'] === 'permissions-editor').length === 1)
  assert.match(text(page), /without re-pairing/)
  const boxes = () => find(page, (node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.onChange)
  // The editor lists every scope a desktop may hold, and NOTHING for another kind (below).
  assert.equal(boxes().length, ALL.length)
  assert.deepEqual(boxes().filter((node) => node.props.checked).length, 2, 'the current grant is ticked')
  // `web:unlock` is listed but not tickable: the passkey flow owns it.
  assert.equal(boxes()[ALL.indexOf('web:unlock')].props.disabled, true)
  // A no-op save is refused by the page itself (no confirm, no request).
  assert.equal(button(page, 'Apply permissions').props.disabled, true)
  // Add one, remove one, then confirm. The body is the DIFF, never the whole list.
  await act(async () => { boxes()[ALL.indexOf('attachments:write')].props.onChange({ target: { checked: true } }) })
  await act(async () => { boxes()[ALL.indexOf('prompt:send')].props.onChange({ target: { checked: false } }) })
  ui.calls.length = 0
  await click(button(page, 'Apply permissions'))
  const call = ui.calls.find((entry) => entry.route === '/mgw/devices/dev-1/scopes')
  assert.equal(call.method, 'POST')
  assert.deepEqual(call.body, { add: ['attachments:write'], remove: ['prompt:send'] })
  assert.match(text(page), /The device reconnects to pick them up/)
  // The route's answer is the new baseline: the page re-reads the rows, and a second click sends
  // nothing (the same change is not applied twice against a stale row).
  assert.ok(ui.calls.some((entry) => entry.route === '/mgw/devices'), 'onApplied refreshes the rows')
  assert.equal(button(page, 'Apply permissions').props.disabled, true, 'nothing left to apply')
  // A refusal leaves the tick state alone, so the owner can correct it and try again.
  assert.equal(boxes()[ALL.indexOf('attachments:write')].props.checked, true)
  await act(async () => { for (const tick of [...ui.intervals.values()]) await tick() })
  assert.doesNotMatch(text(page), /Re-grant file upload permission/, 'the hint goes once the scope is there')
  // A named refusal is said in the page's language, not the route's English sentence.
  ui.state.scopeFailure = { status: 400, body: { error: 'scope-not-for-kind', message: 'scope x is not available for a desktop device' } }
  await act(async () => { boxes()[ALL.indexOf('terminal')].props.onChange({ target: { checked: true } }) })
  await click(button(page, 'Apply permissions'))
  assert.equal(find(page, (node) => node.props['data-testid'] === 'permissions-error')[0].children.join(''),
    'That permission does not apply to this kind of device.')
  ui.state.scopeFailure = { status: 404, body: { error: 'not-found', message: 'no such device' } }
  await click(button(page, 'Apply permissions'))
  assert.equal(find(page, (node) => node.props['data-testid'] === 'permissions-error')[0].children.join(''),
    'That device is no longer paired. Reload the page.')
  page.unmount()

  // A `mobile` record: the desktop-only scopes are not even listed, so the gateway can never refuse
  // a tick the page offered. That is the same DESKTOP_ONLY_SCOPES table the contract carries.
  const phone = { id: 'dev-2', name: 'Phone', kind: 'mobile', scopes: ['sessions:read'], online: false }
  const second = load({ devices: [phone], status: { remoteControl: { enabled: true, accepting: true }, lan: { listening: true, urls: [] } } })
  const mobilePage = await mount(React.createElement(second.api.testing.AllowTab))
  await flush()
  await click(button(mobilePage, 'Permissions'))
  const mobileBoxes = () => find(mobilePage, (node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.onChange)
  assert.equal(mobileBoxes().length, ALL.length - DESKTOP_ONLY_SCOPES.length)
  for (const scope of DESKTOP_ONLY_SCOPES) {
    assert.equal(mobileBoxes().some((node) => node.props['data-scope'] === scope), false, `${scope} is not offered to a mobile`)
  }
  assert.deepEqual([...second.api.testing.scopesForKind('mobile')].sort(),
    [...ALL.filter((scope) => !DESKTOP_ONLY_SCOPES.includes(scope))].sort(), 'the client mirror matches the contract table')
  // vi: the editor's own strings are real translations and the dictionaries stay twins.
  second.setLocale('vi')
  await flush()
  assert.match(text(mobilePage), /Áp dụng quyền/)
  assert.match(text(mobilePage), /Cấp lại quyền tải tệp lên/)
  const { DICT } = second.api.testing
  assert.deepEqual(Object.keys(DICT.vi).sort(), Object.keys(DICT.en).sort(), 'vi and en stay twins')
  assert.notEqual(DICT.vi.permsHelp, DICT.en.permsHelp)
  mobilePage.unmount()
})

await check('connect tab: Add device dialog (LAN | Internet disabled, Address, 8-digit code, Display name, Advanced link); remote list shows status', async () => {
  const remotes = [{ id: 'r1', name: 'Laptop', address: '192.168.1.30:3081', status: 'online', approvals: [] },
    { id: 'r2', name: 'Old', address: '192.168.1.31:3081', status: 'revoked', approvals: [] }]
  const ui = load({ remotes })
  const page = await mount(React.createElement(ui.api.testing.ConnectTab))
  await flush()
  assert.match(text(page), /Laptop/); assert.match(text(page), /Online/); assert.match(text(page), /Access revoked/)
  await click(find(page, (node) => node.type === 'button' && node.children.join('') === 'Add device')[0])
  const internet = find(page, (node) => node.type === 'button' && /Internet/.test(node.children.join('')))[0]
  assert.equal(internet.props.disabled, true, 'Internet stays disabled')
  assert.match(text(page), /192\.168\.1\.9:41234/, 'Qoder placeholder')
  const submitButton = () => find(page, (node) => node.type === 'button' && node.props.type === 'submit')[0]
  assert.equal(submitButton().props.disabled, true)
  const [address] = find(page, (node) => node.type === 'input' && node.props.placeholder === '192.168.1.9:41234')
  const [code] = find(page, (node) => node.type === 'input' && node.props.placeholder === '1234 5678')
  const [name] = find(page, (node) => node.type === 'input' && node.props['aria-label'] === 'Display name')
  await act(async () => { address.props.onChange({ target: { value: ' 192.168.1.30:3081 ' } }) })
  await act(async () => { code.props.onChange({ target: { value: '1234 567' } }) })
  assert.equal(submitButton().props.disabled, true, '7 digits are not enough')
  await act(async () => { code.props.onChange({ target: { value: '1234 5678' } }) })
  await act(async () => { name.props.onChange({ target: { value: 'My PC' } }) })
  assert.equal(submitButton().props.disabled, false)
  const form = find(page, (node) => node.type === 'form')[0]
  await act(async () => { await form.props.onSubmit({ preventDefault() {} }) })
  assert.deepEqual(ui.calls.find((call) => call.method === 'POST' && call.route === '/devices/pairings').body,
    { address: '192.168.1.30:3081', name: 'My PC', otp: '12345678' })
  // Waiting screen: spinner until the Host answers with the verification code, then the code.
  assert.match(text(page), /Waiting for approval on the host/)
  ui.state.pairing = { id: 'p-1', state: 'pending', address: '192.168.1.30:3081', verificationCode: '123 456', error: null }
  for (const tick of [...ui.intervals.values()]) await act(async () => { await tick() })
  assert.match(text(page), /123 456/)
  // Cancel is a DELETE on the session.
  await click(button(page, 'Cancel'))
  assert.ok(ui.calls.some((call) => call.method === 'DELETE' && call.route === '/devices/pairings/p-1'))
  // Advanced: the pairing string replaces the code field.
  await click(find(page, (node) => node.type === 'button' && node.children.join('') === 'Add device')[0])
  await click(button(page, 'Advanced: paste pairing string'))
  assert.equal(find(page, (node) => node.type === 'textarea').length, 1)
  assert.equal(find(page, (node) => node.type === 'input' && node.props.placeholder === '1234 5678').length, 0)
  const opens = find(page, (node) => node.type === 'button' && node.children.join('') === 'Open')
  assert.equal(opens[1].props.disabled, true, 'a revoked remote cannot be opened')
  page.unmount()
})
await check('open a remote: sessions -> history -> send prompt -> approvals allow once / reject echo argsHash', async () => {
  const approval = { rpcId: 'rpc-1', sessionId: 's1', approvalId: 'ap-1', toolName: 'bash', reason: 'run ls', argsHash: 'a'.repeat(64), argsPreview: '{"command":"ls"}' }
  const noHash = { rpcId: 'rpc-2', sessionId: 's1', approvalId: 'ap-2', toolName: 'rm', argsHash: null, argsPreview: '' }
  const remote = { id: 'r1', name: 'Laptop', address: '192.168.1.30:3081', status: 'online', approvals: [approval, noHash] }
  const ui = load({ remotes: [remote] })
  const page = await mount(React.createElement(ui.api.testing.ConnectTab))
  await flush()
  await click(button(page, 'Open'))
  await flush()
  assert.match(text(page), /Fix the build/)
  assert.match(text(page), /bash/)
  assert.match(text(page), /Decide on the other device/)
  assert.equal(find(page, (node) => node.type === 'button' && node.children.join('') === 'Allow once').length, 1, 'no hash, no remote decision')
  await click(button(page, 'Open'))                          // the session row's Open
  await flush()
  assert.match(text(page), /hello remote/)
  const [prompt] = find(page, (node) => node.type === 'textarea')
  await act(async () => { prompt.props.onChange({ target: { value: 'run the tests' } }) })
  await click(button(page, 'Send'))
  assert.deepEqual(ui.calls.find((call) => call.route.endsWith('/prompt')).body, { sessionId: 's1', text: 'run the tests' })
  await click(button(page, 'Allow once'))
  assert.deepEqual(ui.calls.find((call) => call.route.endsWith('/approval')).body,
    { rpcId: 'rpc-1', sessionId: 's1', approvalId: 'ap-1', argsHash: 'a'.repeat(64), outcome: 'allowed-once' })
  await click(button(page, 'Reject'))
  assert.equal(ui.calls.filter((call) => call.route.endsWith('/approval')).at(-1).body.outcome, 'rejected')
  assert.ok(!text(page).includes('"token"'))
  page.unmount()
})

await check('a subagent row is opened with its parent address; an ordinary row carries neither field', async () => {
  // DSH refuses a history read addressed as an ordinary session for a subagent child
  // (`session/agent-busy`), so the row this view already lists must supply the parent
  // — the request must not depend on the server-side fallback.
  const sessions = [
    { sessionId: 's1', projections: { values: { title: 'Ordinary' } } },
    { sessionId: 'c1', origin: 'subagent', parentSessionId: 'p1', projections: { values: { title: 'Child work' } } },
  ]
  const ui = load({ remotes: [{ id: 'r1', name: 'Laptop', address: '192.168.1.30:3081', status: 'online', approvals: [] }], sessions })
  const page = await mount(React.createElement(ui.api.testing.ConnectTab))
  await flush()
  const opens = () => find(page, (node) => node.type === 'button' && node.children.join('') === 'Open')
  const histories = () => ui.calls.filter((call) => /\/history\?/.test(call.route))
  await click(opens()[0])
  await flush()
  await click(opens()[0])
  await flush()
  assert.equal(histories().at(-1).route, '/devices/remotes/r1/history?sessionId=s1', 'an ordinary row sends no parent fields')
  await click(opens()[1])
  await flush()
  assert.equal(histories().at(-1).route,
    '/devices/remotes/r1/history?sessionId=c1&parentSessionId=p1&subagentMode=unknown')
  page.unmount()
})

await check('errors from the server are shown, not swallowed', async () => {
  const ui = load({ fail: { '/devices/remotes': 'boom: pin mismatch' } })
  const page = await mount(React.createElement(ui.api.testing.ConnectTab))
  await flush()
  assert.match(text(page), /boom: pin mismatch/)
  page.unmount()
})

await check('a remote granted no harness:remote says so on its row (en and vi); one that has it says nothing', async () => {
  // Measured end to end: without the scope the merged session/list answers Local
  // rows only, so the host looks connected and empty. The row must name the
  // consequence and the fix instead of leaving it to a log line.
  const shortGrant = { id: 'r1', name: 'Sigma', address: '192.168.1.40:3081', status: 'online', approvals: [],
    device: { kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'approval:respond'] } }
  const fullGrant = { ...shortGrant, id: 'r2', name: 'Omega', device: { kind: 'desktop', scopes: ['sessions:read', 'harness:remote'] } }
  const ui = load({ remotes: [shortGrant] })
  const page = await mount(React.createElement(ui.api.testing.ConnectTab))
  await flush()
  const { DICT } = ui.api.testing
  const warnings = () => find(page, (node) => node.props['data-testid'] === 'missing-remote-scope')
  assert.equal(warnings().length, 1, 'exactly one warning, on the short-grant row')
  assert.equal(warnings()[0].children.join(''), DICT.en.missingRemoteScope, 'the English sentence names the consequence and the fix')
  assert.match(DICT.en.missingRemoteScope, /Remote sessions and workspaces cannot appear/)
  assert.match(DICT.en.missingRemoteScope, /paired again/)
  // Both languages carry the sentence, and it is not an English copy.
  assert.ok(DICT.vi.missingRemoteScope)
  assert.notEqual(DICT.vi.missingRemoteScope, DICT.en.missingRemoteScope)
  assert.match(DICT.vi.missingRemoteScope, /ghép đôi lại/)
  // Nothing blocks: the row's buttons stay usable.
  assert.equal(button(page, 'Open').props.disabled, false)
  await act(async () => { ui.setLocale('vi') })
  assert.equal(warnings()[0].children.join(''), DICT.vi.missingRemoteScope, 'the Vietnamese sentence renders too')
  page.unmount()

  const withScope = load({ remotes: [fullGrant] })
  const other = await mount(React.createElement(withScope.api.testing.ConnectTab))
  await flush()
  assert.equal(find(other, (node) => node.props['data-testid'] === 'missing-remote-scope').length, 0, 'no noise when the grant has the scope')
  assert.ok(!text(other).includes('Remote sessions and workspaces cannot appear'))
  // A gateway that predates scopes sends no list at all: nothing is claimed about it.
  const legacy = load({ remotes: [{ id: 'r3', name: 'Old', address: '192.168.1.41:3081', status: 'online', approvals: [] }] })
  const legacyPage = await mount(React.createElement(legacy.api.testing.ConnectTab))
  await flush()
  assert.equal(find(legacyPage, (node) => node.props['data-testid'] === 'missing-remote-scope').length, 0)
  other.unmount()
  legacyPage.unmount()
})

await check('a per-host refusal is shown on the remote row; the log line stays the audit trail', async () => {
  const remote = { id: 'r1', name: 'Sigma', address: '192.168.1.40:3081', status: 'online', approvals: [],
    device: { kind: 'desktop', scopes: ['sessions:read', 'harness:remote'] },
    hostError: { code: 'auth/forbidden-scope', scope: 'harness:remote', at: 1 } }
  const ui = load({ remotes: [remote] })
  const page = await mount(React.createElement(ui.api.testing.ConnectTab))
  await flush()
  const refused = find(page, (node) => node.props['data-testid'] === 'host-refused')
  assert.equal(refused.length, 1)
  assert.match(text(page), /auth\/forbidden-scope/)
  assert.match(text(page), /harness:remote/)
  assert.ok(text(page).includes(ui.api.testing.DICT.en.hostRefused))
  page.unmount()
})

await check('connect tab: a remote row can Reconnect without opening a session — one POST, the in-flight label, then the list re-reads; a revoked row has no button', async () => {
  // The chip's Reconnect only exists inside an open remote session, and Open reached the
  // host only as a side effect of the detail view; the row is the one-click path a user
  // has while the link is down.
  const remotes = [
    { id: 'r1', name: 'Laptop', address: '192.168.1.30:3081', status: 'offline', approvals: [] },
    { id: 'r2', name: 'Old', address: '192.168.1.31:3081', status: 'revoked', approvals: [] },
  ]
  const ui = load({ remotes })
  const page = await mount(React.createElement(ui.api.testing.ConnectTab))
  await flush()
  const { DICT } = ui.api.testing
  const reconnects = () => find(page, (node) => node.type === 'button' && node.props['data-testid'] === 'remote-reconnect')
  const posts = () => ui.calls.filter((call) => call.method === 'POST' && call.route === '/devices/remotes/r1/connect')
  assert.equal(reconnects().length, 1, 'one Reconnect: the row that is not revoked')
  assert.equal(reconnects()[0].children.join(''), DICT.en.reconnect, 'the existing label, not a new string')
  assert.equal(find(page, (node) => node.type === 'button' && node.children.join('') === DICT.en.reconnect).length, 1,
    'this view shows that label once, not once per row')
  assert.equal(reconnects()[0].props.disabled, false)
  assert.equal(ui.calls.filter((call) => /\/sessions$/.test(call.route)).length, 0, 'no session was opened to reach it')
  const intervalsBefore = ui.intervals.size
  let release
  ui.state.connectGate = new Promise((resolve) => { release = resolve })
  await act(async () => { reconnects()[0].props.onClick({ preventDefault() {}, target: {} }) })
  assert.equal(posts().length, 1, 'one click, one POST')
  assert.deepEqual(posts()[0].body, {})
  assert.equal(reconnects()[0].children.join(''), DICT.en.reconnecting, 'the row says it is dialling')
  assert.equal(reconnects()[0].props.disabled, true, 'and cannot be pressed again while in flight')
  // The Host now reports the link up: the tab's own refresh (not an added poll) shows it.
  ui.state.remotes = remotes.map((remote) => (remote.id === 'r1' ? { ...remote, status: 'online' } : remote))
  ui.calls.length = 0
  await act(async () => { release(); await new Promise((resolve) => setImmediate(resolve)) })
  assert.match(text(page), /Online/, 'the row re-read its state after the dial')
  assert.equal(ui.calls.filter((call) => call.route === '/devices/remotes').length, 1, 'the list this tab already polls, once')
  assert.equal(ui.intervals.size, intervalsBefore, 'no poll was added')
  assert.equal(reconnects()[0].children.join(''), DICT.en.reconnect, 'the label is back once it settles')
  page.unmount()
})

await check('connect tab: a failed Reconnect keeps the route\'s reason on that row (message or code), never a console line', async () => {
  const ui = load({ remotes: [{ id: 'r1', name: 'Laptop', address: '192.168.1.30:3081', status: 'offline', approvals: [] }] })
  const page = await mount(React.createElement(ui.api.testing.ConnectTab))
  await flush()
  const reconnects = () => find(page, (node) => node.type === 'button' && node.props['data-testid'] === 'remote-reconnect')
  const shown = () => find(page, (node) => node.props['data-testid'] === 'remote-reconnect-error')
  ui.state.connectFailure = { status: 409, body: { error: 'remote/host-offline', message: 'Laptop is offline; the link was not re-established' } }
  await click(reconnects()[0])
  assert.equal(shown().length, 1, 'the reason is on the page')
  assert.equal(shown()[0].props.role, 'alert')
  assert.equal(shown()[0].children.join(''), 'Laptop is offline; the link was not re-established')
  assert.equal(reconnects()[0].props.disabled, false, 'the row stays usable for another try')
  // A route that answers with a code alone still reaches the user.
  ui.state.connectFailure = { status: 502, body: { error: 'unreachable' } }
  await click(reconnects()[0])
  assert.equal(shown()[0].children.join(''), 'unreachable')
  page.unmount()
})

await check('connect tab: the row Reconnect renders in vi too, and the two dictionaries stay twins', async () => {
  const ui = load({ locale: 'vi', remotes: [{ id: 'r1', name: 'Laptop', address: '192.168.1.30:3081', status: 'offline', approvals: [] }] })
  const page = await mount(React.createElement(ui.api.testing.ConnectTab))
  await flush()
  const { DICT } = ui.api.testing
  const reconnects = () => find(page, (node) => node.type === 'button' && node.props['data-testid'] === 'remote-reconnect')
  assert.equal(reconnects()[0].children.join(''), DICT.vi.reconnect)
  assert.notEqual(DICT.vi.reconnect, DICT.en.reconnect, 'a real translation, not a copy')
  assert.deepEqual(Object.keys(DICT.vi).sort(), Object.keys(DICT.en).sort())
  page.unmount()
})

await check('connect tab: a remote with a pending automatic retry says so (en and vi); a plain offline one stays quiet', async () => {
  // The link supervisor dials by itself after a drop; "offline" alone reads like a
  // dead pairing, so the row names the retry that is already scheduled and keeps
  // the manual Reconnect button as it is.
  const retry = { attempt: 2, nextAt: Date.now() + 1500 }
  const remotes = [
    { id: 'r1', name: 'Laptop', address: '192.168.1.30:3081', status: 'offline', approvals: [], retry },
    { id: 'r2', name: 'Other', address: '192.168.1.31:3081', status: 'offline', approvals: [], retry: null },
  ]
  const ui = load({ remotes })
  const page = await mount(React.createElement(ui.api.testing.ConnectTab))
  await flush()
  const { DICT } = ui.api.testing
  const notes = () => find(page, (node) => node.props['data-testid'] === 'remote-retry')
  assert.equal(notes().length, 1, 'only the row with a scheduled retry')
  assert.equal(notes()[0].children.join(''), DICT.en.autoRetry)
  assert.notEqual(DICT.vi.autoRetry, DICT.en.autoRetry, 'a real translation, not a copy')
  assert.match(DICT.vi.autoRetry, /tự kết nối lại/)
  const reconnects = () => find(page, (node) => node.type === 'button' && node.props['data-testid'] === 'remote-reconnect')
  assert.equal(reconnects().length, 2, 'the manual Reconnect button stays')
  await act(async () => { ui.setLocale('vi') })
  assert.equal(notes()[0].children.join(''), DICT.vi.autoRetry, 'the Vietnamese note renders too')
  page.unmount()
})

await check('connect tab: a remote whose certificate changed says so in danger (en and vi); no retry note, no noise otherwise', async () => {
  // The supervisor stops retrying on `pin-mismatch` (a retry cannot fix a changed
  // certificate), so the row has to say what happened and that nothing was sent.
  const remotes = [
    { id: 'r1', name: 'Laptop', address: '192.168.1.30:3081', status: 'error', approvals: [], retry: null, linkError: 'pin-mismatch' },
    { id: 'r2', name: 'Other', address: '192.168.1.31:3081', status: 'offline', approvals: [], retry: null, linkError: null },
  ]
  const ui = load({ remotes })
  const page = await mount(React.createElement(ui.api.testing.ConnectTab))
  await flush()
  const { DICT } = ui.api.testing
  const notes = () => find(page, (node) => node.props['data-testid'] === 'remote-pin-mismatch')
  assert.equal(notes().length, 1, 'only the row whose pin no longer matches')
  assert.equal(notes()[0].children.join(''), DICT.en.pinMismatchNote)
  assert.equal(notes()[0].props.role, 'alert', 'a danger note, not a hint')
  assert.match(DICT.en.pinMismatchNote, /different certificate/)
  assert.match(DICT.en.pinMismatchNote, /Nothing was sent/)
  assert.match(DICT.en.pinMismatchNote, /Pair it again/)
  assert.notEqual(DICT.vi.pinMismatchNote, DICT.en.pinMismatchNote, 'a real translation, not a copy')
  assert.match(DICT.vi.pinMismatchNote, /chứng chỉ khác/)
  assert.match(DICT.vi.pinMismatchNote, /ghép đôi lại/)
  assert.deepEqual(Object.keys(DICT.vi).sort(), Object.keys(DICT.en).sort(), 'vi and en stay twins')
  // A terminal reason is not a retry: the two notes never coexist.
  assert.equal(find(page, (node) => node.props['data-testid'] === 'remote-retry').length, 0)
  // The manual Reconnect stays available: a human may still ask once.
  assert.equal(find(page, (node) => node.props['data-testid'] === 'remote-reconnect').length, 2)
  await act(async () => { ui.setLocale('vi') })
  assert.equal(notes()[0].children.join(''), DICT.vi.pinMismatchNote, 'the Vietnamese note renders too')
  page.unmount()
})

await check('connect tab: the Host\'s attachment bridge is on the remote row — off is muted, a broken route is an alert with its reason, healthy and unreported stay silent', async () => {
  // Spec 013: GET /devices/remotes carries `uploads` = { route, wrapped, reason,
  // dshVersion, pinned }. A route that is not wrapped makes every tagged upload
  // answer the native 404, so the row has to say so before the owner sends one.
  const remotes = [{ id: 'r1', name: 'Laptop', address: '192.168.1.30:3081', status: 'online', approvals: [], retry: null }]
  const noteIn = (ui, page) => find(page, (node) => node.props['data-testid'] === 'remote-uploads')

  // Broken (wrapped measured false after a file-upload reload): danger + reason.
  const broken = load({ remotes, uploads: { route: '/api/session/uploadFileBinary', wrapped: false, reason: 'route-replaced', dshVersion: '0.2.2-rc.1', pinned: '0.2.2-rc.1' } })
  const brokenPage = await mount(React.createElement(broken.api.testing.ConnectTab))
  await flush()
  const { DICT } = broken.api.testing
  const alerts = noteIn(broken, brokenPage)
  assert.equal(alerts.length, 1, 'one note per remote row')
  assert.equal(alerts[0].props.role, 'alert', 'a broken bridge is a danger note')
  assert.equal(alerts[0].props['data-reason'], 'route-replaced', 'the Host\'s own reason is kept')
  assert.ok(alerts[0].children.join('').includes(DICT.en.uploadsBroken), 'the English sentence names the failure')
  assert.ok(alerts[0].children.join('').includes('route-replaced'), 'and carries the reason verbatim')
  assert.match(DICT.en.uploadsBroken, /will fail/)
  assert.match(DICT.en.uploadsBroken, /not in place/)
  assert.notEqual(DICT.vi.uploadsBroken, DICT.en.uploadsBroken, 'a real translation, not a copy')
  await act(async () => { broken.setLocale('vi') })
  assert.ok(noteIn(broken, brokenPage)[0].children.join('').includes(DICT.vi.uploadsBroken), 'the Vietnamese sentence renders too')
  brokenPage.unmount()

  // Off by configuration: muted, not an alarm — nothing is broken.
  const off = load({ remotes, uploads: { route: null, wrapped: false, reason: 'disabled' } })
  const offPage = await mount(React.createElement(off.api.testing.ConnectTab))
  await flush()
  const muted = noteIn(off, offPage)
  assert.equal(muted.length, 1)
  assert.equal(muted[0].props.role, 'status', 'off is news, not a failure')
  assert.equal(muted[0].children.join(''), off.api.testing.DICT.en.uploadsOff, 'the off sentence is the whole line')
  assert.notEqual(off.api.testing.DICT.vi.uploadsOff, off.api.testing.DICT.en.uploadsOff, 'a real translation, not a copy')
  assert.deepEqual(Object.keys(off.api.testing.DICT.vi).sort(), Object.keys(off.api.testing.DICT.en).sort(), 'vi and en stay twins')
  await act(async () => { off.setLocale('vi') })
  assert.equal(noteIn(off, offPage)[0].children.join(''), off.api.testing.DICT.vi.uploadsOff)
  offPage.unmount()

  // Healthy: `wrapped` measured true — no noise at all.
  const healthy = load({ remotes, uploads: { route: '/api/session/uploadFileBinary', wrapped: true, reason: null, dshVersion: '0.2.2-rc.1', pinned: '0.2.2-rc.1' } })
  const healthyPage = await mount(React.createElement(healthy.api.testing.ConnectTab))
  await flush()
  assert.equal(noteIn(healthy, healthyPage).length, 0, 'a working bridge says nothing')
  assert.ok(!text(healthyPage).includes(healthy.api.testing.DICT.en.uploadsOff))
  healthyPage.unmount()

  // An older Host sends no `uploads` key: claim nothing rather than guess.
  const legacy = load({ remotes })
  const legacyPage = await mount(React.createElement(legacy.api.testing.ConnectTab))
  await flush()
  assert.equal(noteIn(legacy, legacyPage).length, 0, 'no field, no claim')
  legacyPage.unmount()
})

await check('connect tab: the remote row\'s notes (incl. the attachment-bridge note) are keyed — no React "unique key" warning', async () => {
  // React reports a missing key once per owner per process, so a console spy here can
  // be pre-empted by an earlier test. Assert the cause instead: every note rendered in
  // the row's list carries a key, and none were logged by this test's own renders.
  const remotes = [{ id: 'r1', name: 'Laptop', address: '192.168.1.30:3081', status: 'online', approvals: [], retry: { attempt: 1 } }]
  const warnings = []
  const original = console.error
  console.error = (...args) => { warnings.push(args.map(String).join(' ')) }
  try {
    for (const uploads of [
      { route: '/api/session/uploadFileBinary', wrapped: false, reason: 'route-replaced' },
      { route: null, wrapped: false, reason: 'disabled' },
    ]) {
      const ui = load({ remotes, uploads })
      const page = await mount(React.createElement(ui.api.testing.ConnectTab))
      await flush()
      const notes = find(page, (node) => ['remote-uploads', 'remote-retry'].includes(node.props['data-testid']))
      assert.equal(notes.length, 2, 'the retry and the uploads notes rendered')
      // test-renderer nodes hide `key`; read it off the live element tree instead.
      const keyed = page.root.findAll((node) => ['remote-uploads', 'remote-retry'].includes(node.props?.['data-testid']) && node.type === 'div')
      assert.ok(keyed.length >= 2)
      for (const node of keyed) assert.ok(node._fiber.key !== null && node._fiber.key !== undefined, `${node.props['data-testid']} has a key`)
      page.unmount()
    }
  } finally { console.error = original }
  assert.deepEqual(warnings.filter((line) => /unique "key"|Each child in a list/.test(line)), [], 'no key warning')
})

const ONLINE = { remoteControl: { enabled: true, accepting: true }, lan: { listening: true, urls: [] } }
const checkboxes = (page) => find(page, (node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.onChange)
const ticked = (page) => checkboxes(page).map((node, index) => (node.props.checked ? ALL[index] : null)).filter(Boolean)

await check('the UI scope list mirrors the contract: every desktop scope, presets equal SCOPE_PRESETS (drift fails here)', () => {
  const ui = load()
  const { ALL_SCOPES, SCOPE_PRESETS } = ui.api.testing
  assert.deepEqual([...ALL_SCOPES].sort(), [...CONTRACT_SCOPES].sort(), 'client.js lists exactly the contract SCOPES')
  assert.deepEqual([...ALL_SCOPES], ALL, 'checkbox order')
  assert.deepEqual([...SCOPE_PRESETS.standard].sort(), [...CONTRACT_PRESETS.standard].sort())
  assert.deepEqual([...SCOPE_PRESETS.full].sort(), [...CONTRACT_PRESETS.full].sort())
  for (const scope of ['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote', 'commands:execute',
    'workspace:manage', 'settings:write', 'credentials:write', 'plugins:manage', 'schedule:write', 'terminal']) {
    assert.ok(ALL_SCOPES.includes(scope), `${scope} is listed`)
  }
  for (const scope of DESKTOP_ONLY_SCOPES) assert.ok(ALL_SCOPES.includes(scope), `${scope} (desktop-only) is listed`)
})

await check('every scope has vi + en labels, every dangerous one a risk hint; vi and en stay twins', () => {
  const ui = load()
  const { DICT, ALL_SCOPES, RISKY_SCOPES } = ui.api.testing
  // Not a second list to curate: the very set the picker prints a risk line for. A
  // scope it flags but has no sentence for renders an empty hint under its checkbox.
  const dangerous = [...RISKY_SCOPES]
  for (const scope of dangerous) assert.ok(ALL_SCOPES.includes(scope), `${scope} (risky) is a listed scope`)
  for (const lang of ['en', 'vi']) {
    for (const scope of ALL_SCOPES) assert.ok(DICT[lang][`scope.${scope}`], `${lang} label for ${scope}`)
    for (const scope of dangerous) assert.ok(DICT[lang][`risk.${scope}`], `${lang} risk hint for ${scope}`)
    for (const key of ['presetStandard', 'presetFull', 'advancedLimits', 'limitsHelp', 'unlimited']) assert.ok(DICT[lang][key], `${lang} ${key}`)
  }
  assert.notEqual(DICT.vi['scope.terminal'], DICT.en['scope.terminal'])
  assert.deepEqual(Object.keys(DICT.vi).sort(), Object.keys(DICT.en).sort())
})

await check('Approve: lists all scopes, defaults to Standard, risk hints show, presets set the list, narrowed grant is sent', async () => {
  const item = { id: 'req-9', name: 'Dev box', clientIp: '10.0.0.8', kind: 'desktop', createdAt: 1_700_000_000_000, verificationCode: '654321',
    requestedScopes: [...ALL] }
  const ui = load({ pending: [item], status: ONLINE })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  assert.equal(checkboxes(page).length, ALL.length)
  assert.deepEqual(ticked(page), ['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote'], 'default = Standard')
  const rendered = text(page)
  assert.match(rendered, /Run slash commands/); assert.match(rendered, /Open a terminal/)
  assert.match(rendered, /Full shell on this Host/, 'a risk hint is shown for terminal')
  assert.match(rendered, /Can overwrite your API keys/)
  // "Full control" ticks everything, "Standard" returns to the default set.
  await click(find(page, (node) => node.type === 'button' && node.children.join('') === 'Full control')[0])
  assert.deepEqual(ticked(page), ALL)
  await click(find(page, (node) => node.type === 'button' && node.children.join('') === 'Standard')[0])
  assert.deepEqual(ticked(page), ['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote'])
  // Add one dangerous scope by hand and approve: exactly that list is sent.
  await act(async () => { checkboxes(page)[ALL.indexOf('terminal')].props.onChange({ target: { checked: true } }) })
  await click(button(page, 'Approve'))
  assert.deepEqual(ui.calls.find((call) => call.route === '/mgw/pending/req-9/approve').body.scopes,
    ['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote', 'terminal'])
  page.unmount()
  // vi labels + hints.
  const vi = load({ locale: 'vi', pending: [item], status: ONLINE })
  const viPage = await mount(React.createElement(vi.api.testing.AllowTab))
  await flush()
  assert.match(text(viPage), /Mở terminal/); assert.match(text(viPage), /Toàn quyền shell/)
  assert.ok(find(viPage, (node) => node.type === 'button' && node.children.join('') === 'Toàn quyền').length >= 1)
  viPage.unmount()
})

await check('Approve: a request that asked for less cannot be widened (extra scopes disabled; Full control cuts to the offer)', async () => {
  const item = { id: 'req-3', name: 'Small', clientIp: '10.0.0.9', kind: 'desktop', createdAt: 1_700_000_000_000, verificationCode: '111222',
    requestedScopes: ['sessions:read', 'harness:remote'] }
  const ui = load({ pending: [item], status: ONLINE })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  assert.deepEqual(ticked(page), ['sessions:read', 'harness:remote'], 'Standard narrowed to the offer')
  await click(find(page, (node) => node.type === 'button' && node.children.join('') === 'Full control')[0])
  assert.deepEqual(ticked(page), ['sessions:read', 'harness:remote'], 'Full control cannot exceed the offer')
  await click(button(page, 'Approve'))
  assert.deepEqual(ui.calls.find((call) => call.route === '/mgw/pending/req-3/approve').body, { scopes: ['sessions:read', 'harness:remote'] })
  page.unmount()
})

await check('Edit permissions: all scopes with risk hints and both presets; Full control re-pairs with every scope', async () => {
  const device = { id: 'dev-2', name: 'Box', displayName: 'Box', kind: 'desktop', scopes: ['sessions:read'], lastSeenAt: null, online: false }
  const ui = load({ devices: [device], status: ONLINE })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  await click(button(page, 'Edit permissions'))
  assert.equal(checkboxes(page).length, ALL.length)
  assert.deepEqual(ticked(page), ['sessions:read'])
  assert.match(text(page), /Can install or enable code that runs on this Host/)
  await click(find(page, (node) => node.type === 'button' && node.children.join('') === 'Full control')[0])
  assert.deepEqual(ticked(page), ALL)
  await click(find(page, (node) => node.type === 'button' && node.children.join('') === 'Standard')[0])
  assert.deepEqual(ticked(page), ['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote'])
  await click(find(page, (node) => node.type === 'button' && node.children.join('') === 'Full control')[0])
  await click(button(page, 'Generate new pairing code'))
  assert.deepEqual(ui.calls.find((call) => call.route === '/mgw/pair').body, { kind: 'desktop', scopes: ALL })
  page.unmount()
})

await check('OTP offer asks for every desktop scope (the Host picks at Approve)', async () => {
  const ui = load({ status: { remoteControl: { enabled: true, accepting: true }, lan: { listening: true, urls: ['wss://10.0.0.5:3081/ws/mobile'] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  await click(button(page, 'Generate pairing code'))
  assert.deepEqual(ui.calls.find((call) => call.route === '/mgw/pair').body.scopes, ALL)
  page.unmount()
})

await check('Advanced (Allow tab): shows remoteBridgeLimits read-only, 0 = unlimited; never writes the limits', async () => {
  const limits = { maxConnectionsPerDevice: 0, maxStreamsPerDevice: 32, maxInflightPerDevice: 0, callsPerSecond: 20, maxResultBytes: 0 }
  const ui = load({ status: { ...ONLINE, remoteBridgeLimits: limits } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  assert.match(text(page), /Advanced/)
  assert.doesNotMatch(text(page), /Open streams per device/, 'collapsed until opened')
  await click(find(page, (node) => node.type === 'button' && node.props['aria-expanded'] === false)[0])
  const value = (key) => find(page, (node) => node.props['data-testid'] === `limit-${key}`)[0].children.join('')
  assert.equal(value('maxConnectionsPerDevice'), '0 (unlimited)')
  assert.equal(value('maxStreamsPerDevice'), '32')
  assert.equal(value('callsPerSecond'), '20')
  assert.equal(value('maxResultBytes'), '0 (unlimited)')
  assert.match(text(page), /remoteBridgeLimits/, 'says where they are configured')
  assert.match(text(page), /cannot be changed from this page/)
  assert.equal(find(page, (node) => node.props['data-testid'] === 'advanced-limits')[0].findAll((node) => node.type === 'input').length, 0, 'read-only: no inputs')
  assert.equal(ui.calls.some((call) => call.method === 'POST' && /limit/i.test(call.route + JSON.stringify(call.body))), false)
  page.unmount()
  // A Host that reports nothing shows the defaults (unlimited).
  const bare = load({ status: ONLINE })
  const barePage = await mount(React.createElement(bare.api.testing.AllowTab))
  await flush()
  await click(find(barePage, (node) => node.type === 'button' && node.props['aria-expanded'] === false)[0])
  assert.equal(find(barePage, (node) => node.props['data-testid'] === 'limit-callsPerSecond')[0].children.join(''), '0 (unlimited)')
  barePage.unmount()
})

// T036: the listener's real bind (from /mgw/status, the poll AllowTab already runs).
const PIN = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join(':')
const LAN_UP = { enabled: true, listening: true, host: '127.0.0.1', port: 3081, urls: ['wss://127.0.0.1:3081/ws/mobile'],
  requireAuth: true, tls: true, certSha256: PIN, error: null }
const byTestId = (page, id) => find(page, (node) => node.props['data-testid'] === id)
// Text of one subtree only (the port-risk note must be read apart from the raw error row).
const flatText = (node) => (typeof node === 'string' ? node : (node.children || []).map(flatText).join(' '))

await check('listening on: a loopback bind shows the real bind + pin and warns that no other machine can connect, naming where to change it', async () => {
  const ui = load({ status: { ...ONLINE, lan: LAN_UP, tailscale: { addresses: ['100.64.0.10'], urls: [] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  const rendered = text(page)
  const { DICT } = ui.api.testing
  assert.equal(byTestId(page, 'listener-bind')[0].children.join(''), 'wss://127.0.0.1:3081/ws/mobile', 'the URL the listener really serves')
  assert.equal(byTestId(page, 'listener-state')[0].children.join(''), DICT.en.listenerUp)
  assert.ok(rendered.includes(DICT.en.listeningOn))
  assert.equal(byTestId(page, 'listener-loopback').length, 1, 'a loopback bind is called out')
  // The route is one chip in the header, and the warning is a quiet line: no box,
  // no bold heading, and the address is not printed a second time inside it.
  const route = byTestId(page, 'listener-route')[0]
  assert.equal(route.children.join(''), DICT.en.routeLoopback, 'the header names the route in one word')
  assert.equal(route.props.className, 'dshdev-badge')
  const loopbackNote = byTestId(page, 'listener-loopback')[0]
  assert.match(String(loopbackNote.props.className), /dshdev-note/, 'a note, not a banner')
  assert.equal(loopbackNote.findAll((node) => node.type === 'strong').length, 0, 'no bold heading')
  const card = byTestId(page, 'listening-on')[0]
  assert.equal(card.findAll((node) => typeof node.type === 'string'
    && /dshdev-banner/.test(String(node.props.className || ''))).length, 0, 'no callout box in the card')
  assert.equal(flatText(card).split('wss://127.0.0.1:3081/ws/mobile').length - 1, 1,
    'the address is stated once — the note no longer repeats it')
  // The address and the pin each carry a copy button at the same weight.
  assert.equal(byTestId(page, 'listening-on')[0].findAll((node) => node.type === 'button'
    && node.props.className === 'dshdev-btn').length, 2, 'copy the address, copy the pin')
  // The warning says where the owner changes it and that a certificate is not needed.
  assert.match(rendered, /Settings → Plugins/)
  assert.match(rendered, /mobile-gateway row/)
  assert.match(rendered, /lanHost/)
  assert.match(rendered, /Tailscale/)
  assert.match(rendered, /no new certificate/)
  // The certificate pin is shown shortened; the full value stays on the element.
  const [pin] = byTestId(page, 'listener-pin')
  const shown = pin.children.join('')
  assert.ok(shown.length < PIN.length, 'the pin is truncated')
  assert.ok(shown.startsWith(PIN.slice(0, 17)) && shown.endsWith(PIN.slice(-11)), `truncated pin: ${shown}`)
  assert.equal(pin.props.title, PIN, 'the full pin is still available (it is what a client pins)')
  // The old "reachable" prose is gone everywhere: the route chip carries that fact.
  assert.doesNotMatch(rendered, /Reachable from other machines/, 'no "reachable" heading')
  assert.doesNotMatch(rendered, /this machine's Tailscale addresses/, 'no tailnet sentence')
  page.unmount()
})

await check('listening on: a non-loopback bind shows the address and, when it is a Tailscale address, the route chip says so', async () => {
  const lan = { ...LAN_UP, host: '100.64.0.10', urls: ['wss://100.64.0.10:3081/ws/mobile'] }
  const ui = load({ status: { ...ONLINE, lan, tailscale: { addresses: ['100.64.0.10'], urls: lan.urls } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  const rendered = text(page)
  const { DICT } = ui.api.testing
  assert.equal(byTestId(page, 'listener-loopback').length, 0, 'no loopback warning off loopback')
  assert.equal(byTestId(page, 'listener-bind')[0].children.join(''), 'wss://100.64.0.10:3081/ws/mobile')
  // The invariant the removed paragraph carried: the page still tells the owner this
  // bind is a Tailscale address. The route chip is now the one place that says it.
  assert.equal(byTestId(page, 'listener-route')[0].children.join(''), DICT.en.routeTailscale,
    'the header chip names the tailnet instead of describing it')
  assert.ok(rendered.includes(DICT.en.routeTailscale), 'the chip says "Tailscale" on the page')
  // ...and the prose that restated the chip is gone: no heading, no tailnet sentence.
  assert.doesNotMatch(rendered, /Reachable from other machines/, 'the "reachable" heading is gone')
  assert.doesNotMatch(rendered, /this machine's Tailscale addresses/, 'the tailnet sentence is gone')
  assert.equal(byTestId(page, 'listener-reachable').length, 0, 'no "reachable" block')
  assert.equal(byTestId(page, 'listener-tailscale').length, 0, 'no tailnet line')
  // One statement per fact: the address row states the URL, and no note repeats it.
  assert.equal(flatText(byTestId(page, 'listening-on')[0]).split('wss://100.64.0.10:3081/ws/mobile').length - 1, 1,
    'the URL is printed once')
  // The card is the chips plus two lines; the only note left is the port warning
  // (3081 sits in a dynamic range), not a re-statement of who can connect.
  const notes = page.root.findAll((node) => typeof node.type === 'string'
    && /(^| )dshdev-note( |$)/.test(String(node.props.className || '')))
  assert.deepEqual(notes.map((node) => node.props['data-testid']), ['listener-port-risk'],
    'no note restates the route chip')
  page.unmount()
  // A bind that is neither loopback nor a local Tailscale address gets no Tailscale
  // claim and no note at all: the "LAN" chip is the whole statement. (30081 is in
  // the safe port band, so the port note stays quiet too.)
  const quietLan = { ...LAN_UP, host: '192.168.1.20', port: 30081, urls: ['wss://192.168.1.20:30081/ws/mobile'] }
  const other = load({ status: { ...ONLINE, lan: quietLan, tailscale: { addresses: ['100.64.1.2'], urls: [] } } })
  const otherPage = await mount(React.createElement(other.api.testing.AllowTab))
  await flush()
  assert.equal(byTestId(otherPage, 'listener-reachable').length, 0, 'a plain LAN bind states nothing twice')
  assert.equal(byTestId(otherPage, 'listener-tailscale').length, 0)
  assert.equal(byTestId(otherPage, 'listener-route')[0].children.join(''), other.api.testing.DICT.en.routeLan,
    'a plain LAN bind is not claimed as a tailnet address')
  assert.doesNotMatch(text(otherPage), /this machine's Tailscale addresses/)
  // ...and the card is silent: no note of any kind in that normal case — the
  // Tailscale bind above is the only one that used to add a sentence.
  const otherCard = otherPage.root.findAll((node) => typeof node.type === 'string'
    && /(^| )dshdev-note( |$)/.test(String(node.props.className || '')))
  assert.equal(otherCard.length, 0, 'a normal non-loopback bind renders no note')
  otherPage.unmount()
})

await check('listening on: listener down shows the off state, the error verbatim, and no loopback warning', async () => {
  const lan = { enabled: false, listening: false, host: '127.0.0.1', port: 3081, urls: [], requireAuth: true,
    tls: false, certSha256: null, error: 'EADDRINUSE: 127.0.0.1:3081' }
  const ui = load({ status: { ...ONLINE, lan, tailscale: { addresses: [], urls: [] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  const { DICT } = ui.api.testing
  assert.equal(byTestId(page, 'listener-state')[0].children.join(''), DICT.en.listenerDown)
  assert.equal(byTestId(page, 'listener-error')[0].children.join(''), 'EADDRINUSE: 127.0.0.1:3081', 'shown verbatim')
  assert.equal(byTestId(page, 'listener-loopback').length, 0, 'a listener that is off cannot be unreachable')
  assert.doesNotMatch(text(page), /Reachable from other machines/, 'the "reachable" prose is gone')
  assert.equal(byTestId(page, 'listener-reachable').length, 0)
  assert.equal(byTestId(page, 'listener-bind')[0].children.join(''), '127.0.0.1:3081', 'host:port without a URL')
  page.unmount()
})

// Port risk: a listener inside the OS dynamic range can lose its port to an
// outgoing connection's source port, so the card explains it — and stays quiet
// in the safe band. Ports here come from /mgw/status, the poll AllowTab runs.
const riskLan = (port) => ({ enabled: true, listening: true, host: '192.168.1.20', port,
  urls: [`wss://192.168.1.20:${port}/ws/mobile`], requireAuth: true, tls: true, certSha256: null, error: null })
const BUSY_LAN = { enabled: false, listening: false, host: '127.0.0.1', port: 30081, urls: [], requireAuth: true,
  tls: false, certSha256: null, error: 'EADDRINUSE: 127.0.0.1:30081' }

await check('listening on: a safe-band port (30081) says nothing about port risk', async () => {
  const ui = load({ status: { ...ONLINE, lan: riskLan(30081), tailscale: { addresses: [], urls: [] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  assert.equal(byTestId(page, 'listener-port-risk').length, 0, 'no row when there is nothing to say')
  const rendered = text(page)
  assert.ok(!rendered.includes(ui.api.testing.DICT.en.portRiskBody))
  assert.ok(!rendered.includes(ui.api.testing.DICT.en.portRiskSafeBand))
  page.unmount()
})

await check('listening on: a port in the measured retuned range (3081) gets the note, naming the safe band', async () => {
  const ui = load({ status: { ...ONLINE, lan: riskLan(3081), tailscale: { addresses: [], urls: [] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  const { DICT } = ui.api.testing
  const [note] = byTestId(page, 'listener-port-risk')
  assert.ok(note, 'the note is rendered')
  // One compact line under the facts, not a bordered panel with a heading.
  assert.match(String(note.props.className), /dshdev-note/)
  assert.equal(note.findAll((node) => node.type === 'strong').length, 0, 'no bold heading')
  const rendered = flatText(note)
  assert.ok(rendered.includes(DICT.en.portRiskBody), 'says the bind can fail at a random moment')
  assert.ok(rendered.includes(DICT.en.portRiskSafeBand), 'names the safe band')
  assert.match(rendered, /20000-39999/)
  page.unmount()
})

await check('listening on: a port in the Windows default dynamic range (50000) gets the note too', async () => {
  const ui = load({ status: { ...ONLINE, lan: riskLan(50000), tailscale: { addresses: [], urls: [] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  const { DICT } = ui.api.testing
  const [note] = byTestId(page, 'listener-port-risk')
  assert.ok(note, 'the note is rendered')
  assert.ok(flatText(note).includes(DICT.en.portRiskBody))
  assert.equal(byTestId(page, 'listener-port-risk').length, 1, 'one note, not one per row')
  page.unmount()
})

await check('listening on port risk: both dynamic ranges are inclusive at their edges — 15000 and 49152 warn, 15001 and 49151 stay quiet', async () => {
  // 1024-15000 is the measured range on the machine this was built for; 49152-65535
  // is the Windows default. The edge ports are what an off-by-one would get wrong.
  for (const [port, risky] of [[15000, true], [15001, false], [49152, true], [49151, false]]) {
    const ui = load({ status: { ...ONLINE, lan: riskLan(port), tailscale: { addresses: [], urls: [] } } })
    const page = await mount(React.createElement(ui.api.testing.AllowTab))
    await flush()
    assert.equal(byTestId(page, 'listener-port-risk').length, risky ? 1 : 0,
      `port ${port} ${risky ? 'is inside a dynamic range and warns' : 'is outside both ranges and stays quiet'}`)
    page.unmount()
  }
})

await check('listening on: a busy port keeps the error verbatim while the note explains the cause instead of repeating it', async () => {
  const ui = load({ status: { ...ONLINE, lan: BUSY_LAN, tailscale: { addresses: [], urls: [] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  const { DICT } = ui.api.testing
  assert.equal(byTestId(page, 'listener-error')[0].children.join(''), 'EADDRINUSE: 127.0.0.1:30081', 'shown verbatim')
  const [note] = byTestId(page, 'listener-port-risk')
  assert.ok(note, 'a busy port is explained')
  const rendered = flatText(note)
  assert.ok(rendered.includes(DICT.en.portBusyBody), 'explains the cause')
  assert.match(rendered, /busy port/i, 'names the busy port')
  assert.ok(!rendered.includes('EADDRINUSE'), 'explains the cause, does not repeat the raw text')
  page.unmount()
})

await check('listening on port risk: every new string exists in vi and en; vi/en key sets stay identical', async () => {
  const keys = ['portRiskBody', 'portRiskSafeBand', 'portBusyBody']
  const states = [
    { ...ONLINE, lan: riskLan(3081), tailscale: { addresses: [], urls: [] } },
    { ...ONLINE, lan: BUSY_LAN, tailscale: { addresses: [], urls: [] } },
  ]
  for (const locale of ['en-US', 'vi']) {
    const ui = load({ locale, status: states[0] })
    const { DICT } = ui.api.testing
    const lang = locale === 'vi' ? 'vi' : 'en'
    const seen = new Set()
    // One mount per state, collecting which of the new strings the page renders.
    for (const status of states) {
      ui.state.status = status
      const page = await mount(React.createElement(ui.api.testing.AllowTab))
      await flush()
      const rendered = text(page)
      for (const key of keys) if (rendered.includes(DICT[lang][key])) seen.add(key)
      page.unmount()
    }
    assert.deepEqual([...seen].sort(), [...keys].sort(), `${locale} renders every new string`)
  }
  const ui = load()
  const { DICT } = ui.api.testing
  assert.deepEqual(Object.keys(DICT.vi).sort(), Object.keys(DICT.en).sort(), 'vi and en stay twins')
})

await check('listening on: every new string exists in vi and en; vi/en key sets stay identical', async () => {
  const keys = ['listeningOn', 'listenerUp', 'listenerDown', 'listenerUnknown', 'certPin',
    'routeLoopback', 'routeLan', 'routeTailscale', 'loopbackWarning', 'reachableNote']
  const states = [
    // loopback bind: the loopback route and its one long warning.
    { ...ONLINE, lan: LAN_UP, tailscale: { addresses: ['100.64.0.10'], urls: [] } },
    // a plain LAN bind: the LAN route, the count-free "who can connect" line.
    { ...ONLINE, lan: riskLan(30081), tailscale: { addresses: ['100.64.0.10'], urls: [] } },
    // a tailnet bind: the Tailscale route, said once in the chip.
    { ...ONLINE, lan: { ...LAN_UP, host: '100.64.0.10', urls: ['wss://100.64.0.10:3081/ws/mobile'] }, tailscale: { addresses: ['100.64.0.10'], urls: [] } },
    { remoteControl: { enabled: false, accepting: false } },
  ]
  for (const locale of ['en-US', 'vi']) {
    const ui = load({ locale, status: states[0] })
    const { DICT } = ui.api.testing
    const lang = locale === 'vi' ? 'vi' : 'en'
    const seen = new Set()
    // One mount per state, collecting which new strings the page actually renders.
    for (const status of states) {
      ui.state.status = status
      const page = await mount(React.createElement(ui.api.testing.AllowTab))
      await flush()
      const rendered = text(page)
      for (const key of keys) if (rendered.includes(DICT[lang][key])) seen.add(key)
      page.unmount()
    }
    assert.deepEqual([...seen].sort(), [...keys].sort(), `${locale} renders every new string`)
  }
  const ui = load()
  const { DICT } = ui.api.testing
  assert.deepEqual(Object.keys(DICT.vi).sort(), Object.keys(DICT.en).sort(), 'vi and en stay twins')
})

await check('listening on: read-only — no write request and no input for this block, only the two copy buttons', async () => {
  const ui = load({ status: { ...ONLINE, lan: LAN_UP, tailscale: { addresses: ['100.64.0.10'], urls: [] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  assert.deepEqual([...new Set(ui.calls.map((call) => call.route))].sort(),
    ['/mgw/devices', '/mgw/pending', '/mgw/status'], 'the block adds no request: it reuses the polls already on this tab')
  assert.equal(ui.calls.some((call) => call.method !== 'GET'), false, 'no write, no dial')
  const [card] = byTestId(page, 'listening-on')
  assert.equal(card.findAll((node) => node.type === 'input').length, 0, 'read-only: no input')
  // The only controls are the two copy buttons (address, pin): copying changes
  // nothing on the Host, and no click on this card sends a request.
  const controls = card.findAll((node) => node.type === 'button')
  assert.equal(controls.length, 2, 'exactly the address and pin copy buttons')
  assert.deepEqual(controls.map((node) => node.props.className), ['dshdev-btn', 'dshdev-btn'])
  assert.deepEqual(controls.map((node) => node.children.join('')), [ui.api.testing.DICT.en.copy, ui.api.testing.DICT.en.copy])
  await act(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.equal(ui.calls.some((call) => call.method !== 'GET'), false, 'still no write, no dial')
  page.unmount()
})

// Connection plan (POST /mgw/listen): the one writer on the Allow tab. It binds
// the listener to one of this machine's own addresses, so the address and URLs the
// Listening on card shows must follow the response instead of a config edit.
// The control is one section inside the "Advanced" disclosure now (the page starts
// quiet), so every check below opens that disclosure before reading it.
const PLAN_LAN = { ...LAN_UP, host: '100.64.0.7', urls: ['wss://100.64.0.7:3081/ws/mobile'] }
const planSelect = (page) => byTestId(page, 'plan-select')[0]
const planOption = (page, label) => find(page, (node) => node.type === 'option' && node.children.join('') === label)[0]
const LISTEN = (ui) => ui.calls.filter((call) => call.route === '/mgw/listen')
// The one disclosure on the Allow tab (the plan and the limits live inside it).
const advancedToggle = (page) => find(page, (node) => node.type === 'button' && node.props['aria-expanded'] === false)[0]
const openAdvanced = async (page) => {
  const toggle = advancedToggle(page)
  assert.ok(toggle, 'the Advanced disclosure is on the tab, closed')
  await click(toggle)
}

await check('connection plan: the current plan is derived from status — loopback, a 100.64 Tailscale address, a private LAN address', async () => {
  const cases = [
    ['loopback', LAN_UP, { addresses: ['100.64.0.7'], urls: [] }],
    ['tailscale', PLAN_LAN, { addresses: ['100.64.0.7'], urls: [] }],
    ['lan', { ...LAN_UP, host: '192.168.1.20', urls: ['wss://192.168.1.20:3081/ws/mobile'] }, { addresses: ['100.64.0.7'], urls: [] }],
    // The 100.64.0.0/10 range is enough on its own, even when the gateway listed no address.
    ['tailscale', { ...LAN_UP, host: '100.100.1.9', urls: [] }, { addresses: [], urls: [] }],
  ]
  for (const [expected, lan, tailscale] of cases) {
    const ui = load({ status: { ...ONLINE, lan, tailscale } })
    const page = await mount(React.createElement(ui.api.testing.AllowTab))
    await flush()
    await openAdvanced(page)
    assert.equal(planSelect(page).props.value, expected, `${lan.host} is the ${expected} plan`)
    assert.equal(planSelect(page).props.disabled, false, 'a known plan is selectable')
    page.unmount()
  }
})

await check('connection plan: choosing Tailscale sends exactly one POST /mgw/listen { target: "tailscale" } and the card shows the returned URL + address', async () => {
  const ui = load({ status: { ...ONLINE, lan: LAN_UP, tailscale: { addresses: ['100.64.0.7'], urls: [] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  await openAdvanced(page)
  assert.equal(planSelect(page).props.value, 'loopback')
  ui.calls.length = 0
  await act(async () => { await planSelect(page).props.onChange({ target: { value: 'tailscale' } }) })
  const listens = LISTEN(ui)
  assert.equal(listens.length, 1, 'exactly one rebind')
  assert.equal(listens[0].method, 'POST')
  assert.deepEqual(listens[0].body, { target: 'tailscale' })
  assert.equal(planSelect(page).props.value, 'tailscale', 'the select follows the applied plan')
  // The point of the feature: the Tailscale address is visible after the mapping.
  const urls = flatText(byTestId(page, 'plan-tailscale-urls')[0])
  assert.match(urls, /wss:\/\/100\.64\.0\.7:30081\/ws\/mobile/)
  assert.equal(byTestId(page, 'plan-tailscale-addresses')[0].children.join(''), '100.64.0.7', 'the plain address is secondary text')
  // The read-only card below is updated from the response, not from the next poll.
  assert.equal(byTestId(page, 'listener-bind')[0].children.join(''), 'wss://100.64.0.7:30081/ws/mobile')
  assert.equal(byTestId(page, 'listener-route')[0].children.join(''), ui.api.testing.DICT.en.routeTailscale,
    'a Tailscale bind is named in the route chip')
  assert.equal(byTestId(page, 'listener-reachable').length, 0, 'and nothing restates it in prose')
  assert.equal(byTestId(page, 'listener-pin')[0].props.title, PIN, 'the pin still comes from status after the rebind')
  page.unmount()
})

await check('connection plan: without a detected Tailscale interface the option is disabled and says why', async () => {
  const ui = load({ status: { ...ONLINE, lan: LAN_UP, tailscale: { addresses: [], urls: [] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  await openAdvanced(page)
  assert.equal(planOption(page, 'Tailscale private network').props.disabled, true)
  assert.equal(planOption(page, 'LAN').props.disabled, false)
  assert.ok(text(page).includes(ui.api.testing.DICT.en.planTailscaleUnavailable), 'the reason is shown')
  assert.equal(byTestId(page, 'plan-tailscale-unavailable').length, 1)
  page.unmount()
})

await check('connection plan: a 409 tailscale/not-detected shows the message, puts the select back on the real plan, and fires no retry', async () => {
  const ui = load({ status: { ...ONLINE, lan: LAN_UP, tailscale: { addresses: ['100.64.0.7'], urls: [] } },
    listenFailure: { status: 409, body: { error: 'tailscale/not-detected', message: 'No Tailscale interface address on this machine.' } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  await openAdvanced(page)
  await act(async () => { await planSelect(page).props.onChange({ target: { value: 'tailscale' } }) })
  assert.equal(byTestId(page, 'plan-error')[0].children.join(''), 'No Tailscale interface address on this machine.')
  assert.match(text(page), /No Tailscale interface address on this machine\./)
  assert.equal(planSelect(page).props.value, 'loopback', 'back on the plan status reports')
  assert.equal(planSelect(page).props.disabled, false, 'the owner can try another plan')
  await flush()
  assert.equal(LISTEN(ui).length, 1, 'the fallback fires no second rebind')
  assert.equal(byTestId(page, 'listener-bind')[0].children.join(''), 'wss://127.0.0.1:3081/ws/mobile', 'the bind did not move')
  page.unmount()
  // The same refusal on a Vietnamese page: the known reason is named in
  // Vietnamese instead of pasting the route's English sentence onto the page.
  const vi = load({ locale: 'vi', status: { ...ONLINE, lan: LAN_UP, tailscale: { addresses: ['100.64.0.7'], urls: [] } },
    listenFailure: { status: 409, body: { error: 'tailscale/not-detected', message: 'No Tailscale interface address on this machine.' } } })
  const viPage = await mount(React.createElement(vi.api.testing.AllowTab))
  await flush()
  await openAdvanced(viPage)
  await act(async () => { await planSelect(viPage).props.onChange({ target: { value: 'tailscale' } }) })
  const viReason = byTestId(viPage, 'plan-error')[0].children.join('')
  assert.equal(viReason, vi.api.testing.DICT.vi.planErrTailscale, 'the Vietnamese page names the reason in Vietnamese')
  assert.notEqual(viReason, vi.api.testing.DICT.en.planErrTailscale)
  assert.equal(text(viPage).includes('No Tailscale interface address on this machine.'), false,
    'no raw English reason printed on the Vietnamese page')
  assert.equal(LISTEN(vi).length, 1, 'and still exactly one rebind, no retry')
  viPage.unmount()
})

await check('connection plan: two rapid selections cannot put two rebinds in flight', async () => {
  const ui = load({ status: { ...ONLINE, lan: LAN_UP, tailscale: { addresses: ['100.64.0.7'], urls: [] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  await openAdvanced(page)
  let release
  ui.state.listenGate = new Promise((resolve) => { release = resolve })
  await act(async () => {
    planSelect(page).props.onChange({ target: { value: 'tailscale' } })
    planSelect(page).props.onChange({ target: { value: 'lan' } })
  })
  assert.equal(LISTEN(ui).length, 1, 'the second selection is ignored while busy')
  assert.equal(LISTEN(ui)[0].body.target, 'tailscale')
  assert.equal(planSelect(page).props.disabled, true, 'the select is locked while applying')
  assert.ok(text(page).includes(ui.api.testing.DICT.en.planApplying), 'the applying hint shows')
  await act(async () => { release(); await new Promise((resolve) => setImmediate(resolve)) })
  assert.equal(planSelect(page).props.value, 'tailscale')
  assert.equal(planSelect(page).props.disabled, false)
  page.unmount()
})

await check('connection plan: the LAN option is honest — it names the first private address the OS reports and shows the address it actually bound', async () => {
  // The gateway's `lan` target is the first private IPv4 the OS reports in Node's
  // interface order; on the machine this was built for that is a WireGuard adapter
  // (10.253.0.1), not the household LAN. The control must say so and show the bind.
  const privateLan = { ...LAN_UP, host: '10.253.0.1', urls: ['wss://10.253.0.1:3081/ws/mobile'] }
  const ui = load({ status: { ...ONLINE, lan: privateLan, tailscale: { addresses: [], urls: [] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  await openAdvanced(page)
  const planCard = flatText(byTestId(page, 'connection-plan')[0])
  // The distinguishing phrases, not the whole sentence, so the copy can be edited.
  assert.match(planCard, /first private address the operating system reports/)
  assert.match(planCard, /VPN or virtual adapter/)
  assert.match(planCard, /Tailscale option or set the listen address in the gateway config/)
  // The exact bind sits next to the plan control, not only in the card below.
  assert.match(flatText(byTestId(page, 'plan-bound')[0]), /wss:\/\/10\.253\.0\.1:3081\/ws\/mobile/)
  // A private/virtual address is named as what happened, quietly (no alert styling).
  const hint = byTestId(page, 'plan-private-hint')[0]
  assert.match(flatText(hint), /private or virtual address/i)
  assert.match(flatText(hint), /10\.253\.0\.1/)
  assert.equal(hint.props.role, undefined, 'a non-fatal condition, not an alert')
  assert.equal(byTestId(page, 'listener-bind')[0].children.join(''), 'wss://10.253.0.1:3081/ws/mobile',
    'the card below agrees with the plan card')
  page.unmount()
  // A loopback bind says nothing extra: there is no private-address hint to give.
  const loopback = load({ status: { ...ONLINE, lan: LAN_UP, tailscale: { addresses: [], urls: [] } } })
  const loopbackPage = await mount(React.createElement(loopback.api.testing.AllowTab))
  await flush()
  await openAdvanced(loopbackPage)
  assert.equal(byTestId(loopbackPage, 'plan-private-hint').length, 0, 'quiet when there is nothing to say')
  assert.match(flatText(byTestId(loopbackPage, 'plan-bound')[0]), /wss:\/\/127\.0\.0\.1:3081\/ws\/mobile/)
  loopbackPage.unmount()
})

await check('connection plan: the LAN consent strings exist in vi and en, render in both, and vi/en key sets stay identical', async () => {
  const keys = ['planLanCaveat', 'planBound', 'planPrivateHint']
  const privateLan = { ...LAN_UP, host: '10.253.0.1', urls: ['wss://10.253.0.1:3081/ws/mobile'] }
  for (const locale of ['en-US', 'vi']) {
    const ui = load({ locale, status: { ...ONLINE, lan: privateLan, tailscale: { addresses: [], urls: [] } } })
    const { DICT } = ui.api.testing
    const lang = locale === 'vi' ? 'vi' : 'en'
    const page = await mount(React.createElement(ui.api.testing.AllowTab))
    await flush()
    await openAdvanced(page)
    const rendered = flatText(byTestId(page, 'connection-plan')[0])
    for (const key of keys) {
      assert.ok(DICT[lang][key], `${lang} ${key} exists`)
      assert.ok(rendered.includes(DICT[lang][key]), `${locale} renders ${key}`)
    }
    page.unmount()
  }
  const { DICT } = load().api.testing
  assert.deepEqual(Object.keys(DICT.vi).sort(), Object.keys(DICT.en).sort(), 'vi and en stay twins')
})

await check('connection plan: every new string exists in vi and en (identical key sets); the block adds one POST /mgw/listen and nothing else', async () => {
  const keys = ['planTitle', 'planHelp', 'plan.loopback', 'plan.lan', 'plan.tailscale', 'planApplying',
    'planUnknown', 'planTailscaleUnavailable']
  const ui0 = load()
  for (const lang of ['en', 'vi']) for (const key of keys) assert.ok(ui0.api.testing.DICT[lang][key], `${lang} ${key}`)
  // The refusal reasons are strings too: they exist in both languages even though
  // they only render after a failed POST (asserted in the 409 test above).
  for (const lang of ['en', 'vi']) for (const key of ['planErrTailscale', 'planErrLan', 'planErrDisabled']) {
    assert.ok(ui0.api.testing.DICT[lang][key], `${lang} ${key}`)
  }
  assert.deepEqual(Object.keys(ui0.api.testing.DICT.vi).sort(), Object.keys(ui0.api.testing.DICT.en).sort(), 'vi and en stay twins')
  for (const locale of ['en-US', 'vi']) {
    const ui = load({ locale, status: { ...ONLINE, lan: LAN_UP, tailscale: { addresses: ['100.64.0.7'], urls: [] } } })
    const { DICT } = ui.api.testing
    const lang = locale === 'vi' ? 'vi' : 'en'
    const seen = new Set()
    const collect = (page) => {
      const rendered = text(page)
      for (const key of keys) if (rendered.includes(DICT[lang][key])) seen.add(key)
    }
    const page = await mount(React.createElement(ui.api.testing.AllowTab))
    await flush()
    await openAdvanced(page)
    collect(page)
    // In flight: the "applying" hint. The request is held open so it renders.
    let release
    ui.state.listenGate = new Promise((resolve) => { release = resolve })
    await act(async () => { planSelect(page).props.onChange({ target: { value: 'tailscale' } }) })
    collect(page)
    await act(async () => { release(); await new Promise((resolve) => setImmediate(resolve)) })
    page.unmount()
    // No status from the gateway: the plan is unknown and the select is disabled.
    const bare = load({ locale })
    bare.state.status = null
    const barePage = await mount(React.createElement(bare.api.testing.AllowTab))
    await flush()
    await openAdvanced(barePage)
    assert.equal(byTestId(barePage, 'plan-select')[0].props.disabled, true, 'no status, no plan')
    collect(barePage)
    barePage.unmount()
    // No Tailscale interface: the third option is off, with the reason.
    const off = load({ locale, status: { ...ONLINE, lan: LAN_UP, tailscale: { addresses: [], urls: [] } } })
    const offPage = await mount(React.createElement(off.api.testing.AllowTab))
    await flush()
    await openAdvanced(offPage)
    collect(offPage)
    offPage.unmount()
    const missing = keys.filter((key) => !seen.has(key))
    assert.ok(missing.length === 0, `${locale} does not render: ${missing.join(', ')}`)
  }
  // This block is the only writer: the tab's polls stay GETs plus the single listen POST.
  const ui = load({ status: { ...ONLINE, lan: LAN_UP, tailscale: { addresses: ['100.64.0.7'], urls: [] } } })
  const page = await mount(React.createElement(ui.api.testing.AllowTab))
  await flush()
  await openAdvanced(page)
  await act(async () => { await planSelect(page).props.onChange({ target: { value: 'tailscale' } }) })
  assert.deepEqual([...new Set(ui.calls.map((call) => `${call.method} ${call.route}`))].sort(),
    ['GET /mgw/devices', 'GET /mgw/pending', 'GET /mgw/status', 'POST /mgw/listen'])
  page.unmount()
})

// --- Qoder-style presentation of the Devices page ---------------------------
// Presentation only: these checks read the markup this file renders and the one
// stylesheet it injects. Nothing here adds a route, a timer or a request.
const roles = (page, role) => find(page, (node) => node.props.role === role)
const flowOf = (page) => byTestId(page, 'flow')[0]
const flowNote = (page) => find(page, (node) => node.props.className === 'dshdev-flow-note')[0].children.join('')

await check('settings page: the two tabs are one segmented control — same ids, labels and order, plus one muted subtitle', async () => {
  const ui = load()
  const page = await mount(React.createElement(ui.api.testing.DevicesPage))
  await flush()
  const { DICT } = ui.api.testing
  const tabs = roles(page, 'tab')
  assert.equal(tabs.length, 2, 'still the two tabs, in the same order')
  assert.deepEqual(tabs.map((tab) => tab.children.join('')), [DICT.en.tabAllow, DICT.en.tabConnect], 'labels unchanged')
  assert.deepEqual(tabs.map((tab) => tab.props['aria-selected']), [true, false], 'allow is still the default tab')
  for (const tab of tabs) assert.match(tab.props.className, /dshdev-seg-btn/, 'a pill per tab, not an underline')
  assert.equal(roles(page, 'tablist').length, 1, 'one tablist role holds them')
  assert.match(text(page), /Devices/)
  assert.equal(byTestId(page, 'page-subtitle')[0].children.join(''), DICT.en.subtitle, 'one muted subtitle line')
  // The pill follows the selection and the other tab is the one that renders.
  assert.equal(byTestId(page, 'connected-count').length, 0, 'the Allow tab does not carry the remote count')
  await click(tabs[1])
  assert.deepEqual(roles(page, 'tab').map((tab) => tab.props['aria-selected']), [false, true])
  assert.equal(byTestId(page, 'connected-count').length, 1, 'the Connect tab opened')
  // The subtitle is translated, not copied, and the dictionaries stay twins.
  const vi = load({ locale: 'vi' })
  const viPage = await mount(React.createElement(vi.api.testing.DevicesPage))
  await flush()
  assert.equal(byTestId(viPage, 'page-subtitle')[0].children.join(''), vi.api.testing.DICT.vi.subtitle)
  assert.notEqual(vi.api.testing.DICT.vi.subtitle, vi.api.testing.DICT.en.subtitle)
  assert.deepEqual(Object.keys(vi.api.testing.DICT.vi).sort(), Object.keys(vi.api.testing.DICT.en).sort())
  page.unmount(); viPage.unmount()
})

await check('connect tab: the this-device row names the machine /mgw/status reports and counts only online hosts', async () => {
  const remotes = [
    { id: 'r1', name: 'Laptop', address: '192.168.1.30:3081', status: 'online', approvals: [] },
    { id: 'r2', name: 'Studio', address: '192.168.1.31:3081', status: 'online', approvals: [] },
    { id: 'r3', name: 'Down', address: '192.168.1.32:3081', status: 'offline', approvals: [] },
    { id: 'r4', name: 'Gone', address: '192.168.1.33:3081', status: 'revoked', approvals: [] },
  ]
  const ui = load({ remotes, status: { ...ONLINE, gatewayName: 'Workstation-7' } })
  const page = await mount(React.createElement(ui.api.testing.ConnectTab))
  await flush()
  const { DICT } = ui.api.testing
  assert.equal(byTestId(page, 'this-device-name')[0].children.join(''), 'Workstation-7',
    'the name this machine already reports, not an invented one')
  assert.ok(text(page).includes(DICT.en.thisDevice), 'and a chip saying it is this device')
  assert.equal(byTestId(page, 'connected-count')[0].children.join(''), '2 connected successfully',
    'only status "online" counts: offline and revoked do not')
  assert.equal(ui.api.testing.connectedCount(1), '1 connected successfully', 'one connection reads right too')
  assert.equal(ui.intervals.size, 1, 'the /mgw/status read rides the poll this tab already runs')
  assert.equal(ui.calls.filter((call) => call.route === '/mgw/status').length >= 1, true)
  assert.equal(ui.calls.some((call) => /^\/devices\/(?!remotes)/.test(call.route)), false, 'no new /devices route')
  // A gateway that reports no name falls back to the translated literal.
  const anonymous = load({ remotes })
  const anonPage = await mount(React.createElement(anonymous.api.testing.ConnectTab))
  await flush()
  assert.equal(byTestId(anonPage, 'this-device-name')[0].children.join(''), anonymous.api.testing.DICT.en.thisDevice)
  // The count is translated too, with the number in the right place.
  const vi = load({ locale: 'vi', remotes })
  const viPage = await mount(React.createElement(vi.api.testing.ConnectTab))
  await flush()
  assert.equal(byTestId(viPage, 'connected-count')[0].children.join(''), '2 kết nối thành công')
  page.unmount(); anonPage.unmount(); viPage.unmount()
})

await check('connect tab: the flow strip animates only when a real link justifies it — online, connecting, idle', async () => {
  // The honesty rule: `data-state` is derived from the paired hosts, nothing else.
  const strip = async (remotes, locale = 'en-US') => {
    const ui = load({ remotes, locale })
    const page = await mount(React.createElement(ui.api.testing.ConnectTab))
    await flush()
    const info = { state: flowOf(page).props['data-state'], note: flowNote(page),
      dots: find(page, (node) => node.props.className === 'dshdev-flow-dot').length }
    page.unmount()
    return info
  }
  const remote = (patch) => ({ id: 'r1', name: 'A', address: '192.168.1.30:3081', status: 'offline', approvals: [], ...patch })
  const online = await strip([remote({ status: 'online' })])
  assert.equal(online.state, 'online', 'a host that answers flows')
  const retrying = await strip([remote({ retry: { attempt: 1, nextAt: Date.now() + 1000 } })])
  assert.equal(retrying.state, 'connecting', 'a scheduled retry is a link being dialled')
  assert.equal((await strip([remote({ status: 'connecting' })])).state, 'connecting')
  // Nothing online at all: no animation, whatever else the rows say.
  assert.equal((await strip([remote({})])).state, 'idle', 'an offline host is not a live link')
  assert.equal((await strip([remote({ status: 'revoked' })])).state, 'idle')
  assert.equal((await strip([])).state, 'idle', 'no paired host is not a live link')
  // The rule itself, independent of rendering: a dialling link is the louder state.
  const { flowState } = load().api.testing
  assert.equal(flowState([{ status: 'online' }, { status: 'offline', retry: { attempt: 2 } }]), 'connecting')
  assert.equal(flowState([{ status: 'online' }, { status: 'offline' }]), 'online')
  assert.equal(flowState(null), 'idle', 'a list that does not exist yet is not a connection')
})

await check('connect tab: idle still draws its dots (static) and the note says which state the strip is in', async () => {
  // A strip that vanished when nothing is connected would read as "no feature";
  // idle keeps the grid, dimmed and still.
  const ui = load()
  const page = await mount(React.createElement(ui.api.testing.ConnectTab))
  await flush()
  const { DICT } = ui.api.testing
  assert.equal(flowOf(page).props['data-state'], 'idle')
  const dots = find(page, (node) => node.props.className === 'dshdev-flow-dot')
  assert.equal(dots.length, 60, 'the 15 x 4 grid is there in every state')
  // Band + caption: the dots stay in their own fixed-height band and the caption
  // is a child of the strip, after it, in the DOM (so assistive tech reads it).
  const [band] = find(page, (node) => node.props.className === 'dshdev-flow-band')
  assert.ok(band, 'the dots sit in a band of their own')
  assert.equal(band.findAll((node) => node.props.className === 'dshdev-flow-dot').length, 60, 'the band holds the grid')
  const [note] = find(page, (node) => node.props.className === 'dshdev-flow-note')
  assert.ok(note, 'the caption is in the DOM, not only painted')
  assert.equal(note.props.role, 'status', 'the caption is announced')
  assert.equal(note.props['aria-live'], 'polite')
  assert.ok(flowOf(page).children.indexOf(note) > flowOf(page).children.indexOf(band), 'the caption sits under the band')
  assert.equal(flowNote(page), DICT.en.flowIdle, 'nothing claims to be flowing')
  assert.ok(DICT.vi.flowIdle && DICT.vi.flowIdle !== DICT.en.flowIdle)
  page.unmount()
  // With a host online the same strip says what is happening, and in vi too.
  const online = { id: 'r1', name: 'A', address: '192.168.1.30:3081', status: 'online', approvals: [] }
  for (const locale of ['en-US', 'vi']) {
    const up = load({ remotes: [online], locale })
    const upPage = await mount(React.createElement(up.api.testing.ConnectTab))
    await flush()
    const lang = locale === 'vi' ? 'vi' : 'en'
    assert.equal(flowOf(upPage).props['data-state'], 'online')
    assert.equal(flowNote(upPage), up.api.testing.DICT[lang].flowBusy)
    assert.equal(find(upPage, (node) => node.props.className === 'dshdev-flow-dot').length, 60)
    upPage.unmount()
  }
})

await check('flow strip: fixed-height band with its caption beneath, no idle animation, reduced motion stops it — CSS only, no timer or canvas', () => {
  // The strip must not move the page when the state or the host count changes:
  // the dot band is ONE fixed-height row and the caption sits outside it.
  const bandRule = source.split('\n').find((line) => line.startsWith('.dshdev-flow-band{'))
  assert.match(bandRule, /height:44px/, 'one fixed-height row')
  assert.match(bandRule, /overflow:hidden/, 'nothing in the band can grow it')
  const containerRule = source.split('\n').find((line) => line.startsWith('.dshdev-flow{'))
  assert.match(containerRule, /flex-direction:column/, 'the caption stacks under the band')
  assert.doesNotMatch(containerRule, /height:/, 'the band alone owns the fixed height, so the caption never shifts it')
  // The caption is quiet: muted, small — a caption, not a second heading.
  const noteRule = source.split('\n').find((line) => line.startsWith('.dshdev-flow-note{'))
  assert.match(noteRule, /color:\$\{colors\.muted\}/, 'muted')
  assert.match(noteRule, /font-size:11\.5px/, 'small')
  // Dots stay legible on a dark theme: an explicit colour and a visible floor,
  // never fully transparent.
  const dotRule = source.split('\n').find((line) => line.startsWith('.dshdev-flow-dot{'))
  assert.match(dotRule, /background:\$\{colors\.accent\}/, 'the dot has its own colour')
  assert.match(dotRule, /opacity:\.26/, 'a visible floor when still')
  assert.match(dotRule, /will-change:opacity/)
  // A pulse exists for online and connecting, and for no other state at all.
  const ruleOf = (state) => source.split('\n').find((line) => line.startsWith(`.dshdev-flow[data-state=${state}] .dshdev-flow-dot{`))
  assert.match(ruleOf('online'), /animation:dshdev-flow-pulse/, 'an answering host pulses, gently')
  assert.match(ruleOf('online'), /2\.8s/, 'gently: the online wave is slow')
  assert.match(ruleOf('connecting'), /animation:dshdev-flow-pulse 1\.1s/, 'a dialling link pulses faster and brighter')
  assert.equal(ruleOf('idle'), undefined, 'idle has no rule: the dots do not move')
  // Accessibility: reduced motion leaves static dots, at every state.
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)\{\s*\.dshdev-flow \.dshdev-flow-dot\{animation:none!important/)
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)\{[^}]*\.dshdev-flow \.dshdev-flow-dot\{animation:none!important;opacity:\.26\}/,
    'reduced motion keeps the visible floor, not a vanishing grid')
  // The travelling wave is one keyframe plus a per-dot delay, painted by the compositor.
  assert.match(source, /@keyframes dshdev-flow-pulse\{0%,100%\{opacity:\.22\}45%\{opacity:1\}\}/,
    'one keyframe: dim to full, never to nothing')
  assert.match(source, /animationDelay: `\$\{column \* 90 \+ row \* 40\}ms`/, 'each dot starts a little later: one wave')
  // No scripted animation and no external asset: the glyphs are inline data URIs.
  assert.doesNotMatch(source, /requestAnimationFrame|<canvas|requestIdleCallback/)
  assert.equal([...source.matchAll(/--dshdev-glyph:url\("data:image\/svg\+xml,/g)].length, 3,
    'the three row actions are inline SVG data URIs, not files')
})

await check('authorized devices: one chip per scope with a count, the ScopePicker\'s dangerous set in amber, a two-row clamp that keeps every chip and opens with aria-expanded, and the last use on its own line in the page language', async () => {
  const TS = 1_700_000_000_000
  // The dangerous set is not a second list: it is exactly the scopes the ScopePicker
  // prints a risk line for, so the chip tooltip and the checkbox hint cannot drift.
  const { DICT } = load().api.testing
  const risky = ALL.filter((scope) => typeof DICT.en[`risk.${scope}`] === 'string')
  // 13 = the twelve pre-019 scopes plus `permission:lower` (spec 019: lower-only, so it
  // still gets its own amber hint next to the write scopes it sits beside).
  assert.equal(risky.length, 13, 'the thirteen dangerous scopes, as the picker classifies them')
  const devices = [
    { id: 'd1', name: 'DNLP25-IT09', displayName: 'DNLP25-IT09', kind: 'desktop', scopes: ALL, createdAt: TS, lastSeenAt: TS, online: true },
    { id: 'd2', name: 'Pixel 8', displayName: 'Pixel 8', kind: 'mobile', scopes: ['sessions:read', 'prompt:send'], createdAt: TS, lastSeenAt: null, online: false },
    { id: 'd3', name: 'Old phone', displayName: 'Old phone', kind: 'mobile', scopes: [], createdAt: TS, lastSeenAt: null, online: false },
  ]
  const WHEN = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
  assert.notEqual(new Date(TS).toLocaleString('en-US', WHEN), new Date(TS).toLocaleString('vi-VN', WHEN),
    'the two page languages really format a date differently')
  for (const [locale, lang, tag] of [['en-US', 'en', 'en-US'], ['vi', 'vi', 'vi-VN']]) {
    const ui = load({ locale, devices, status: { remoteControl: { enabled: true, accepting: true }, lan: { listening: true, urls: [] } } })
    const { DICT } = ui.api.testing
    const page = await mount(React.createElement(ui.api.testing.AllowTab))
    await flush()
    const items = byTestId(page, 'authorized-item')
    assert.equal(items.length, 3)
    const chipsOf = (item) => item.findAll((node) => typeof node.type === 'string' && typeof node.props['data-scope'] === 'string')
    const areaOf = (item) => item.findAll((node) => typeof node.type === 'string' && /^dshdev-scopes( |$)/.test(String(node.props.className || '')))[0]
    const toggleOf = (item) => item.findAll((node) => node.type === 'button' && node.props.className === 'dshdev-scopes-toggle')[0]
    const whenOf = (item) => item.findAll((node) => node.props['data-testid'] === 'last-used')[0].children.join('')

    // The owner's real case: every scope granted, one chip each, in the granted order.
    assert.deepEqual(chipsOf(items[0]).map((node) => node.props['data-scope']), ALL, `${lang}: every scope is its own chip`)
    assert.equal(byTestId(page, 'scope-count')[0].children.join(''), DICT[lang].scopeCount.replace('{{n}}', String(ALL.length)),
      `${lang}: the count labels the list`)
    for (const chip of chipsOf(items[0])) {
      const scope = chip.props['data-scope']
      const flagged = / dshdev-scope risk|^dshdev-scope risk$/.test(String(chip.props.className))
      assert.equal(flagged, risky.includes(scope), `${lang}: ${scope} carries the amber flag only when the picker calls it dangerous`)
      // No new copy: the tooltip is the very sentence the checkbox prints.
      assert.equal(chip.props.title, risky.includes(scope) ? DICT[lang][`risk.${scope}`] : undefined)
    }

    // Clamped to about two rows, and every chip stays in the DOM (CSS only).
    assert.match(String(areaOf(items[0]).props.className), /clamped/, `${lang}: all ${ALL.length} chips clamp`)
    assert.equal(chipsOf(items[0]).length, ALL.length, `${lang}: clamping removes nothing`)
    assert.equal(toggleOf(items[0]).props['aria-expanded'], false)
    assert.equal(toggleOf(items[0]).children.join(''), DICT[lang].showAllScopes.replace('{{n}}', String(ALL.length)))
    await click(toggleOf(items[0]))
    assert.equal(toggleOf(items[0]).props['aria-expanded'], true, `${lang}: the toggle says it is open`)
    assert.doesNotMatch(String(areaOf(items[0]).props.className), /clamped/, `${lang}: open means no clamp`)
    assert.equal(toggleOf(items[0]).children.join(''), DICT[lang].showLessScopes)
    assert.equal(chipsOf(items[0]).length, ALL.length, `${lang}: opening is not a second render of the list`)
    await click(toggleOf(items[0]))
    assert.match(String(areaOf(items[0]).props.className), /clamped/, `${lang}: and it closes again`)

    // A short grant has nothing to open; an empty one says so without a chip.
    assert.equal(toggleOf(items[1]), undefined, `${lang}: two scopes never clamp`)
    assert.equal(chipsOf(items[1]).length, 2)
    assert.equal(chipsOf(items[2]).length, 0)
    assert.equal(items[2].findAll((node) => node.props['data-testid'] === 'scope-count')[0].children.join(''),
      DICT[lang].scopeCount.replace('{{n}}', '0'))

    // Last use: its own row under the chips, formatted for the page's language.
    assert.equal(whenOf(items[0]), new Date(TS).toLocaleString(tag, WHEN), `${lang}: date and time, compact`)
    assert.equal(whenOf(items[1]), DICT[lang].never, `${lang}: a device never seen says so`)
    const meta = items[0].findAll((node) => node.props.className === 'dshdev-item-meta')
    assert.equal(meta.length, 1, 'one row of its own, not part of the chip area')
    assert.equal(meta[0].children[0].children.join(''), DICT[lang].lastUsed, 'with its muted label')
    page.unmount()
  }
})

await check('authorized devices and the host popover: presentation is CSS + markup only — no scope list is printed as a comma sentence anywhere', () => {
  // No scope list survives as prose: the two places that built one now share the chips.
  assert.doesNotMatch(source, /map\(\(scope\) => tr\(`scope\.\$\{scope\}`\)\)\.join/, 'no joined scope sentence')
  assert.doesNotMatch(source, /`\$\{tr\('scopes'\)\}: /, 'no "Permissions: …" line')
  // A rule may be written over several lines (the file already does that) and it
  // carries `${colors.x}` placeholders, so walk the braces instead of splitting on
  // the first `}` — a placeholder's own brace is not the end of the rule.
  const rule = (selector) => {
    const start = source.indexOf(`${selector}{`)
    assert.ok(start >= 0, `no rule for ${selector}`)
    const text = source.slice(start)
    let depth = 0
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '$' && text[i + 1] === '{') {
        i = text.indexOf('}', i) // a placeholder never nests a brace
        continue
      }
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') {
        depth -= 1
        if (depth === 0) return text.slice(0, i + 1)
      }
    }
    return text
  }
  // The clamp is a rule, not a slice: the chips stay in the DOM for assistive tech.
  const clamp = rule('.dshdev-scopes.clamped')
  assert.match(clamp, /max-height:50px/, 'about two 22px rows')
  assert.doesNotMatch(clamp, /display:none|visibility:hidden/)
  assert.match(rule('.dshdev-item.dshdev-item-stack'), /display:block/, 'header line above, body across the card below')
  assert.match(rule('.dshdev-item-top'), /flex-wrap:wrap/, 'the actions wrap under the name instead of squeezing it')
  assert.match(rule('.dshdev-item-main'), /flex:1 1 180px/, 'a basis, so a narrow card breaks lines rather than crushing the text')
  const chip = rule('.dshdev-scope')
  assert.match(chip, /border-radius:999px/); assert.match(chip, /font-size:11\.5px/)
  assert.match(chip, /border:1px solid \$\{colors\.border\}/); assert.match(chip, /background:\$\{colors\.hover\}/)
  assert.match(chip, /white-space:nowrap/, 'a chip never wraps mid-label')
  // Amber comes from the theme's warn colour, so it follows the theme like the badges do.
  assert.match(rule('.dshdev-scope.risk'), /colors\.warn/)
  assert.doesNotMatch(source, /https?:\/\/[^\s'"`]+\.(?:png|jpg|svg|woff2?)/, 'no new asset')
})

// --- AddressEditor: change a paired host's address (PATCH keeps the pin) ---
const REMOTE = { id: 'r-1', name: 'Laptop', address: 'wss://10.0.0.5:41234', status: 'online', approvals: [] }
const editorOf = (page) => find(page, (node) => node.props['data-testid'] === 'address-editor')[0]
const tid = (page, id) => find(page, (node) => node.props['data-testid'] === id)[0]
const PATCHES = (ui) => ui.calls.filter((call) => call.method === 'PATCH')
const typeInto = async (page, value) => { await act(async () => { tid(page, 'address-input').props.onChange({ target: { value } }) }) }
const openEditor = async (page) => { await click(tid(page, 'address-edit')) }

await check('address editor: opens prefilled with the current address, with the pin note and Save/Cancel', async () => {
  const ui = load()
  const page = await mount(React.createElement(ui.api.testing.AddressEditor, { remote: REMOTE, onDone: () => {} }))
  assert.equal(editorOf(page), undefined, 'closed at first')
  assert.equal(tid(page, 'address-edit').children.join(''), ui.api.testing.DICT.en.editAddress)
  await openEditor(page)
  assert.ok(editorOf(page))
  assert.equal(tid(page, 'address-input').props.value, REMOTE.address)
  assert.equal(tid(page, 'address-pin-note').children.join(''), ui.api.testing.DICT.en.addressPinNote)
  assert.equal(tid(page, 'address-save').children.join(''), ui.api.testing.DICT.en.saveAddress)
  assert.equal(tid(page, 'address-cancel').children.join(''), ui.api.testing.DICT.en.cancel)
  page.unmount()
})

await check('address editor: Save issues exactly one PATCH carrying only the typed url, same-origin', async () => {
  const ui = load()
  const page = await mount(React.createElement(ui.api.testing.AddressEditor, { remote: REMOTE, onDone: () => {} }))
  await openEditor(page)
  await typeInto(page, 'wss://10.0.0.9:5555/x')
  await click(tid(page, 'address-save'))
  await flush()
  const patches = PATCHES(ui)
  assert.equal(patches.length, 1)
  assert.equal(patches[0].route, '/devices/remotes/r-1')
  assert.deepEqual(patches[0].body, { url: 'wss://10.0.0.9:5555/x' })
  assert.equal(patches[0].origin, 'http://127.0.0.1:3080')
  assert.equal(patches[0].credentials, 'same-origin')
  assert.equal(ui.calls.length, 1, 'no other request')
  page.unmount()
})

await check('address editor: success closes the editor and runs the refresh once', async () => {
  const ui = load()
  let done = 0
  const page = await mount(React.createElement(ui.api.testing.AddressEditor, { remote: REMOTE, onDone: () => { done += 1 } }))
  await openEditor(page)
  await typeInto(page, '10.0.0.9:5555')
  await click(tid(page, 'address-save'))
  await flush()
  assert.equal(done, 1)
  assert.equal(editorOf(page), undefined, 'editor closed')
  assert.ok(tid(page, 'address-edit'), 'the Edit address button is back')
  page.unmount()
})

await check('address editor: a 4xx shows the server message inline and keeps the editor open, without refreshing', async () => {
  const ui = load()
  ui.state.patchFailure = { status: 409, body: { error: 'pin-immutable', message: 'The certificate pin cannot change.' } }
  let done = 0
  const page = await mount(React.createElement(ui.api.testing.AddressEditor, { remote: REMOTE, onDone: () => { done += 1 } }))
  await openEditor(page)
  await typeInto(page, 'wss://10.0.0.9:5555')
  await click(tid(page, 'address-save'))
  await flush()
  assert.ok(editorOf(page), 'still open')
  const alert = tid(page, 'address-error')
  assert.equal(alert.props.role, 'alert')
  assert.equal(alert.props.className, 'dshdev-err')
  assert.equal(alert.children.join(''), 'The certificate pin cannot change.')
  assert.equal(tid(page, 'address-input').props.value, 'wss://10.0.0.9:5555', 'what was typed is kept')
  assert.equal(done, 0)
  assert.equal(tid(page, 'address-save').props.disabled, false, 'usable again to retry')
  page.unmount()
})

await check('address editor: Cancel sends nothing and closes', async () => {
  const ui = load()
  const page = await mount(React.createElement(ui.api.testing.AddressEditor, { remote: REMOTE, onDone: () => {} }))
  await openEditor(page)
  await typeInto(page, 'wss://elsewhere:1')
  await click(tid(page, 'address-cancel'))
  await flush()
  assert.equal(ui.calls.length, 0)
  assert.equal(editorOf(page), undefined)
  page.unmount()
})

await check('address editor: input and both buttons are disabled while the save is in flight', async () => {
  const ui = load()
  let release
  ui.state.patchGate = new Promise((resolve) => { release = resolve })
  const page = await mount(React.createElement(ui.api.testing.AddressEditor, { remote: REMOTE, onDone: () => {} }))
  await openEditor(page)
  assert.equal(tid(page, 'address-save').props.disabled, false)
  const saving = click(tid(page, 'address-save'))
  await flush()
  assert.equal(tid(page, 'address-input').props.disabled, true)
  assert.equal(tid(page, 'address-save').props.disabled, true)
  assert.equal(tid(page, 'address-cancel').props.disabled, true)
  assert.equal(tid(page, 'address-save').children.join(''), ui.api.testing.DICT.en.addressSaving)
  await click(tid(page, 'address-save'))
  assert.equal(PATCHES(ui).length, 1, 'a second press does not send a second request')
  release()
  await saving
  await flush()
  assert.equal(editorOf(page), undefined)
  page.unmount()
})

await check('address editor: renders in en and vi, the new strings are real translations, and the dictionaries stay twins', async () => {
  const keys = ['editAddress', 'saveAddress', 'addressPinNote', 'addressSaving']
  for (const [locale, lang] of [['en-US', 'en'], ['vi-VN', 'vi']]) {
    const ui = load({ locale })
    const { DICT } = ui.api.testing
    for (const key of keys) assert.ok(DICT[lang][key], `${lang} ${key}`)
    const page = await mount(React.createElement(ui.api.testing.AddressEditor, { remote: REMOTE, onDone: () => {} }))
    assert.equal(tid(page, 'address-edit').children.join(''), DICT[lang].editAddress)
    await openEditor(page)
    assert.equal(tid(page, 'address-pin-note').children.join(''), DICT[lang].addressPinNote)
    assert.equal(tid(page, 'address-save').children.join(''), DICT[lang].saveAddress)
    assert.equal(tid(page, 'address-cancel').children.join(''), DICT[lang].cancel)
    page.unmount()
  }
  const { DICT } = load().api.testing
  for (const key of keys) assert.notEqual(DICT.vi[key], DICT.en[key], `${key}: a real translation, not a copy`)
  assert.deepEqual(Object.keys(DICT.vi).sort(), Object.keys(DICT.en).sort(), 'vi and en stay twins')
})

await check('address editor: mounted on the remote card next to the address (not on a revoked host)', async () => {
  const ui = load({ remotes: [REMOTE, { ...REMOTE, id: 'r-2', status: 'revoked' }] })
  const page = await mount(React.createElement(ui.api.testing.ConnectTab))
  await flush()
  assert.equal(find(page, (node) => node.props['data-testid'] === 'address-edit').length, 1)
  page.unmount()
})

// ------------------------------------------------------------------ spec 016 Phase 1
// The Start page's per-machine doorways. Loaded the way the shell loads the plugin (a
// vm with __ModuleLoader__) against a fake shell that declares the three services the
// surfaces need, so what is asserted is what the real registry would receive.
function loadDoors({ remotes, locale = 'en-US' }) {
  let api
  const timers = { started: 0, cleared: 0 }
  const live = { remotes }
  const fetch = async (url) => {
    const route = new URL(String(url), 'http://127.0.0.1:3080/').pathname
    if (route === '/devices/remotes') {
      return { ok: true, status: 200, json: async () => ({ remotes: live.remotes, routing: { remote: true, reason: null, hosts: [] } }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  const window = {
    __ModuleLoader__: { load: ({ factory }) => { api = factory(() => React) } },
    setInterval: () => { timers.started += 1; return timers.started }, clearInterval: () => { timers.cleared += 1 }, setTimeout: () => 1, clearTimeout: () => {},
  }
  const document = { baseURI: 'http://127.0.0.1:3080/', head: { appendChild() {} }, createElement: () => ({ remove() {} }) }
  vm.runInNewContext(source, { window, document, fetch, URL, console, setTimeout, clearTimeout, Date, navigator: { language: locale } })
  // The registry the shell hands over: rc.1's own rules for ids, a repeated kind, and
  // the flat guide sorted by `order` (SidebarRightTabRegistry.register / refresh).
  const types = new Map()
  const registry = {
    register(definition) {
      if (types.has(definition.id)) throw new Error(`tab type id "${definition.id}" is already registered`)
      if ([...types.values()].some((held) => held.kind === definition.kind)) throw new Error(`tab kind "${definition.kind}" is already registered`)
      const guide = definition.guide ?? []
      if (new Set(guide.map((entry) => entry.id)).size !== guide.length) throw new Error('duplicate guide entry id')
      types.set(definition.id, definition)
      return () => { types.delete(definition.id) }
    },
  }
  const guide = () => [...types.values()]
    .flatMap((definition) => (definition.guide ?? []).map((entry) => ({ ...entry, kind: definition.kind, providerId: definition.id })))
    .sort((left, right) => left.order - right.order)
  const bodies = new Map()
  const disposers = []
  // Shipped capsules, at the orders rc.1 gives them: the doors must land after all of these.
  for (const [id, order] of [['files', 10], ['review', 15], ['terminal', 20], ['browser', 30], ['inspector', 60]]) {
    registry.register({ id, kind: id, guide: [{ id: 'open', order, title: () => id }] })
  }
  const slots = {
    inject(slot, factory) {
      const registration = factory()
      if (slot === 'sidebar.right.pane.tab') bodies.set(registration.meta.key, registration)
      return () => { if (slot === 'sidebar.right.pane.tab') bodies.delete(registration.meta.key) }
    },
    register(meta, component) { return { meta, component } },
  }
  const services = { sessions: { refresh: async () => {} }, sidebarRight: { openTab() {} }, sidebarRightTabs: registry, contextMenus: { register: () => () => {} } }
  const ctx = {
    locale: { getSnapshot: () => ({ active: locale }), subscribe: () => () => {} },
    effect(fn) { const out = fn(); if (typeof out === 'function') disposers.push(out); return () => { out?.() } },
    inject(deps, fn) {
      const scope = {}
      for (const dep of deps) scope[dep] = services[dep]
      const out = fn(scope)
      if (typeof out === 'function') disposers.push(out)
      return () => { out?.() }
    },
    slots,
  }
  api.apply(ctx)
  return { api, live, types, guide, bodies, disposers, timers, refresh: () => api.testing.hostsStore.refresh() }
}

const DOOR_REMOTES = [
  { id: 'r-b', name: 'Desk-Box', address: '10.0.0.41:3081', status: 'online', createdAt: 2, device: { kind: 'desktop', scopes: [] } },
  { id: 'r-a', name: 'Qoder-Sigma', address: '10.0.0.40:3081', status: 'online', createdAt: 1, device: { kind: 'desktop', scopes: [] } },
]
const doorGuide = (ui) => ui.guide().filter((entry) => entry.providerId.startsWith('dsh-ext.devices.r-'))

await check('start page: every connected paired host gets its own entries, labelled "<item> · <host>", ids namespaced by host', async () => {
  const ui = loadDoors({ remotes: DOOR_REMOTES })
  await ui.refresh()
  await flush()
  const doors = doorGuide(ui)
  assert.deepEqual(doors.map((entry) => entry.providerId).sort(), [
    'dsh-ext.devices.r-a.devices', 'dsh-ext.devices.r-a.host', 'dsh-ext.devices.r-b.devices', 'dsh-ext.devices.r-b.host',
  ], 'two doorways per host, id = dsh-ext.devices.<hostId>.<entry>')
  const title = (id) => doors.find((entry) => entry.providerId === id).title()
  assert.equal(title('dsh-ext.devices.r-a.host'), 'Remote machine · Qoder-Sigma')
  assert.equal(title('dsh-ext.devices.r-a.devices'), 'Devices · Qoder-Sigma')
  assert.equal(title('dsh-ext.devices.r-b.host'), 'Remote machine · Desk-Box')
  for (const entry of doors) {
    assert.equal(entry.kind, entry.providerId, 'the type id is its kind, so the capsule opens that machine\'s own tab')
    assert.equal(typeof entry.icon, 'function', 'an icon component, rendered by the shell with { size }')
    assert.equal(typeof entry.description(), 'string')
    assert.ok(ui.types.get(entry.providerId).priority === 'extension' && ui.types.get(entry.providerId).multiple === false)
    // The body is dispatched with the type id (rc.1 `sidebar.right.pane.tab`).
    assert.equal(ui.bodies.get(entry.providerId).meta.name, 'sidebar.right.pane.tab')
    assert.equal(typeof ui.bodies.get(entry.providerId).component, 'function')
  }
  for (const dispose of ui.disposers) { try { dispose() } catch { /* teardown */ } }
})

await check('start page order: every local capsule first, then one contiguous block per host (1000 + 100 per host, +1 per entry)', async () => {
  const ui = loadDoors({ remotes: DOOR_REMOTES })
  await ui.refresh()
  const all = ui.guide()
  const shippedMax = Math.max(...all.filter((entry) => !entry.providerId.startsWith('dsh-ext.devices.')).map((entry) => entry.order))
  const doors = doorGuide(ui)
  assert.ok(Math.min(...doors.map((entry) => entry.order)) > shippedMax, 'no per-host entry sorts among the local ones')
  assert.deepEqual(doors.map((entry) => [entry.providerId, entry.order]), [
    ['dsh-ext.devices.r-a.host', 1000], ['dsh-ext.devices.r-a.devices', 1001],
    ['dsh-ext.devices.r-b.host', 1100], ['dsh-ext.devices.r-b.devices', 1101],
  ], 'host ids are sorted, so the numbers do not depend on the order the Host listed them in')
  // The merged list, as the Start page renders it: locals, then host A's block, then host B's.
  const merged = all.map((entry) => entry.providerId)
  assert.ok(merged.indexOf('inspector') < merged.indexOf('dsh-ext.devices.r-a.host'))
  assert.ok(merged.indexOf('dsh-ext.devices.r-a.devices') + 1 === merged.indexOf('dsh-ext.devices.r-b.host'), 'one host\'s block is not interleaved with the other\'s')
  const { HOST_DOOR_BASE, HOST_DOOR_STRIDE, hostDoorEntries } = ui.api.testing
  assert.equal(HOST_DOOR_BASE, 1000)
  assert.equal(HOST_DOOR_STRIDE, 100)
  // Same set in another list order: identical numbers.
  const flipped = hostDoorEntries([...DOOR_REMOTES].reverse()).map((entry) => [entry.id, entry.order])
  assert.deepEqual(flipped, hostDoorEntries(DOOR_REMOTES).map((entry) => [entry.id, entry.order]))
  for (const dispose of ui.disposers) { try { dispose() } catch { /* teardown */ } }
})

await check('start page: a removed host\'s entries and bodies disappear on the next refresh; the other host is untouched', async () => {
  const ui = loadDoors({ remotes: DOOR_REMOTES })
  await ui.refresh()
  assert.equal(doorGuide(ui).length, 4)
  const before = ui.types.get('dsh-ext.devices.r-b.host')
  ui.live.remotes = DOOR_REMOTES.filter((remote) => remote.id !== 'r-a')
  await ui.refresh()
  assert.deepEqual(doorGuide(ui).map((entry) => entry.providerId), ['dsh-ext.devices.r-b.host', 'dsh-ext.devices.r-b.devices'])
  assert.equal(ui.bodies.has('dsh-ext.devices.r-a.host'), false, 'the body seat goes with its type')
  assert.equal(ui.bodies.has('dsh-ext.devices.r-a.devices'), false)
  assert.equal(ui.types.get('dsh-ext.devices.r-b.host'), before, 'a host that stayed is not re-registered (no churn on every refresh)')
  // Not re-registered, so its number is the one it got: still contiguous and after every local capsule.
  assert.deepEqual(doorGuide(ui).map((entry) => entry.order), [1100, 1101])
  // Adding it back brings the entries back.
  ui.live.remotes = DOOR_REMOTES
  await ui.refresh()
  assert.equal(doorGuide(ui).length, 4)
  for (const dispose of ui.disposers) { try { dispose() } catch { /* teardown */ } }
})

await check('start page: an offline host is OMITTED (spec: "per connected remote host"), and returns when it reconnects', async () => {
  const ui = loadDoors({ remotes: DOOR_REMOTES.map((remote) => (remote.id === 'r-a' ? { ...remote, status: 'offline' } : remote)) })
  await ui.refresh()
  assert.deepEqual(doorGuide(ui).map((entry) => entry.providerId), ['dsh-ext.devices.r-b.host', 'dsh-ext.devices.r-b.devices'],
    'no entry, disabled or not, for a host that cannot answer')
  assert.equal(doorGuide(ui).find((entry) => entry.order === 1000).providerId, 'dsh-ext.devices.r-b.host', 'the block index counts connected hosts only')
  ui.live.remotes = DOOR_REMOTES // r-a reconnects
  await ui.refresh()
  assert.equal(doorGuide(ui).length, 4)
  ui.live.remotes = DOOR_REMOTES.map((remote) => ({ ...remote, status: 'revoked' }))
  await ui.refresh()
  assert.equal(doorGuide(ui).length, 0, 'a revoked pairing is not a doorway either')
  for (const dispose of ui.disposers) { try { dispose() } catch { /* teardown */ } }
})

await check('start page: no new timer — the doorways ride the one shared refresh, and teardown removes every type and body', async () => {
  const ui = loadDoors({ remotes: DOOR_REMOTES })
  await ui.refresh()
  assert.equal(doorGuide(ui).length, 4)
  // startPoll is the plugin's one timer; two hosts and four doorways must not add another.
  assert.equal(ui.timers.started, 1, 'exactly one interval, the shared host-list refresh')
  for (let round = 0; round < 3; round += 1) await ui.refresh()
  assert.equal(ui.timers.started, 1, 'refreshing again starts nothing')
  for (const dispose of ui.disposers) { try { dispose() } catch { /* teardown */ } }
  assert.equal(ui.timers.cleared, 1, 'teardown clears that one interval')
  assert.equal(doorGuide(ui).length, 0, 'disposing the surfaces unregisters every doorway')
  assert.equal([...ui.bodies.keys()].filter((key) => key.startsWith('dsh-ext.devices.r-')).length, 0)
})
await check('start page: malformed rows never become entries, and the pure helper needs no shell', async () => {
  const ui = loadDoors({ remotes: DOOR_REMOTES })
  await ui.refresh()
  assert.ok(ui.api.testing.hostDoorEntries(DOOR_REMOTES).length === 4)
  // (arrays built inside the vm are another realm's, so compare by length, not deepEqual)
  assert.equal(ui.api.testing.hostDoorEntries(undefined).length, 0)
  assert.equal(ui.api.testing.hostDoorEntries([null, { id: 3 }, { name: 'x', status: 'online' }]).length, 0, 'a malformed row never becomes an entry')
  for (const dispose of ui.disposers) { try { dispose() } catch { /* teardown */ } }
})

await check('start page: the machine card renders the paired host\'s own sessions card; a host that is gone says so', async () => {
  const ui = loadDoors({ remotes: DOOR_REMOTES })
  await ui.refresh()
  const { HostDoorTab } = ui.api.testing
  const present = await mount(React.createElement(HostDoorTab, { hostId: 'r-a' }))
  await flush()
  assert.equal(find(present, (node) => node.props['data-testid'] === 'host-door').length, 1)
  assert.match(text(present), /Qoder-Sigma/, 'it is that host\'s card')
  assert.equal(find(present, (node) => node.type === 'button' && node.children.join('') === 'Back').length, 0, 'no inert Back button inside a tab')
  present.unmount()
  const gone = await mount(React.createElement(HostDoorTab, { hostId: 'r-zzz' }))
  assert.equal(find(gone, (node) => node.props['data-testid'] === 'host-door-gone').length, 1)
  assert.match(text(gone), /no longer paired/)
  gone.unmount()
  for (const dispose of ui.disposers) { try { dispose() } catch { /* teardown */ } }
})

await check('start page: the doorway strings exist in vi and en as real translations; vi/en key sets stay twins; the label follows the language', async () => {
  const { DICT } = load().api.testing
  const keys = ['hostDoor', 'hostDoorDescription', 'devicesDoorDescription', 'hostDoorGone']
  for (const key of keys) {
    assert.equal(typeof DICT.en[key], 'string', `${key} (en)`)
    assert.equal(typeof DICT.vi[key], 'string', `${key} (vi)`)
    assert.notEqual(DICT.vi[key], DICT.en[key], `${key}: a real translation, not a copy`)
  }
  assert.deepEqual(Object.keys(DICT.vi).sort(), Object.keys(DICT.en).sort(), 'vi and en stay twins')
  const vi = loadDoors({ remotes: DOOR_REMOTES, locale: 'vi-VN' })
  await vi.refresh()
  const doors = doorGuide(vi)
  assert.equal(doors.find((entry) => entry.providerId === 'dsh-ext.devices.r-a.host').title(), 'Máy từ xa · Qoder-Sigma')
  assert.equal(doors.find((entry) => entry.providerId === 'dsh-ext.devices.r-a.devices').title(), 'Thiết bị · Qoder-Sigma')
  for (const dispose of vi.disposers) { try { dispose() } catch { /* teardown */ } }
})
finish('client')
