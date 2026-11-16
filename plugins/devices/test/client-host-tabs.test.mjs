// The sidebar's two tabs (Qoder's This Computer / Remote Workspace), client half:
//  - the strip is placed in the SIDEBAR's DOM, not granted a seat of its own: one
//    `div[data-testid="sidebar-host-tabs"]` inserted as the sidebar section header's
//    NEXT SIBLING — below `<div … data-sidebar-workspace-header>` and directly above
//    `<div … data-sidebar-list-area>`, never inside that scrolling area (it owns the
//    sidebar's `100cqh` scroll contract) and never over the New Session button, which
//    keeps its exact position and size (owner decision 2026-11-16);
//  - the seat that carries the placement helper is the root-scope `shell.overlay` list
//    slot, and the helper renders nothing — no floating box, no second root tree in
//    this bundle's React;
//  - the insertion is idempotent: one node per header however many observer passes run,
//    re-inserted after a re-render drops it, and never duplicated;
//  - the filter is ONE <style data-plugin="dsh-ext.devices.host-tabs">, swapped (never
//    stacked) on a tab change, holding the exact rules for each tab on the shipped
//    `data-row-key` shapes and never hiding the empty state;
//  - the choice is persisted (localStorage, default `local`) and unpublished to the
//    strip; Ctrl+Alt+1 / 2 switch it;
//  - a shell with no header (the collapsed rail draws none) or a refused seat says so on
//    the Devices page;
//  - dispose removes the node, the style, the observer and every registration, and
//    leaves the host store as it was;
//  - and the whole feature makes no HTTP call at all: the tab switch writes a style,
//    nothing else — the native streams are the browser's own business.
// Loads lib/client.js in a vm with a fake __ModuleLoader__ + a fake slot host and a fake
// DOM, the way test/client.test.mjs does, and runs as a plain script (`node test/...`)
// because spawning `node --test` workers is EPERM in the sandbox.
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

const h = React.createElement
// The vm's `window` IS `globalThis`, so a shell-looking script here is what the page
// sees — exactly the way the desktop renderer runs it.
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)) },
}
console.log('client-host-tabs')

const STYLE_ID = 'dsh-ext.devices.host-tabs'
const STORAGE_KEY = 'dsh-ext.devices.sidebar-tab'
// The seat the placement helper lives in: a root-scope `list` slot the layout declares.
const PLACEMENT_SEAT = 'shell.overlay'

/**
 * A fake document with just enough tree for the placement contract: `parentNode`,
 * `children` (elements only), `nextElementSibling`, `insertBefore`, `remove`, and the
 * two queries the plugin runs — `[data-sidebar-workspace-header]` / -list-area, and the
 * `[data-testid="…"]` of its own node. Shipped shape (read from source): the New
 * Session row above, then the `Workspaces` section header, then the scrolling list
 * area, which is what `bindScrollerRef` is bound to.
 */
function makeDocument({ header = true, listArea = true } = {}) {
  const doc = { mutations: [] }
  const mk = (tag, attrs = {}) => ({
    tagName: tag.toUpperCase(),
    attrs,
    children: [],
    parentNode: null,
    removed: false,
    textContent: '',
    dataset: {},
    get nextElementSibling() {
      if (this.parentNode === null) return null
      const at = this.parentNode.children.indexOf(this)
      return at < 0 ? null : (this.parentNode.children[at + 1] ?? null)
    },
    get nextSibling() { return this.nextElementSibling },
    insertBefore(child, reference) {
      if (child.parentNode !== null) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1)
      const at = reference === null || reference === undefined ? this.children.length : this.children.indexOf(reference)
      this.children.splice(at < 0 ? this.children.length : at, 0, child)
      child.parentNode = this
      child.removed = false
      doc.mutations.push(`insert:${child.attrs['data-testid'] ?? child.tagName}`)
      return child
    },
    appendChild(child) { return this.insertBefore(child, null) },
    remove() {
      if (this.parentNode !== null) {
        const at = this.parentNode.children.indexOf(this)
        if (at >= 0) this.parentNode.children.splice(at, 1)
      }
      this.parentNode = null
      this.removed = true
      doc.mutations.push(`remove:${this.attrs['data-testid'] ?? this.tagName}`)
    },
    matches(selector) {
      if (selector === '[data-sidebar-workspace-header]') return this.attrs['data-sidebar-workspace-header'] !== undefined
      if (selector === '[data-sidebar-list-area]') return this.attrs['data-sidebar-list-area'] !== undefined
      const testid = /^\[data-testid="(.+)"\]$/.exec(selector)
      return testid ? this.attrs['data-testid'] === testid[1] : false
    },
    setAttribute() {},
  })
  doc.body = mk('body')
  doc.sidebar = mk('div', { class: 'sidebar' })
  doc.body.appendChild(doc.sidebar)
  doc.newSession = mk('button', { class: 'shell-new-session' })
  doc.sidebar.appendChild(doc.newSession)
  doc.header = header ? mk('div', { class: 'sectionHeader', 'data-sidebar-workspace-header': '' }) : null
  if (doc.header) doc.sidebar.appendChild(doc.header)
  doc.listArea = listArea ? mk('div', { class: 'listArea', 'data-sidebar-list-area': '' }) : null
  if (doc.listArea) doc.sidebar.appendChild(doc.listArea)
  const walk = (node) => [node, ...node.children.flatMap(walk)]
  doc.all = () => walk(doc.body)
  doc.querySelector = (selector) => doc.all().find((node) => node.matches(selector)) ?? null
  doc.querySelectorAll = (selector) => doc.all().filter((node) => node.matches(selector))
  doc.createElement = (tag) => {
    const node = mk(tag)
    // The strip's node is found by its `data-testid`; the filter by `data-plugin`, which
    // the writer sets through `setAttribute` OR `dataset` — the fake supports both, as a
    // real element does, so either branch lands in `attrs`.
    node.setAttribute = (name, value) => { node.attrs[name] = String(value) }
    return node
  }
  doc.head = {
    children: [],
    appendChild(node) { this.children.push(node); node.parentNode = this; return node },
    removeChild(node) {
      const at = this.children.indexOf(node)
      if (at >= 0) this.children.splice(at, 1)
      node.parentNode = null
      return node
    },
  }
  return doc
}

