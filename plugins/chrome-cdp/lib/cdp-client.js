/**
 * The Chrome DevTools Protocol transport (spec 035).
 *
 * One control connection to the browser endpoint does the discovery and the tab work
 * (`/json/list`, `/json/new`, `Target.closeTarget`); one page connection per target drives
 * the page (`Page`, `Runtime`, and the per-frame sessions an OOPIF needs). Node's global
 * `WebSocket` is the client: no dependency, and no Chrome started by this module.
 *
 * Every part is loopback by construction — the endpoint rule lives in `parseEndpoint`, and
 * a WebSocket URL from Chrome is accepted only when its host matches the configured one.
 *
 * @module @dsh-ext/chrome-cdp/cdp-client
 */
import { snapshotExpression, elementRectExpression, LEASE_MS, OWNER_CHROME_PORT } from './cdp.js'

/** A CDP call that never settled. */
const DEFAULT_TIMEOUT_MS = 20_000

/** How long one WebSocket may take to open before the attempt is abandoned. */
const CONNECT_TIMEOUT_MS = 5_000


const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * A test process must never open the owner's own Chrome socket. The HTTP guard in
 * `index.js` covers discovery; this one covers the WebSocket itself, so a fake cannot lure a
 * test onto the owner's port either. Outside a test process it does nothing.
 * @param {string} url - the socket about to open.
 */
function assertNotOwnerChrome (url) {
  if (process.env.NODE_TEST_CONTEXT === undefined) return
  let port = 0
  try {
    port = Number(new URL(url).port)
  } catch {
    return
  }
  if (port === OWNER_CHROME_PORT) {
    throw new Error(`refused a test connection to ${url}: port ${OWNER_CHROME_PORT} is the owner's own Chrome`)
  }
}

/**
 * Check a WebSocket URL Chrome published against the configured endpoint before connecting.
 *
 * The endpoint is loopback by construction, and so must be every socket the plugin opens: a
 * `webSocketDebuggerUrl` naming another host, another port or another scheme is refused, so a
 * Chrome (or something answering in its place) cannot redirect this plugin to a third party.
 * @param {unknown} url - the URL from `/json/version` or `/json/list`.
 * @param {{host: string, port: number}} endpoint - the configured, validated endpoint.
 * @returns {string} the URL when it is safe to connect to.
 * @throws {Error} when it is not a `ws:` URL on the configured loopback host and port.
 */
