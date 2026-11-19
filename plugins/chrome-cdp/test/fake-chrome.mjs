/**
 * A fake Chrome: the four `/json/...` reads the plugin makes, a browser WebSocket, and one
 * page WebSocket per target, all speaking the real CDP JSON-RPC framing.
 *
 * Nothing here reaches a browser: the point is that the production transport — HTTP
 * discovery, the flattened session framing, `Runtime.evaluate`, `Input.dispatch*` — runs
 * exactly as it will against Chrome, so the specs pin behaviour rather than a mock of it.
 */
import http from 'node:http'
import { createHash } from 'node:crypto'
import { runInDocument, element, documentOf } from './fixture-dom.mjs'

/** A 1x1 JPEG, so a screenshot byte path can be exercised without a real page. */
export const TINY_JPEG = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=='

/**
 * Start one fake Chrome.
 * @param {object} [options] - test inputs.
 * @param {object[]} [options.targets] - pages; each { id, title, url, frames?, document? }.
 * @param {string[]} [options.frameUrls] - OOPIF urls the first page attaches once.
 * @param {Function} [options.createTarget] - opt-in tab creation; without it `/json/new` refuses,
 *   so a suite that ever pointed at a live Chrome could not open a window on the owner's desktop.
 * @param {string[]} [options.unreadableFrames] - frame ids whose isolated world Chrome refuses,
 *   as a detached renderer would.
 * @param {Function} [options.resumeFails] - a session id the debugger refuses to resume.
 * @param {object[]} [options.childFrames] - same-process child frames; each
 *   `{ id, url, parentId?, content?, contentWidth?, contentHeight?, border?, padding?, margin?,
 *   rotated?, document? }`: `content` is the owner's content corner in the ROOT document
 *   (default `{ x: 0, y: 0 }`), as Chrome measures same-process box-model quads, and
 *   `contentWidth`/`contentHeight` the content box's size. A frame's content box is the size of
 *   the document it hosts, so a CSS-scaled owner gives its child a smaller viewport than the
 *   box. `border`, `padding` and `margin` are the CSS edges OUTSIDE the content box, so the
 *   border quad starts that much further up and left than the content quad (default all 0).
 *   `document` is the document that frame hosts (see `frameDocument` of
 *   `test/fixture-dom.mjs`); without one it is empty, and a page's `document` is what the
 *   fixture gives it. `rotated` reports a content quad that is no longer axis-aligned.
 * @returns {Promise<object>} the fake's handles and recorded calls.
 */
