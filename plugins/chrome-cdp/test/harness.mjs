/**
 * Test harness: a fake Cordis context, fake HTTP request/response objects, and a temp
 * plugin data directory.
 *
 * Nothing here reaches DSH; the production code paths — endpoint validation, the secret
 * handshake, route authorization, the risk declaration — run exactly as they will in a
 * Host, so the specs pin behaviour rather than a mock of it.
 *
 * Arming the fakes here, before anything is imported, is what makes the suite hermetic: this
 * process refuses every Chrome side effect until a test names an endpoint, and the default
 * endpoint is the discard port, never the owner's Chrome on 40222.
 */
import { Writable, Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, __internals } from '../lib/index.js'
import { SYNTHETIC_ENDPOINT } from './fixtures.mjs'

process.env.DSH_CHROME_CDP_ARM_FAKES = '1'

/**
 * Apply the plugin against a fake Host.
 * @param {object} [options] - test inputs.
 * @param {object} [options.config] - plugin config, merged over the test defaults.
 * @param {object} [options.permissionPresets] - a stub native preset service.
 * @param {object} [options.sandboxPolicy] - a stub native sandbox-policy service.
 * @param {{host: string, port: number|null}} [options.webServer] - this Host's listener.
 * @param {object[]} [options.routes] - extra routes to record from other code paths.
 */
export function createHost ({
  config = {},
  permissionPresets,
  sandboxPolicy,
  webServer = { host: '127.0.0.1', port: 3080 },
} = {}) {
  const tools = new Map()
  const routes = new Map()
  const injections = []
  const preExecute = []
  const effects = []
  const warned = []
  const services = { permissionPresets, sandboxPolicy }

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
    effect: (fn) => {
      const dispose = fn()
      effects.push(dispose)
      return () => { if (typeof dispose === 'function') dispose() }
    },
    inject: (names, callback) => {
      if (names.includes('webServer')) callback({ webServer: webServerService, effect: (fn) => { const dispose = fn(); effects.push(dispose); return dispose } })
    },
  }

  const applied = apply(ctx, {
    endpoint: SYNTHETIC_ENDPOINT,
    launchPolicy: 'never',
    dataDir: '',
    ...config,
  })

  // Belt and braces for every host this harness builds, whether or not a test named an
  // endpoint: the built-in default is the owner's Chrome, so a host that ever resolved to
  // 40222 refuses here, before any socket could open, even with the under-test guard off.
  // The default itself is pinned without a host (`endpoint.test.mjs`, `parseEndpoint`).
  if (applied.state.endpoint.port === 40222) {
    throw new Error('a test harness resolved its endpoint to 127.0.0.1:40222, the owner\'s own Chrome; give createHost a fake or SYNTHETIC_ENDPOINT')
  }

  /** Rows the host would render into the page for this Peer. */
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
   * Resolve the `tools/pre-execute` decision the way the tools pipeline does: each listener
   * may return a decision or delegate with `next()`; the first decision wins.
   */
  const riskDecision = async (exec) => {
    const next = () => Promise.resolve({ kind: 'allow' })
    for (const listener of preExecute) {
      const decision = await listener(exec, next)
      if (decision !== undefined) return decision
    }
    return { kind: 'allow' }
  }

  /** Run every teardown the plugin registered (unload), last registered first. */
  const dispose = () => {
    for (const effect of effects.reverse()) if (typeof effect === 'function') effect()
  }

  return { ctx, tools, routes, collectInjections, bridgeSecret, riskDecision, warned, services, dispose, applied }
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
  const end = res.end.bind(res)
  // Captured before `end` hands the chunk to the stream, which writes it once more.
  res.end = (chunk, ...rest) => { if (chunk !== undefined) chunks.push(Buffer.from(String(chunk))); return end(...rest) }
  res.body = () => JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
  res.text = () => Buffer.concat(chunks).toString('utf8')
  return res
}

/**
 * Call a bridge route the way the client half does.
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

/** One exec context as the tools pipeline passes it. */
export const execOf = (toolName, args = {}, { sessionId = 'session-1', presetHost } = {}) => {
  const session = { id: sessionId }
  return {
    name: toolName,
    arguments: args,
    agent: { session },
    session,
    // One call id per session, as the real pipeline does: a stubbed `Math.random` (a test that
    // pins a page clock) would otherwise hand two calls the same id.
    callId: `${toolName}-${sessionId}`,
    presetHost,
  }
}

/** A temporary plugin data directory, removed when `done` is called. */
export function tempDataDir () {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-chrome-cdp-test-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}