/** The sidebar's order by role, so a test states the placement as one string. */
const sidebarOrder = (doc) => doc.sidebar.children.map((node) => {
  if (node.attrs['data-sidebar-workspace-header'] !== undefined) return 'header'
  if (node.attrs['data-sidebar-list-area'] !== undefined) return 'listArea'
  // The strip is the sidebar's own `div` that carries our test id (a React root's
  // container: created empty, then filled by the strip's tree).
  if (node.attrs['data-testid'] === 'sidebar-host-tabs') return 'strip'
  if (node.attrs.class === 'shell-new-session') return 'newSession'
  return node.tagName.toLowerCase()
}).join(' > ')

/**
 * Load lib/client.js and apply() it against a fake host. `declared` decides which seats
 * the shell declares (the placement seat is `shell.overlay`), `keyRegistry` whether the
 * key registry is handed over, `dom` is the fake document — a shell with no sidebar
 * header passes `header: false`, which is the collapsed rail's shape.
 */
function load({ locale = 'en-US', declared = ['shell.overlay'], keyRegistry = 'ok', stored = null, dom } = {}) {
  let api
  const calls = []
  const fetch = async (url, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${new URL(url).pathname}`)
    // Every route answers "nothing paired, no service": this feature never needs one,
    // and the surfaces that do must not crash the run either way.
    return { ok: true, status: 200, json: async () => ({ remotes: [], routing: { remote: false, reason: 'disabled', hosts: [] } }) }
  }
  storage.clear()
  if (stored !== null) storage.set(STORAGE_KEY, stored)
  const doc = dom ?? makeDocument()
  // What the strip's React root is handed: the SAME element the plugin rendered, so a
  // test mounts the strip's real tree. The counters are how "unmounted, not orphaned"
  // and "rendered once" are provable without a browser.
  const rendered = []
  const roots = []
  const createRoot = (node) => {
    const root = {
      node, renders: 0, unrenders: 0, unmounted: false, element: null,
      render(element) {
        if (this.unmounted) throw new Error('render on an unmounted root')
        this.renders += 1
        this.element = element
        rendered.push(element)
      },
      unmount() { this.unrenders += 1; this.unmounted = true },
    }
    roots.push(root)
    return root
  }
  // One head per page: a reload starts from an empty document.
  const timers = []
  const observers = []
  let disconnected = 0
  // A MutationObserver that records its callback, so `pulse()` IS "the sidebar
  // re-rendered": the pass only reaches the DOM through the plugin's own debounce.
  class FakeObserver {
    constructor(callback) { this.callback = callback; this.observing = null; observers.push(this) }
    observe(target, options) { this.observing = { target, options } }
    disconnect() { this.observing = null; disconnected += 1 }
  }
  const window = {
    __ModuleLoader__: { load: ({ id, factory }) => { api = { id, ...factory((name) => { assert.equal(name, 'react'); return React }) } } },
    localStorage: globalThis.localStorage,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => { timers.push(fn); return timers.length },
    clearTimeout: (id) => { if (id > 0) timers[id - 1] = null },
    confirm: () => true,
  }
  vm.runInNewContext(source, { window, document: doc, fetch, URL, console, Date, MutationObserver: FakeObserver,
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    navigator: { language: locale, clipboard: { writeText: async () => {} } } })
  const entries = []
  const kinds = { 'shell.overlay': 'list' }
  for (const name of ['settings.section', 'settings.section.icon', 'conversation.input.left', 'conversation.input.dock',
    'conversation.input.right', 'sidebar.session.row.trailing', 'sidebar.session.row.hover', 'sidebar.panellist', 'plugins.detail.section']) kinds[name] = 'list'
  kinds.main = 'keyed'
  const registered = []
  const registeredShortcuts = []
  // `ctx.effect(fn)` runs it now and keeps what it returned; one entry per effect, so a
  // dispose() only ever tears down what the module mounted.
  const effects = []
  const localeListeners = new Set()
  let snapshot = { active: locale }
  const ctx = {
    locale: { getSnapshot: () => snapshot, subscribe: (listener) => { localeListeners.add(listener); return () => localeListeners.delete(listener) } },
    effect(fn) { effects.push(fn()) },
    slots: {
      inject(slot, factory) {
        // `ctx.slots.inject` is inert until the parent entry declares the seat; the
        // factory (and with it `register`) never runs against an undeclared one. Every
        // other seat this bundle fills is declared by its OWN package, so only the
        // placement seat is on trial here.
        if (slot === PLACEMENT_SEAT && !declared.includes(slot)) return () => {}
        const registration = factory()
        const entry = { slot, meta: registration.meta, component: registration.component }
        entries.push(entry)
        return () => { const at = entries.indexOf(entry); if (at >= 0) entries.splice(at, 1); return undefined }
      },
      register(meta, component) {
        const kind = kinds[meta.name]
        if (!kind) throw new Error(`slot "${meta.name}" is not declared (a parent entry's children table must declare it)`)
        // A seat the shell does not declare hands back an inert registration instead of
        // throwing — the shape an undeclared parent seat really has, so `declared: []`
        // means "this shell does not offer it" and not "the test made it impossible".
        if (meta.name === PLACEMENT_SEAT && !declared.includes(meta.name)) return { meta, component, inert: true }
        // Every seat this package asks for is a `list`, whose one mandatory option is id.
        if (meta.id === undefined) throw new Error(`list slot "${meta.name}" requires options.id`)
        registered.push(meta.name)
        return { meta, component }
      },
    },
    ...(keyRegistry === 'absent' ? {} : {
      shortcuts: {
        register(command) {
          if (keyRegistry === 'refuse') throw new Error('Reserved shortcut default: ' + command.id)
          registeredShortcuts.push(command)
          return () => { const at = registeredShortcuts.indexOf(command); if (at >= 0) registeredShortcuts.splice(at, 1); return undefined }
        },
      },
    }),
  }
  // The root renderer is the seam `installHostTabPlacement` takes in production too
  // (`reactRoot()` → `deps.reactRoot`); `createRoot` here is that seam.
  api.apply(ctx, { createRoot })
  const stripNode = () => doc.querySelector('[data-testid="sidebar-host-tabs"]')
  const flushTimers = () => { for (const fn of timers.splice(0)) if (typeof fn === 'function') fn() }
  // "The sidebar re-rendered": one batch of childList records that are NOT ours, which is
  // what a real MutationObserver callback receives — and what the plugin's own insertion
  // batch is recognised by (a record whose addedNodes are only the strip's node).
  const foreignBatch = () => [{ type: 'childList', target: doc.sidebar, addedNodes: [doc.listArea].filter(Boolean), removedNodes: [] }]
  const pulse = () => { for (const observer of observers) if (observer.observing) observer.callback(foreignBatch()) }
  const pulseOwn = () => {
    const ours = stripNode()
    const batch = [{ type: 'childList', target: doc.sidebar, addedNodes: ours ? [ours] : [], removedNodes: [] }]
    for (const observer of observers) if (observer.observing) observer.callback(batch)
  }
  const stripElement = () => {
    const root = roots.find((item) => item.node === stripNode()) ?? roots.at(-1)
    return root?.element ?? null
  }
  return {
    api, calls, entries, registered, doc, roots, flushTimers, pulse, pulseOwn,
    shortcuts: registeredShortcuts,
    stripNode,
    stripElement,
    stripRoot: () => roots.at(-1) ?? null,
    renderedRoots: () => rendered,
    observers: () => observers.length,
    disconnected: () => disconnected,
    sidebarOrder: () => sidebarOrder(doc),
    strips: () => doc.querySelectorAll('[data-testid="sidebar-host-tabs"]'),
    inserts: () => doc.mutations.filter((entry) => entry === 'insert:sidebar-host-tabs').length,
    style: () => doc.head.children.find((node) => node.attrs?.['data-plugin'] === STYLE_ID),
    setLocale(active) { snapshot = { active }; for (const listener of localeListeners) listener() },
    dispose() { for (const dispose of effects.splice(0)) { if (typeof dispose === 'function') dispose() } },
  }
}

