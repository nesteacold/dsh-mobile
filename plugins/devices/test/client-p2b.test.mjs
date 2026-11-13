// Spec 008 P2b (client): the native remote-session surfaces.
//  - the host badge: a tagged session row in the native browser names its Host, in
//    the two row seats the native `WorkspaceBrowser` declares; the stock
//    `sidebar.workspaces` browser is never replaced (the merged rows are its own);
//  - a change to the connected-host set asks the native session catalog to pull
//    `session/list` again, because a Host that connects after startup is in that
//    merged answer only after the next pull;
//  - the composer chip exists only for a tagged session and its popover drives
//    Reconnect / Forget host (no Settings navigation exists on rc.1);
//  - the offline and model-status banners;
//  - the remote terminal entry, hidden without the `terminal` grant.
// Loads lib/client.js in a vm with a fake __ModuleLoader__ + a fake slot host, the
// way test/client.test.mjs does. Run with `node --test --test-isolation=none` or
// as a plain script.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { test } from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const React = require('../../mobile-gateway/node_modules/react')
const { create, act } = require('../../mobile-gateway/node_modules/react-test-renderer')
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const source = fs.readFileSync(path.join(here, '../lib/client.js'), 'utf8')

console.log('client-p2b')

const REMOTE = { id: 'r1', name: 'Qoder-Sigma', address: '192.168.1.40:3081', status: 'online', createdAt: Date.parse('2026-11-01T08:30:00Z'),
  device: { kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'harness:remote'] } }
const ROUTING = { remote: true, reason: null, hosts: [{ hostId: 'r1', hostName: 'Qoder-Sigma', online: true }], merged: ['session/list', 'workspace/follow'] }

