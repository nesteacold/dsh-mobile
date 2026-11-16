// Shared test helpers. Tests run as plain scripts (`node test/x.test.mjs`)
// because spawning `node --test` workers is EPERM in the sandbox.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import plugin, { internalsFor } from '../lib/index.mjs'

const require = createRequire(import.meta.url)
// `selfsigned` is the gateway's own certificate generator; reused from its
// node_modules (no network install here) to mint certificates for fake remotes.
export const selfsigned = require('../../mobile-gateway/node_modules/selfsigned')
export const { WebSocketServer } = require('../../mobile-gateway/node_modules/ws')

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
let passes = 0
export async function check(name, fn) {
  try {
    await fn()
    passes += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    // An assertion's own message first: without it a failed expectation prints only
    // the stack, and a deepEqual diff reads as "something broke somewhere".
    const detail = error && error.message ? `\n       ${error.message.split('\n').join('\n       ')}` : ''
    console.log(`  FAIL ${name}${detail}\n       ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n       ') : error}`)
  }
}
export function finish(label) {
  console.log(`${label}: ${passes} passed, ${failures} failed`)
  // Sockets/servers a failed test left open must not keep the run alive.
  process.exit(failures === 0 ? 0 : 1)
}
export function skip(name, reason) {
  console.log(`  SKIP ${name} (${reason})`)
}

