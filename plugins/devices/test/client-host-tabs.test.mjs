// The sidebar's two tabs (Qoder's This Computer / Remote Workspace), client half:
//  - the strip is placed in the SIDEBAR's DOM, not granted a seat of its own: one
//    `div[data-testid="sidebar-host-tabs"]` inserted as the sidebar section header's
//    PREVIOUS SIBLING — after the New Session button, immediately ABOVE
//    `<div … data-sidebar-workspace-header>` ("Workspaces"), still outside
//    `<div … data-sidebar-list-area>` (it owns the sidebar's `100cqh` scroll contract).
//    New Session keeps its exact position and size (owner decision 2026-11-16, order
//    refined 2026-11-17);
//  - the strip is PLAIN DOM with inline SVG (createElementNS), not a React root. It needs
//    no `shell.overlay` declaration and no `react-dom/client`: an optional invisible
//    helper may still register when the shell declares the seat, but placement proceeds
//    either way;
//  - the two tabs are compact ICON buttons (monitor+check / cloud+link-dot), never text:
//    the localized name and its Ctrl+Alt+1/2 shortcut live in `title`/`aria-label`, the
//    glyph strokes with `currentColor` so the selected mockup blue (or inactive gray)
//    draws it;
//  - the insertion is idempotent: one node per header however many observer passes run,
//    re-inserted after a re-render drops it, and never duplicated;
//  - the filter is ONE <style data-plugin="dsh-ext.devices.host-tabs">, swapped (never
//    stacked) on a tab change, holding the exact rules for each tab on the shipped
//    `data-row-key` shapes and never hiding the empty state;
//  - the choice is persisted (localStorage, default `local`) and published to the strip;
//    Ctrl+Alt+1 / 2 switch it; a locale change repaints the labels in place;
//  - a shell with no header (the collapsed rail draws none), no document or no observer
//    says so on the Devices page — a missing seat is no longer a reason;
//  - dispose removes the node, the style, the observer, the store/locale subscriptions,
//    the shortcuts and every registration, and leaves the host store as it was;
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
 * `children` (elements only), `nextElementSibling` / `previousElementSibling`,
 * `insertBefore`, `remove`, and the
 * two queries the plugin runs — `[data-sidebar-workspace-header]` / -list-area, and the
 * `[data-testid="…"]` of its own node. Shipped shape (read from source): the New
 * Session row above, then the `Workspaces` section header, then the scrolling list
 * area, which is what `bindScrollerRef` is bound to.
 */