function load({ locale = 'en-US', routing = ROUTING, remotes = [REMOTE], cached = true, deferredSessions = false, missingSlots = [] } = {}) {
  let api
  const calls = []
  const state = { routing, remotes, cached }
  const fetch = async (url, options = {}) => {
    const target = new URL(url)
    const route = target.pathname + target.search
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({ method: options.method ?? 'GET', route, body, origin: target.origin, credentials: options.credentials })
    const reply = (data, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => data })
    if (route === '/devices/remotes') return reply({ remotes: state.remotes, routing: state.routing })
    if (/^\/devices\/remotes\/[^/]+\/connect$/.test(route) && options.method === 'POST') {
      state.routing = { ...state.routing, hosts: [{ hostId: 'r1', hostName: 'Qoder-Sigma', online: true }] }
      return reply({ remote: state.remotes[0], state: 'online' })
    }
    if (/^\/devices\/remotes\/[^/]+\/sessions\/[^/]+$/.test(route) && options.method === 'DELETE') {
      const removed = state.cached
      state.cached = false
      return reply({ removed, sessionId: decodeURIComponent(route.split('/').at(-1)) })
    }
    if (/^\/devices\/remotes\/[^/]+$/.test(route) && options.method === 'DELETE') {
      state.remotes = []
      state.routing = { ...state.routing, hosts: [] }
      return reply({ removed: true })
    }
    return reply({ message: 'not found' }, false)
  }
  const entries = []
  // The shell's slot ledger, as rc.1's SlotCore.register implements it: a `single`
  // slot refuses a second registration at an already-taken priority and accepts a
  // lower one ("lowest renders"). `sidebar.workspaces` ships occupied by the stock
  // browser (`tk`) at priority 0, and this plugin must never take that seat: the
  // native browser renders the merged rows itself, so modelling the occupant here
  // turns "a replacement crept back in" into a failed test instead of a user's
  // session. The kinds are the shipped catalog's — the two session-row seats are
  // `list` (client-ui-workspace declares them for exactly this kind of decoration) —
  // and `register` below carries the rest of the rule: a `list`/`keyed` entry must
  // carry its key option before a seat is even looked for, and a `list` seat is
  // (id, priority).
  const SLOT_KINDS = {
    'sidebar.workspaces': 'single',
    'settings.section': 'list',
    'settings.section.icon': 'list',
    'conversation.input.left': 'list',
    'conversation.input.dock': 'list',
    'conversation.input.right': 'list',
    'sidebar.session.row.trailing': 'list',
    'sidebar.session.row.hover': 'list',
  }
  const occupants = new Map(Object.keys(SLOT_KINDS).map((slot) => [slot, []]))
  // The stock sidebar browser, registered by the shell itself before any plugin runs.
  occupants.get('sidebar.workspaces').push({ slot: 'sidebar.workspaces', meta: { name: 'sidebar.workspaces', priority: 0, registrant: 'tk' } })
  const disposers = []
  const intervals = new Map()
  let sequence = 0
  let confirmations = 0
  const sessionsService = { refreshes: 0, refresh() { this.refreshes += 1; return Promise.resolve() } }
  let sidebarRight = { tabs: [] }
  sidebarRight.openTab = (kind, options) => { sidebarRight.tabs.push([kind, options]) }
  const services = { sessions: deferredSessions ? null : sessionsService, sidebarRight }
  // A service handed over after the surfaces are installed (`ctx.inject` resolves
  // then), so the "pull waits for the handle" path is reachable in a test.
  const deferred = []
  const window = {
    __ModuleLoader__: { load: ({ id, factory }) => { api = { id, ...factory((name) => { assert.equal(name, 'react'); return React }) } } },
    setInterval: (fn) => { intervals.set(++sequence, fn); return sequence },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn) => { fn(); return 0 },
    confirm: () => { confirmations += 1; return true },
  }
  const document = { baseURI: 'http://127.0.0.1:3080/', head: { appendChild() {} }, createElement: () => ({ remove() {} }) }
  vm.runInNewContext(source, { window, document, fetch, URL, console, setTimeout, clearTimeout, Date,
    navigator: { language: locale, clipboard: { writeText: async () => {} } } })
  // Fake host: the slot ledger (inject waits for a declaration, register returns a
  // disposer), the optional Cordis services P2b asks for, and the locale face.
  const localeListeners = new Set()
  let snapshot = { active: locale }
  const ctx = {
    locale: { getSnapshot: () => snapshot, subscribe: (listener) => { localeListeners.add(listener); return () => localeListeners.delete(listener) } },
    effect(fn) { disposers.push(fn()) },
    get(name) { return services[name] },
    inject(deps, fn) {
      if (deferredSessions && deps.includes('sessions')) {
        deferred.push(() => fn({ sessions: services.sessions }))
        return () => {}
      }
      const scope = {}
      for (const dep of deps) scope[dep] = services[dep]
      const out = fn(scope)
      return typeof out === 'function' ? out : () => {}
    },
    slots: {
      inject(slot, factory) {
        const registration = factory()
        const entry = { slot, meta: registration.meta, component: registration.component }
        entries.push(entry)
        return () => {
          const at = entries.indexOf(entry)
          if (at >= 0) entries.splice(at, 1)
          const held = occupants.get(slot) ?? []
          const seat = held.findIndex((occupant) => occupant.meta === entry.meta)
          if (seat >= 0) held.splice(seat, 1)
        }
      },
      register(meta, component) {
        const kind = missingSlots.includes(meta.name) ? undefined : SLOT_KINDS[meta.name]
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
        held.push({ slot: meta.name, meta, component })
        return { meta, component }
      },
    },
  }
  api.apply(ctx)
  const entryOf = (slot) => entries.find((entry) => entry.slot === slot)
  // Which occupant actually renders: the lowest priority in the slot (the shell's
  // rule), so a test can prove the stock browser still owns its seat.
  const winnerOf = (slot) => (occupants.get(slot) ?? []).reduce((best, occupant) =>
    !best || (occupant.meta.priority ?? 0) < (best.meta.priority ?? 0) ? occupant : best, undefined)
  return {
    api, calls, entries, entryOf, winnerOf, occupants, services, state, intervals, disposers,
    setLocale(active) { snapshot = { active }; for (const listener of localeListeners) listener() },
    confirmations: () => confirmations,
    /** Hand the native session catalog over now, the way a late `inject` does. */
    giveSessions() {
      services.sessions = sessionsService
      for (const run of deferred.splice(0)) run()
      return sessionsService
    },
    dispose() { for (const dispose of disposers.splice(0)) dispose?.() },
  }
}