export function tempDir(prefix = 'dsh-devices-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** SHA-256 of a PEM certificate's DER, the pin format of the pairing payload. */
export function pinOf(pem) {
  return crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('hex')
}

/**
 * The child context a fake `ctx.inject` hands its callback: it is the applied
 * context (so `elektron`, `effect` and `webServer` behave the same) narrowed to
 * the services this fiber was started for, and it does NOT define a `inject` of
 * its own — the upload install must not nest another fiber.
 */
function injectedContext(parent) {
  // An own, non-callable `inject` shadows the parent's: a fiber that tried to
  // start another one would fail loudly here instead of nesting silently.
  return Object.create(parent, { inject: { value: undefined } })
}

/**
 * `ctx.inject(dependencies, callback)` as Cordis runs it: the callback is a fiber
 * that starts only once EVERY required service is live, is unloaded when one goes
 * away, and is started again when the service returns — the shape the upload
 * wrapper relies on (lib/index.mjs). A withdrawal is ordered as the provider does
 * it: the fiber is unloaded first (the callback's returned disposer), then the
 * service is deleted (`registerFetchRoute`, dsh-client-connection
 * lib/index.js:850-852).
 *
 * PROVIDER IDENTITY is part of the epoch, not just presence: rc.3's Fiber builds
 * its epoch from each dependency's implementation `uid`
 * (cordis lib/index.js:611-635), so replacing a provider with another one — even
 * while the name stays available — moves the epoch and the fiber is unloaded
 * (`_unload`, :693-718) and only then reloaded (`_reload`, :670-691). A fake that
 * only tracked presence would keep `live` true across a replacement and hide every
 * bug that depends on the install running again. Each `setService` call is one
 * new implementation, so the per-name generation below is that uid.
 */
function createInjection(parent) {
  const fibers = []
  /** Per-name provider generation: bumped by every `setService`, the fake's impl uid. */
  const generations = new Map()
  const present = (name) => parent.get(name) !== undefined
  // Presence AND identity, exactly what `Fiber._refresh` folds into the epoch.
  const epochOf = (fiber) => fiber.dependencies.map((name) => (present(name) ? `${name}:${generations.get(name) ?? 0}` : null))
  const active = (fiber) => fiber.dependencies.every(present)
  const load = (fiber) => {
    if (!active(fiber)) return
    fiber.live = true
    fiber.epoch = epochOf(fiber).join('|')
    fiber.dispose = fiber.callback(injectedContext(parent)) ?? undefined
  }
  const unload = (fiber) => {
    if (!fiber.live) return
    fiber.live = false
    const dispose = fiber.dispose
    fiber.dispose = undefined
    if (typeof dispose === 'function') dispose()
  }
  const settle = () => {
    for (const fiber of fibers) {
      if (!active(fiber)) { unload(fiber); continue }
      const epoch = epochOf(fiber).join('|')
      // A live fiber whose dependency identities changed is one whose install must
      // run again: unload first (the exact restore), then reload below.
      if (fiber.live && fiber.epoch !== epoch) unload(fiber)
      if (!fiber.live) load(fiber)
    }
  }
  return {
    settle,
    bump(name) { generations.set(name, (generations.get(name) ?? 0) + 1) },
    inject(dependencies, callback) {
      const fiber = { dependencies: [...dependencies], callback, live: false, dispose: undefined, epoch: '' }
      fibers.push(fiber)
      load(fiber)
      return fiber
    },
    unloadAll() { for (const fiber of fibers) unload(fiber) },
  }
}

/** Mount the plugin on a fake web server; returns a request function that drives its handler. */
export async function mountPlugin(config = {}) {
  const dataDir = config.dataDir ?? tempDir()
  let route
  const disposers = []
  // Mutated by `setService`, so a test can replay the Host's real order: the
  // `connection` service appears AFTER this plugin applied, and can go away again.
  const services = { ...config.services }
  const ctx = {
    webServer: { register(entry) { route = entry; return () => { route = undefined } } },
    // Cordis services the plugin reads optionally (`ctx.get(name, false)`), e.g.
    // the Host `typertGateway` the multi-host router wraps (spec 008 P2a).
    get(name) { return services[name] },
    effect(fn) { disposers.push(fn()) },
  }
  const injection = createInjection(ctx)
  ctx.inject = (dependencies, callback) => injection.inject(dependencies, callback)
  const logs = []
  await plugin.apply(ctx, { dataDir, log: (line) => logs.push(line), ...config })
  // Cordis settles pending fibers whenever a provider appears, withdraws or is
  // REPLACED: a new implementation is a new uid, so every dependent fiber restarts.
  const setService = (name, value) => {
    if (value === undefined) delete services[name]
    else services[name] = value
    injection.bump(name)
    injection.settle()
  }
  // `apply` is async and Cordis rejects a non-function resolution as an invalid
  // effect, so the internals come from the plugin's WeakMap, not from a return.
  const instance = internalsFor(ctx) ?? {}
  const call = (method, url, { body, headers = {}, remoteAddress = '127.0.0.1' } = {}) => new Promise((resolve) => {
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const req = {
      method, url, headers: { host: '127.0.0.1:3080', ...headers }, socket: { remoteAddress },
      on(event, handler) {
        if (event === 'data') queueMicrotask(() => chunks.forEach((chunk) => handler(chunk)))
        if (event === 'end') queueMicrotask(() => queueMicrotask(() => handler()))
        return req
      },
    }
    const res = {
      writeHead(status, responseHeaders) { res.status = status; res.headers = responseHeaders },
      end(text) { resolve({ status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined, text }) },
    }
    route.handler(req, res)
  })
  return {
    dataDir, logs, call, instance, route: () => route, setService,
    close() {
      // Cordis unloads the child fibers of a plugin before its own disposers.
      injection.unloadAll()
      for (const dispose of disposers.splice(0)) dispose?.()
      fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

// --------------------------------------------------------------- fake DSH DOM
// Spec 033 (A1.2). DSH's real composer, as the installed
// `dsh-client-ui-conversation/lib/client.js` renders it:
//
//   [data-conversation-session]            ConversationRoot → `data-conversation-content`
//     [data-conversation-region=composer]
//       [data-composer-seat]
//         [data-composer-card]
//           [data-composer-input]           ComposerContentEditable  ← no picker inside
//           [data-composer-tools]           InputBar `tools` row
//             input[type=file][hidden]      the `+` picker — a SIBLING, not a child
//
// and DSH's own `onPickFiles` order: drain `e.target.files`, then `e.target.value=''`,
// then `intakeFiles(picked)`. Anything that reads `.files` when `pathFor` runs sees an
// empty picker, so the pick must be claimed from the capture phase of `change`.
/**
 * The compound selectors this fake understands — the same grammar a browser parses for the
 * shapes DSH's markup uses: `tag`, `[attr]`, `[attr="value"]`, `[attr=value]`, and their
 * combinations (`[hidden] input[type="file"]` is a descendant combinator, handled below).
 */
function parseCompounds(selector) {
  const parts = selector.trim().split(/\s+/)
  if (parts.some((part) => part === '')) throw new SyntaxError(`fake DOM: unsupported selector "${selector}"`)
  return parts.map((part) => {
    if (part === '*') return { tag: null, attrs: [] }
    const tagMatch = /^([a-zA-Z][\w-]*)?/.exec(part)
    const tag = tagMatch[1] ?? null
    const rest = part.slice(tagMatch[0].length)
    const attrs = []
    if (rest !== '') {
      let at = 0
      while (at < rest.length) {
        const attr = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/.exec(rest.slice(at))
        if (attr === null) throw new SyntaxError(`fake DOM: unsupported selector "${selector}"`)
        attrs.push({ name: attr[1], value: attr[2] ?? attr[3] ?? attr[4] ?? null })
        at += attr[0].length
      }
    }
    return { tag, attrs }
  })
}

const assertKnownSelector = (selector) => { parseCompounds(selector) }

/** One compound (`tag[attr=value]`) against one element: the browser's own rule. */
function compoundMatches(node, compound) {
  if (compound.tag !== null && node.tag !== compound.tag) return false
  return compound.attrs.every(({ name, value }) => (value === null ? node.hasAttribute(name) : node.getAttribute(name) === value))
}

/** A full selector (`a b`) against an element, with a descendant combinator between compounds. */
function matchCompounds(node, selector) {
  const compounds = parseCompounds(selector)
  const check = (at, index) => {
    if (at === null || at === undefined || typeof at.tag !== 'string') return false
    if (!compoundMatches(at, compounds[index])) return false
    if (index === 0) return true
    return check(at.parent, index - 1)
  }
  return check(node, compounds.length - 1)
}

/** The browser's matching predicate — the one `Element.matches` runs. */
const matches = (node, selector) => matchCompounds(node, selector)

/** The document object is the root, not an element: it answers no tag and no attributes. */
const isPlainNode = (value) => typeof value === 'object' && value !== null && typeof value.tag === 'string'

/** One document-ordered walk, the way `querySelectorAll` answers for a subtree. */
function descendants(node) {
  const out = []
  const walk = (at) => { for (const child of at.elts) { out.push(child); walk(child) } }
  walk(node)
  return out
}

/**
 * Walk a detached subtree: every PARENT the query walks through must leave the document, as the
 * browser's `Document.contains` requires — ascending stops at the first node outside it. The
 * document itself stays attached, because the fake document owns its tree (React's real document
 * has the window above it, so the distinction does not arise there).
 */
function detach(node, document) {
  node.ownerDocument = null
  if (node.parent !== null && node.parent !== document) node.parent = null
  for (const descendant of descendants(node)) detach(descendant, document)
}

/** Still in the tree: the browser's `Document.contains` for a detached-then-removed node. */
function isAttached(node, document) {
  for (let at = node; at !== null && at !== undefined; at = at.parent) if (at === document) return true
  return false
}

function makeElement(tag, attrs) {
  const node = {
    tag, attrs, elts: [], parent: null, ownerDocument: null, files: null, value: '',
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null },
    hasAttribute(name) { return Object.hasOwn(this.attrs, name) },
    get parentElement() { return this.parent },
    get nextElementSibling() {
      if (this.parent === null) return null
      const at = this.parent.elts.indexOf(this)
      return at < 0 ? null : (this.parent.elts[at + 1] ?? null)
    },
    /** The browser's rule: every compound must match this element. */
    matches(selector) {
      return matchCompounds(this, selector)
    },
    querySelectorAll(selector) {
      // A real DOM throws on a selector it cannot parse, and this fake does the same.
      assertKnownSelector(selector)
      return descendants(this).filter((child) => matches(child, selector))
    },
    get childElementCount() { return this.elts.length },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
    closest(selector) {
      assertKnownSelector(selector)
      for (let at = this; at !== null && at !== undefined; at = at.parent) if (isPlainNode(at) && matches(at, selector)) return at
      return null
    },
  }
  return node
}

const appendChild = (parent, child) => {
  child.parent = parent
  parent.elts.push(child)
  // Membership is inherited at attach time, as a browser does it: a subtree hung on the
  // document belongs to it, and a node removed from the tree keeps no owner.
  child.ownerDocument = parent.ownerDocument ?? parent
  for (const descendant of descendants(child)) descendant.ownerDocument = child.ownerDocument
  return child
}

/**
 * A document shaped like DSH's conversation, with its OWN dispatcher (so capture and
 * bubble both run, in spec order), and DSH's `onPickFiles` on the picker.
 *
 * `sessions` are the session ids rendered, in DOM order; `hero` adds a composer with no
 * session view (DSH's start page); `picker` asks for one page-level hidden file input
 * outside every composer (a file input DSH did not render); `hidInputs` renders the
 * composer input WITHOUT `[data-composer-input]` (older layout); `hidSeat` omits the seat
 * `[data-conversation-region=composer]` (a composer bar that is not in a composer region);
 * `elsewhere` adds a hidden file input beside a composer, inside its session view and
 * OUTSIDE its composer region (some other panel of the session, not the composer); `dialog`
 * mounts a second composer card, composer input included and no region above it, on the page
 * (a dialog or a start-page bar), so no ancestor holds "exactly one" composer input;
 * `realFiles` is DSH AS THE PICKER REALLY IS for spec 033's live mechanism: no listener of
 * our own on the picker (React's root delegate owns `change`), DSH's own handler registered
 * once on the React root (the page), wrapping `e.target.files` in try/catch as browsers do,
 * and a FILE LIST that can actually be replaced — the fake picker may accept an assignment to
 * a real `FileList`, which is what `input.files = dt.files` needs.
 */
const defaultBox = () => ({ sessions: [], hero: false, picker: false, hidInputs: false, hidSeat: false, elsewhere: false, dialog: false, realFiles: false })
export function createFakeComposerDocument(box = {}) {
  const { sessions, hero, picker, hidInputs, hidSeat, elsewhere, dialog, realFiles } = { ...defaultBox(), ...box }
  const listeners = new Map()
  const document = {
    activeElement: null,
    elts: [],
    contains: (node) => node !== null && node !== undefined && (node === document || (node.ownerDocument === document && isAttached(node, document))),
    querySelectorAll(selector) {
      assertKnownSelector(selector)
      return descendants(document).filter((child) => matches(child, selector))
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
    addEventListener(type, listener, options = {}) {
      const capture = typeof options === 'boolean' ? options : options.capture === true
      const entries = listeners.get(type) ?? []
      entries.push({ listener, capture })
      listeners.set(type, entries)
    },
    removeEventListener(type, listener, options = {}) {
      const capture = typeof options === 'boolean' ? options : options.capture === true
      const entries = listeners.get(type) ?? []
      listeners.set(type, entries.filter((entry) => entry.listener !== listener || entry.capture !== capture))
    },
    /**
     * Fire one event the way the browser does: capture down the ancestor chain (each node's
     * listeners in registration order), then bubble up. A listener is invoked once per node of
     * the path and gets that node as `currentTarget`.
     */
    dispatch(event) {
      // One walk per registered listener, never one walk per registration: these listeners are
      // held per document and invoked with each node as `currentTarget` — so a count of
      // listeners on the event says how many walkers run, not how many nodes they visit.
      const seen = new Set()
      const entries = []
      for (const entry of listeners.get(event.type) ?? []) {
        if (seen.has(entry.listener)) continue
        seen.add(entry.listener)
        entries.push(entry)
      }
      // The event's path, once per dispatch: `down` is capture order (page → target), `up` bubble.
      const chain = []
      for (let at = event.target; at !== null && at !== undefined && at !== document; at = at.parent) chain.push(at)
      chain.push(document)
      event.chain = chain
      const down = [...chain].reverse()
      for (const node of down) {
        event.currentTarget = node
        for (const entry of entries) if (entry.capture) entry.listener.call(node, event)
      }
      for (const node of chain) {
        event.currentTarget = node
        for (const entry of entries) if (!entry.capture && entry.route !== 'dsh') entry.listener.call(node, event)
      }
      // React's root delegate owns `change` and runs AFTER every plain listener on the same
      // node (it was attached first), so DSH's own handler is routed last at the page.
      for (const node of chain) {
        event.currentTarget = node
        for (const entry of entries) if (!entry.capture && entry.route === 'dsh') entry.listener.call(node, event)
      }
    },
    /** Remove `node` from the tree, as a React unmount does. */
    remove(node) {
      if (node?.parent === null || node?.parent === undefined) return
      const at = node.parent.elts.indexOf(node)
      if (at >= 0) node.parent.elts.splice(at, 1)
      detach(node, this)
    },
    listenerCount(type) { return (listeners.get(type) ?? []).length },
  }
  // A real change event: `new Event('change', {bubbles: true})` as the browser fires it. The
  // fake pickers' own `dispatch` is for the legacy per-picker listener; this one walks the
  // document's capture and bubble listeners like the browser, with `target`/`currentTarget`.
  document.createEvent = (type) => {
    const event = { type, target: null, currentTarget: null, timeStamp: 0, bubbles: true, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true }, stopPropagation() {} }
    return event
  }
  document.dispatchEvent = (event) => { document.dispatch({ type: event.type, target: event.target, timeStamp: event.timeStamp, real: true }) }
  const composers = []
  // DSH's own handler, registered once on React's root (which this fake page stands for) and
  // reading `event.target.files` in try/catch: a browser answers `null` for a list that is not
  // a `FileList` it built, and React's synthetic event does the same.
  const readTargetFiles = (target) => {
    const files = target?.files ?? null
    if (files === null || typeof files !== 'object' || (realFiles && !(files instanceof FILE_LIST_CLASS()))) return null
    // A copy: reading `files` must not hand DSH the very object a later assignment may replace.
    return [...files]
  }
  const rootOnPickFiles = (event) => {
    const composer = composers.find((entry) => entry.fileInput === event.target)
    if (composer === undefined) return
    const picked = readTargetFiles(event.target)
    event.target.value = ''
    if (realFiles) return
    event.target.files = null
    if (picked.length > 0) composer.intake.picked.push(...picked)
  }
  if (realFiles) document.addEventListener('change', rootOnPickFiles)
  const build = (sessionId) => {
    const card = makeElement('div', { 'data-composer-card': '' })
    const input = makeElement('div', { role: 'textbox', ...(hidInputs ? {} : { 'data-composer-input': '' }) })
    const tools = makeElement('div', { 'data-composer-tools': '' })
    const fileInput = makeElement('input', { type: 'file', multiple: '', hidden: '', tabindex: '-1' })
    if (realFiles) {
      // A browser's `input.files`: only a `FileList` (build one with `fakeFileList`) may be assigned.
      Object.defineProperty(fileInput, 'files', {
        configurable: true, enumerable: true,
        get() { return this.pickList ?? null },
        set(value) {
          if (value !== null && !(value instanceof FILE_LIST_CLASS())) throw new TypeError('not a FileList')
          this.pickList = value
        },
      })
    }
    const row = makeElement('div', { 'data-composer-row': '' })
    appendChild(card, input)
    appendChild(tools, makeElement('button', { 'aria-label': 'commands' }))
    appendChild(tools, fileInput)
    appendChild(row, tools)
    appendChild(card, row)
    let root = card
    let seat = null
    if (!hidSeat) {
      seat = makeElement('div', { 'data-composer-seat': '', 'data-conversation-region': 'composer' })
      appendChild(seat, card)
      root = seat
    }
    if (sessionId !== undefined) {
      // `ConversationRoot`'s body element IS `[data-conversation-region="chat"]` and holds the seat.
      root = makeElement('div', { 'data-conversation-session': sessionId, 'data-conversation-region': 'chat', 'data-conversation-content': '' })
      appendChild(root, seat ?? card)
    }
    appendChild(document, root)
    // DSH's own `onPickFiles` on THIS picker's `change` (bubble phase), exactly as the
    // installed InputBar registers it per render: drain `e.target.files`, reset
    // `e.target.value`, then hand the files on — one listener, one picker.
    const intake = { picked: [] }
    const onPickFiles = (event) => {
      if (event.target !== fileInput) return
      const picked = event.target.files === null ? [] : [...event.target.files]
      event.target.value = ''
      event.target.files = null
      if (picked.length > 0) intake.picked.push(...picked)
    }
    if (realFiles) {
      // React owns the picker's `change` at the root, so the element itself has none.
    } else {
      fileInput.addEventListener = (type, listener) => { if (type === 'change') document.addEventListener('change', listener) }
      document.addEventListener('change', onPickFiles)
    }
    // A panel of the session that is not the composer: its own file input, beside the seat.
    let other = null
    if (elsewhere && sessionId !== undefined && String(sessionId).startsWith('h:')) {
      other = makeElement('input', { type: 'file', hidden: '' })
      other.addEventListener = fileInput.addEventListener
      appendChild(root, other)
    }
    composers.push({ root, seat, card, row, tools, input, fileInput, intake, elsewhere: other })
  }
  for (const sessionId of sessions) build(sessionId)
  if (hero) build(undefined)
  // A composer card on the page outside every session view and every composer region.
  if (dialog) {
    const card = makeElement('div', { 'data-composer-card': '' })
    appendChild(card, makeElement('div', { role: 'textbox', 'data-composer-input': '' }))
    appendChild(document, card)
  }
  let loose = null
  if (picker) {
    loose = makeElement('input', { type: 'file', hidden: '' })
    // A live page's pickers take a real `FileList` (the `realFiles` contract above); a
    // page-level input is no different to the browser, only to the attribution.
    if (realFiles) {
      Object.defineProperty(loose, 'files', {
        configurable: true, enumerable: true,
        get() { return this.pickList ?? null },
        set(value) {
          if (value !== null && !(value instanceof FILE_LIST_CLASS())) throw new TypeError('not a FileList')
          this.pickList = value
        },
      })
    }
    appendChild(document, loose)
  }
  return { document, composers, loosePicker: loose }
}

/**
 * One pick in DSH's order: fill the picker, dispatch `change` (the capture listener runs
 * first — DSH's own bubble handler then drains and resets the picker), announce the batch
 * DSH keeps (`onIntake`, when given: the installed `apply.ts` `addFiles` dispatches
 * `dsh:intake-files` before it loops), and finally call `pathFor` for every picked file,
 * synchronously, as `addFiles` does.
 * @returns {unknown[]} one answer per file
 */
export function pickFiles(document, fileInput, files, pathFor, onIntake) {
  // A real FileList: indexable, `length`, and iterable (DSH spreads it).
  fileInput.files = Object.assign([...files], { item: (index) => files[index] ?? null })
  fileInput.pickClock = (fileInput.pickClock ?? 1000) + 1
  document.dispatch({ type: 'change', target: fileInput, timeStamp: fileInput.pickClock })
  if (typeof onIntake === 'function') onIntake(files)
  return files.map((file) => pathFor(file))
}

/** Let the microtask queue drain. */
export const settleMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * The `FileList` class these tests stand a browser's `input.files = dt.files` in for. Node has
 * `File` but no `FileList`, so a test asks for the browser's class and gets an exact stand-in.
 */
let FileListClass = null
function fileListPrototype() {
  if (FileListClass === null) FileListClass = class FileList { constructor() { throw new TypeError('illegal constructor') } }
  return FileListClass.prototype
}
export const FILE_LIST_CLASS = () => (fileListPrototype(), FileListClass)
export const installFileListStub = () => { if (typeof globalThis.FileList === 'undefined') globalThis.FileList = FILE_LIST_CLASS() }

/**
 * A `FileList` built the way `DataTransfer.files` builds one: the real class, with the files
 * as indexed own properties. Node has `File` and `Blob` (web fetch); it has no
 * `DataTransfer`, so this stands in for the list a browser's would be — an `instanceof
 * FileList` the picker's setter accepts, exactly like a browser's own assignment.
 */
export function fakeFileList(files) {
  const list = Object.create(fileListPrototype())
  files.forEach((file, at) => { list[at] = file })
  Object.defineProperties(list, {
    length: { value: files.length, enumerable: false },
    item: { value: (index) => files[index] ?? null, enumerable: false },
    [Symbol.iterator]: { value: function* iterate() { yield* files }, enumerable: false },
  })
  return list
}

/** A page's constructors, as a renderer realm has them: `File` (Node's) and a `DataTransfer`. */
export function fakeRealmExtras() {
  class DataTransfer {
    constructor() {
      const items = []
      this.items = {
        add: (file) => { items.push(file) },
        [Symbol.iterator]: () => items[Symbol.iterator](),
      }
      this.pending = items
    }
    get files() { return fakeFileList(this.pending) }
  }
  return { File, DataTransfer, Blob }
}

/**
 * The page the spec 033 mechanism runs in, for the REAL-file tests: DSH's composer document
 * (`realFiles`), a replaceable picker list, a `File`/`DataTransfer` realm, and the bridge the
 * preload exposes — a FROZEN contextBridge copy (`exposeInMainWorld`), which is what the
 * plugin must leave alone.
 *
 * THE BRIDGE ANSWERS LIKE THE PRELOAD, per object: `webUtils.getPathForFile` has a path only
 * for the files the OS picker handed this page, and `''` for any `File` page script built. The
 * fixture once answered a path for every `File`, which made every path-free COPY look already
 * named — the mechanism could pass a symmetric-looking bridge while a real one was untouched.
 * Files become "picked" by the `picked()` marker below (an own `origin` property the preload
 * would never see; the copies `File([file], name, {type, lastModified})` builds never carry it).
 * @param {{sessions: string[]}} box the composer sessions to render
 */
export const PICKED_ORIGIN = 'picked'
/** A file as the OS hands it over: the bridge answers a real path for THIS object. */
export function picked(file) {
  return Object.assign(file, { origin: PICKED_ORIGIN })
}
/**
 * Make one composer's picker refuse the page's replacement (`input.files = dt.files`), the two
 * ways a browser can: `throws` — a `[LegacyUnforgeable]` `files` or a setter that raises — and
 * `ignored` — the assignment is accepted but the picker keeps the list it had (spec 033 review
 * 2026-11-16: a PROVEN remote non-image pick whose copies did not take must say
 * `replace-failed`, never `certain`).
 * @param {object} fileInput the composer's hidden `input[type=file]`
 * @param {'throws'|'ignored'} mode
 */
export function refusePickerList(fileInput, mode = 'throws') {
  Object.defineProperty(fileInput, 'files', {
    configurable: true, enumerable: true,
    get() { return this.pickList ?? null },
    set(value) {
      if (mode === 'throws') throw new TypeError('files is read-only here')
      // `ignored`: the setter exists and returns, and the list is unchanged.
    },
  })
  return fileInput
}
export function createLivePage(box) {
  const page = createFakeComposerDocument({ ...box, realFiles: true })
  const holder = { document: page.document, fetch: undefined, ...fakeRealmExtras() }
  // Frozen exactly as contextBridge freezes it: members non-writable, non-configurable.
  Object.defineProperty(holder, '__DSH_HOST_PATHS__', {
    value: Object.freeze({
      pathFor: (file) => (file?.origin === PICKED_ORIGIN ? `C:\\Users\\owner\\Downloads\\${file.name}` : ''),
    }),
    writable: false, configurable: false, enumerable: false,
  })
  return { page, holder, document: page.document, composers: page.composers, loosePicker: page.loosePicker }
}

/**
 * A page with no `__DSH_HOST_PATHS__` at all (the Web GUI), where a constructed path is
 * impossible and the mechanism therefore needs no contract measurement.
 */
export function createWebPage(box) {
  const page = createFakeComposerDocument({ ...box, realFiles: true })
  const holder = { document: page.document, ...fakeRealmExtras() }
  return { page, holder, document: page.document, composers: page.composers, loosePicker: page.loosePicker }
}

/**
 * One REAL pick, in DSH's own order for a browser: the files go into the picker (a `FileList`),
 * `change` fires as the browser fires it — the page's capture listeners first, then the page's
 * bubble listeners, where DSH's own `onPickFiles` reads `e.target.files` — and then DSH's own
 * handler runs on the list it found: it drains it, hands the files on (`intake`) and every
 * file is answered through `pathFor`, as `apply.ts` `addFiles` does.
 *
 * DSH's listener is the test's own, registered just before the pick and removed just after:
 * the event was already dispatched by then, which is exactly the order a listener registered
 * after this plugin's capture one has.
 * @param {object} document the fake page
 * @param {object} picker DSH's hidden `input[type=file]`
 * @param {File[]} files what the user picked
 * @param {(file: File) => string} pathFor the preload bridge's answer
 * @param {(picked: File[]) => void} [intake] what DSH's handler handed on
 * @returns {Array<{kind: string, ref?: string, path: string}>} DSH's own outcome per file
 */
export function livePick(document, picker, files, pathFor, intake) {
  picker.pickList = fakeFileList(files)
  const event = document.createEvent('Event')
  event.type = 'change'
  event.target = picker
  picker.pickClock = (picker.pickClock ?? 1000) + 1
  event.timeStamp = picker.pickClock
  // The bubble phase, down to the page: DSH's own handlers run here, AFTER every capture
  // listener (this fake walks the chain capture-then-bubble, as the DOM does).
  const seen = []
  const dshOnPickFiles = (live) => {
    // The pick's own dispatch, in bubble order (after every capture listener above): DSH's
    // handler is registered on the page, so it is called for every node's bubble walk and
    // runs once, when that walk reaches the page.
    if (live.target !== picker || live.chain === undefined || live.currentTarget !== document) return
    const listed = picker.files ?? null
    const picked = listed === null || typeof listed !== 'object' ? [] : [...listed]
    picker.value = ''
    if (picked.length > 0) seen.push(...picked)
  }
  document.addEventListener('change', dshOnPickFiles)
  try {
    document.dispatchEvent(event)
  } finally {
    document.removeEventListener('change', dshOnPickFiles)
  }
  intake?.(seen)
  return seen.map((file) => {
    const path = pathFor(file) ?? ''
    if (path === '') return { kind: 'upload', path }
    return { kind: 'mention', ref: `@"${path}"`, path }
  })
}

/**
 * DSH's own notice about the batch its loop was handed (`apply.ts` `addFiles`: the
 * `dsh:intake-files` detail event, `{files, skipped, refused?}`), with the identity of THIS
 * picker's files. Dispatching it is the test's job — the module only listens — and it proves
 * the half a fake `pathFor` loop cannot: with DSH's own handler the picker is drained and
 * reset before `pathFor` ever runs.
 * @param {object} document the fake document
 * @param {object[]} files the files this batch was handed
 * @param {{refused?: boolean}} [box] whether DSH refused this batch (it is not in `intake.picked`)
 */
export function dispatchIntake(document, files, box = {}) {
  document.dispatch({ type: 'dsh:intake-files', target: document, timeStamp: (document.intakeClock ?? 0) + 1,
    detail: { files: [...files], skipped: [], ...(box.refused === true ? { refused: [...files] } : {}) } })
}


