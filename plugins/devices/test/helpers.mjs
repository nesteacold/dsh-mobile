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
    console.log(`  FAIL ${name}\n       ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n       ') : error}`)
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