const text = (renderer) => JSON.stringify(renderer.toJSON())
async function mount(element) {
  let renderer
  await act(async () => { renderer = create(element) })
  return renderer
}
const flush = async () => { await act(async () => { await new Promise((resolve) => setImmediate(resolve)) }) }
const find = (node, predicate) => (node.root ?? node).findAll((child) => typeof child.type === 'string' && predicate(child))
const byTestId = (renderer, id) => find(renderer, (node) => node.props['data-testid'] === id)
const click = async (node) => { await act(async () => { await node.props.onClick({ preventDefault() {}, target: {} }) }) }
const tick = async (ui) => { for (const fn of [...ui.intervals.values()]) await act(async () => { await fn() }); await flush() }

test('the stock sidebar keeps its seat in every routing state; the plugin only fills additive seats', async () => {
  const off = load({ routing: { remote: false, reason: 'disabled', hosts: [] } })
  await flush()
  const noHost = load({ routing: { ...ROUTING, hosts: [] }, remotes: [] })
  await flush()
  const live = load()
  await flush()
  for (const [label, ui] of [['routing off', off], ['no host connected', noHost], ['a host connected', live]]) {
    assert.equal(ui.entryOf('sidebar.workspaces'), undefined, `${label}: the plugin never takes the browser's seat`)
    assert.equal(ui.winnerOf('sidebar.workspaces').meta.registrant, 'tk', `${label}: the stock browser is the only occupant`)
    // The additive surfaces are installed in every state; each renders nothing for a
    // local session or an idle host, so none of them shadows the native row.
    for (const slot of ['sidebar.session.row.trailing', 'sidebar.session.row.hover',
      'conversation.input.left', 'conversation.input.dock', 'conversation.input.right']) {
      assert.ok(ui.entryOf(slot), `${label}: ${slot} is registered`)
    }
  }
  // What the Devices page reads: the badge seats are in, and an off routing says so.
  // No connected host is not a failure — the seats are still there.
  assert.deepEqual({ ...off.api.testing.remoteUI.getSnapshot() },
    { grouped: false, reason: 'multi-host routing is off: disabled', hosts: 0 })
  assert.deepEqual({ ...noHost.api.testing.remoteUI.getSnapshot() }, { grouped: true, reason: null, hosts: 0 })
  assert.deepEqual({ ...live.api.testing.remoteUI.getSnapshot() }, { grouped: true, reason: null, hosts: 1 })
})

test('the host badge fills both native session-row seats under the plugin id, and stays when the host drops', async () => {
  const ui = load()
  await flush()
  for (const slot of ['sidebar.session.row.trailing', 'sidebar.session.row.hover']) {
    const entry = ui.entryOf(slot)
    assert.ok(entry, `${slot} took its seat`)
    assert.equal(entry.meta.name, slot)
    assert.equal(entry.meta.id, 'dsh-ext.devices.host')
    assert.equal(entry.meta.order, 100)
    assert.equal(entry.meta.label, ui.api.testing.DICT.en.hostChip)
    assert.equal(entry.component, ui.api.testing.SessionHostBadge, 'both seats render the same badge')
    // A leaf decoration: the row stays the native browser's, so the entry declares
    // no child seats of its own.
    assert.equal(entry.meta.children, undefined)
  }
  // Badging is additive: a dropped host changes what the badge says, not whether
  // the row seat exists.
  ui.state.routing = { ...ROUTING, hosts: [] }
  await tick(ui)
  assert.ok(ui.entryOf('sidebar.session.row.trailing'), 'the trailing seat survives a disconnect')
  assert.ok(ui.entryOf('sidebar.session.row.hover'), 'the hover seat survives a disconnect')
})