function makeDocument({ header = true, listArea = true, rows = [] } = {}) {
  // A1.3: the capture-phase click listener and the row clicks it observes are counted
  // here, so "one synthetic click", "owner toggle remembered" and "dispose removes the
  // listener" are all provable without a browser.
  const doc = { mutations: [], listeners: new Map(), clicks: [] }
  const mk = (tag, attrs = {}) => ({
    tagName: tag.toUpperCase(),
    attrs,
    children: [],
    parentNode: null,
    removed: false,
    textContent: '',
    dataset: {},
    listeners: new Map(),
    get nextElementSibling() {
      if (this.parentNode === null) return null
      const at = this.parentNode.children.indexOf(this)
      return at < 0 ? null : (this.parentNode.children[at + 1] ?? null)
    },
    get previousElementSibling() {
      if (this.parentNode === null) return null
      const at = this.parentNode.children.indexOf(this)
      return at <= 0 ? null : this.parentNode.children[at - 1]
    },
    get nextSibling() { return this.nextElementSibling },
    getAttribute(name) { return this.attrs[name] === undefined ? null : String(this.attrs[name]) },
    // A row click dispatches to CAPTURE listeners BEFORE its own toggle applies — the
    // real DOM order, so a listener that reads aria-expanded in capture sees the OLD
    // state. The helper's deferred read is what makes the owner's choice correct.
    click() {
      const event = { type: 'click', target: this }
      for (const listener of doc.listeners.get('click') ?? []) {
        try { listener(event) } catch { /* one listener must not stop the click */ }
      }
      doc.clicks.push(this.attrs['data-row-key'] ?? this.tagName)
      const toggle = () => {
        if (this.attrs.role === 'treeitem' && this.attrs['aria-expanded'] !== undefined) {
          this.attrs['aria-expanded'] = this.attrs['aria-expanded'] === 'true' ? 'false' : 'true'
        }
      }
      // A browser may checkpoint microtasks between capture and the row's own handler.
      // Flip this per-document flag to run the simulated DSH toggle AFTER that checkpoint.
      if (doc.toggleAfterMicrotask) queueMicrotask(toggle)
      else toggle()
    },
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
      // The A1.3 deferred read re-resolves the CURRENT row by exact key (a detached
      // row must not be found), so the fake needs that selector too.
      const rowKey = /^\[data-row-key="([^"]+)"\]$/.exec(selector)
      if (rowKey) return this.attrs['data-row-key'] === rowKey[1]
      if (selector === '[data-row-key^="workspace:h:"][role="treeitem"]') {
        return typeof this.attrs['data-row-key'] === 'string' && this.attrs['data-row-key'].startsWith('workspace:h:')
          && this.attrs.role === 'treeitem'
      }
      const testid = /^\[data-testid="(.+)"\]$/.exec(selector)
      return testid ? this.attrs['data-testid'] === testid[1] : false
    },
    setAttribute(name, value) { this.attrs[name] = String(value) },
    // The strip's buttons are plain DOM with their own listeners; a click on one is
    // dispatched here, just as a browser would dispatch it on a real button.
    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? []
      list.push(listener)
      this.listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      const list = this.listeners.get(type) ?? []
      const at = list.indexOf(listener)
      if (at >= 0) list.splice(at, 1)
    },
    fire(type) {
      for (const listener of this.listeners.get(type) ?? []) {
        try { listener({ type, target: this }) } catch { /* one listener must not stop another */ }
      }
    },
    replaceChildren(...children) {
      for (const child of this.children) child.parentNode = null
      this.children.length = 0
      for (const child of children) this.appendChild(child)
    },
  })
  doc.mk = mk
  doc.body = mk('body')
  doc.sidebar = mk('div', { class: 'sidebar' })
  doc.body.appendChild(doc.sidebar)
  doc.newSession = mk('button', { class: 'shell-new-session' })
  doc.sidebar.appendChild(doc.newSession)
  doc.header = header ? mk('div', { class: 'sectionHeader', 'data-sidebar-workspace-header': '' }) : null
  if (doc.header) doc.sidebar.appendChild(doc.header)
  doc.listArea = listArea ? mk('div', { class: 'listArea', 'data-sidebar-list-area': '' }) : null
  if (doc.listArea) doc.sidebar.appendChild(doc.listArea)
  // The rows the sidebar draws inside its list area. Only `workspace:h:` treeitem rows
  // are the plugin's; local/ungrouped rows are here so a test can prove they stay alone.
  doc.rows = rows.map((attrs) => {
    const row = mk('div', attrs)
    if (doc.listArea) doc.listArea.appendChild(row)
    return row
  })
  doc.addEventListener = (type, listener) => {
    const list = doc.listeners.get(type) ?? []
    list.push(listener)
    doc.listeners.set(type, list)
  }
  doc.removeEventListener = (type, listener) => {
    const list = doc.listeners.get(type) ?? []
    const at = list.indexOf(listener)
    if (at >= 0) list.splice(at, 1)
  }
  const walk = (node) => [node, ...node.children.flatMap(walk)]
  doc.all = () => walk(doc.body)
  doc.querySelector = (selector) => doc.all().find((node) => node.matches(selector)) ?? null
  doc.querySelectorAll = (selector) => doc.all().filter((node) => node.matches(selector))
  doc.createElement = (tag) => mk(tag)
  // The strip's glyphs are real SVG elements made with createElementNS; the fake keeps
  // the namespace so a test can prove the DOM renderer did not use HTML elements.
  doc.createElementNS = (namespace, tag) => {
    const node = mk(tag)
    node.namespaceURI = namespace
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
  // The sidebar renders AFTER apply() (the real shell mounts it later): the header and the
  // list area appear in this order, exactly as `WorkspaceBrowser` draws them.
  doc.appendSidebarBody = () => {
    doc.header = mk('div', { class: 'sectionHeader', 'data-sidebar-workspace-header': '' })
    doc.sidebar.appendChild(doc.header)
    doc.listArea = mk('div', { class: 'listArea', 'data-sidebar-list-area': '' })
    doc.sidebar.appendChild(doc.listArea)
    return doc.header
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
function load({ locale = 'en-US', declared = ['shell.overlay'], keyRegistry = 'ok', stored = null, dom, seatRefuses = false, rows = [], storageGetterThrows = false } = {}) {
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
  const doc = dom ?? makeDocument({ rows })
  // Every `console.warn` the bundle raises, so "one warn, once" is provable.
  const warnings = []
  const pageConsole = { ...console, warn: (...args) => { warnings.push(args.map(String).join(' ')) } }
  // One head per page: a reload starts from an empty document. Timers are keyed so
  // `clearTimeout` really cancels (the placement debounces its passes).
  const timers = new Map()
  let timerSeq = 0
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
    setTimeout: (fn) => { timerSeq += 1; timers.set(timerSeq, fn); return timerSeq },
    clearTimeout: (id) => { timers.delete(id) },
    confirm: () => true,
  }
  if (storageGetterThrows) {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError: localStorage is unavailable') },
    })
  }
  vm.runInNewContext(source, { window, document: doc, fetch, URL, console: pageConsole, Date, MutationObserver: FakeObserver,
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
        // A shell may not declare the optional helper seat at all, or may refuse the
        // injection even when declared. Neither may stop the DOM placement.
        if (slot === PLACEMENT_SEAT && (!declared.includes(slot) || seatRefuses)) return () => {}
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
  // No root renderer is handed over: the strip is plain DOM and must not need one.
  api.apply(ctx)
  const stripNode = () => doc.querySelector('[data-testid="sidebar-host-tabs"]')
  const flushTimers = () => { for (const [id, fn] of [...timers]) { timers.delete(id); if (typeof fn === 'function') fn() } }
  // "The sidebar re-rendered": one batch of childList records that are NOT ours, which is
  // what a real MutationObserver callback receives — and what the plugin's own insertion
  // batch is recognised by (a record whose addedNodes are only the strip's node).
  const foreignBatch = () => [{ type: 'childList', target: doc.sidebar, addedNodes: [doc.listArea ?? doc.newSession], removedNodes: [] }]
  const pulse = () => { for (const observer of observers) if (observer.observing) observer.callback(foreignBatch()) }
  const pulseOwn = () => {
    const ours = stripNode()
    const batch = [{ type: 'childList', target: doc.sidebar, addedNodes: ours ? [ours] : [], removedNodes: [] }]
    for (const observer of observers) if (observer.observing) observer.callback(batch)
  }
  // A real MutationRecord for a REMOVAL has `addedNodes: []`. `.every()` over that
  // empty list is true, so this is the batch that used to be mistaken for our own.
  const pulseRemovedOnly = () => {
    const batch = [{ type: 'childList', target: doc.sidebar, addedNodes: [], removedNodes: [doc.listArea] }]
    for (const observer of observers) if (observer.observing) observer.callback(batch)
  }
  // A browser hands a MutationRecord NodeLists: array-like and iterable, with `.item()`,
  // but no `.every()` / `.includes()`. Deliberately NO array methods, so a direct call
  // to them throws inside the observer callback and recovery never happens.
  const asNodeList = (items) => Object.freeze({
    length: items.length,
    ...Object.fromEntries(items.map((item, index) => [index, item])),
    item(index) { return items[index] ?? null },
    [Symbol.iterator]() { return items[Symbol.iterator]() },
  })
  const pulseNodeList = (added = [], removed = []) => {
    const batch = [{ type: 'childList', target: doc.sidebar, addedNodes: asNodeList(added), removedNodes: asNodeList(removed) }]
    for (const observer of observers) if (observer.observing) observer.callback(batch)
  }
  return {
    api, calls, entries, registered, doc, rows: doc.rows, flushTimers, pulse, pulseOwn, pulseRemovedOnly, pulseNodeList, warnings,
    shortcuts: registeredShortcuts,
    stripNode,
    localeSubscribers: () => localeListeners.size,
    observers: () => observers.length,
    disconnected: () => disconnected,
    // A1.3 observability: the capture listener, the row clicks (in dispatch order) and
    // the outstanding timers, so a test can prove what dispose actually removed.
    listeners: (type = 'click') => (doc.listeners.get(type) ?? []).length,
    clicks: () => [...doc.clicks],
    pendingTimers: () => timers.size,
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
/** Walk a plain-DOM subtree (the fake nodes expose `children`). */
const allOf = (node) => [node, ...node.children.flatMap(allOf)]
/** The two tab buttons inside the one placed strip. */
const tabsOf = (ui) => {
  const node = ui.stripNode()
  assert.ok(node, 'the placement helper rendered the strip')
  return allOf(node).filter((element) => element.attrs?.role === 'tab')
}
/** Every text node under a plain-DOM element: an icon-only button has none. */
const textOf = (element) => allOf(element).map((node) => node.textContent ?? '').join('')
/** The one inline SVG glyph a tab button carries, with the ink that follows its state. */
const glyphOf = (tab) => {
  const svgs = allOf(tab).filter((element) => element.tagName === 'SVG')
  assert.equal(svgs.length, 1, 'one inline SVG glyph per tab')
  assert.equal(svgs[0].namespaceURI, 'http://www.w3.org/2000/svg', 'it is a real SVG element')
  assert.equal(svgs[0].getAttribute('stroke'), 'currentColor', 'the glyph follows the button ink (active accent / inactive muted)')
  assert.equal(svgs[0].getAttribute('aria-hidden'), 'true', 'the glyph is decorative; the button names itself')
  return svgs[0]
}
const clickTab = (tab) => { tab.fire('click') }

// ------------------------------------------------------------------- the placement
await check('the strip is ONE node, the sidebar header\'s previous sibling: after "New Session", above "Workspaces", outside the list area', async () => {
  const ui = load()
  assert.equal(ui.sidebarOrder(), 'newSession > strip > header > listArea',
    'the New Session row keeps its place; the strip sits between it and the "Workspaces" header')
  const node = ui.stripNode()
  assert.equal(node.parentNode, ui.doc.sidebar, 'a sibling of the header, never a child of the list area')
  assert.equal(ui.doc.header.previousElementSibling, node, 'exactly the header\'s previous sibling')
  assert.equal(ui.doc.newSession.nextElementSibling, node, 'and directly after New Session')
  assert.equal(ui.strips().length, 1, 'one strip')
  assert.equal(ui.doc.listArea.children.length, 0, 'the scrolling area holds nothing of ours')
  // The optional seat is still taken when the shell declares it, and its helper renders
  // nothing — but nothing here depends on it.
  const entry = ui.entries.find((item) => item.slot === PLACEMENT_SEAT)
  assert.ok(entry, `the helper took the ${PLACEMENT_SEAT} seat when it was offered`)
  assert.equal(entry.meta.name, PLACEMENT_SEAT)
  assert.equal(entry.meta.id, 'dsh-ext.devices.tabs', 'a fresh id, so nothing shipped is shadowed')
  const page = await mount(h(entry.component, {}))
  assert.equal(page.toJSON(), null, 'the helper renders no box — no floating overlay over the sidebar')
  page.unmount()
  assert.equal(ui.entries.filter((item) => item.slot === 'sidebar.session.action').length, 0,
    'the New Session seat is not asked for any more')
  assert.equal(tabsOf(ui).length, 2, 'the strip itself is plain DOM with two buttons')
  ui.dispose()
})

await check('the strip is a tablist of two plain-DOM ICON buttons — "This Computer" / "Remote Workspace" (vi: "Máy này" / "Workspace từ xa") in title/aria-label, local selected', async () => {
  const ui = load()
  const { DICT } = ui.api.testing
  const tabs = tabsOf(ui)
  assert.equal(tabs.length, 2, 'two tabs, built without any React root')
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('data-tab')), ['local', 'remote'])
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('data-testid')), ['sidebar-host-tab-local', 'sidebar-host-tab-remote'])
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('role')), ['tab', 'tab'])
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('type')), ['button', 'button'])
  // Icon-only: no text anywhere inside the button — the name is in title/aria-label.
  for (const tab of tabs) {
    assert.equal(textOf(tab), '', 'the button carries no text label')
    glyphOf(tab)
  }
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('aria-selected')), ['true', 'false'], 'local is the default')
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('aria-pressed')), ['true', 'false'], 'aria-pressed agrees')
  for (const [tab, label, keys] of [[tabs[0], DICT.en.tabThisComputer, DICT.en.tabShortcutLocal],
    [tabs[1], DICT.en.tabRemoteWorkspace, DICT.en.tabShortcutRemote]]) {
    assert.ok(tab.getAttribute('title').includes(label), 'title names the tab in the owner\'s words')
    assert.ok(tab.getAttribute('title').includes(`(${keys})`), 'title names its key')
    assert.ok(tab.getAttribute('aria-label').includes(label), 'aria-label names the tab')
    assert.ok(tab.getAttribute('aria-label').includes(`(${keys})`), 'aria-label names its key')
  }
  assert.match(tabs[0].getAttribute('title'), /\(Ctrl\+Alt\+1\)$/, 'each tab names its key')
  assert.match(tabs[1].getAttribute('title'), /\(Ctrl\+Alt\+2\)$/)
  // The local glyph is a monitor + check; the remote one a cloud + filled link dot.
  const localPaths = allOf(tabs[0]).filter((node) => node.tagName === 'PATH').map((node) => node.getAttribute('d'))
  assert.ok(localPaths.includes('M9 20.5h6M12 17v3.5'), 'local has a monitor stand')
  assert.ok(localPaths.includes('M8.5 10.5l2.5 2.5 4.5-4.5'), 'local has a check')
  const remote = allOf(tabs[1])
  assert.ok(remote.some((node) => node.tagName === 'PATH' && node.getAttribute('d').startsWith('M18 10h-1.26A8 8')), 'remote has a cloud')
  assert.ok(remote.some((node) => node.tagName === 'CIRCLE' && node.getAttribute('fill') === 'currentColor'), 'remote has a filled dot')
  // No shell child is wrapped: the strip holds one tablist with exactly two buttons.
  const strip = ui.stripNode()
  const list = allOf(strip).find((node) => node.getAttribute('role') === 'tablist')
  assert.ok(list, 'one tablist')
  assert.equal(list.getAttribute('class'), 'dshdev-hosttabs-strip dshdev-seg', 'the shipped CSS classes stay')
  assert.equal(strip.getAttribute('class'), 'dshdev-hosttabs', 'outer node keeps its class')
  // A locale change repaints the SAME node, in the owner's language.
  ui.setLocale('vi')
  const viTabs = tabsOf(ui)
  assert.equal(ui.stripNode(), strip, 'no new node on a locale change')
  for (const [tab, label] of [[viTabs[0], DICT.vi.tabThisComputer], [viTabs[1], DICT.vi.tabRemoteWorkspace]]) {
    assert.equal(textOf(tab), '', 'the vi buttons are icon-only too')
    glyphOf(tab)
    assert.ok(tab.getAttribute('aria-label').includes(label), 'the vi label is in aria-label')
    assert.ok(tab.getAttribute('title').includes(label), 'and in title')
  }
  // Both dictionaries still carry the same keys, translated.
  const { DICT: EN } = load().api.testing
  const { DICT: VI } = ui.api.testing
  assert.deepEqual(Object.keys(VI.en).sort(), Object.keys(EN.en).sort(), 'vi and en stay twins')
  assert.deepEqual(Object.keys(VI.vi).sort(), Object.keys(EN.en).sort(), 'and both tables hold the same keys as en')
  for (const key of ['tabThisComputer', 'tabRemoteWorkspace', 'hostTabs', 'sidebarReasonShortcut', 'hostTabsOn', 'hostTabsOff']) {
    assert.ok(EN.en[key], `en.${key}`)
    assert.notEqual(EN.en[key], VI.vi[key], `${key} is translated`)
  }
  ui.dispose()
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
  assert.equal(ui.stripNode(), node, 'the same node comes back (its buttons were never rebuild elsewhere)')
  assert.equal(ui.doc.header.previousElementSibling, node, 'and in the same place')
  assert.equal(ui.strips().length, 1, 'never a copy')
  assert.deepEqual(ui.doc.listArea.children, [], 'and still nothing inside the list area')
  assert.equal(tabsOf(ui).length, 2, 'and its two buttons are still there')
  ui.dispose()
})