const text = (renderer) => JSON.stringify(renderer.toJSON())
async function mount(reactElement) {
  let renderer
  await act(async () => { renderer = create(reactElement) })
  return renderer
}
const find = (renderer, predicate) => renderer.root.findAll((node) => typeof node.type === 'string' && predicate(node))
const byTestId = (renderer, id) => find(renderer, (node) => node.props['data-testid'] === id)
const click = async (node) => { await act(async () => { await node.props.onClick({ preventDefault() {}, target: {} }) }) }
/** The strip's own tree: the element the placement helper handed its React root. */
const stripOf = async (ui) => {
  const element = ui.stripElement()
  assert.ok(element, 'the placement helper rendered the strip')
  return mount(element)
}

// ------------------------------------------------------------------- the placement
await check('the strip is ONE node, the sidebar header\'s next sibling: below "Workspaces", above the list area', async () => {
  const ui = load()
  assert.equal(ui.sidebarOrder(), 'newSession > header > strip > listArea',
    'the New Session row keeps its place; the strip sits between the header and the list area')
  const node = ui.stripNode()
  assert.equal(node.parentNode, ui.doc.sidebar, 'a sibling of the header, never a child of the list area')
  assert.equal(ui.doc.header.nextElementSibling, node, 'exactly the header\'s next sibling')
  assert.equal(ui.strips().length, 1, 'one strip')
  assert.equal(ui.doc.listArea.children.length, 0, 'the scrolling area holds nothing of ours')
  // The seat: the root-scope overlay list, and a helper that draws nothing at all.
  const entry = ui.entries.find((item) => item.slot === PLACEMENT_SEAT)
  assert.ok(entry, `the helper took the ${PLACEMENT_SEAT} seat`)
  assert.equal(entry.meta.name, PLACEMENT_SEAT)
  assert.equal(entry.meta.id, 'dsh-ext.devices.tabs', 'a fresh id, so nothing shipped is shadowed')
  const page = await mount(h(entry.component, {}))
  assert.equal(page.toJSON(), null, 'the helper renders no box — no floating overlay over the sidebar')
  page.unmount()
  assert.equal(ui.entries.filter((item) => item.slot === 'sidebar.session.action').length, 0,
    'the New Session seat is not asked for any more')
  assert.equal(ui.roots.length, 1, 'one React root for the strip')
  ui.dispose()
})