test('the badge names the host of a tagged session with an online dot, and renders nothing for a local one', async () => {
  const ui = load()
  await flush()
  const entry = ui.entryOf('sidebar.session.row.trailing')
  const page = await mount(React.createElement(entry.component, { sessionId: 'h:r1:s-remote' }))
  const badge = byTestId(page, 'session-host-badge')[0]
  assert.ok(badge, 'the badge is rendered')
  assert.equal(badge.props['data-host'], 'r1')
  assert.equal(badge.props.title, `${ui.api.testing.DICT.en.hostChip}: Qoder-Sigma`)
  assert.match(byTestId(page, 'session-host-dot')[0].props.className, /(^|\s)ok(\s|$)/, 'a live link reads as online')
  assert.match(text(page), /Qoder-Sigma/, 'the host name is the visible label')
  // An id with no host tag is a local session: the native row says all there is.
  const localPage = await mount(React.createElement(entry.component, { sessionId: 's-local' }))
  assert.equal(localPage.toJSON(), null)
  // Paired but with no live link: the owner's session still carries the name it was
  // paired under, and only the dot reads as dead.
  const offline = load({ routing: { ...ROUTING, hosts: [] } })
  await flush()
  const offlinePage = await mount(React.createElement(offline.entryOf('sidebar.session.row.hover').component, { sessionId: 'h:r1:s-remote' }))
  assert.match(byTestId(offlinePage, 'session-host-dot')[0].props.className, /(^|\s)off(\s|$)/)
  assert.match(text(offlinePage), /Qoder-Sigma/)
  page.unmount()
  localPage.unmount()
  offlinePage.unmount()
})

test('a change to the connected-host set pulls the native session catalog again; an unchanged set does not', async () => {
  const ui = load()
  await flush()
  // Startup already pulled `session/list` once (the shell's own connect path).
  assert.equal(ui.services.sessions.refreshes, 0, 'no duplicate pull at startup')
  await tick(ui)
  assert.equal(ui.services.sessions.refreshes, 0, 'the same host set polling again refreshes nothing')
  // A Host that connects after startup is in the merged answer only after the next
  // pull, so the connect is what asks for it.
  ui.state.routing = { ...ROUTING, hosts: [...ROUTING.hosts, { hostId: 'r2', hostName: 'Sigma-DSH', online: true }] }
  await tick(ui)
  assert.equal(ui.services.sessions.refreshes, 1, 'connect → one refresh')
  await tick(ui)
  assert.equal(ui.services.sessions.refreshes, 1, 'a stable set refreshes nothing')
  ui.state.routing = { ...ROUTING }
  await tick(ui)
  assert.equal(ui.services.sessions.refreshes, 2, 'disconnect → one refresh')
})

test('a host change that lands before the sessions service does is pulled once it arrives, not lost', async () => {
  const ui = load({ deferredSessions: true })
  await flush()
  ui.state.routing = { ...ROUTING, hosts: [...ROUTING.hosts, { hostId: 'r2', hostName: 'Sigma-DSH', online: true }] }
  await tick(ui)
  assert.equal(ui.services.sessions, null, 'the shell has not handed the service over yet')
  await act(async () => { ui.giveSessions() })
  await flush()
  assert.equal(ui.services.sessions.refreshes, 1, 'the pending pull runs as soon as the handle exists')
})

test('a refused session-row seat is reported on the Devices page and takes no other surface down', async () => {
  const ui = load({ missingSlots: ['sidebar.session.row.hover'] })
  await flush()
  assert.ok(ui.entryOf('sidebar.session.row.trailing'), 'the other seat still registered')
  assert.ok(ui.entryOf('conversation.input.left'), 'the composer chip still registered')
  const status = ui.api.testing.remoteUI.getSnapshot()
  assert.equal(status.grouped, false)
  assert.ok(status.reason.includes('sidebar.session.row.hover'), status.reason)
  assert.match(status.reason, /is not declared/)
  // The status line is part of the Devices page, so the reason is visible in the UI.
  const page = await mount(React.createElement(ui.api.testing.RemoteGroupingStatus))
  const rendered = text(page)
  const { DICT } = ui.api.testing
  assert.ok(rendered.includes(DICT.en.sidebarGrouping), 'the status line is labelled')
  assert.ok(rendered.includes(DICT.en.sidebarOffState), 'and reads as off')
  assert.ok(rendered.includes('is not declared'), 'with the reason a seat failed')
  page.unmount()
})

