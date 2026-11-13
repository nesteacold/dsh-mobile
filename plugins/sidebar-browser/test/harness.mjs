/**
 * Test harness: a fake Cordis context, fake HTTP request/response objects, and a fake
 * "app window" that speaks the real bridge protocol (poll -> run -> reply).
 *
 * Nothing here reaches DSH; the point is that the production code paths — route
 * authorization, the secret handshake, the tool gate — run exactly as they will in a
 * Host, so the specs pin behaviour rather than a mock of it.
 */
import { Readable, Writable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, __internals } from '../lib/index.js'

/** Every DOM hook present, as on DSH 0.2.2-rc.1. */
export const FULL_HOOKS = { frame: true, frameKind: 'webview', dockTab: true, rightToggle: true }

/** A 1x1 PNG, so the screenshot path can be exercised without a real page. */
export const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/**
 * Apply the plugin against a fake Host.
 * @param {object} options - test inputs.
 * @param {object} [options.config] - plugin config (merged over the test defaults).
 * @param {object} [options.remoteSessionScope] - a stub C6 service.
 * @param {object} [options.remoteBrowser] - a stub `remoteBrowser` service (spec 016).
 * @param {object} [options.permissionPresets] - a stub native preset service.
 * @param {object} [options.sandboxPolicy] - a stub native sandbox-policy service.
 * @param {{host: string, port: number|null}} [options.webServer] - this Host's own listener,
 *   as `dsh-host-webserver` reports it (M3 refuses it as a navigation target).
 */
export function createHost ({
  config = {},
  remoteSessionScope,
  remoteBrowser,
  permissionPresets,
  sandboxPolicy,
  webServer = { host: '127.0.0.1', port: 3080 },
} = {}) {
  const tools = new Map()
  const routes = new Map()
  const injections = []
  const preExecute = []
  const warned = []
  const services = { remoteSessionScope, remoteBrowser, permissionPresets, sandboxPolicy }

  const webServerService = {
    host: webServer?.host,
    port: webServer?.port,
    register: (route) => {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  services.webServer = webServerService

  const ctx = {
    logger: { warn: (line) => warned.push(line) },
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    get: (key) => services[key],
    on: (event, handler) => {
      if (event === 'webserver/index-inject') injections.push(handler)
      if (event === 'tools/pre-execute') preExecute.push(handler)
    },
    effect: (fn) => fn(),
    inject: (names, callback) => {
      if (names.includes('webServer')) {
        callback({ webServer: webServerService, effect: (fn) => fn() })
      }
    },
  }

  apply(ctx, {
    dataDir: '',
    grantedScopes: ['browser:control'],
    tab: '',
    ...config,
  })

  const poll = routes.get(`${__internals.BRIDGE_PREFIX}/poll`)
  const reply = routes.get(`${__internals.BRIDGE_PREFIX}/reply`)

  /** Rows the host would render into the page for this peer. */
  const collectInjections = (peer = { principal: { kind: 'owner' } }) => {
    const table = []
    for (const handler of injections) handler(table, peer)
    return table
  }

  /** The secret exactly as the client half would read it: from the injected global row. */
  const bridgeSecret = (peer) => {
    const row = collectInjections(peer).find((entry) => entry.kind === 'global' && entry.name === __internals.GLOBAL_KEY)
    return row?.value?.secret ?? null
  }

  /**
   * Resolve the `tools/pre-execute` decision the way the tools pipeline does: each
   * listener may return a decision or delegate with `next()`, and the first decision wins.
   * `next()` here stands for "every later listener allows", so a delegation reads `allow`.
   */
  const riskDecision = async (exec) => {
    const next = () => Promise.resolve({ kind: 'allow' })
    for (const listener of preExecute) {
      const decision = await listener(exec, next)
      if (decision !== undefined) return decision
    }
    return { kind: 'allow' }
  }

  return { ctx, tools, routes, poll, reply, collectInjections, bridgeSecret, riskDecision, warned, services }
}

/** A fake `node:http` request carrying a JSON body. */
function fakeRequest ({ body = {}, headers = {}, method = 'POST', remoteAddress = '127.0.0.1' } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = headers
  req.socket = { remoteAddress }
  req.destroy = () => {}
  return req
}

/** A fake `node:http` response that records status and JSON body. */
function fakeResponse () {
  const chunks = []
  const res = new Writable({
    write: (chunk, _encoding, done) => { chunks.push(chunk); done() },
  })
  res.statusCode = 200
  res.headers = {}
  res.writeHead = (status, headers) => {
    res.statusCode = status
    Object.assign(res.headers, headers ?? {})
  }
  res.body = () => JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
  return res
}

/**
 * Call a bridge route the way the app window does.
 * @returns {Promise<{status: number, body: any}>}
 */
export async function callRoute (handler, { body, secret, headers = {}, method = 'POST', remoteAddress = '127.0.0.1' } = {}) {
  const allHeaders = { 'content-type': 'application/json', host: '127.0.0.1:3080', ...headers }
  if (secret !== undefined) allHeaders[__internals.SECRET_HEADER] = secret
  const req = fakeRequest({ body, headers: allHeaders, method, remoteAddress })
  const res = fakeResponse()
  await handler(req, res)
  return { status: res.statusCode, body: res.body() }
}

/**
 * One full exchange as the client half would perform it: poll for a command, run it,
 * post the reply. Start it before (or after) the tool call — the queue is order-free.
 * @param {object} host - from createHost().
 * @param {object} options - poll report and the responder.
 */
export async function pollAndReply (host, { hooks = FULL_HOOKS, page = 'https://example.com/', secret, respond, waitMs = 20000 } = {}) {
  const answer = secret === undefined ? host.bridgeSecret() : secret
  const polled = await callRoute(host.poll, { body: { hooks, page, waitMs }, secret: answer })
  if (polled.status !== 200) throw new Error(`poll refused: HTTP ${polled.status}`)
  const command = polled.body
  if (!command || command.idle) return { idle: true }
  let reply
  try {
    reply = { id: command.id, ok: true, value: await respond(command.op, command.args) }
  } catch (error) {
    reply = { id: command.id, ok: false, error: String(error?.message ?? error) }
  }
  const posted = await callRoute(host.reply, { body: reply, secret: answer })
  if (posted.status !== 200) throw new Error(`reply refused: HTTP ${posted.status}`)
  return { op: command.op, args: command.args, value: reply.value }
}

/** Run one tool call with an exec context, through the same protocol a real Host uses. */
export async function runTool (host, toolName, args, { exec, respond, hooks, page, secret } = {}) {
  const tool = host.tools.get(toolName)
  if (!tool) throw new Error(`no such tool: ${toolName}`)
  const call = () => tool.execute(args, exec ?? { name: toolName, agent: { session: {} }, callId: 'call-1' })
  if (respond === undefined) return call()

  // A tool may need several round trips (screenshot: probe, install, render), so the fake
  // window serves until the call settles. It asks for a short poll window so stopping it
  // never waits out the production 20 s park.
  let running = true
  const window = (async () => {
    while (running) {
      try {
        await pollAndReply(host, { hooks, page, secret, respond, waitMs: 25 })
      } catch {
        return
      }
      // The tool checks that a window is connected before it queues, so keep polling.
      if (running) await new Promise((done) => setTimeout(done, 2))
    }
  })()

  await new Promise((done) => setTimeout(done, 25))
  try {
    return await call()
  } finally {
    running = false
    await Promise.race([window, new Promise((done) => setTimeout(done, 200))])
  }
}

/** A temporary plugin data directory, removed when `done` is called. */
export function tempDataDir () {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-browser-test-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}