export function assertLoopbackSocket (url, endpoint) {
  if (typeof url !== 'string' || url === '') throw new Error('Chrome reported no WebSocket URL')
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Chrome reported a WebSocket URL that is not a URL: ${url.slice(0, 120)}`)
  }
  if (parsed.protocol !== 'ws:') {
    throw new Error(`Chrome reported a WebSocket URL with the "${parsed.protocol}" scheme; this plugin only opens ws: on loopback (spec 035 R1)`)
  }
  let host = parsed.hostname.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const port = parsed.port === '' ? 80 : Number(parsed.port)
  if (host !== endpoint.host || port !== endpoint.port) {
    throw new Error(
      `Chrome reported the WebSocket ${host}:${port}, which is not the configured endpoint ${endpoint.host}:${endpoint.port}. `
      + 'Every CDP socket stays on that one loopback endpoint (spec 035 R1).',
    )
  }
  return url
}

/**
 * One WebSocket speaking the CDP JSON-RPC framing.
 *
 * CDP answers every command in order with the matching id, so one connection keeps a
 * pending map keyed by id and dispatches every other message to its event listeners.
 */
class Connection {
  /** @param {string} url - ws:// URL of a Chrome target or of the browser, already checked. */
  constructor (url) {
    assertNotOwnerChrome(url)
    this.url = url
    this.next = 0
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    this.socket = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      // One deadline, and a pre-open close is a failed open: without either, an endpoint that
      // accepts the TCP connection and never answers holds a tool call forever.
      const timer = setTimeout(() => {
        this.closed = true
        try { this.socket.close() } catch (error) {}
        reject(new Error(`the CDP connection did not open within ${CONNECT_TIMEOUT_MS} ms`))
      }, CONNECT_TIMEOUT_MS)
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve() })
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('websocket')) })
      this.socket.addEventListener('close', () => {
        clearTimeout(timer)
        if (!this.closed) reject(new Error('the CDP connection closed before it opened'))
        this.closed = true
        for (const [, slot] of this.pending) {
          clearTimeout(slot.timer)
          slot.reject(new Error('the CDP connection closed'))
        }
        this.pending.clear()
      })
    })
    // An unhandled rejection here would surface on every unreachable Chrome.
    this.ready.catch(() => {})
    this.socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const slot = this.pending.get(message.id)
        this.pending.delete(message.id)
        clearTimeout(slot.timer)
        if (message.error) slot.reject(new Error(String(message.error.message ?? 'CDP error')))
        else slot.resolve(message.result)
        return
      }
      if (typeof message.method !== 'string') return
      for (const listener of this.listeners.get(message.method) ?? []) {
        try {
          listener(message.params)
        } catch {
          // A listener of ours; a throw must not take the socket down.
        }
      }
    })
  }

  /**
   * @param {string} method - CDP method.
   * @param {object} [params] - CDP parameters.
   * @param {number} [timeoutMs] - deadline.
   * @param {string|null} [sessionId] - flattened session; commands that need one carry it.
   * @param {number|null} [contextId] - `Input.dispatch*` take the isolated world an element
   *   number was resolved in, so a key or a click lands in the frame that printed it (R3).
   */
  send (method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS, sessionId = null, contextId = null) {
    if (this.closed) return Promise.reject(new Error('the CDP connection closed'))
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} did not answer within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const frame = { id, method, params }
      if (typeof sessionId === 'string' && sessionId !== '') frame.sessionId = sessionId
      if (Number.isInteger(contextId)) frame.params = { ...params, contextId }
      try {
        this.socket.send(JSON.stringify(frame))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** @param {string} method - CDP event name. @param {Function} listener - receives the params. */
  on (method, listener) {
    const list = this.listeners.get(method) ?? []
    list.push(listener)
    this.listeners.set(method, list)
  }

  close () {
    this.closed = true
    try {
      this.socket.close()
    } catch {
      // Already closing.
    }
  }
}

/**
 * Flatten one `Page.getFrameTree` subtree into document order: the frame, then its children.
 * @param {object|null} node - one `FrameTree` node, or null.
 * @param {string|null} [parentId] - the frame that contains `node`.
 * @returns {object[]} `{ frameId, parentId, url, kind }` per document; the child of a child is
 *   named `deep frame`, because `CDP` reads its `Runtime` world from the top document.
 */
export function walkFrameTree (node, parentId = null) {
  if (node === null || typeof node !== 'object' || typeof node.frame?.id !== 'string') return []
  const url = typeof node.frame.url === 'string' ? node.frame.url : ''
  const kind = parentId === null ? 'top' : (typeof node.frame.parentId === 'string' ? 'deep frame' : 'frame')
  const self = { frameId: node.frame.id, parentId, url, kind }
  const children = Array.isArray(node.childFrames) ? node.childFrames : []
  return [self, ...children.flatMap((child) => walkFrameTree(child, node.frame.id))]
}

/**
 * Give every element of a fresh read one page-wide number and record where it lives.
 *
 * The frame scripts number within their own document, and two frames routinely both report 1;
 * the host therefore keeps its own series (R3: a number identifies exactly one frame, session,
 * context and element, so a click is never ambiguous). Both numbers travel: `index` is the
 * page-wide one the results print, and `localIndex` is the frame-local one that only ever
 * appears inside `data-chrome-cdp-index` in that frame's document, which is the attribute a
 * click or fill interacts with. The series is assigned to every snapshot the host takes; a
 * number is stored in the snapshot of the session that took it, so two sessions reading one
 * tab never share a numbering (R3).
 * @param {object[]} found - `{ element, frame, label }` in document order.
 * @returns {{frames: Map<object, object[]>, index: Map<number, object>, total: number}} the
 *   elements per frame, the numbers with their exact location, and the total.
 */
export function numberSnapshot (found) {
  const frames = new Map()
  const index = new Map()
  let next = 1
  for (const hit of found) {
    const localIndex = Number.isInteger(hit.element?.index) && hit.element.index > 0 ? hit.element.index : next
    const element = { ...hit.element, index: next, localIndex }
    const list = frames.get(hit.frame) ?? []
    list.push(element)
    frames.set(hit.frame, list)
    index.set(next, {
      frame: hit.frame,
      label: hit.label,
      sessionId: hit.frame.sessionId ?? null,
      contextId: hit.frame.contextId,
      frameId: hit.frame.frameId ?? null,
      localIndex,
    })
    next += 1
  }
  return { frames, index, total: next - 1 }
}

/**
 * One page target: its own connection, every frame session attached to it, and the tab
 * binding shared with the tools.
 *
 * Frames are addressed the way Chrome exposes them (R3): the top document and each
 * same-process child frame exist as frames of the page session, reached with the `frameId`
 * parameter of `Runtime.evaluate`; each cross-process frame (OOPIF) is its own target session.
 * Every read runs in an isolated world (`Page.createIsolatedWorld`), which no page script can
 * see, so element numbers and lookups cannot be forged from the page.
 */
class PageConnection {
  /** @param {ChromeCdp} client - the client that owns every binding and lease. */
  constructor (client, target, task) {
    this.plugin = client
    this.target = target
    /**
     * Whose connection this is: the session that opened it, recorded for diagnostics only.
     * Any session may share a live connection once no active lease excludes it (R4); the
     * lease, not this field, decides who may act.
     */
    this.owner = task.sessionId
    this.task = task
    /** every caller using this connection, in arrival order */
    this.users = [task.sessionId]
    this.connection = new Connection(target.webSocketDebuggerUrl)
    this.sessions = new Map()
    /** childFrameId → the OOPIF target session that owns it (R3: the host's number map). */
    this.frames = new Map()
    /** OOPIF target session → its own flattened frame tree, as Chrome reports it. */
    this.oopifTrees = new Map()
    /** page-wide number → the exact frame, session, isolated context and element it was printed
     *   in, per calling session, with the generation of that snapshot (R3). */
    this.snapshots = new Map()
    /** bumped on every snapshot; an action quoting an older generation is refused as stale. */
    this.generation = 0
    /** `${sessionId}|${frameId}` → executionContextId of that frame's isolated world. */
    this.worlds = new Map()
    this.tree = undefined
    this.mainFrameId = null
    /** the page-wide number a snapshot printed was cut by a repeated child id (never act on it) */
    this.treeUnreliable = false
    /** bumped whenever a document loads in this tab: a number from the old one must not click */
    this.document = 0
    this.crashed = null
    this.ready = this.init()
    this.ready.catch(() => {})
  }

  /**
   * Whether the connection can never answer: the tab closed, the page crashed, or CDP failed.
   * Read from `broken` at every use, so a connection is reopened when it dies and reused
   * when it lives, by its owner.
   */
  get broken () {
    return this.crashed !== null || this.connection.closed
  }

  async init () {
    const { connection } = this
    await connection.ready
    connection.on('Target.attachedToTarget', (params) => {
      const { sessionId, targetInfo } = params ?? {}
      if (typeof sessionId !== 'string' || sessionId === '') return
      this.sessions.set(sessionId, { targetId: targetInfo?.targetId, type: targetInfo?.type, url: targetInfo?.url })
      // An OOPIF reports the frame it became; the frame tree names that id too, and that is
      // what lets the host find the child frame behind a cross-process document (R3).
      const frameId = targetInfo?.targetId
      if (typeof targetInfo?.url === 'string' && typeof frameId === 'string' && frameId !== '') this.frames.set(frameId, sessionId)
      // A paused child waits here until this side resumes it; a resume that fails is reported
      // on the session that failed instead of being dropped, because that frame then stays
      // frozen and every read of it would time out with no reason. The session id goes on the
      // wire exactly as Chrome sent it: a string, or no session at all.
      connection.send('Runtime.runIfWaitingForDebugger', {}, 5_000, sessionId).catch((error) => {
        this.sessions.set(sessionId, { ...(this.sessions.get(sessionId) ?? {}), failed: `could not resume the frame: ${String(error?.message ?? error)}` })
      })
    })
    connection.on('Target.detachedFromTarget', (params) => {
      const { sessionId, targetInfo } = params ?? {}
      this.sessions.delete(sessionId)
      const frameId = targetInfo?.targetId
      if (typeof frameId === 'string' && this.frames.get(frameId) === sessionId) this.frames.delete(frameId)
    })
    const forget = (frameId) => {
      this.index.delete(frameId)
      // A navigation makes every world of this frame stale: its own, the session-wide one, and
      // the world of an OOPIF that used this id as its root frame.
      this.worlds.delete(`|${frameId}`)
      this.worlds.delete('|')
      this.worlds.delete(`|${this.tree?.[0]?.frameId ?? ''}`)
      for (const sessionId of this.frames.values()) this.worlds.delete(`${sessionId}|${frameId}`)
      this.oopifTrees.delete(frameId)
    }
    connection.on('Page.frameNavigated', (params) => {
      const frame = params?.frame
      if (frame?.parentId === undefined) this.document += 1
      if (typeof frame?.id === 'string') forget(frame.id)
      // The tree is re-read on the next read rather than guessed from the event.
      this.tree = undefined
    })
    connection.on('Page.frameDetached', (params) => {
      if (typeof params?.frameId === 'string') forget(params.frameId)
      this.tree = undefined
    })
    connection.on('Inspector.targetCrashed', () => { this.crashed = 'the page crashed' })
    connection.on('Inspector.detached', (params) => { this.crashed = params?.reason || 'the page was detached' })

    // OOPIFs: every out-of-process frame becomes a session on this connection, paused
    // until this side resumes it — so it can be driven before its first script runs (R3).
    await connection.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    const tree = await connection.send('Page.getFrameTree')
    this.tree = walkFrameTree(tree?.frameTree ?? null)
    this.mainFrameId = this.tree[0]?.frameId ?? null
    await connection.send('Page.enable')
    await connection.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {})
  }

 /**
   * Frames that may answer an element query, each with the session and the isolated-world
   * context that addresses it exactly: the top document and every same-process child frame
   * from `Page.getFrameTree`, then every document of each attached OOPIF target.
   *
   * A child frame whose id an attached target owns is an OOPIF: its document is read through
   * its own session, never through the page session's world, which would answer with the top
   * document. Each OOPIF target reports its own frame tree, so the frame id passed to
   * `Page.createIsolatedWorld` is that target's real root frame, never a guess. Every frame
   * that cannot be read stays in the list as `failed`, so the results say which part is
   * missing instead of silently dropping it (R3).
   * @param {{refresh?: boolean}} [options] - `refresh` re-reads the frame tree first.
   * @returns {Promise<object[]>} `{ sessionId, frameId, contextId, kind, url, failed? }` entries.
   */
  async frameSessions ({ refresh = false } = {}) {
    await this.frameTree({ refresh })
    const frames = []
    const unreadable = (frame, reason) => frames.push({ sessionId: frame.sessionId, frameId: frame.frameId, contextId: null, kind: frame.kind, url: frame.url, failed: reason })
    for (const frame of this.tree ?? []) {
      if (frame.url === '' || frame.url === 'about:blank') continue
      if (frame.parentId !== null && this.frames.has(frame.frameId)) continue
      const world = await this.isolatedWorld(null, frame.frameId)
      if (world === null) {
        unreadable({ sessionId: null, frameId: frame.frameId, kind: frame.kind, url: frame.url }, 'Chrome gave this frame no isolated world (it may be detached)')
        continue
      }
      frames.push({ sessionId: null, frameId: frame.frameId, contextId: world, kind: frame.kind, url: frame.url })
    }
    for (const [sessionId, info] of this.sessions) {
      if (info?.type !== 'iframe' || typeof info.url !== 'string' || info.url === 'about:blank') continue
      // A session this side could not resume is reported rather than read: its renderer is frozen.
      if (typeof info.failed === 'string') {
        unreadable({ sessionId, frameId: null, kind: 'iframe', url: info.url }, info.failed)
        continue
      }
      // The OOPIF's own tree names the frame that is its document: the id Chrome requires.
      const tree = await this.frameTreeOf(sessionId, info.targetId)
      const root = tree[0]
      if (root === undefined) {
        unreadable({ sessionId, frameId: null, kind: 'iframe', url: info.url }, 'the iframe target gave no frame tree')
        continue
      }
      for (const frame of tree) {
        if (frame.url === '' || frame.url === 'about:blank') continue
        const world = await this.isolatedWorld(sessionId, frame.frameId)
        if (world === null) {
          unreadable({ sessionId, frameId: frame.frameId, kind: 'iframe', url: frame.url }, 'Chrome gave this frame no isolated world (it may be detached)')
          continue
        }
        frames.push({ sessionId, frameId: frame.frameId, contextId: world, kind: 'iframe', url: frame.url })
      }
    }
    return frames
  }

  /**
   * The frame tree of one attached OOPIF target, flattened. Chrome answers `Page.getFrameTree`
   * on the target session and its root frame is the frame the target is, which is the only id
   * `Page.createIsolatedWorld` accepts there.
   * @param {string} sessionId - the OOPIF target session.
   * @param {string} [targetId] - its target id, the fallback root when Chrome reports no tree.
   * @returns {Promise<object[]>} `{ frameId, parentId, url, kind }` entries.
   */
  async frameTreeOf (sessionId, targetId) {
    const tree = await this.connection.send('Page.getFrameTree', {}, 5_000, sessionId).catch(() => null)
    const flat = walkFrameTree(tree?.frameTree ?? null)
    if (flat.length > 0) {
      this.oopifTrees.set(sessionId, flat)
      return flat
    }
    // Chrome refused the read: the target id is still the frame it became, so that stays usable.
    const cached = this.oopifTrees.get(sessionId)
    if (cached !== undefined) return cached
    if (typeof targetId !== 'string' || targetId === '') return []
    return [{ frameId: targetId, parentId: null, url: this.sessions.get(sessionId)?.url ?? '', kind: 'iframe' }]
  }

  /**
   * `Page.getFrameTree`, flattened to document order (R3).
   *
   * The tree is the only place a same-process child frame comes from. When one frame id
   * appears twice the pass is cut short and marked unreliable, so a number from that read is
   * never resolved against a guess: a click refuses instead of acting on the wrong document.
   * @param {{refresh?: boolean}} [options] - `refresh` re-reads even when a tree is cached.
   * @returns {Promise<object[]>} `{ frameId, parentId, url, kind }` entries.
   */
  async frameTree ({ refresh = false } = {}) {
    if (!refresh && this.tree !== undefined && !this.treeUnreliable) return this.tree
    const tree = await this.connection.send('Page.getFrameTree').catch(() => null)
    const flat = walkFrameTree(tree?.frameTree ?? null)
    const ids = new Set()
    const stable = []
    let unreliable = false
    for (const frame of flat) {
      if (ids.has(frame.frameId)) {
        unreliable = true
        break
      }
      ids.add(frame.frameId)
      stable.push(frame)
    }
    this.tree = stable
    this.treeUnreliable = unreliable
    if (stable.length > 0) this.mainFrameId = stable[0].frameId
    // A new document starts a new numbering pass: its numbers are not the previous page's.
    return stable
  }

  /**
   * Same-process child frames and the OOPIF target behind each, for the page-side reader.
   *
   * A frame inside the top document is read with the top document's own `Runtime` and its
   * `frameId`; a frame behind an OOPIF has the OOPIF's session, so the reader recurses into
   * its tree in that session. This is what lets one numbering pass reach nested frames
   * without ever evaluating in a context that belongs to another document (R3).
   * @returns {Promise<object[]>} `{ frameId, url, sessionId }` per child frame.
   */
  async childFrameTargets () {
    const tree = await this.frameTree({ refresh: true })
    return tree
      .filter((frame) => frame.parentId !== null)
      .map((frame) => ({ frameId: frame.frameId, url: frame.url, sessionId: this.frames.get(frame.frameId) ?? null }))
  }

  /**
   * The isolated world of one frame, created on demand and reused until its document goes
   * away. `null` when Chrome will not give one (a detached or crashed frame).
   * @param {string|null} sessionId - the OOPIF target session, or null for the page session.
   * @param {string|null} frameId - the frame's own id; on an OOPIF session it is that target's
   *   root frame, the id Chrome requires there.
   */
  async isolatedWorld (sessionId, frameId) {
    const key = `${sessionId ?? ''}|${frameId ?? ''}`
    const cached = this.worlds.get(key)
    if (cached !== undefined) return cached
    const params = { worldName: 'dsh-ext-chrome-cdp' }
    if (frameId !== null) params.frameId = frameId
    try {
      const result = await this.connection.send('Page.createIsolatedWorld', params, 5_000, sessionId)
      const contextId = result?.executionContextId
      if (!Number.isInteger(contextId)) return null
      this.worlds.set(key, contextId)
      return contextId
    } catch (error) {
      this.worlds.delete(key)
      return null
    }
  }

  /** Evaluate one expression in one frame's isolated world, addressed by session and context. */
  evaluate (frame, expression, timeoutMs = 30_000) {
    const params = { expression, returnByValue: true, awaitPromise: true }
    if (frame.contextId !== undefined) params.contextId = frame.contextId
    return this.connection.send('Runtime.evaluate', params, timeoutMs, frame.sessionId)
  }

  /**
   * Note the tab's URL in every session that selected it; never creates a selection (R4).
   * Every selection is the session's own entry, so this cannot rewrite another session's
   * choice — only the URL of the tab they both selected.
   */
  noteUrl (url) {
    if (typeof url !== 'string' || url === '') return
    for (const [sessionId, binding] of this.plugin.bindings) {
      if (binding.targetId === this.target.id) this.plugin.bind(sessionId, this.target.id, url)
    }
  }

  /**
   * Whether a frame's own viewport is not the viewport its input is dispatched in, so its
   * element rect needs the immediate owner's content quad to reach that viewport (R3).
   *
   * A frame of the page session below the top document is such a frame. An OOPIF target is its
   * own root and the top document is the viewport the command is already sent on, so neither
   * needs this.
   * @param {string|null} frameId - the frame the point belongs to.
   * @param {string|null} sessionId - the session the point is dispatched on.
   * @returns {boolean} true when the owner's quad must map the point.
   */
  needsOwnerMapping (frameId, sessionId) {
    if (sessionId !== null && sessionId !== undefined) return false
    const frame = this.tree?.find((entry) => entry.frameId === frameId) ?? null
    return frame !== null && frame.parentId !== null
  }
}

/**
 * The CDP client one plugin instance owns: target discovery, the contract operations, and
 * the in-memory state of leases and tab bindings (R4 — the binding must survive the session
 * process only as long as the Host runs, which is exactly a Map here).
 */
export class ChromeCdp {
  /**
   * @param {object} options - plugin state.
   * @param {{url: string, host: string, port: number}} options.endpoint - validated endpoint.
   * @param {object} [options.logger] - line logger.
   * @param {Function} [options.fetch] - the HTTP transport (injected in tests); defaults to the
   *   platform's `fetch`. A test process is refused the owner's port by `installOwnerPortGuard`
   *   on whatever value arrives here, so no transport can reach port 40222 either.
   */
  constructor ({ endpoint, logger, fetch }) {
    this.endpoint = endpoint
    this.log = logger ?? (() => {})
    /**
     * The transport this client uses; a test injects its own, so no guard ever touches the
     * process-wide `fetch`.
     */
    this.fetch = typeof fetch === 'function' ? fetch : globalThis.fetch
    /** targetId → { sessionId, url, at } */
    this.bindings = new Map()
    /** sessionId → targetId (one current tab per session, R4) */
    this.byOwner = new Map()
    /** targetId → { sessionKey, at } (R4 lease) */
    this.leases = new Map()
    /** targetId → PageConnection */
    this.pages = new Map()
    /** targetId → tail of that target's operation queue */
    this.queues = new Map()
    this.controlConnection = undefined
    this.version = null
    this.lastError = null
  }

  // --- tab bindings and leases (R4) ---------------------------------------------------

  /**
   * The tab this session acts on, or undefined. The selection is the session's own map entry
   * and is never shared: selecting a tab here cannot unselect another session's tab.
   */
  bindingFor (sessionId) {
    if (typeof sessionId !== 'string') return undefined
    return this.bindings.get(sessionId)
  }

  /**
   * Note that a session uses a tab. The binding is the session's own selection (`sessionId →
   * { targetId, url }`) — never a record of who owns the tab's connection — so two sessions
   * may select one tab, and only the action lease decides who may type or click (R4).
   * @param {string} sessionId - whose selection this is.
   * @param {string} targetId - the tab it selects.
   * @param {string} [url] - the tab's URL when known.
   */
  bind (sessionId, targetId, url) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('a tab selection needs a session')
    this.byOwner.set(sessionId, targetId)
    this.bindings.set(sessionId, { sessionId, targetId, url: typeof url === 'string' ? url : '', at: Date.now() })
  }

  /** Drop exactly this session's selection; no other session's selection is touched. */
  unbind (sessionId) {
    this.byOwner.delete(sessionId)
    this.bindings.delete(sessionId)
  }

  /**
   * Lease the tab to this session for one action, or refuse when another session holds it
   * (R4: "tab in use by another session", never an interleaved click).
   *
   * The same session taking a lease it already holds is not a conflict, and every lease is
   * refreshed at its holder's next action, so "in use" and "refused" can never disagree.
   * @returns {string} the session key the lease was taken under.
   */
  lease (sessionId, targetId) {
    const key = `session:${String(sessionId)}`
    const now = Date.now()
    for (const [held, lease] of this.leases) if (now - lease.at >= LEASE_MS) this.leases.delete(held)
    const held = this.leases.get(targetId)
    if (held !== undefined && held.sessionKey !== key) {
      throw new Error(`target ${targetId} is in use by another session (tab in use by another session); it is released when that session has not acted on it for ${LEASE_MS / 1000} s`)
    }
    this.leases.set(targetId, { sessionKey: key, at: now })
    return key
  }

  /** Release the lease this session holds on a tab (its own, so no other session's lease is touched). */
  release (sessionId, targetId) {
    if (this.leases.get(targetId)?.sessionKey === `session:${String(sessionId)}`) this.leases.delete(targetId)
  }

  /**
   * Keep the lease this session holds, once one action is over (R4). A finished action does
   * not hand the tab to the next session at once: the lease lapses 60 s after the last action
   * (`touchIdle`), so two sessions alternating on one tab never bob it back and forth
   * mid-turn. A session that took no lease here gets none from this call.
   */
  renew (sessionId, targetId) {
    const key = `session:${String(sessionId)}`
    if (this.leases.get(targetId)?.sessionKey === key) this.leases.set(targetId, { sessionKey: key, at: Date.now() })
  }

  /**
   * Start the 60 s idle window of the lease this session holds (R4), whether or not this call
   * takes one itself: the fields the owner watches in the sidebar are actions too, so a
   * session reading its own tab keeps it; another session is told it is in use.
   */
  touchIdle (sessionId, targetId) {
    const key = `session:${String(sessionId)}`
    if (this.leases.get(targetId)?.sessionKey === key) this.leases.set(targetId, { sessionKey: key, at: Date.now() })
  }

  /**
   * Whether this session currently holds the tab's lease: every held lease is "in use", and a
   * stale one (60 s idle) is gone, so the answer and the refusal in `lease` cannot disagree.
   */
  isLeasedBy (sessionId, targetId) {
    const held = this.leases.get(targetId)
    if (held === undefined) return false
    if (Date.now() - held.at >= LEASE_MS) {
      this.leases.delete(targetId)
      return false
    }
    return held.sessionKey === `session:${String(sessionId)}`
  }

  // --- transport ----------------------------------------------------------------------

  /**
   * Answer one `/json/...` request from the Chrome HTTP endpoint.
   *
   * A redirect is refused rather than followed: discovery decides which WebSocket this plugin
   * opens, so a hop to another origin would be exactly the redirect R1 forbids. The body is
   * read as text and parsed here, so a browser's opaque redirect body cannot be mistaken for
   * an empty success either.
   * @param {string} path - `/json/version`, `/json/list`, `/json/new?<url>`, `/json/close/<id>`.
   * @param {string} [method] - HTTP method; `/json/new` needs PUT on Chrome 111+.
   */
  async http (path, method = 'GET') {
    try {
      // The client's own transport, never the process-wide global: a caller may inject one,
      // and no test guard has to rewrite `globalThis.fetch` to keep the suite hermetic.
      const response = await this.fetch(`${this.endpoint.url}${path}`, {
        method, redirect: 'manual', signal: AbortSignal.timeout(5_000), cache: 'no-store',
      })
      if (response.status >= 300 && response.status < 400) {
        throw new Error(`Chrome answered ${path} with a redirect (HTTP ${response.status}); discovery never follows one`)
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      if (text.trim() === '') throw new Error(`Chrome answered ${path} with an empty body`)
      return JSON.parse(text)
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      throw new Error(this.lastError)
    }
  }

  /** The browser's own identity, or a throw when nothing answers (R9 maps it). */
  async browserVersion () {
    const value = await this.http('/json/version')
    this.version = { browser: value?.Browser ?? 'unknown', protocol: value?.['Protocol-Version'] ?? 'unknown' }
    return this.version
  }

  /** Open pages as the sidebar and the tools list them, each with its checked socket. */
  async listTargets () {
    const list = await this.http('/json/list')
    return (Array.isArray(list) ? list : [])
      .filter((target) => target?.type === 'page' && typeof target.id === 'string' && typeof target.webSocketDebuggerUrl === 'string')
      .map((target) => ({ id: target.id, title: target.title ?? '', url: target.url ?? '', ws: assertLoopbackSocket(target.webSocketDebuggerUrl, this.endpoint) }))
  }

  /**
   * A connection to the browser itself, for tab management that no page owns.
   *
   * `/json/version` names the browser WebSocket, so discovery is two HTTP reads and no
   * page has to be opened — which is what makes `chrome_close_tab` able to close any
   * named tab, including one this session has no binding for.
   */
  async control () {
    if (this.controlConnection !== undefined && !this.controlConnection.closed) return this.controlConnection
    const value = await this.http('/json/version')
    this.version = { browser: value?.Browser ?? 'unknown', protocol: value?.['Protocol-Version'] ?? 'unknown' }
    const url = assertLoopbackSocket(value?.webSocketDebuggerUrl, this.endpoint)
    const connection = new Connection(url)
    try {
      await connection.ready
    } catch (error) {
      connection.close()
      throw new Error(`Chrome CDP refused the browser WebSocket at ${this.endpoint.url} (${String(error?.message ?? error)})`)
    }
    this.controlConnection = connection
    return connection
  }

  /**
   * The page connection for one target, or a throw when that target is gone (a binding is
   * verified before every action, R4).
   *
   * A connection is shared by whoever acts on the tab: an existing connection is reused if it
   * lives, and a dead one is reopened. The only exclusion is the *active* lease (R4) — while
   * session A holds its 60 s idle lease on a tab, session B gets "tab in use by another
   * session"; once that lease lapses (or is released) B shares the same live connection.
   * Sharing never destroys anyone's selection: opening the connection does not touch
   * `bindings`. A connection that died is reopened once, so a closed socket cannot lock
   * agents out. Opening is serialized per target, so two calls that arrive together open once.
   * @param {string} targetId - the target.
   * @param {{sessionId: string}} task - the calling session, recorded as a user.
   */
  async page (targetId, task) {
    const open = async () => {
      const caller = String(task.sessionId)
      const existing = this.pages.get(targetId)
      if (existing !== undefined) {
        if (existing.broken) {
          this.forget(targetId)
          throw new Error(`target ${targetId} is no longer usable: ${existing.crashed ?? 'the CDP connection closed'}`)
        }
        try {
          await existing.ready
        } catch (error) {
          this.forget(targetId)
          throw error
        }
        if (!existing.users.includes(caller)) existing.users.push(caller)
        existing.task = task
        return existing
      }
      const target = (await this.listTargets()).find((entry) => entry.id === targetId)
      if (target === undefined) throw new Error(`target ${targetId} no longer exists (was the tab closed?)`)
      const page = new PageConnection(this, { ...target, webSocketDebuggerUrl: target.ws }, { sessionId: caller })
      this.pages.set(targetId, page)
      try {
        await page.ready
      } catch (error) {
        this.forget(targetId)
        throw error
      }
      return page
    }
    return this.inOrder(targetId, open)
  }

  /**
   * Run one operation for a target after every earlier operation for it has settled.
   *
   * Two sessions may act on one tab only one after the other (R4), and the sidebar's own
   * forwarded input runs on the same queue, so a capture never interleaves with a click.
   * @param {string} targetId - the target.
   * @param {Function} operation - the work; receives nothing and may be async.
   */
  inOrder (targetId, operation) {
    const previous = this.queues.get(targetId) ?? Promise.resolve()
    const run = previous.then(operation, operation)
    const tail = run.then(() => {}, () => {})
    this.queues.set(targetId, tail)
    tail.then(() => { if (this.queues.get(targetId) === tail) this.queues.delete(targetId) })
    return run
  }

  /** Drop the in-memory state of one target: its page connection, queues and lease. */
  forget (targetId) {
    const page = this.pages.get(targetId)
    this.pages.delete(targetId)
    page?.connection.close()
    this.queues.delete(targetId)
    this.leases.delete(targetId)
    // A closed tab cannot be selected by anyone any more; every session's selection of it goes,
    // including the sidebar's, so no later request resolves against a tab that is gone.
    for (const [sessionId, selected] of this.bindings) if (selected.targetId === targetId) this.unbind(sessionId)
  }

  /** Close every connection this instance owns (plugin unload). */
  dispose () {
    for (const targetId of [...this.pages.keys()]) this.forget(targetId)
    this.controlConnection?.close()
    this.controlConnection = undefined
  }

  // --- page operations ----------------------------------------------------------------

  /**
   * Read the current page: title, URL and the numbered elements of the top document, every
   * same-process child frame and every OOPIF (R3).
   *
   * The pass is the Host's: `frameSessions` names every document with the session and isolated
   * context it lives in, this method evaluates the one per-document script in each of them,
   * and `numberSnapshot` merges the answers into one page-wide series that remembers which
   * frame, context and frame-local number each page-wide number came from.
   *
   * A snapshot belongs to the session that asked for it: its numbers are stored under that
   * session with a generation, so another session's read afterwards can never change what a
   * number means for the first one. A click or fill resolves only against its own session's
   * map, and refuses when that map is gone or older than the page it was taken from.
   * @param {object} page - page connection.
   * @param {{sessionId?: string}} [task] - the session the numbers belong to.
   * @param {{reuseMs?: number}} [options] - how long a document's numbering pass is reused.
   * @returns {Promise<object>} the merged read, with the identity other calls must quote.
   */
  async snapshot (page, task = {}, { reuseMs = 120_000 } = {}) {
    const sessionId = typeof task?.sessionId === 'string' && task.sessionId !== '' ? task.sessionId : page.owner
    // The whole pass belongs to one session and one document: the socket, the numbering and
    // the connection are the caller's, and a second session waits its turn on the same tab.
    return this.inOrder(page.target.id, async () => {
      const sessions = await page.frameSessions({ refresh: true })
      const visits = new Set()
      const frames = []
      const found = []
      for (const frame of sessions) {
        if (visits.has(`${frame.sessionId ?? ''}|${frame.frameId ?? ''}`)) continue
        visits.add(`${frame.sessionId ?? ''}|${frame.frameId ?? ''}`)
        const where = frame.kind === 'top' ? 'top document' : `${frame.kind} ${frame.url}`
        if (typeof frame.failed === 'string') {
          frames.push({ frame, kind: frame.kind, url: frame.url, failed: frame.failed, label: where, elements: [] })
          continue
        }
        try {
          const { result } = await page.evaluate(frame, snapshotExpression(reuseMs))
          const value = result?.value ?? null
          const elements = Array.isArray(value?.elements) ? value.elements : []
          // Each document's viewport is its own; never one another frame answered with.
          const viewport = frame.kind === 'top' && value?.viewport && typeof value.viewport === 'object' ? value.viewport : undefined
          const read = { frame, kind: frame.kind, url: value?.url || frame.url || '', title: frame.kind === 'top' ? (value?.title ?? '') : '', viewport, elements, label: where }
          frames.push(read)
          for (const element of elements) found.push({ element, frame, label: where })
        } catch (error) {
          // A frame Chrome cannot evaluate in (a detached or crashed renderer) is reported,
          // never silently dropped: the snapshot then says which part is missing.
          frames.push({ frame, kind: frame.kind, url: frame.url ?? '', failed: String(error?.message ?? error), label: where, elements: [] })
        }
      }
      const top = frames.find((entry) => entry.kind === 'top') ?? frames[0]
      const url = top?.url ?? page.target.url
      page.noteUrl(url)
      const numbered = numberSnapshot(found)
      for (const entry of frames) if (entry.failed === undefined) entry.elements = numbered.frames.get(entry.frame) ?? []
      // This pass becomes the session's current snapshot; the document it belongs to is part
      // of the identity, so a navigation between the read and the action refuses the number.
      page.generation += 1
      const index = new Map()
      for (const [number, entry] of numbered.index) index.set(number, { ...entry, sessionId })
      const document = page.document
      const generation = page.generation
      page.snapshots.set(sessionId, { sessionId, generation, document, index, at: Date.now() })
      return { frames, title: top?.title ?? '', url, total: numbered.total, unreliable: page.treeUnreliable, sessionId, generation }
    })
  }

  /**
   * The session's own current snapshot, or a refusal. Nothing is read here: a number that is
   * not in the caller's map is a stale number, never an invitation to re-read the page for it.
   * @param {object} page - page connection.
   * @param {object} task - `{ sessionId, generation? }` the action quotes.
   */
  currentSnapshot (page, task) {
    const sessionId = typeof task?.sessionId === 'string' && task.sessionId !== '' ? task.sessionId : page.owner
    const snap = page.snapshots.get(sessionId)
    if (snap === undefined) {
      throw new Error('stale snapshot: this session has no chrome_snapshot of this tab — take a new chrome_snapshot and use its numbers')
    }
    if (Number.isInteger(task?.generation) && task.generation !== snap.generation) {
      throw new Error(`stale snapshot: the numbers came from snapshot #${task.generation} but this session's current one is #${snap.generation} — take a new chrome_snapshot and use its numbers`)
    }
    if (snap.document !== page.document) {
      throw new Error('stale snapshot: the page navigated since chrome_snapshot printed these numbers — take a new chrome_snapshot and use its numbers')
    }
    return snap
  }

  /**
   * Resolve one element number to the frame it lives in and the viewport coordinate that
   * frame's layout gives it. Never a screen coordinate: the number is resolved in the page
   * itself, so scrolling, zoom and window position cannot make a click land elsewhere (R3).
   *
   * The page-wide number is only ever resolved in its own session's snapshot, and the
   * attribute it looks for is that frame's *local* number: two documents may both print
   * element 1, and each is found by its own `data-chrome-cdp-index`. A number from another
   * session's snapshot, or from a page that has since navigated, is refused as stale — the
   * call never takes a snapshot of its own for it.
   * @param {object} page - page connection.
   * @param {number} index - page-wide number from this session's snapshot.
   * @param {{allowPassword?: boolean, task?: object}} [options] - `false` refuses a password
   *   field (R8); `task` is the session (and generation) the number was quoted from.
   */
  async resolveElement (page, index, { allowPassword = true, task } = {}) {
    const snap = this.currentSnapshot(page, task)
    const known = snap.index.get(Number(index))
    if (known === undefined) {
      throw new Error(`stale snapshot: element [${index}] is not in this session's chrome_snapshot (which printed ${snap.index.size} number(s)) — take a new chrome_snapshot and use its numbers`)
    }
    if (page.treeUnreliable) {
      throw new Error(`element [${index}] cannot be trusted: two frames of ${page.target.id} reported the same id, so the read that printed it is ambiguous — run chrome_snapshot again`)
    }
    // The recorded frame and its own number, never a fresh lookup: the lookup runs in the
    // session and the isolated context the number was printed in, and in no other (R3).
    const local = Number.isInteger(known.localIndex) ? known.localIndex : Number(index)
    let rect
    try {
      // The frame's own dispatch session (an OOPIF target session, or none for the page
    // session), never the calling session: that string would be sent as a CDP session id.
    const { result } = await page.evaluate({ sessionId: known.frame.sessionId, contextId: known.contextId }, elementRectExpression(local), 10_000)
      rect = result?.value ?? null
    } catch (error) {
      throw new Error(`element [${index}] could not be resolved in ${known.label}: ${String(error?.message ?? error)}. Run chrome_snapshot again`)
    }
    if (rect === null) throw new Error(`element [${index}] is no longer on the page — run chrome_snapshot again`)
    if (!allowPassword && String(rect.type ?? '').toLowerCase() === 'password') {
      throw new Error(
        `element [${index}] is a password field, and chrome_fill does not type passwords (spec 035 R8). `
        + 'Fill it yourself in Chrome: the plugin never reads the password store, cookies or browser storage.',
      )
    }
    if (page.document !== snap.document) {
      throw new Error(`stale snapshot: element [${index}] moved to another document while it was being resolved — take a new chrome_snapshot`)
    }
    // `session` is the CDP session the input is dispatched on (null for the page session);
    // the calling session is only the identity of whose snapshot the number came from.
    return { ...rect, index: Number(index), session: known.frame.sessionId ?? null, contextId: known.contextId, frame: known.label, frameId: known.frameId, generation: snap.generation }
  }

  /**
   * Click one numbered element (R3: by number, never by screen coordinate).
   * @param {object} page - page connection.
   * @param {number} index - page-wide number from this session's snapshot.
   * @param {{double?: boolean, task?: object}} [options] - `task` is the session it acts for.
   * @returns {Promise<object>} the element that was clicked, for the result text.
   */
  async click (page, index, { double = false, task } = {}) {
    const hit = await this.resolveElement(page, index, { task })
    const session = hit.session
    const clickCount = double ? 2 : 1
    // The pointer move, each press and each release carry the isolated world the number was
    // resolved in, so a click inside a frame is dispatched there and never somewhere else.
    const where = [{ type: 'mouseMoved', x: hit.x, y: hit.y }]
    for (let count = 1; count <= clickCount; count++) {
      const button = { x: hit.x, y: hit.y, button: 'left', clickCount: count, buttons: 1 }
      where.push({ type: 'mousePressed', ...button })
      where.push({ type: 'mouseReleased', ...button, buttons: 0 })
    }
    for (const params of where) {
      // A nested same-process frame's rect is relative to that frame's own viewport: the
      // host translates it into the viewport the input is dispatched in (R3).
      const point = await this.toDispatchSpace(page, hit, params.x, params.y)
      await page.connection.send('Input.dispatchMouseEvent', { ...params, x: point.x, y: point.y }, 10_000, session, hit.contextId)
    }
    const center = await this.toDispatchSpace(page, hit, hit.x, hit.y)
    return { ...hit, x: center.x, y: center.y }
  }

  /**
   * Translate a point a frame's own layout gave into the viewport the input is dispatched in.
   *
   * Chrome's `Input.dispatch*` coordinates are the viewport of the session the command is sent
   * on. A rect from a same-process child frame is in that child's own viewport, and Chrome
   * measures same-process box-model quads against the root document, so the point maps through
   * the immediate owner's content quad: `root = content corner + local × (content size /
   * child's viewport size)`. The child's viewport size is the `innerWidth`/`innerHeight` the
   * element lookup read in that document, so a CSS scale or zoom on the owner is folded in
   * without being guessed, and nothing from an outer level is carried: the quad is already in
   * the dispatch viewport's coordinates. The owner is never guessed from the DOM:
   * `DOM.getFrameOwner` names the exact owner element of the frame id. A rotated or skewed
   * owner, or one Chrome will not name or measure, makes the action refuse rather than click
   * the wrong place.
   * @param {object} page - page connection.
   * @param {object} hit - the resolved element, with its frame id, dispatch session and the
   *   viewport size of the document it lives in (`innerWidth`/`innerHeight`).
   * @param {number} x - the point in the frame's own viewport.
   * @param {number} y - the same on the vertical axis.
   * @returns {Promise<{x: number, y: number}>} the point in the dispatch viewport.
   */
  async toDispatchSpace (page, hit, x, y) {
    // The element's own viewport and the dispatch viewport are one viewport for a root
    // document and for an OOPIF target; only a same-process frame needs its owner's quad.
    if (!page.needsOwnerMapping(hit.frameId, hit.session)) return { x: Number(x), y: Number(y) }
    const width = Number(hit.innerWidth)
    const height = Number(hit.innerHeight)
    const refuse = (reason) => new Error(`the frame owner of ${hit.frame} ${reason}; this action is refused rather than clicked at the wrong place`)
    if (!(width > 0) || !(height > 0)) throw refuse('sits in a document whose viewport Chrome did not report')
    let owner
    try {
      const named = await page.connection.send('DOM.getFrameOwner', { frameId: hit.frameId }, 10_000, hit.session)
      if (!Number.isInteger(named?.backendNodeId)) throw new Error('Chrome named no owner element')
      owner = named.backendNodeId
    } catch (error) {
      throw refuse(`could not be measured (${String(error?.message ?? error)})`)
    }
    let model
    try {
      model = (await page.connection.send('DOM.getBoxModel', { backendNodeId: owner }, 10_000, hit.session))?.model
    } catch (error) {
      throw refuse(`could not be measured (${String(error?.message ?? error)})`)
    }
    if (model !== null && typeof model === 'object') page.boxModels = (page.boxModels ?? []).concat([{ ...model }])
    // The immediate owner's content quad — inside its border and padding, by the replaced-element
    // model where the child document is laid out — and root-relative, so its corner is where the
    // child's own 0,0 sits in the viewport the input is sent on. Nothing from an outer level is
    // added: the quad is already in that viewport's coordinates.
    const content = Array.isArray(model?.content) ? model.content.map(Number) : []
    if (content.length < 8 || !content.every(Number.isFinite)) throw refuse('was not found in its parent document')
    const [x0, y0, x1, y1, , , x3, y3] = content
    // An axis-aligned box runs along its own edges; any tilt is a rotation whose corner is no
    // longer where the child's viewport origin is.
    if (Math.abs(y1 - y0) > 0.5 || Math.abs(x3 - x0) > 0.5) {
      throw refuse('is rotated or skewed, so its content box has no axis-aligned origin')
    }
    const quadWidth = Math.hypot(x1 - x0, y1 - y0)
    const quadHeight = Math.hypot(x3 - x0, y3 - y0)
    if (!(quadWidth > 0) || !(quadHeight > 0)) throw refuse('has no measurable content box')
    return { x: x0 + Number(x) * (quadWidth / width), y: y0 + Number(y) * (quadHeight / height) }
  }

  /**
   * Type into one numbered element: focus it, optionally select what is there, then insert
   * the text as one `Input.insertText` (the page sees one input event, which is what React
   * and Vue bind to). A password field is refused before anything is typed (R8).
   * @param {object} page - page connection.
   * @param {number} index - page-wide number from this session's snapshot.
   * @param {string} text - what to type.
   * @param {{replace?: boolean, task?: object}} [options] - `task` is the calling session (and
   *   generation): without it the number would resolve against the connection owner's map.
   */
  async fill (page, index, text, { replace = false, task } = {}) {
    const hit = await this.resolveElement(page, index, { allowPassword: false, task })
    // The click repeats the lookup by the same page-wide number, so the focus goes to the same
    // element and its release lands back in this frame.
    await this.click(page, index, { task })
    if (replace) {
      await page.connection.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
      }, 10_000, hit.session)
      await page.connection.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
      }, 10_000, hit.session)
    }
    await page.connection.send('Input.insertText', { text }, 10_000, hit.session)
    return hit
  }

  /**
   * Press one key in the page: a full keyDown/keyUp pair, so forms behave as with a keyboard.
   * @param {object} page - page connection.
   * @param {object} key - a `KEYS` entry.
   * @param {{session?: string|null, contextId?: number|null}} [where] - the frame the key goes
   *   to; with neither, the tab's focused frame.
   */
  async press (page, { key, code, keyCode }, where = {}) {
    for (const type of ['keyDown', 'keyUp']) {
      await page.connection.send('Input.dispatchKeyEvent', {
        type, key, code, windowsVirtualKeyCode: keyCode, text: type === 'keyDown' && key.length === 1 ? key : undefined,
      }, 10_000, where.session ?? null, where.contextId ?? null)
    }
  }

  /**
   * JPEG screenshot of the bound tab's viewport (the sidebar relaying the same call). It runs
   * on the target's operation queue, so it never interleaves with a click or a key.
   */
  async screenshot (page, { quality = 70 } = {}) {
    return this.inOrder(page.target.id, async () => {
      const { data } = await page.connection.send('Page.captureScreenshot', { format: 'jpeg', quality })
      return data
    })
  }

  /** Navigate the bound tab; the frame tree is re-read on the next snapshot. */
  async navigate (page, url) {
    const result = await page.connection.send('Page.navigate', { url })
    if (typeof result?.errorText === 'string' && result.errorText !== '') {
      throw new Error(`Chrome refused to load ${url}: ${result.errorText}`)
    }
    await sleep(200)
  }

  /** Back, forward or reload through the page's own history; null when there is nowhere to go. */
  async history (page, action) {
    if (action === 'reload') {
      await page.connection.send('Page.reload', {})
      await sleep(300)
      return true
    }
    const navigation = await page.connection.send('Page.getNavigationHistory')
    const entries = Array.isArray(navigation?.entries) ? navigation.entries : []
    const current = Number(navigation?.currentIndex ?? 0)
    const next = action === 'back' ? entries[current - 1] : entries[current + 1]
    if (next === undefined) return null
    await page.connection.send('Page.navigateToHistoryEntry', { entryId: next.id })
    await sleep(200)
    return true
  }

  /**
   * Open a tab. `/json/new` is the one way to create a tab without a page connection, and
   * Chrome 111+ wants it as PUT.
   */
  async openTab (url) {
    const target = await this.http(`/json/new?${encodeURIComponent(url)}`, 'PUT')
    if (typeof target?.id !== 'string') throw new Error('Chrome did not return the new tab')
    return { id: target.id, url: target.url ?? url, title: target.title ?? '' }
  }

  /**
   * Close exactly the named target (R5). The model names the tab, so the lease rule does not
   * apply: a stuck session must not make an explicitly named tab impossible to close.
   */
  async closeTab (targetId) {
    const control = await this.control()
    const result = await control.send('Target.closeTarget', { targetId })
    if (result?.success === false) throw new Error(`Chrome refused to close target ${targetId}`)
    this.forget(targetId)
  }
}