test('composer chip: only a tagged session shows it; host name + online dot; click toggles the popover', async () => {
  const local = load()
  await flush()
  const localPage = await mount(React.createElement(local.entryOf('conversation.input.left').component, { sessionId: 's-local' }))
  assert.equal(localPage.toJSON(), null, 'a local session has no host chip')
  localPage.unmount()
  const ui = load()
  await flush()
  const page = await mount(React.createElement(ui.entryOf('conversation.input.left').component, { sessionId: 'h:r1:s-remote' }))
  const chip = byTestId(page, 'host-chip')[0]
  assert.ok(chip, 'the chip is rendered')
  assert.match(text(page), /Qoder-Sigma/)
  assert.match(byTestId(page, 'host-chip-dot')[0].props.className, /ok/)
  assert.equal(chip.props['aria-expanded'], false)
  assert.equal(byTestId(page, 'host-popover').length, 0, 'closed until clicked')
  await click(chip)
  assert.equal(byTestId(page, 'host-popover').length, 1)
  assert.equal(byTestId(page, 'host-chip')[0].props['aria-expanded'], true)
  await click(byTestId(page, 'host-chip')[0])
  assert.equal(byTestId(page, 'host-popover').length, 0, 'clicking again closes it')
  page.unmount()
})

test('popover shows host facts and its actions hit the right routes (Reconnect, Forget host); no Settings navigation', async () => {
  const ui = load()
  await flush()
  const page = await mount(React.createElement(ui.entryOf('conversation.input.left').component, { sessionId: 'h:r1:s-remote' }))
  await click(byTestId(page, 'host-chip')[0])
  const rendered = text(page)
  assert.match(rendered, /Qoder-Sigma/)
  assert.match(rendered, /Online/)
  assert.match(rendered, /desktop/, 'kind summary')
  assert.match(rendered, /See sessions and history/, 'scopes summary uses the scope labels')
  assert.equal(byTestId(page, 'popover-paired')[0].children.join(''), '2026-11-01 08:30')
  assert.match(rendered, /Manage all devices in Settings → Devices/)
  assert.ok(byTestId(page, 'terminal-hint').length, 'no terminal grant → the hint is offered here')
  // Reconnect: POST /devices/remotes/:id/connect
  await click(byTestId(page, 'reconnect')[0])
  await flush()
  const connect = ui.calls.find((call) => call.route === '/devices/remotes/r1/connect')
  assert.ok(connect, 'reconnect posted')
  assert.equal(connect.method, 'POST')
  // Forget host: DELETE /devices/remotes/:id, behind the confirm.
  await click(byTestId(page, 'forget-host')[0])
  await flush()
  assert.equal(ui.confirmations(), 1, 'asked first')
  const forget = ui.calls.find((call) => call.method === 'DELETE' && call.route === '/devices/remotes/r1')
  assert.ok(forget, 'the host was deleted')
  // Nothing anywhere tries to navigate to a Settings page (rc.1 has no such API).
  assert.equal(ui.calls.some((call) => /settings|navigate|location/i.test(call.route)), false)
  page.unmount()
})