await check('the strip is a tablist of "This Computer" / "Remote Workspace" (vi: "Máy này" / "Workspace từ xa"), local selected', async () => {
  const ui = load()
  const page = await stripOf(ui)
  const { DICT } = ui.api.testing
  const tabs = find(page, (node) => node.props.role === 'tab')
  assert.deepEqual(tabs.map((tab) => tab.children.join('')), [DICT.en.tabThisComputer, DICT.en.tabRemoteWorkspace])
  assert.deepEqual(tabs.map((tab) => tab.props['aria-selected']), [true, false], 'local is the default')
  assert.match(tabs[0].props.title, /\(Ctrl\+Alt\+1\)$/, 'each tab names its key')
  assert.match(tabs[1].props.title, /\(Ctrl\+Alt\+2\)$/)
  // No children of the shell are wrapped any more: the box is the strip and the strip only.
  assert.deepEqual(page.toJSON().children.map((child) => child.props.role), ['tablist'])
  page.unmount()
  const vi = load({ locale: 'vi' })
  const viPage = await stripOf(vi)
  assert.deepEqual(find(viPage, (node) => node.props.role === 'tab').map((tab) => tab.children.join('')),
    [vi.api.testing.DICT.vi.tabThisComputer, vi.api.testing.DICT.vi.tabRemoteWorkspace])
  viPage.unmount()
  // Both dictionaries carry the new strings, and neither is a copy of the other.
  const { DICT: EN } = load().api.testing
  const { DICT: VI } = vi.api.testing
  assert.deepEqual(Object.keys(VI.en).sort(), Object.keys(EN.en).sort(), 'vi and en stay twins')
  assert.deepEqual(Object.keys(VI.vi).sort(), Object.keys(EN.en).sort(), 'and both tables hold the same keys as en')
  for (const key of ['tabThisComputer', 'tabRemoteWorkspace', 'hostTabs', 'sidebarReasonNoTabs', 'sidebarReasonShortcut', 'hostTabsOn', 'hostTabsOff']) {
    assert.ok(EN.en[key], `en.${key}`)
    assert.notEqual(EN.en[key], VI.vi[key], `${key} is translated`)
  }
  ui.dispose(); vi.dispose()
})