await check('a removal-only MutationRecord is not mistaken for our own insertion', async () => {
  const ui = load()
  const before = ui.inserts()
  // React dropped a sibling: addedNodes is empty, removedNodes is not. That batch is
  // FOREIGN and must schedule the pass that re-inserts a strip the renderer dropped.
  const node = ui.stripNode()
  node.remove()
  ui.pulseRemovedOnly()
  ui.flushTimers()
  assert.equal(ui.stripNode(), node, 'the removal batch re-inserted the strip')
  assert.equal(ui.inserts(), before + 1, 'one re-insert')
  ui.dispose()
})

await check('browser-shaped NodeLists in a MutationRecord still drive observer recovery', async () => {
  const ui = load()
  const node = ui.stripNode()
  node.remove()
  // A real browser delivers NodeLists, not arrays. A removal-only record has an empty
  // addedNodes: calling `.every()` on it used to throw and the strip was never put back.
  ui.pulseNodeList([], [ui.doc.listArea])
  ui.flushTimers()
  assert.equal(ui.stripNode(), node, 'the NodeList removal batch re-inserted the strip')
  const afterRecovery = ui.inserts()
  // Our own node in a NodeList must still be recognised and skipped (no feedback loop).
  ui.pulseNodeList([node], [])
  ui.flushTimers()
  assert.equal(ui.inserts(), afterRecovery, 'a NodeList batch of only our node schedules no pass')
  assert.equal(ui.strips().length, 1, 'one strip, no copy')
  ui.dispose()
})