test('offline host: read-only banner naming the host; "Remove local copy" deletes our cached copy', async () => {
  const ui = load({ routing: { ...ROUTING, hosts: [] } })
  await flush()
  const page = await mount(React.createElement(ui.entryOf('conversation.input.dock').component, { sessionId: 'h:r1:s-remote' }))
  const banner = byTestId(page, 'offline-banner')[0]
  assert.ok(banner, 'the offline banner is shown')
  const rendered = text(page)
  assert.match(rendered, /This task is no longer available on Qoder-Sigma/)
  assert.match(rendered, /Read-only/)
  assert.match(rendered, /local copy/)
  await click(byTestId(page, 'remove-local-copy')[0])
  await flush()
  const removed = ui.calls.find((call) => call.method === 'DELETE' && call.route === '/devices/remotes/r1/sessions/s-remote')
  assert.ok(removed, 'the raw (untagged) session id is used on the wire')
  assert.match(text(page), /Local copy removed/)
  page.unmount()
  // Already gone: the same click reports it instead of failing.
  const second = load({ routing: { ...ROUTING, hosts: [] }, cached: false })
  await flush()
  const page2 = await mount(React.createElement(second.entryOf('conversation.input.dock').component, { sessionId: 'h:r1:s-remote' }))
  await click(byTestId(page2, 'remove-local-copy')[0])
  await flush()
  assert.match(text(page2), /There was no local copy to remove/)
  page2.unmount()
  // A local session has no remote banner at all.
  const local = load({ routing: { ...ROUTING, hosts: [] } })
  await flush()
  const page3 = await mount(React.createElement(local.entryOf('conversation.input.dock').component, { sessionId: 's-local' }))
  assert.equal(page3.toJSON(), null)
  page3.unmount()
})

test('model error from the host: "Model status" banner, no local fallback; nothing without an error', async () => {
  const ui = load()
  await flush()
  const withError = (state) => (selector) => selector(state)
  const page = await mount(React.createElement(ui.entryOf('conversation.input.dock').component, {
    sessionId: 'h:r1:s-remote',
    useSession: withError({ projections: { values: { model: { error: 'provider key rejected on the host' } } } }),
  }))
  const banner = byTestId(page, 'model-status-banner')[0]
  assert.ok(banner, 'the model-status banner is shown')
  const rendered = text(page)
  assert.match(rendered, /Model status/)
  assert.match(rendered, /provider key rejected on the host/, 'the host answer is quoted')
  assert.match(rendered, /no local model is used instead/)
  page.unmount()
  const clean = load()
  await flush()
  const page2 = await mount(React.createElement(clean.entryOf('conversation.input.dock').component, {
    sessionId: 'h:r1:s-remote',
    useSession: withError({ projections: { values: {} } }),
  }))
  assert.equal(byTestId(page2, 'model-status-banner').length, 0, 'a healthy session shows no notice')
  assert.equal(byTestId(page2, 'offline-banner').length, 0)
  page2.unmount()
})

test('remote terminal: hidden without the terminal grant, an entry with it, and it opens the host tab', async () => {
  const ui = load()
  await flush()
  const page = await mount(React.createElement(ui.entryOf('conversation.input.right').component, { sessionId: 'h:r1:s-remote' }))
  assert.equal(page.toJSON(), null, 'no terminal scope → no entry')
  page.unmount()
  // Grant it, then the entry appears and asks the right column to open the tab.
  const granted = load({ remotes: [{ ...REMOTE, device: { kind: 'desktop', scopes: [...REMOTE.device.scopes, 'terminal'] } }] })
  await flush()
  const entry = granted.entryOf('conversation.input.right')
  const page2 = await mount(React.createElement(entry.component, { sessionId: 'h:r1:s-remote', ...entry.meta.inject() }))
  const terminal = byTestId(page2, 'remote-terminal')[0]
  assert.ok(terminal, 'the terminal entry is rendered')
  assert.equal(terminal.props.disabled, false)
  await click(terminal)
  assert.deepEqual(JSON.parse(JSON.stringify(granted.services.sidebarRight.tabs)), [['terminal', { params: { sessionId: 'h:r1:s-remote' } }]])
  page2.unmount()
  // A local session never gets one.
  const localPage = await mount(React.createElement(entry.component, { sessionId: 's-local', ...entry.meta.inject() }))
  assert.equal(localPage.toJSON(), null)
  localPage.unmount()
})