await check('many observer passes insert the node ONCE; a re-render that drops it gets it back, never a second copy', async () => {
  const ui = load()
  assert.equal(ui.inserts(), 1, 'the first pass placed exactly one node')
  const node = ui.stripNode()
  // The observer sees the batch its own insertion caused — and MUST ignore it: a pass run
  // for our own record would be the loop the contract forbids.
  ui.pulseOwn()
  ui.flushTimers()
  assert.equal(ui.inserts(), 1, 'the batch our own insert caused schedules no pass')
  // A burst of sidebar renders: the observer fires, the debounce collapses them, and
  // every pass that finds our own node already in place changes nothing.
  const observed = ui.observers()
  assert.equal(observed, 1, 'one observer on the document')
  for (let i = 0; i < 5; i += 1) ui.pulse()
  ui.flushTimers()
  assert.equal(ui.inserts(), 1, 'five more passes, still one insertion')
  assert.equal(ui.strips().length, 1, 'exactly one strip')
  assert.equal(ui.stripNode(), node, 'still the same node')
  // React re-renders and throws the node away: the next pass puts it back, in place.
  node.remove()
  assert.equal(ui.stripNode(), null, 'gone')
  ui.pulse()
  ui.flushTimers()
  assert.equal(ui.stripNode(), node, 'the same node comes back (its root was never unmounted)')
  assert.equal(ui.doc.header.nextElementSibling, node, 'and in the same place')
  assert.equal(ui.strips().length, 1, 'never a copy')
  assert.deepEqual(ui.doc.listArea.children, [], 'and still nothing inside the list area')
  assert.equal(ui.roots[0].unrenders, 0, 'the root was not torn down for a re-insert')
  ui.dispose()
})

await check('a stray copy of the strip is removed, not kept: one node per header', async () => {
  const ui = load()
  const copy = ui.doc.createElement('div')
  copy.setAttribute('data-testid', 'sidebar-host-tabs')
  // A copy standing where OURS belongs: the pass removes it and puts ours there — the
  // header's next sibling, still above the list area.
  const copied = ui.stripNode()
  copied.remove()
  ui.doc.sidebar.insertBefore(copy, ui.doc.header.nextSibling)
  assert.equal(ui.doc.header.nextElementSibling, copy, 'the copy is standing where ours belongs')
  // One more mutation: the observer's debounced pass is the thing that cleans up.
  ui.pulse()
  ui.flushTimers()
  assert.equal(ui.strips().length, 1, 'one node per header')
  assert.ok(copy.removed, 'the copy was the one removed')
  assert.equal(ui.sidebarOrder(), 'newSession > header > strip > listArea', 'ours is back between header and list area')
  assert.equal(ui.doc.header.nextElementSibling, ui.stripNode(), 'the header\'s next sibling is ours')
  ui.dispose()
})

await check('a shell with no header (the collapsed rail draws none) gets no strip, and the page says why', async () => {
  const ui = load({ dom: makeDocument({ header: false }) })
  assert.equal(ui.strips().length, 0, 'no header, no strip')
  assert.equal(ui.style(), undefined, 'no tab filter either — a filter with no switch would hide half the list')
  assert.equal(ui.shortcuts.length, 0, 'and no keys pointing at nothing')
  const status = ui.api.testing.remoteUI.getSnapshot()
  assert.equal(status.tabs, false)
  assert.equal(status.tabsReason, 'no-tabs', 'and the page can say why')
  const page = await mount(h(ui.api.testing.RemoteGroupingStatus))
  const rendered = text(page)
  assert.ok(rendered.includes(ui.api.testing.DICT.en.hostTabsOff), 'the page says the tabs are not installed')
  assert.ok(byTestId(page, 'sidebar-tabs-state').length === 1)
  page.unmount()
  ui.dispose()
})

// ---------------------------------------------------------------------- the filter
await check('one style element, from load on, under data-plugin dsh-ext.devices.host-tabs', async () => {
  const ui = load()
  const styles = ui.doc.head.children.filter((node) => node.attrs?.['data-plugin'] === STYLE_ID)
  assert.equal(styles.length, 1, 'exactly one injected element')
  assert.equal(styles[0].textContent, ui.api.testing.HOST_TABS_STYLE.local, 'local is the default rule set')
  ui.dispose()
})