await check('a stray copy of the strip is removed, not kept: one node per header', async () => {
  const ui = load()
  const copy = ui.doc.createElement('div')
  copy.setAttribute('data-testid', 'sidebar-host-tabs')
  // A copy standing where OURS belongs: the pass removes it and puts ours there — the
  // header's previous sibling, after New Session and still outside the list area.
  const copied = ui.stripNode()
  copied.remove()
  ui.doc.sidebar.insertBefore(copy, ui.doc.header)
  assert.equal(ui.doc.header.previousElementSibling, copy, 'the copy is standing where ours belongs')
  // One more mutation: the observer's debounced pass is the thing that cleans up.
  ui.pulse()
  ui.flushTimers()
  assert.equal(ui.strips().length, 1, 'one node per header')
  assert.ok(copy.removed, 'the copy was the one removed')
  assert.equal(ui.sidebarOrder(), 'newSession > strip > header > listArea', 'ours is back after New Session and before the header')
  assert.equal(ui.doc.header.previousElementSibling, ui.stripNode(), 'the header\'s previous sibling is ours')
  ui.dispose()
})

await check('a shell with no header (the collapsed rail draws none) gets no strip, and the page says why', async () => {
  const ui = load({ dom: makeDocument({ header: false }) })
  assert.equal(ui.strips().length, 0, 'no header, no strip')
  // The filter waits with the strip: it is installed only once the tabs are reachable, so a
  // filter that would hide half the list can never outlive its own switch.
  assert.equal(ui.style(), undefined, 'no tab filter yet — the tabs are not reachable')
  assert.equal(ui.shortcuts.length, 0, 'and no keys pointing at nothing')
  ui.flushTimers()
  assert.equal(ui.warnings.length, 1, 'the missing header is reported once')
  const status = ui.api.testing.remoteUI.getSnapshot()
  assert.equal(status.tabs, true, 'installed and still watching')
  assert.equal(status.tabsReason, 'no-header', 'and the page can say which fact it is')
  const page = await mount(h(ui.api.testing.RemoteGroupingStatus))
  const rendered = text(page)
  assert.ok(rendered.includes(ui.api.testing.DICT.en.hostTabsOff), 'the page says the tabs are not installed')
  assert.ok(rendered.includes(ui.api.testing.DICT.en.sidebarReasonNoHeader), 'with the header reason')
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

await check('the selected tab uses fixed mockup blue and a pale chip, never the DSH button-primary alias', async () => {
  assert.match(source, /const HOST_TAB_ACCENT = '#4f7cff'/)
  assert.match(source, /const HOST_TAB_ACCENT_PALE = 'rgba\(79,124,255,\.16\)'/)
  const start = source.indexOf("/* The glyphs stroke with currentColor: the selected tab draws in the mockup blue on a")
  const end = source.indexOf('/* spec 008 P2b:')
  assert.ok(start >= 0 && end > start, 'the host-tab CSS is in the shipped stylesheet')
  const css = source.slice(start, end)
  assert.match(css, /\.dshdev-hosttabs-strip button\[aria-selected=true\]\{background:\$\{HOST_TAB_ACCENT_PALE\};color:\$\{HOST_TAB_ACCENT\}\}/)
  assert.match(css, /color-mix\(in srgb, \$\{HOST_TAB_ACCENT\} 16%, transparent\)/)
  assert.match(css, /\.dshdev-hosttabs-strip button\{[^}]*color:\$\{colors\.muted\}/)
  assert.doesNotMatch(css, /\$\{colors\.accent\}|--dsw-alias-button-primary-fill/)
  const ui = load()
  for (const tab of tabsOf(ui)) glyphOf(tab)
  ui.dispose()
})

// The `data-row-key` values the owner measured on the live DSH window (flat, in
// document order): local workspace untagged, local session `session-<uuid>`, every
// remote row tagged `h:<hostId>:` after its kind, and the ungrouped header + its
// overflow button — which held remote sessions only in that measurement.
const MEASURED_ROWS = [
  { key: 'workspace:', local: false, note: 'ungrouped header (holds only remote sessions)' },
  { key: 'overflow:', local: false, note: 'ungrouped group\'s hidden-sessions button' },
  { key: 'workspace:local-workspace-fixed-id', local: true },
  { key: 'session:session-local-workspace-fixed-id', local: true },
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

await check('a plain-DOM tab click writes the style text and persists the choice; no request, no timer, no stream', async () => {
  const ui = load()
  const callsBefore = ui.calls.length
  const node = ui.stripNode()
  clickTab(tabsOf(ui)[1])
  assert.equal(ui.style().textContent, ui.api.testing.HOST_TABS_STYLE.remote, 'the same element, new text')
  assert.equal(ui.doc.head.children.filter((item) => item.attrs?.['data-plugin'] === STYLE_ID).length, 1, 'never a second element')
  assert.equal(ui.stripNode(), node, 'the one strip node is reused, only its buttons are repainted')
  assert.deepEqual(tabsOf(ui).map((tab) => tab.getAttribute('aria-selected')), ['false', 'true'], 'the strip follows')
  assert.deepEqual(tabsOf(ui).map((tab) => tab.getAttribute('aria-pressed')), ['false', 'true'], 'aria-pressed follows too')
  assert.equal(storage.get(STORAGE_KEY), 'remote', 'the choice is remembered')
  assert.equal(ui.calls.length, callsBefore, 'a tab click asks the Host nothing')
  clickTab(tabsOf(ui)[0])
  assert.equal(ui.style().textContent, ui.api.testing.HOST_TABS_STYLE.local)
  assert.deepEqual(tabsOf(ui).map((tab) => tab.getAttribute('aria-selected')), ['true', 'false'], 'and back again')
  assert.equal(storage.get(STORAGE_KEY), 'local')
  assert.equal(ui.api.testing.hostTabsStore.getSnapshot(), 'local')
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

// ------------------------------------------------- no seat is not a failure any more
await check('a shell that never declares shell.overlay still gets the strip, the filter, the keys and a placed status', async () => {
  const ui = load({ declared: [] })
  assert.equal(ui.entries.filter((item) => item.slot === 'shell.overlay').length, 0, 'no helper seat taken')
  assert.equal(ui.strips().length, 1, 'but the plain-DOM strip is placed anyway')
  assert.equal(tabsOf(ui).length, 2, 'with both icon buttons')
  assert.ok(ui.style(), 'the filter is installed')
  assert.equal(ui.shortcuts.length, 2, 'and the keys work')
  const status = ui.api.testing.remoteUI.getSnapshot()
  assert.equal(status.tabs, true)
  assert.equal(status.tabsReason, null, 'no invented "no-seat" reason')
  const page = await mount(h(ui.api.testing.RemoteGroupingStatus))
  const rendered = text(page)
  assert.ok(rendered.includes(ui.api.testing.DICT.en.hostTabsOn), 'the page says the tabs are on')
  assert.ok(!rendered.includes('no-seat'), 'and never prints a seat reason')
  assert.ok(byTestId(page, 'sidebar-tabs-state').length === 1)
  page.unmount()
  // The rest of the bundle is untouched: the devices surfaces still registered.
  assert.ok(ui.registered.includes('settings.section'))
  ui.dispose()
})

await check('a shell whose slot host REFUSES the optional seat still gets the strip', async () => {
  const ui = load({ seatRefuses: true })
  assert.equal(ui.entries.filter((item) => item.slot === 'shell.overlay').length, 0, 'the helper was refused')
  assert.equal(ui.strips().length, 1, 'the strip did not depend on it')
  assert.equal(ui.api.testing.remoteUI.getSnapshot().tabsReason, null)
  ui.dispose()
})

// --------------------------------- the defect that made both tabs never appear
// `apply()` runs before the shell mounts the sidebar's workspace browser, so the header is
// normally ABSENT on the first pass. The old code disposed the placement in that case,
// which also disposed the only observer that could ever have placed the strip. These
// checks pin the fix: a header that arrives after apply() is placed on the next batch.
await check('a header that arrives AFTER apply() still gets the strip: installed while waiting, placed on the next batch', async () => {
  const doc = makeDocument({ header: false })
  const ui = load({ dom: doc })
  // apply() ran: the seat is registered, the placement is installed and watching, and
  // nothing was torn down just because the header was not there yet.
  assert.ok(ui.entries.find((item) => item.slot === PLACEMENT_SEAT), 'the helper kept its seat')
  assert.equal(ui.observers(), 1, 'the observer is installed at apply time, not after a header shows up')
  assert.equal(ui.strips().length, 0, 'no header yet, so no node — that is the waiting state, not a refusal')
  assert.equal(ui.api.testing.remoteUI.getSnapshot().tabs, true, 'reported as installed (watching)')
  assert.equal(ui.api.testing.remoteUI.getSnapshot().tabsReason, 'no-header', 'and the page names the exact missing piece')
  assert.equal(ui.warnings.length, 0, 'no warning yet: the header may simply be late')
  assert.equal(ui.style(), undefined, 'no tab filter while the tabs cannot be reached')
  assert.equal(ui.shortcuts.length, 0, 'and no keys pointing at nothing')
  // The sidebar mounts now: header, then the scrolling list area, exactly as the shipped
  // `WorkspaceBrowser` draws them.
  const header = doc.appendSidebarBody()
  ui.pulse()
  ui.flushTimers()
  const node = ui.stripNode()
  assert.ok(node, 'the strip was placed by the observer batch')
  assert.equal(header.previousElementSibling, node, 'as the header\'s previous sibling')
  assert.equal(node.parentNode, doc.sidebar, 'in the sidebar, never inside the list area')
  assert.equal(doc.listArea.children.length, 0, 'the scrolling area holds nothing of ours')
  assert.equal(ui.strips().length, 1, 'exactly one node')
  // The strip is real DOM now, with both icon buttons (no React root anywhere).
  const tabs = tabsOf(ui)
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('data-tab')), ['local', 'remote'], 'both tabs')
  for (const tab of tabs) { assert.equal(textOf(tab), '', 'icon-only, no text'); glyphOf(tab) }
  assert.ok(tabs[0].getAttribute('aria-label').includes(ui.api.testing.DICT.en.tabThisComputer), 'the name lives in aria-label')
  assert.ok(tabs[1].getAttribute('aria-label').includes(ui.api.testing.DICT.en.tabRemoteWorkspace), 'both tabs, in the owner\'s words')
  // The status followed: `no-header` was about the past, and it is gone.
  assert.equal(ui.api.testing.remoteUI.getSnapshot().tabsReason, null, 'the reason clears itself once placed')
  assert.equal(ui.style().textContent, ui.api.testing.HOST_TABS_STYLE.local, 'and the filter is installed now')
  assert.equal(ui.warnings.length, 0, 'a late header is not a warning')
  ui.dispose()
  assert.equal(ui.stripNode(), null, 'dispose still takes it back out')
})

await check('a header that never arrives: ONE warn after the wait, reason no-header, and the observer keeps looking', async () => {
  const ui = load({ dom: makeDocument({ header: false }) })
  assert.equal(ui.warnings.length, 0, 'nothing warned at apply time')
  // The wait expires with no header in sight.
  ui.flushTimers()
  const warnText = ui.api.testing.HOST_TABS_NO_HEADER_WARN
  assert.equal(ui.warnings.length, 1, 'exactly one warning, never a stream of them')
  assert.equal(ui.warnings[0], warnText, 'and it names the selector it looked for')
  assert.ok(warnText.includes(ui.api.testing.HOST_TABS_HEADER), 'the selector is in the message')
  assert.equal(ui.api.testing.remoteUI.getSnapshot().tabsReason, 'no-header')
  // The page says which fact it is, in a sentence, and does not claim two tabs it cannot draw.
  const page = await mount(h(ui.api.testing.RemoteGroupingStatus))
  const rendered = text(page)
  assert.ok(rendered.includes(ui.api.testing.DICT.en.sidebarReasonNoHeader), 'the header reason, not the seat one')
  assert.ok(rendered.includes(ui.api.testing.DICT.en.hostTabsOff), 'and "not installed" as the state line')
  assert.ok(!rendered.includes(ui.api.testing.DICT.en.hostTabsOn), 'never sold as on screen')
  page.unmount()
  // The observer is still live: a header that shows up after the warning is still placed,
  // and no second warning is raised.
  const header = ui.doc.appendSidebarBody()
  ui.pulse()
  ui.flushTimers()
  assert.ok(ui.stripNode(), 'placed late')
  assert.equal(header.previousElementSibling, ui.stripNode(), 'in the right place')
  assert.equal(ui.warnings.length, 1, 'still one warning in total')
  assert.equal(ui.api.testing.remoteUI.getSnapshot().tabsReason, null, 'and the reason is gone')
  ui.dispose()
})

await check('only real placement failures are reported: no-document and no-observer, never a seat or renderer', async () => {
  const ui = load()
  const place = ui.api.testing.installHostTabPlacement
  const noDoc = place({ doc: null })
  assert.equal(noDoc.status(), 'unavailable')
  assert.equal(noDoc.reason(), 'no-document', 'the page can name an unplaceable shell')
  const noObserver = place({ doc: ui.doc, MutationObserver: null })
  assert.equal(noObserver.reason(), 'no-observer', 'or a shell with no observer')
  // No createRoot / seat input is needed to install against a real document.
  const ok = place({ doc: ui.doc })
  assert.equal(ok.status(), 'placed', 'plain DOM is enough')
  assert.equal(ok.reason(), null)
  ok.dispose()
  ui.dispose()
})

await check('the registration passes the exact options a list slot requires, like every shipped shell.overlay occupant', async () => {
  const ui = load()
  const entry = ui.entries.find((item) => item.slot === PLACEMENT_SEAT)
  assert.ok(entry, 'registered')
  // `id` is the ONE mandatory option of a `list` slot (the cell key); omitting it makes the
  // registration throw in a real shell. `order` is optional and chooses the row position.
  assert.deepEqual(Object.keys(entry.meta).sort(), ['id', 'name', 'order'], 'name + id + order, nothing else')
  assert.equal(entry.meta.name, PLACEMENT_SEAT)
  assert.equal(entry.meta.id, 'dsh-ext.devices.tabs', 'a fresh id of its own, so nothing shipped is shadowed')
  assert.equal(typeof entry.meta.id, 'string', 'and a string, not a number')
  assert.equal(typeof entry.meta.order, 'number', 'order is a number')
  assert.equal(entry.component === undefined || typeof entry.component === 'function', true, 'the helper is a component')
  ui.dispose()
})

// ------------------------------------------------------------------------- dispose
await check('dispose removes node + style + keys + observer + subscriptions; the host store is as it was', async () => {
  const ui = load({ stored: 'remote' })
  const before = { ...ui.api.testing.hostsStore.getSnapshot() }
  assert.ok(ui.style(), 'installed')
  assert.equal(ui.shortcuts.length, 2, 'two commands')
  const node = ui.stripNode()
  assert.ok(node, 'the strip node is in the sidebar')
  assert.deepEqual(tabsOf(ui).map((tab) => tab.getAttribute('aria-selected')), ['false', 'true'], 'remote is painted')
  assert.equal(ui.observers(), 1, 'one observer watches the document')
  assert.equal(ui.localeSubscribers(), 2, 'the page language and the strip both listen')
  ui.dispose()
  assert.equal(ui.style(), undefined, 'the style is gone from the head')
  assert.equal(ui.shortcuts.length, 0, 'both commands are unregistered')
  assert.equal(ui.entries.filter((item) => item.slot === 'shell.overlay').length, 0, 'and the helper with them')
  assert.equal(ui.stripNode(), null, 'the node left the sidebar')
  assert.equal(ui.disconnected(), 1, 'the observer was disconnected')
  assert.equal(ui.localeSubscribers(), 0, 'both locale subscriptions were released')
  // A store or locale change after dispose cannot repaint a node we no longer own.
  ui.api.testing.publishHostTab('local')
  ui.setLocale('vi')
  assert.deepEqual(allOf(node).filter((item) => item.attrs?.role === 'tab').map((item) => item.getAttribute('aria-selected')),
    ['false', 'true'], 'the disposed strip did not repaint')
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
  // The host store fetches only while something subscribes to it — as in the shell,
  // where its surface is mounted; nothing here does, and the tabs need it not to.
  ui.api.testing.hostsStore.subscribe(() => {})
  const baseline = [...ui.calls]
  clickTab(tabsOf(ui)[1]); clickTab(tabsOf(ui)[0]); clickTab(tabsOf(ui)[1])
  assert.deepEqual(ui.calls, baseline, 'three tab switches, not one request')
  ui.dispose()
})

// ------------------------------------------------------- A1.3: remote workspace expansion
// The same observer/debounce as the strip drives this pass; one click per row, a
// namespaced map of the owner's own choices, and no DSH state touched anywhere.
const EXPANSION_KEY = 'dsh-ext.devices.workspace-expansion.v1'
// The stored key is the row key minus `workspace:` — i.e. `h:<hostId>:<uuid>`.
const REMOTE_KEY_A = 'h:r1:1a2b3c4d-2222-4e5f-8a9b-0c1d2e3f4a5b'
const REMOTE_KEY_B = 'h:r2:2b3c4d5e-3333-4f60-9a1b-2c3d4e5f6a7b'
const LOCAL_KEY = 'local-workspace-fixed-id'
const row = (key, expanded) => ({
  // A remote key already carries its `h:` tag; a local one is a bare uuid.
  'data-row-key': `workspace:${key}`,
  role: 'treeitem', 'aria-expanded': expanded ? 'true' : 'false',
})
const expansionMap = () => JSON.parse(storage.get(EXPANSION_KEY) ?? '{}')
/** Simulate DSH re-rendering a workspace row: a fresh node with the same key. */
const rerender = (ui, old, attrs) => {
  old.remove()
  const fresh = ui.doc.mk('div', attrs)
  ui.doc.listArea.appendChild(fresh)
  return fresh
}

await check('A1.3: a first-seen remote row is clicked ONCE and remembered as expanded; DSH\'s view state is never touched', async () => {
  const ui = load({ rows: [row(REMOTE_KEY_A, false)] })
  const first = ui.rows[0]
  assert.equal(ui.api.testing.WORKSPACE_EXPANSION_STORAGE, EXPANSION_KEY, 'the new namespaced key')
  assert.deepEqual(ui.clicks(), [first.attrs['data-row-key']], 'exactly one click, on the remote row')
  assert.equal(first.attrs['aria-expanded'], 'true', 'the row is expanded by that click')
  assert.deepEqual(expansionMap(), { [REMOTE_KEY_A]: true }, 'the first-seen default is remembered')
  assert.equal(storage.has('dsh.workspace.view.v5'), false, 'DSH\'s own workspace view is never written')
  assert.equal(ui.listeners('click'), 1, 'one capture click listener on the document')
  // Another debounced pass (the sidebar re-rendered) must not click it again.
  ui.pulse(); ui.flushTimers()
  assert.deepEqual(ui.clicks(), [first.attrs['data-row-key']], 'still one click after a re-render')
  assert.equal(first.attrs['aria-expanded'], 'true', 'and it stays open')
  ui.dispose()
})

await check('A1.3: the owner\'s collapse is remembered from the click\'s effect and a later re-render is corrected', async () => {
  const ui = load({ rows: [row(REMOTE_KEY_A, false)] })
  const first = ui.rows[0]
  assert.equal(first.attrs['aria-expanded'], 'true', 'plugin opened the first-seen row')
  const baseline = ui.clicks().length
  // The owner collapses the row. Capture listeners see the OLD value first: the map must
  // hold the value read on the next task, AFTER the click's effect, i.e. false.
  first.click()
  ui.flushTimers()
  assert.equal(first.attrs['aria-expanded'], 'false')
  assert.equal(expansionMap()[REMOTE_KEY_A], false, 'the owner\'s collapse won')
  assert.equal(ui.clicks().length, baseline + 1, 'one owner click, no extra synthetic one')
  // DSH re-renders the row OPEN (it forgot the collapse): the next pass restores it shut.
  const reopened = rerender(ui, first, row(REMOTE_KEY_A, true))
  ui.pulse(); ui.flushTimers()
  assert.equal(reopened.attrs['aria-expanded'], 'false', 'one click closed it again')
  assert.equal(expansionMap()[REMOTE_KEY_A], false, 'the remembered choice is unchanged')
  assert.equal(ui.clicks().length, baseline + 2, 'exactly one corrective click')
  ui.dispose()
})

await check('A1.3: a remembered expanded row that DSH re-renders collapsed is opened again', async () => {
  const ui = load({ rows: [row(REMOTE_KEY_B, true)] })
  const first = ui.rows[0]
  assert.deepEqual(ui.clicks(), [], 'an already-open first-seen row needs no click')
  assert.equal(expansionMap()[REMOTE_KEY_B], true, 'but its state is remembered')
  const collapsed = rerender(ui, first, row(REMOTE_KEY_B, false))
  ui.pulse(); ui.flushTimers()
  assert.equal(collapsed.attrs['aria-expanded'], 'true', 'the remembered expansion is restored')
  assert.deepEqual(ui.clicks(), [collapsed.attrs['data-row-key']], 'one restoration click')
  assert.equal(expansionMap()[REMOTE_KEY_B], true)
  ui.dispose()
})

await check('A1.3: local and ungrouped workspace rows are never clicked or stored', async () => {
  const ui = load({ rows: [row(LOCAL_KEY, false), row('', false), row(REMOTE_KEY_A, false)] })
  const [local, ungrouped, remote] = ui.rows
  assert.deepEqual(ui.clicks(), [remote.attrs['data-row-key']], 'only the h:-tagged row was clicked')
  assert.equal(local.attrs['aria-expanded'], 'false', 'the local row is exactly as DSH drew it')
  assert.equal(ungrouped.attrs['aria-expanded'], 'false', 'and so is the ungrouped header')
  assert.deepEqual(expansionMap(), { [REMOTE_KEY_A]: true }, 'no entry for either local row')
  // Their own clicks are not learned either: the owner can toggle local rows natively.
  local.click(); await Promise.resolve()
  assert.deepEqual(expansionMap(), { [REMOTE_KEY_A]: true }, 'the local toggle changed no plugin state')
  ui.dispose()
})

await check('A1.3: a plugin-initiated click is never recorded as a user choice', async () => {
  const ui = load({ rows: [row(REMOTE_KEY_A, false)] })
  const first = ui.rows[0]
  // The auto-expand click raised the capture listener synchronously, before its own
  // toggle. If that read had been persisted, the map would hold the stale `false`.
  await Promise.resolve()
  assert.equal(first.attrs['aria-expanded'], 'true')
  assert.equal(expansionMap()[REMOTE_KEY_A], true, 'the plugin click did not write a user choice')
  assert.equal(ui.clicks().length, 1, 'and it was the only click')
  ui.dispose()
})

await check('A1.3: dispose removes the capture listener, disconnects the observer and cancels timers', async () => {
  const ui = load({ rows: [row(REMOTE_KEY_A, false)] })
  const first = ui.rows[0]
  assert.equal(ui.listeners('click'), 1, 'listener installed')
  assert.equal(ui.observers(), 1, 'the strip\'s single observer drives the row pass too')
  ui.flushTimers()
  assert.equal(ui.pendingTimers(), 0, 'no debounce timer left from the flush')
  first.click()
  assert.equal(ui.pendingTimers(), 1, 'the owner click left a post-toggle read pending')
  ui.dispose()
  assert.equal(ui.listeners('click'), 0, 'the capture listener was removed')
  assert.equal(ui.disconnected(), 1, 'the shared observer was disconnected')
  assert.equal(ui.pendingTimers(), 0, 'and no timer survived dispose')
  ui.flushTimers()
  assert.equal(expansionMap()[REMOTE_KEY_A], true, 'a cancelled read cannot overwrite the map')
  // A late sidebar re-render changes nothing: no listener, no observer, no click.
  first.attrs['aria-expanded'] = 'false'
  ui.pulse(); ui.flushTimers()
  assert.equal(first.attrs['aria-expanded'], 'false', 'no corrective click after teardown')
  assert.equal(ui.clicks().length, 2, 'only the install click and the owner click, none after teardown')
})

await check('A1.3: a microtask checkpoint before DSH\'s toggle cannot persist a stale value', async () => {
  const ui = load({ rows: [row(REMOTE_KEY_A, false)] })
  const first = ui.rows[0]
  ui.doc.toggleAfterMicrotask = true
  first.click()
  await Promise.resolve() // the checkpoint runs BEFORE the simulated row handler's toggle
  assert.equal(first.attrs['aria-expanded'], 'false', 'DSH has now collapsed the row')
  assert.equal(expansionMap()[REMOTE_KEY_A], true, 'the pre-handler value was never persisted')
  assert.equal(ui.pendingTimers(), 1, 'the remembered read waits for the next task')
  ui.flushTimers()
  assert.equal(expansionMap()[REMOTE_KEY_A], false, 'the post-handler state is what is remembered')
  assert.equal(ui.pendingTimers(), 0, 'no read is left behind')
  ui.dispose()
})

await check('A1.3: a placement pass queued before the owner click cannot reopen the row or re-persist true', async () => {
  const ui = load({ rows: [row(REMOTE_KEY_A, false)] })
  const first = ui.rows[0]
  assert.equal(first.attrs['aria-expanded'], 'true', 'the install pass opened the first-seen row')
  const baseline = ui.clicks().length
  // The sidebar re-rendered just before the owner clicked: its debounced placement
  // pass is already queued when the deferred owner read is added, so it runs FIRST.
  ui.pulse()
  assert.equal(ui.pendingTimers(), 1, 'the placement pass is pending before the click')
  first.click()
  assert.equal(first.attrs['aria-expanded'], 'false', 'the owner collapsed the row')
  assert.equal(ui.pendingTimers(), 2, 'the learning read is queued behind the pass')
  ui.flushTimers()
  assert.equal(first.attrs['aria-expanded'], 'false', 'the pass did not click the just-collapsed row open')
  assert.equal(expansionMap()[REMOTE_KEY_A], false, 'the owner\'s collapse, not the stale true, was persisted')
  assert.equal(ui.clicks().length, baseline + 1, 'only the owner click, no corrective click')
  ui.dispose()
})

await check('A1.3: a row replaced before the deferred read is remembered from the CURRENT row', async () => {
  const ui = load({ rows: [row(REMOTE_KEY_A, false)] })
  const old = ui.rows[0]
  assert.equal(old.attrs['aria-expanded'], 'true')
  old.click()
  assert.equal(old.attrs['aria-expanded'], 'false', 'the owner collapsed the original row')
  // DSH swaps the node before the learning task. The detached row keeps changing;
  // the owner's actual choice lives on the replacement, which is collapsed.
  old.attrs['aria-expanded'] = 'true'
  const current = rerender(ui, old, row(REMOTE_KEY_A, false))
  assert.equal(old.removed, true, 'the row captured by the click is no longer in the page')
  ui.flushTimers()
  assert.equal(expansionMap()[REMOTE_KEY_A], false, 'the new row was read, not the stale detached one')
  ui.pulse(); ui.flushTimers()
  assert.equal(current.attrs['aria-expanded'], 'false', 'the remembered collapse is not undone')
  assert.equal(ui.clicks().length, 2, 'install click + owner click, no corrective click')
  ui.dispose()
})

await check('A1.3: a localStorage getter that throws SecurityError falls back to memory', async () => {
  const ui = load({ rows: [row(REMOTE_KEY_A, false)], storageGetterThrows: true })
  const first = ui.rows[0]
  assert.equal(first.attrs['aria-expanded'], 'true', 'the first-seen row still opens')
  assert.equal(storage.has(EXPANSION_KEY), false, 'nothing could be persisted')
  first.click(); ui.flushTimers()
  assert.equal(first.attrs['aria-expanded'], 'false')
  const reopened = rerender(ui, first, row(REMOTE_KEY_A, true))
  ui.pulse(); ui.flushTimers()
  assert.equal(reopened.attrs['aria-expanded'], 'false', 'the in-memory owner choice still wins')
  ui.dispose()
})

finish('client-host-tabs')