test('a revoked host never reads as disconnected, even when the router still lists it', async () => {
  // `revoked` is decided BEFORE the router's retained entry: a grant that was taken
  // away is not "read-only, it comes back".
  const ui = load({
    remotes: [{ ...REMOTE, id: 'r1', status: 'revoked' }],
    routing: { remote: true, reason: null, merged: ['session/list'], hosts: [],
      disconnected: [{ hostId: 'r1', hostName: 'Qoder-Sigma', online: false, retainedSessions: 3 }] },
  })
  await flush()
  const link = ui.api.testing.hostLinkOf(ui.api.testing.hostsStore.getSnapshot(), 'r1')
  assert.equal(link.revoked, true)
  assert.equal(link.disconnected, false, 'a revoked grant is not a disconnected link')
})

test('a disconnected host is labelled as such, not as a host that was never there', async () => {
  // The router retains a paired host's session rows while its link is down, so the row
  // and the composer must say "Disconnected" — the sessions are still there and
  // readable, only sending is refused. `routing.disconnected` is what carries that.
  const DISCONNECTED = {
    remote: true, reason: null, merged: ['session/list'],
    hosts: [],
    disconnected: [{ hostId: 'r1', hostName: 'Qoder-Sigma', online: false, retainedSessions: 3 }],
  }
  const ui = load({ routing: DISCONNECTED })
  await flush()
  // The single answer every surface reads.
  const link = ui.api.testing.hostLinkOf(ui.api.testing.hostsStore.getSnapshot(), 'r1')
  assert.equal(link.online, false)
  assert.equal(link.disconnected, true, 'a paired host with no link is disconnected, not unknown')
  assert.equal(link.retainedSessions, 3, 'and it says how much is still listed')
  assert.equal(link.name, 'Qoder-Sigma', 'the paired name survives the drop')
  // A tag naming a host the window has no record of is NOT disconnected: nothing is
  // retained for it, so claiming otherwise would invent a retention.
  assert.equal(ui.api.testing.hostLinkOf(ui.api.testing.hostsStore.getSnapshot(), 'r-unknown').disconnected, false)

  // The native row badge: dot off, and the title names the state.
  const badge = await mount(React.createElement(ui.entryOf('sidebar.session.row.trailing').component, { sessionId: 'h:r1:s-remote' }))
  const node = byTestId(badge, 'session-host-badge')[0]
  assert.equal(node.props['data-link'], 'disconnected')
  assert.match(byTestId(badge, 'session-host-dot')[0].props.className, /(^|\s)off(\s|$)/)
  assert.match(node.props.title, /Disconnected/, 'the badge says which kind of dead the link is')
  assert.match(text(badge), /Qoder-Sigma/, 'the host name is still shown')
  badge.unmount()

  // The composer chip's popover says what still works, so "Offline" is not the whole story.
  const chip = await mount(React.createElement(ui.entryOf('conversation.input.left').component, { sessionId: 'h:r1:s-remote' }))
  await click(byTestId(chip, 'host-chip')[0])
  assert.equal(byTestId(chip, 'popover-state')[0].children.join(''), ui.api.testing.DICT.en['status.disconnected'])
  assert.ok(byTestId(chip, 'popover-disconnected').length, 'the read-only note is offered')
  assert.match(text(chip), /Sessions stay listed and readable/)
  chip.unmount()

  // The banner above the conversation: the task is NOT gone, it is disconnected.
  const dock = await mount(React.createElement(ui.entryOf('conversation.input.dock').component, { sessionId: 'h:r1:s-remote' }))
  const banner = byTestId(dock, 'offline-banner')[0]
  assert.ok(banner, 'a notice is still shown')
  assert.equal(banner.props['data-link'], 'disconnected')
  assert.doesNotMatch(text(dock), /no longer available/, 'it never claims the task was lost')
  assert.match(text(dock), /Disconnected/)
  dock.unmount()

  // Both dictionaries carry the new strings.
  const { DICT } = ui.api.testing
  assert.deepEqual(Object.keys(DICT.vi).sort(), Object.keys(DICT.en).sort(), 'vi and en stay twins')
  assert.notEqual(DICT.vi['status.disconnected'], DICT.en['status.disconnected'], 'a real translation, not a copy')
  assert.notEqual(DICT.vi['status.disconnectedSessions'], DICT.en['status.disconnectedSessions'])
})