// The `data-row-key` values the owner measured on the live DSH window (flat, in
// document order): local workspace untagged, local session `session-<uuid>`, every
// remote row tagged `h:<hostId>:` after its kind, and the ungrouped header + its
// overflow button — which held remote sessions only in that measurement.
const MEASURED_ROWS = [
  { key: 'workspace:', local: false, note: 'ungrouped header (holds only remote sessions)' },
  { key: 'overflow:', local: false, note: 'ungrouped group\'s hidden-sessions button' },
  { key: 'workspace:9f1c2a3e-1111-4b2c-8d3e-5a6b7c8d9e0f', local: true },
  { key: 'session:session-9f1c2a3e-1111-4b2c-8d3e-5a6b7c8d9e0f', local: true },
  { key: 'workspace:h:r1:1a2b3c4d-2222-4e5f-8a9b-0c1d2e3f4a5b', local: false },
  { key: 'session:h:r1:session-1a2b3c4d-2222-4e5f-8a9b-0c1d2e3f4a5b', local: false },
  { key: 'overflow:h:r1:6a7b8c9d-3333-4f50-9a1b-2c3d4e5f6a7b', local: false },
]
const STYLE_SUFFIX = '{display:none!important}'

/**
 * Evaluate one simple selector from the stylesheet text against a row key — only the
 * grammar the filter actually writes: `[data-row-key="x"]`, `[data-row-key^="x"]` and
 * `:not([data-row-key^="y"])`, comma-separated. Returns whether the selector hides it.
 */