async function startFake ({ targets = [], frameUrls = [], createTarget, redirects, socketUrl, socketPort, childFrames = [], resumeFails, unreadableFrames = [] } = {}) {
  // `childFrames` (and any `document` inside it) may be a LIST or a FUNCTION OF THE PAGE that a
  // test fills in at any time, so a multi-tab fixture can give each tab its own frames without
  // touching the fake afterwards. `undefined` or `null` means no same-process child frame
  // (a test that clears its fixture says null rather than leaving the key behind).
  const framesOf = (page) => {
    const source = typeof childFrames === 'function' ? childFrames(page) : childFrames
    const list = Array.isArray(source) ? source : []
    return list.filter((frame) => frame !== null && typeof frame === 'object')
  }
  // The page's own document, when the fixture gives one: a list of elements, a document to read,
  // or a function of the page returning either. `undefined` or `null` leaves the frame model to
  // answer the reads.
  const documentOfPage = (page) => {
    const source = page.document
    const resolved = typeof source === 'function' ? source() : source
    if (resolved === null || resolved === undefined) return undefined
    return Array.isArray(resolved) ? documentOf(resolved, page.url) : resolved
  }
  const state = {
    document: undefined,
    pages: targets.map((target) => ({
      ...target,
      frames: (target.frames ?? []),
      sessionCounter: 0,
      attachedFrames: false,
      listening: false,
    })),
    calls: [],
    browserCalls: [],
    closed: [],
    sockets: new Set(),
    version: { Browser: 'Chrome/157.0.0.0 (fake)', 'Protocol-Version': '1.3' },
    expressionAnswer: null,
    /** A document (or a function of context id → document) the REAL script runs in. */
    document: undefined,
    /** Every sessionId a client put on the wire with a type other than string. */
    badSessions: [],
    /** Page.createIsolatedWorld calls that left the required frameId out, as Chrome refuses them. */
    badWorldCalls: [],
    /** Page.createIsolatedWorld calls, in order. */
    worldCalls: [],
    /** keyed `${sessionId}|${frameId}` → executionContextId, as Chrome numbers them per target. */
    worlds: new Map(),
    /** executionContextId → the frame id (and session) that world belongs to. */
    worldFrames: new Map(),
    /** Every Runtime.evaluate: which session, which context, and the expression. */
    evaluations: [],
    /** Every DOM.getFrameOwner / DOM.getBoxModel, in order. */
    domCalls: [],
  }

  // The frame model of each page: one owner element per same-process child frame — the iframe
  // `DOM.getFrameOwner` names — and the document each frame's own scripts read.
  let nextBackendNodeId = 100
  const pageOf = (id) => state.pages.find((entry) => entry.id === id)
  const modelOf = (page) => page?.model ?? { frameById: new Map() }
  for (const page of state.pages) page.model = frameModel(page)
  /** Build one page's frame model from the frames the fixture gives that page. */
  function frameModel (page) {
    const frameById = new Map(framesOf(page).map((spec) => [spec.id, spec]))
    const quad = (box) => [box.x, box.y, box.x + box.width, box.y, box.x + box.width, box.y + box.height, box.x, box.y + box.height]
    for (const spec of frameById.values()) {
      // The box's content size is its own; the document the frame hosts says how big the child's
      // viewport is, which is what a CSS scale makes differ from the box.
      const hosted = spec.document ?? documentOf([], spec.url ?? 'about:blank')
      const width = spec.contentWidth ?? hosted.viewport?.w ?? 600
      const height = spec.contentHeight ?? hosted.viewport?.h ?? 400
      const left = spec.content?.x ?? 0
      const top = spec.content?.y ?? 0
      const padding = spec.padding ?? 0
      const border = spec.border ?? 0
      const margin = spec.margin ?? 0
      const inner = { x: left - padding, y: top - padding, width: width + 2 * padding, height: height + 2 * padding }
      const outer = { x: inner.x - border, y: inner.y - border, width: inner.width + 2 * border, height: inner.height + 2 * border }
      const far = { x: outer.x - margin, y: outer.y - margin, width: outer.width + 2 * margin, height: outer.height + 2 * margin }
      // Quads are ROOT-relative, as Chrome reports them for same-process nodes, and the content
      // quad is the one that places the child's own 0,0. A rotated owner's is not axis-aligned:
      // its second corner runs along the bottom edge instead of the top one.
      const content = spec.rotated === true
        ? [left, top, left - height, top + width, left - height + width, top + width + height, left + width, top + height]
        : quad({ x: left, y: top, width, height })
      spec.owner = element({ tag: 'iframe' })
      spec.owner.backendNodeId = nextBackendNodeId++
      spec.owner.quads = { content, padding: quad(inner), border: quad(outer), margin: quad(far) }
      spec.own = hosted
    }
    return { frameById }
  }
  /**
   * How one frame's page-side read is answered: the page's own document when the fixture gives
   * one, else the document that frame hosts (the page's, for the root frame).
   */
  const fixtureOf = (pageId, frameId) => {
    const page = pageOf(pageId)
    const own = documentOfPage(page)
    if (own !== undefined) return own
    const frame = modelOf(page).frameById.get(frameId)
    if (frame !== undefined) return frame.own
    return frameId === `${pageId}-main` ? documentOf([], page.url) : undefined
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    // The port is known once the server listens; handlers run after that.
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    state.calls.push({ method: req.method, path: url.pathname, search: url.search })
    const port = server.address().port
    // A test can make discovery lie: one hop to another origin, a socket elsewhere, or both.
    if (redirects) {
      res.writeHead(redirects.status, { location: redirects.location })
      return res.end()
    }
    if (url.pathname === '/json/version') return json(200, { ...state.version, webSocketDebuggerUrl: socketUrl ?? `ws://127.0.0.1:${port}/devtools/browser/fake` })
    if (url.pathname === '/json/list') {
      return json(200, state.pages.map((page) => ({
        id: page.id, type: 'page', title: page.title, url: page.url,
        webSocketDebuggerUrl: socketUrl ?? `ws://127.0.0.1:${socketPort ?? port}/devtools/page/${page.id}`,
      })))
    }
    if (url.pathname === '/json/new') {
      // A tab this fake creates is refused unless the test opted in, so running the suite
      // against a live Chrome can never open a window on the owner's desktop.
      if (createTarget === undefined) return json(201, { error: 'this fake opens no tab (pass createTarget to allow it)' })
      if (req.method !== 'PUT') return json(405, { error: '/json/new needs PUT' })
      const created = createTarget(url.searchParams.toString())
      const page = { ...created, frames: [], sessionCounter: 0, attachedFrames: false }
      page.model = frameModel(page)
      state.pages.push(page)
      return json(200, { id: page.id, type: 'page', title: page.title, url: page.url, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${page.id}` })
    }
    return json(404, { error: `no route ${url.pathname}` })
  })

  server.on('upgrade', (req, socket, head) => {
    void head
    const key = req.headers['sec-websocket-key']
    const accept = acceptDigest(key)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
    state.sockets.add(socket)
    const path = req.url.split('?')[0]
    const pageId = path.startsWith('/devtools/page/') ? path.slice('/devtools/page/'.length) : null
    // Everything this socket does is serialized on one chain: two commands arriving in the same
    // chunk (the flattening session's resume beside the page's own first read, say) must not race,
    // and a late answer to an earlier command must never be dropped.
    let chain = Promise.resolve()
    const enqueue = (task) => { chain = chain.then(task).catch(() => {}) }

    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const frame = readFrame(buffer)
        if (frame === null) break
        buffer = buffer.subarray(frame.length)
        if (frame.opcode === 8) { socket.end(); continue }
        if (frame.opcode !== 1) continue
        let message
        try {
          message = JSON.parse(frame.payload.toString('utf8'))
        } catch {
          continue
        }
        enqueue(() => handle(message, pageId, (value) => writeFrame(socket, JSON.stringify(value))))
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => state.sockets.delete(socket))
    // The browser socket leaves silently: a client that never closes it must not hold the
    // suite's process open (chrome_close_tab keeps its connection for the next call).
    if (pageId === null) { state.browserSocket = socket; socket.unref() }
    // A client that insists on the target itself gets `socketUrl` on its way out, for the test
    // that pins discovery's own check.
    if (socketUrl !== undefined) { socket.destroy(); state.sockets.delete(socket); return }
  })

  /** Answer one CDP command; the recorded call list is what the specs assert on. */
  async function handle (message, pageId, reply) {
    const { id, method, params, sessionId } = message
    // The wire carries a session id as a string or not at all. Anything else is a client bug,
    // and this fake answers it the way Chrome does: an error naming the type.
    if (sessionId !== undefined && typeof sessionId !== 'string') {
      state.badSessions.push({ method, sessionId: Array.isArray(sessionId) ? '[array]' : typeof sessionId })
      return reply({ id, error: { code: -32602, message: `Invalid sessionId: expected a string, got ${Array.isArray(sessionId) ? 'array' : typeof sessionId}` } })
    }
    // A mock can ask for an answer that is not there (`Math.random` pinned by another test
    // once made the client pass mocks to Node's own WebSocket); say so instead of crashing.
    if (typeof reply !== 'function') return
    const page = pageId === null ? undefined : state.pages.find((entry) => entry.id === pageId)
    if (page === undefined) {
      state.browserCalls.push({ method, params })
      if (method === 'Target.closeTarget') {
        const index = state.pages.findIndex((entry) => entry.id === params.targetId)
        // Chrome closes the tab's socket; the fake answers success either way.
        if (index >= 0) state.pages.splice(index, 1)
        state.closed.push(params.targetId)
        return reply({ id, result: { success: index >= 0 } })
      }
      return reply({ id, result: {} })
    }
    state[pageId] ??= []
    state[pageId].push({ method, params, sessionId: sessionId ?? null })
    if (method === 'Target.setAutoAttach') {
      reply({ id, result: {} })
      if (params.autoAttach && !page.attachedFrames) {
        page.attachedFrames = true
        for (const frame of frameUrls) {
          const session = `S${++page.sessionCounter}`
          reply({ method: 'Target.attachedToTarget', params: { sessionId: session, targetInfo: { targetId: `frame-${session}`, type: 'iframe', url: frame }, waitingForDebugger: true } })
        }
      }
      return
    }
    if (method === 'Runtime.runIfWaitingForDebugger') {
      if (typeof resumeFails === 'function' && resumeFails(sessionId)) {
        return reply({ id, error: { code: -32000, message: 'Cannot resume: the frame is gone' } })
      }
      return reply({ id, result: {} })
    }
    if (method === 'Page.getFrameTree') {
      // On an OOPIF session the tree is that target's own: its root frame is the frame it is.
      if (sessionId !== null && sessionId !== undefined) {
        const target = `frame-${sessionId}`
        return reply({ id, result: { frameTree: { frame: { id: target, url: page.url, loaderId: `L-${sessionId}` }, childFrames: [] } } })
      }
      // The top document is a frame of the page session; same-process children ride along when
      // the frame model has them, each with its own URL, nested by `parentId` exactly as Chrome
      // reports a frame inside a frame.
      const nodes = new Map()
      for (const spec of modelOf(page).frameById.values()) {
        const parentId = typeof spec.parentId === 'string' ? spec.parentId : `${pageId}-main`
        nodes.set(spec.id, { frame: { id: spec.id, parentId, url: spec.url ?? 'about:blank', loaderId: `L-${spec.id}` }, childFrames: [] })
      }
      const top = { frame: { id: `${pageId}-main`, url: page.url, loaderId: 'L0' }, childFrames: [] }
      for (const node of nodes.values()) (nodes.get(node.frame.parentId)?.childFrames ?? top.childFrames).push(node)
      return reply({ id, result: { frameTree: top } })
    }
    if (method === 'Page.createIsolatedWorld') {
      // The frame id is required, exactly as Chrome requires it.
      if (typeof params?.frameId !== 'string' || params.frameId === '') {
        state.badWorldCalls.push({ sessionId: sessionId ?? null, params })
        return reply({ id, error: { code: -32602, message: 'Invalid parameters: Failed to deserialize params.frameId - required property frameId is missing' } })
      }
      // A frame a test marks unreadable gives no world, as a detached renderer would.
      if (unreadableFrames.includes(params.frameId)) {
        return reply({ id, error: { code: -32000, message: 'No frame for given id' } })
      }
      const key = `${sessionId ?? ''}|${params.frameId}`
      const contextId = state.worlds.size + 1
      state.worlds.set(key, contextId)
      // A world can only run page-side code against a document: the frame's own, or, for an OOPIF
      // session, the page's. A frame with none of either answers as a plain fixture object.
      const pageSide = sessionId !== null && sessionId !== undefined
        ? (documentOfPage(page) ?? documentOf([], page.url))
        : fixtureOf(pageId, params.frameId)
      state.worldFrames.set(contextId, { frameId: params.frameId, sessionId: sessionId ?? null, pageSide })
      state.worldCalls.push({ method, sessionId: sessionId ?? null, frameId: params.frameId, contextId })
      return reply({ id, result: { executionContextId: contextId } })
    }
    if (method === 'Page.enable' || method === 'Page.setLifecycleEventsEnabled') return reply({ id, result: {} })
    if (method === 'DOM.getFrameOwner') {
      state.domCalls.push({ method, sessionId: sessionId ?? null, params })
      const owner = modelOf(page).frameById.get(params?.frameId)?.owner
      // Chrome names the owner of a frame its page knows, in whichever tree named it; a frame
      // with no modeled owner is a refusal, exactly as Chrome answers a frame it never saw.
      if (owner === undefined) return reply({ id, error: { code: -32000, message: 'Frame with the given id was not found.' } })
      return reply({ id, result: { backendNodeId: owner.backendNodeId, nodeId: owner.backendNodeId, nodeType: 1, localName: 'iframe' } })
    }
    if (method === 'DOM.getBoxModel') {
      state.domCalls.push({ method, sessionId: sessionId ?? null, params })
      let owner
      for (const spec of modelOf(page).frameById.values()) if (spec.owner.backendNodeId === params?.backendNodeId) owner = spec.owner
      if (owner === undefined) return reply({ id, error: { code: -32000, message: 'Could not compute box model.' } })
      // The four boxes are mutually exclusive by construction (no edges shared between them):
      // the content box is where the child document is laid out, and the padding, border and
      // margin boxes wrap it, so the corners differ whenever a border or padding is set.
      const { content, padding, border, margin } = owner.quads
      return reply({ id, result: { model: { content, padding, border, margin, width: content[2] - content[0], height: content[5] - content[1] } } })
    }
    if (method === 'Runtime.evaluate') {
      state.evaluations.push({ sessionId: sessionId ?? null, contextId: params.contextId ?? null, expression: params.expression })
      // The page-side reads are the snapshot script (`function …`) and the element lookup
      // (an arrow expression); neither is the plugin's own read of a window's size. A test that
      // sets an answer speaks for the page, and a test that sets a document runs the REAL
      // script in it, so a made-up element number can never mask a defect in the production
      // code. Every page-side read is answered in the document OF THE FRAME IT RAN IN, so the
      // lookup reads the very element the snapshot numbered.
      const expression = String(params.expression ?? '')
      const isViewport = /\{ innerWidth, innerHeight \}/.test(expression)
      const isPageSide = expression.includes('function') || expression.includes('data-chrome-cdp-index=')
      const contextId = params.contextId ?? null
      const frame = contextId === null ? null : (state.worldFrames.get(contextId) ?? null)
      // `expressionAnswer` is armed when the fixture assigns a FUNCTION. A frame that clears
      // its own answer says null (reviewer round 2 does), and that must never speak for the
      // page: the frame's document is what answers then.
      const answer = typeof state.expressionAnswer === 'function' ? state.expressionAnswer : null
      if (answer !== null) {
        const value = await answer(expression, { page, sessionId: sessionId ?? null, contextId, frame })
        return reply({ id, result: { result: { type: 'object', value: JSON.parse(JSON.stringify(value)) } } })
      }
      // A frame with no page-side document of its own answers with its own fixture object.
      if (isPageSide && frame !== null && frame.pageSide !== undefined) {
        const document = fixtureOf(pageId, frame.frameId)
        if (document !== undefined) {
          const value = await runInDocument(document, expression)
          return reply({ id, result: { result: { type: 'object', value: JSON.parse(JSON.stringify(value)) } } })
        }
      }
      if (isViewport) return reply({ id, result: { result: { type: 'object', value: { innerWidth: 800, innerHeight: 600 } } } })
      if (expression.includes('data-chrome-cdp-index=')) return reply({ id, result: { result: { type: 'object', value: null } } })
      if (expression.includes('function')) return reply({ id, result: { result: { type: 'object', value: { title: page.title, url: page.url, viewport: { w: 800, h: 600 }, elements: [] } } } })
      return reply({ id, result: { result: { type: 'object', value: { title: page.title, url: page.url, viewport: { w: 800, h: 600 }, elements: [{ index: 1, tag: 'a', label: 'Example', href: '/x' }] } } } })
    }
    if (method === 'Page.captureScreenshot') return reply({ id, result: { data: page.screenshot ?? TINY_JPEG } })
    if (method === 'Page.navigate') {
      page.url = params.url
      return reply({ id, result: { frameId: `${pageId}-main` } })
    }
    if (method === 'Page.getNavigationHistory') return reply({ id, result: { currentIndex: 1, entries: [{ id: 1, url: 'https://a.example/' }, { id: 2, url: page.url }] } })
    if (method === 'Page.navigateToHistoryEntry') return reply({ id, result: {} })
    if (method === 'Page.reload') return reply({ id, result: {} })
    return reply({ id, result: {} })
  }

  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: async () => {
      for (const socket of state.sockets) socket.destroy()
      await new Promise((done) => server.close(done))
    },
  }
}

/**
 * Start one fake Chrome.
 * @param {object} [options] - test inputs.
 * @param {object[]} [options.targets] - pages; each { id, title, url }.
 * @param {string[]} [options.frameUrls] - OOPIF urls the first page attaches once.
 * @param {Function} [options.createTarget] - opt-in tab creation; without it `/json/new` refuses,
 *   so a suite that ever points at a live Chrome cannot open a window on the owner's desktop.
 * @returns {Promise<object>} the fake's handles and recorded calls.
 */
export async function startFakeChrome (options) {
  return startFake(options)
}

/** A WebSocket accept digest, as RFC 6455 defines it. */
function acceptDigest (key) {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
}

/** Decode one client frame (masked, as browsers send them). */
function readFrame (buffer) {
  if (buffer.length < 2) return null
  const first = buffer[0]
  const second = buffer[1]
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskLength = masked ? 4 : 0
  if (buffer.length < offset + maskLength + length) return null
  const mask = masked ? buffer.subarray(offset, offset + 4) : null
  const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length))
  if (mask !== null) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
  return { opcode, payload, length: offset + maskLength + length }
}

/** Send one unmasked server frame. */
function writeFrame (socket, text) {
  const payload = Buffer.from(text, 'utf8')
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  if (!socket.destroyed) socket.write(Buffer.concat([header, payload]))
}
