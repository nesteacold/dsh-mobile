/**
 * Shared R12 relay harness for the migrated owner-authenticated `/api` fetch routes.
 *
 * This file intentionally registers no tests: `npm test` loads every `test/*.test.mjs`, so a
 * helper under that glob can be imported by the bridge suites without editing the webServer
 * harness (which pins the old, now-unused mount path).
 */
import { apply, __internals } from '../lib/index.js'
import { SYNTHETIC_ENDPOINT } from './fixtures.mjs'

/** Apply the host half with a fake `connection.fetch` registry and collect its routes. */
export function relayHost ({ config = {} } = {}) {
  const registrations = new Map()
  const injections = []
  const tools = new Map()
  const ctx = {
    logger: { warn: () => {} },
    tools: {
      register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) },
    },
    get: () => undefined,
    on: (event, handler) => { if (event === 'webserver/index-inject') injections.push(handler) },
    effect: (fn) => { fn(); return () => {} },
    connection: {
      fetch: {
        register: (route) => {
          if (registrations.has(route.path)) throw new Error(`duplicate route ${route.path}`)
          registrations.set(route.path, route)
          return () => registrations.delete(route.path)
        },
      },
    },
  }
  const applied = apply(ctx, { endpoint: SYNTHETIC_ENDPOINT, launchPolicy: 'never', dataDir: '', ...config })
  const table = []
  for (const handler of injections) handler(table, { principal: { kind: 'owner' } })
  const secret = table.find((entry) => entry.name === __internals.GLOBAL_KEY)?.value?.secret ?? null
  return { registrations, injections, applied, secret, tools, bridgeSecret: () => secret }
}

/** Call one registered relay route the way DSH's `/api` fence does, with an owner peer. */
export async function callRelay (route, {
  body = {},
  rawBody,
  secret,
  method = 'POST',
  headers = {},
  base = 'http://127.0.0.1:3080',
  peer = { principal: { kind: 'owner' } },
} = {}) {
  const allHeaders = new Headers({ 'content-type': 'application/json', ...headers })
  if (secret !== undefined && !allHeaders.has(__internals.SECRET_HEADER)) {
    allHeaders.set(__internals.SECRET_HEADER, secret)
  }
  const payload = rawBody !== undefined ? rawBody : JSON.stringify(body)
  const request = new Request(`${base}${route.path}`, {
    method,
    headers: allHeaders,
    body: method === 'GET' || method === 'HEAD' ? undefined : payload,
  })
  const response = await route.fetch(request, peer)
  const text = await response.text()
  let parsed
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { status: response.status, body: parsed, headers: response.headers, response }
}

/** One named relay registration, or undefined. */
export const relayOf = (registrations, name) => registrations.get(`${__internals.BRIDGE_PREFIX}/${name}`)

/** The four relay registrations from one applied host, in a stable order. */
export function relaysOf (registrations) {
  return ['tabs', 'shot', 'input', 'nav'].map((name) => registrations.get(`${__internals.BRIDGE_PREFIX}/${name}`))
}