function selectorHides(selector, key) {
  const clause = /^\[data-row-key(?:="([^"]*)"|\^="([^"]*)")?\](?::not\(\[data-row-key\^="([^"]*)"\]\))?$/.exec(selector.trim())
  assert.ok(clause, `unexpected selector grammar: ${selector}`)
  const [, exact, prefix, notPrefix] = clause
  const matches = exact !== undefined ? key === exact : key.startsWith(prefix)
  return matches && !(notPrefix !== undefined && key.startsWith(notPrefix))
}
/** Every key the given stylesheet text hides (a row is hidden if any selector matches). */
function hiddenKeys(styleText) {
  assert.match(styleText, new RegExp(`${STYLE_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), 'one rule block')
  const selectors = styleText.slice(0, -STYLE_SUFFIX.length).split(',')
  return MEASURED_ROWS.filter((row) => selectors.some((selector) => selectorHides(selector, row.key))).map((row) => row.key)
}
const LOCAL_KEYS = MEASURED_ROWS.filter((row) => row.local).map((row) => row.key)
const REMOTE_KEYS = MEASURED_ROWS.filter((row) => !row.local).map((row) => row.key)

await check('the local tab\'s style text is exact and hides exactly the h:-tagged rows, ungrouped header/overflow kept', async () => {
  const ui = load()
  const { HOST_TABS_STYLE } = ui.api.testing
  assert.equal(HOST_TABS_STYLE.local,
    '[data-row-key^="workspace:h:"],' +
    '[data-row-key^="session:h:"],' +
    '[data-row-key^="overflow:h:"]{display:none!important}')
  assert.equal(ui.style().textContent, HOST_TABS_STYLE.local)
  // Measured local rows (untagged workspace, local session, ungrouped header and
  // overflow) stay: a local loose session may live under the ungrouped header. Only
  // the h:-tagged rows are hidden.
  assert.deepEqual(hiddenKeys(HOST_TABS_STYLE.local), REMOTE_KEYS.filter((key) => key.slice(key.indexOf(':') + 1).startsWith('h:')))
  for (const key of LOCAL_KEYS) assert.ok(!hiddenKeys(HOST_TABS_STYLE.local).includes(key), `${key} stays`)
  assert.doesNotMatch(HOST_TABS_STYLE.local, /empty/, 'the empty state is never hidden')
  assert.doesNotMatch(HOST_TABS_STYLE.local, /:has\(|:not\(/, 'no case-matching or mixed-case rules')
  ui.dispose()
})

await check('the remote tab\'s style text is exact and hides exactly the local rows plus the ungrouped header', async () => {
  const ui = load()
  const { HOST_TABS_STYLE } = ui.api.testing
  assert.equal(HOST_TABS_STYLE.remote,
    '[data-row-key^="workspace:"]:not([data-row-key^="workspace:h:"]),' +
    '[data-row-key^="session:"]:not([data-row-key^="session:h:"]),' +
    '[data-row-key^="overflow:"]:not([data-row-key^="overflow:h:"]){display:none!important}')
  // Measured: the untagged workspace + local session are hidden; the ungrouped header
  // AND its overflow button are hidden by the plain `:not` rule, and every h:-tagged
  // row — remote workspace with its sessions included — stays.
  assert.deepEqual(hiddenKeys(HOST_TABS_STYLE.remote), [
    'workspace:',
    'overflow:',
    ...LOCAL_KEYS.filter((key) => key !== 'workspace:' && key !== 'overflow:'),
  ])
  for (const key of REMOTE_KEYS.filter((key) => key.startsWith('workspace:h:') || key.startsWith('session:h:') || key.startsWith('overflow:h:'))) {
    assert.ok(!hiddenKeys(HOST_TABS_STYLE.remote).includes(key), `${key} stays on the remote tab`)
  }
  assert.equal(hiddenKeys(HOST_TABS_STYLE.remote).includes('empty'), false, 'the empty state stays')
  assert.doesNotMatch(HOST_TABS_STYLE.remote, /:has\(|data-direct-session-count|\n/, 'one line, no mixed-case rules, no counted steps')
  ui.dispose()
})

await check('a tab click writes the style text and persists the choice; no request, no timer, no stream', async () => {
  const ui = load()
  const page = await stripOf(ui)
  const callsBefore = ui.calls.length
  const [localTab, remoteTab] = find(page, (node) => node.props.role === 'tab')
  await click(remoteTab)
  assert.equal(ui.style().textContent, ui.api.testing.HOST_TABS_STYLE.remote, 'the same element, new text')
  assert.equal(ui.doc.head.children.filter((node) => node.attrs?.['data-plugin'] === STYLE_ID).length, 1, 'never a second element')
  assert.deepEqual(find(page, (node) => node.props.role === 'tab').map((tab) => tab.props['aria-selected']), [false, true], 'the strip follows')
  assert.equal(storage.get(STORAGE_KEY), 'remote', 'the choice is remembered')
  assert.equal(ui.calls.length, callsBefore, 'a tab click asks the Host nothing')
  await click(localTab)
  assert.equal(ui.style().textContent, ui.api.testing.HOST_TABS_STYLE.local)
  assert.equal(storage.get(STORAGE_KEY), 'local')
  assert.equal(ui.api.testing.hostTabsStore.getSnapshot(), 'local')
  page.unmount()
  ui.dispose()
})

await check('the stored tab is what loads next: "remote" survives a reload, a junk value falls back to local', async () => {
  const remote = load({ stored: 'remote' })
  assert.equal(remote.style().textContent, remote.api.testing.HOST_TABS_STYLE.remote)
  assert.equal(remote.api.testing.hostTabsStore.getSnapshot(), 'remote')
  const junk = load({ stored: 'nonsense' })
  assert.equal(junk.style().textContent, junk.api.testing.HOST_TABS_STYLE.local, 'default local')
  assert.equal(junk.api.testing.storedHostTab(), 'local')
  remote.dispose(); junk.dispose()
})

// -------------------------------------------------------------------- shortcuts
await check('Ctrl+Alt+1 / 2 are the two defaults, and running one switches tab and style', async () => {
  const ui = load()
  const ids = ui.shortcuts.map((command) => command.id)
  assert.deepEqual(ids, ['dsh-ext.devices.sidebar-tab-local', 'dsh-ext.devices.sidebar-tab-remote'])
  for (const command of ui.shortcuts) {
    for (const profile of ['desktop:windows', 'desktop:macos', 'desktop:linux']) {
      // JSON round trip: the command object was built inside the vm realm.
      assert.deepEqual(JSON.parse(JSON.stringify(command.defaults[profile].modifiers)), ['primary', 'alt'],
        `${command.id} ${profile}: Ctrl+Alt on every platform`)
    }
    assert.equal(command.defaults['desktop:windows'].code, ids.indexOf(command.id) === 0 ? 'Key1' : 'Key2')
    assert.deepEqual(JSON.parse(JSON.stringify(command.regions)), ['page', 'editable'], 'page + editable: the keys work in the composer too')
    assert.equal(typeof command.label, 'function')
  }
  const result = ui.shortcuts[1].resolve({ source: 'keyboard' })
  assert.equal(result.status, 'handled')
  result.run()
  assert.equal(ui.api.testing.hostTabsStore.getSnapshot(), 'remote')
  assert.equal(ui.style().textContent, ui.api.testing.HOST_TABS_STYLE.remote, 'the keyboard path writes the same style')
  ui.dispose()
})

await check('a shell without ctx.shortcuts still gets the tabs (no keys, no failure)', async () => {
  const ui = load({ keyRegistry: 'absent' })
  assert.ok(ui.entries.find((item) => item.slot === 'shell.overlay'), 'the helper is still registered')
  assert.ok(ui.stripNode(), 'and the strip is still placed')
  assert.equal(ui.style().textContent, ui.api.testing.HOST_TABS_STYLE.local)
  assert.equal(ui.api.testing.remoteUI.getSnapshot().tabs, true, 'reported as installed')
  assert.equal(ui.api.testing.remoteUI.getSnapshot().tabsReason, null, 'and nothing is missing')
  ui.dispose()
})

await check('a refused shortcut registration keeps the tabs and says so on the Devices page', async () => {
  const ui = load({ keyRegistry: 'refuse' })
  const status = ui.api.testing.remoteUI.getSnapshot()
  assert.equal(status.tabs, true, 'the strip still works')
  assert.equal(status.tabsReason, 'shortcuts')
  assert.ok(ui.stripNode(), 'the strip is still there')
  const page = await mount(h(ui.api.testing.RemoteGroupingStatus))
  const rendered = text(page)
  assert.ok(rendered.includes(ui.api.testing.DICT.en.sidebarReasonShortcut), 'the reason is a sentence, not a code')
  assert.ok(rendered.includes(ui.api.testing.DICT.en.hostTabs), 'under the tabs line')
  page.unmount()
  ui.dispose()
})

// --------------------------------------------------------- refusal / honesty line
await check('a shell that declares no shell.overlay seat: no strip, no style, reason on the Devices page', async () => {
  const ui = load({ declared: [] })
  assert.equal(ui.entries.filter((item) => item.slot === 'shell.overlay').length, 0, 'nothing registered')
  assert.equal(ui.strips().length, 0, 'and no node placed')
  // Only the bundle's own stylesheet is in the head: a shell without the seat gets no
  // filter either, because a filter with no way to switch tabs would hide half the list.
  assert.equal(ui.style(), undefined, 'no tab filter injected')
  assert.equal(ui.shortcuts.length, 0, 'and no keys pointing at nothing')
  const status = ui.api.testing.remoteUI.getSnapshot()
  assert.equal(status.tabs, false)
  assert.equal(status.tabsReason, 'no-tabs', 'and the page can say why')
  const page = await mount(h(ui.api.testing.RemoteGroupingStatus))
  const rendered = text(page)
  assert.ok(rendered.includes(ui.api.testing.DICT.en.hostTabsOff), 'the page says the tabs are not installed')
  assert.ok(byTestId(page, 'sidebar-tabs-state').length === 1)
  page.unmount()
  // The rest of the bundle is untouched: the devices surfaces still registered.
  assert.ok(ui.registered.includes('settings.section'))
  ui.dispose()
})

// ------------------------------------------------------------------------- dispose
await check('dispose removes node + style + keys + observer; the host store is as it was', async () => {
  const ui = load({ stored: 'remote' })
  const before = { ...ui.api.testing.hostsStore.getSnapshot() }
  assert.ok(ui.style(), 'installed')
  assert.equal(ui.shortcuts.length, 2, 'two commands')
  const root = ui.stripRoot()
  assert.ok(root, 'the strip has its own React root')
  assert.equal(root.unrenders, 0, 'still mounted')
  assert.equal(ui.observers(), 1, 'one observer watches the document')
  ui.dispose()
  assert.equal(ui.style(), undefined, 'the style is gone from the head')
  assert.equal(ui.shortcuts.length, 0, 'both commands are unregistered')
  assert.equal(ui.entries.filter((item) => item.slot === 'shell.overlay').length, 0, 'and the helper with them')
  assert.equal(ui.stripNode(), null, 'the node left the sidebar')
  assert.equal(root.unrenders, 1, 'the React root was unmounted, not orphaned')
  assert.equal(ui.disconnected(), 1, 'the observer was disconnected')
  // A mutation the sidebar would still trigger changes nothing after dispose.
  ui.pulse()
  ui.flushTimers()
  assert.equal(ui.stripNode(), null, 'and a late pass re-inserts nothing')
  assert.deepEqual({ ...ui.api.testing.hostsStore.getSnapshot() }, before, 'no data stream was touched on the way out')
  assert.equal(ui.api.testing.hostTabsStore.getSnapshot(), 'local', 'the in-memory choice forgets with the plugin')
  assert.equal(ui.api.testing.remoteUI.getSnapshot().tabs, false, 'and the page reads "not installed"')
})

await check('the whole feature makes no HTTP call: a tab click only writes the style', async () => {
  const ui = load()
  const page = await stripOf(ui)
  const [localTab, remoteTab] = find(page, (node) => node.props.role === 'tab')
  // The host store fetches only while something subscribes to it — as in the shell,
  // where its surface is mounted; nothing here does, and the tabs need it not to.
  ui.api.testing.hostsStore.subscribe(() => {})
  const baseline = [...ui.calls]
  await click(remoteTab); await click(localTab); await click(remoteTab)
  assert.deepEqual(ui.calls, baseline, 'three tab switches, not one request')
  page.unmount()
  ui.dispose()
})

finish('client-host-tabs')
