// Spec 025 R1–R4, R6 — owner-side scope update for a paired device.
//
// Two levels, because the risk lives in both:
//   - `planScopeUpdate` (pure): what the route accepts and refuses, against the contract's own
//     scope/kind tables — unknown name, wrong kind, `web:unlock`, both directions;
//   - the real gateway: the HTTP route's guards, the persisted record, and the live socket.
//
// The gateway runs in-process over its real listener, like pairing-approval.test.mjs.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'

import WebSocket from 'ws'
import plugin from '../lib/index.mjs'
import { planScopeUpdate, scopesForKind } from '../lib/device-scope-update.mjs'
import { createRegistry, digest } from '../lib/devices.js'
import { DESKTOP_ONLY_SCOPES, SCOPES as CONTRACT_SCOPES, WEB_UNLOCK_SCOPE } from '@dsh-ext/mobile-protocol'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const DEVICE_ID = '22222222-2222-4222-8222-222222222222'
// Exactly the shape the gateway accepts as `Authorization: Bearer <token>` (43 base64url chars).
const TOKEN = 'Q'.repeat(43)

// ---------------------------------------------------------------- pure planner

test('S1: add/remove are computed against the record, in contract order', () => {
  const device = { kind: 'desktop', scopes: ['sessions:read', 'prompt:send'] }
  const plan = planScopeUpdate({ body: { add: ['attachments:write', 'attachments:write'] }, device })
  assert.deepEqual(plan.added, ['attachments:write'], 'a duplicate is not applied twice')
  assert.deepEqual(plan.removed, [])
  assert.deepEqual(plan.scopes, ['sessions:read', 'prompt:send', 'attachments:write'])
  const drop = planScopeUpdate({ body: { remove: ['prompt:send'] }, device: { ...device, scopes: plan.scopes } })
  assert.deepEqual(drop.removed, ['prompt:send'])
  assert.deepEqual(drop.scopes, ['sessions:read', 'attachments:write'])
  // A no-op is reported as such rather than written.
  assert.equal(planScopeUpdate({ body: { add: ['sessions:read'] }, device }).scopesChanged, false)
})

test('S2: unknown scope, wrong-kind scope, web:unlock and a bad body are all 400', () => {
  const desktop = { kind: 'desktop', scopes: ['sessions:read'] }
  const mobile = { kind: 'mobile', scopes: ['sessions:read'] }
  const cases = [
    [{ add: ['not:a:scope'] }, desktop, 'unknown-scope'],
    [{ remove: ['not:a:scope'] }, desktop, 'unknown-scope'],
    [{ add: ['harness:remote'] }, mobile, 'scope-not-for-kind'],
    [{ add: [WEB_UNLOCK_SCOPE] }, desktop, 'scope-not-updatable'],
    [{ remove: [WEB_UNLOCK_SCOPE] }, desktop, 'scope-not-updatable'],
    [{}, desktop, 'bad-request'],
    [{ add: 'sessions:read' }, desktop, 'bad-request'],
    [{ add: [42] }, desktop, 'bad-request'],
  ]
  for (const [body, device, code] of cases) {
    let thrown
    try { planScopeUpdate({ body, device }) } catch (error) { thrown = error }
    assert.ok(thrown, `expected a refusal for ${JSON.stringify(body)}`)
    assert.equal(thrown.status, 400, JSON.stringify(body))
    assert.equal(thrown.code, code, JSON.stringify(body))
  }
  // A desktop-only scope IS updatable on a desktop (that is the point of R2's kind rule).
  assert.equal(scopesForKind('desktop').includes('harness:remote'), true)
  assert.equal(scopesForKind('mobile').includes('harness:remote'), false)
  assert.deepEqual(
    planScopeUpdate({ body: { add: ['harness:remote'] }, device: desktop }).added,
    ['harness:remote'],
  )
  for (const scope of DESKTOP_ONLY_SCOPES) assert.equal(scopesForKind('mobile').includes(scope), false, scope)
  for (const scope of CONTRACT_SCOPES) {
    if (scope !== WEB_UNLOCK_SCOPE) assert.ok(scopesForKind('desktop').includes(scope), `${scope} must stay settable on a desktop`)
  }
})

// ------------------------------------------------------------ registry persistence

test('S3: the update is persisted atomically, the credential is untouched, and it survives a restart', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-025-scopes-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'devices.json')
  fs.writeFileSync(file, JSON.stringify({
    version: 3,
    devices: [{
      id: DEVICE_ID, name: 'Old desktop', clientDeviceId: 'old-desktop-0001', kind: 'desktop',
      scopes: ['sessions:read', 'prompt:send'], tokenHash: digest(TOKEN),
      createdAt: 1, lastSeenAt: null, revokedAt: null,
    }],
  }))
  const registry = createRegistry(file)
  assert.deepEqual(registry.get(DEVICE_ID).scopes, ['sessions:read', 'prompt:send'])
  const updated = registry.updateScopes(DEVICE_ID, ['sessions:read', 'prompt:send', 'attachments:write'])
  assert.deepEqual(updated.scopes, ['sessions:read', 'prompt:send', 'attachments:write'])
  // R3: the credential is unchanged — the same token still authenticates.
  assert.equal(registry.authenticate(TOKEN, 'old-desktop-0001').id, DEVICE_ID)
  // Persisted: a fresh registry reading the same file sees the new grant.
  assert.deepEqual(createRegistry(file).get(DEVICE_ID).scopes, ['sessions:read', 'prompt:send', 'attachments:write'])
  // The registry filters by kind on the way in too, so a hand-built list cannot smuggle a mobile-only
  // record into a desktop-only scope.
  const mobileFile = path.join(directory, 'mobile.json')
  const mobile = createRegistry(mobileFile)
  const pairing = mobile.createPairing('Phone', { scopes: ['sessions:read'] })
  const claimed = mobile.claimPairing(pairing.code, 'phone-0001')
  assert.deepEqual(mobile.updateScopes(claimed.device.id, ['sessions:read', 'harness:remote']).scopes, ['sessions:read'])
  // An unknown id reports no such device rather than creating one.
  assert.equal(registry.updateScopes('no-such-device', ['sessions:read']), undefined)
})

// ------------------------------------------------------------------ real gateway

async function factory(t, { deviceRows } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-025-gw-'))
  const sockets = []
  let management
  let upgrade
  let dispose = () => {}
  const deviceFile = path.join(directory, 'devices.json')
  if (deviceRows) fs.writeFileSync(deviceFile, JSON.stringify({ version: 3, devices: deviceRows }))
  const server = http.createServer((req, res) => {
    if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) { management.handler(req, res); return }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => { if (upgrade) upgrade.handler(req, socket, head); else socket.destroy() })
  await listenFetchSafe(server)
  const port = server.address().port
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => { management = undefined } },
      registerUpgrade(route) { upgrade = route; return () => { upgrade = undefined } },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      async invoke() { return { items: [] } },
      // Honours the abort signal: an endless `while (true)` timer would keep the process alive after
      // every test in this file is done.
      async stream(request) {
        return (async function* () {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [], projections: {} } }
          while (!request.signal.aborted) await delay(10)
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(fn) { dispose = fn() },
  }
  const apply = async () => plugin.apply(ctx, {
    remoteControl: { enabled: true }, gatewayMode: 'persistent', gatewayWaitTimeoutMs: 60_000,
    gatewayName: `sp25-${port}`, deviceFile, lanEnabled: true, lanHost: '127.0.0.1', lanPort: 0,
  })
  await apply()
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    dispose()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const instance = {
    port, base: `http://127.0.0.1:${port}`, deviceFile,
    async post(route, body, headers = {}) {
      const response = await fetch(`${instance.base}/mgw/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: instance.base, ...headers }, body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, data: await response.json() }
    },
    async get(route, headers = {}) {
      const response = await fetch(`${instance.base}/mgw/${route}`, { headers })
      return { status: response.status, data: await response.json() }
    },
    track(socket) { sockets.push(socket); return socket },
    /**
     * Call the management handler with forged peer/Host/headers (the real peer is always loopback).
     * `stallBody: true` never delivers data or end, so a handler that reads the body before it
     * answers can only be caught by the caller's own deadline.
     */
    raw(method, url, { remoteAddress = '127.0.0.1', headers = {}, body = {}, host, stallBody = false } = {}) {
      return new Promise((resolve) => {
        const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
        const req = {
          method, url, headers: { host: host ?? `127.0.0.1:${port}`, ...headers }, socket: { remoteAddress },
          on(event, handler) {
            if (stallBody) return req
            if (event === 'data') queueMicrotask(() => chunks.forEach((chunk) => handler(chunk)))
            if (event === 'end') queueMicrotask(() => queueMicrotask(() => handler()))
            return req
          },
        }
        const res = {
          writeHead(status) { res.status = status },
          end(text) { resolve({ status: res.status, json: text ? JSON.parse(text) : undefined }) },
        }
        management.handler(req, res)
      })
    },
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = (await instance.get('status')).data
    if (status.lan?.listening && status.lan.urls.length > 0) { instance.lanUrl = status.lan.urls[0]; return instance }
    if (status.lan?.error) throw new Error(`TLS listener failed: ${status.lan.error}`)
    await delay(20)
  }
  throw new Error('TLS listener did not become ready')
}

const desktopRow = (scopes = ['sessions:read', 'prompt:send']) => ({
  id: DEVICE_ID, name: 'Old desktop', clientDeviceId: 'old-desktop-0001', kind: 'desktop',
  scopes, tokenHash: digest(TOKEN), createdAt: 1, lastSeenAt: null, revokedAt: null,
})

/** The device's own control socket, the way the companion opens it. */
async function connectDevice(instance) {
  const ws = instance.track(new WebSocket(instance.lanUrl, ['dsh-mobile-v1'], {
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-DSH-Device-ID': 'old-desktop-0001', 'X-DSH-Channel': 'control' },
    origin: undefined, rejectUnauthorized: false,
  }))
  const frames = []
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())) } catch { /* not json */ } })
  ws.on('error', () => {})
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)))
  await once(ws, 'open')
  for (let i = 0; i < 200 && !frames.some((f) => f.kind === 'hello'); i += 1) await delay(10)
  const hello = frames.find((f) => f.kind === 'hello')
  assert.ok(hello, 'the device should get a hello')
  return { ws, frames, closed, hello }
}

test('S4: a proxied, non-loopback or foreign-origin request is 403 and the record is unchanged', async (t) => {
  const instance = await factory(t, { deviceRows: [desktopRow()] })
  const route = `devices/${DEVICE_ID}/scopes`
  const before = (await instance.get('devices')).data.devices[0].scopes

  const proxied = await instance.raw('POST', `/mgw/${route}`, {
    headers: { 'x-forwarded-for': '203.0.113.9', origin: instance.base }, body: { add: ['attachments:write'] },
  })
  assert.equal(proxied.status, 403, 'a forwarding-family header is a proxy, never the owner')
  const forwarded = await instance.raw('POST', `/mgw/${route}`, {
    headers: { forwarded: 'for=203.0.113.9', origin: instance.base }, body: { add: ['attachments:write'] },
  })
  assert.equal(forwarded.status, 403)
  const remote = await instance.raw('POST', `/mgw/${route}`, {
    remoteAddress: '192.168.1.50', headers: { origin: instance.base }, body: { add: ['attachments:write'] },
  })
  assert.equal(remote.status, 403, 'a LAN peer is not this machine')
  const foreign = await instance.raw('POST', `/mgw/${route}`, {
    headers: { origin: 'https://evil.example' }, body: { add: ['attachments:write'] },
  })
  assert.equal(foreign.status, 403, 'a foreign Origin is refused')
  const foreignHost = await instance.raw('POST', `/mgw/${route}`, {
    host: 'evil.example', headers: { origin: `http://evil.example` }, body: { add: ['attachments:write'] },
  })
  assert.equal(foreignHost.status, 403, 'a Host that is not this machine is refused')

  assert.deepEqual((await instance.get('devices')).data.devices[0].scopes, before, 'nothing was written')
  assert.deepEqual(createRegistry(instance.deviceFile).get(DEVICE_ID).scopes, before, 'and nothing reached disk')
})

test('S5: bad scope requests are 400 and leave the record alone', async (t) => {
  const instance = await factory(t, { deviceRows: [desktopRow()] })
  const route = `devices/${DEVICE_ID}/scopes`
  for (const [body, label] of [
    [{ add: ['not:a:scope'] }, 'unknown scope'],
    [{ add: [WEB_UNLOCK_SCOPE] }, 'web:unlock cannot be added'],
    [{ remove: [WEB_UNLOCK_SCOPE] }, 'web:unlock cannot be removed'],
    [{}, 'nothing named'],
  ]) {
    const answer = await instance.post(route, body)
    assert.equal(answer.status, 400, label)
  }
  // A mobile record cannot take a desktop-only scope.
  const mobileId = '33333333-3333-4333-8333-333333333333'
  const mobile = await factory(t, {
    deviceRows: [desktopRow(), {
      id: mobileId, name: 'Phone', clientDeviceId: 'phone-0001', kind: 'mobile',
      scopes: ['sessions:read'], tokenHash: digest('phone-token'), createdAt: 1, lastSeenAt: null, revokedAt: null,
    }],
  })
  assert.equal((await mobile.post(`devices/${mobileId}/scopes`, { add: ['harness:remote'] })).status, 400)
  assert.deepEqual((await mobile.get('devices')).data.devices.find((d) => d.id === mobileId).scopes, ['sessions:read'])
  // An unknown device is a 404, not a new record.
  assert.equal((await instance.post('devices/no-such-device/scopes', { add: ['sessions:read'] })).status, 404)
})

test('S8: an unknown device id answers 404 before the body is read', async (t) => {
  const instance = await factory(t, { deviceRows: [desktopRow()] })
  // The body never arrives: a route that read it would wait forever, so a 404 proves the record
  // was looked up first. The racer fails the test instead of hanging the suite.
  const answer = await Promise.race([
    instance.raw('POST', '/mgw/devices/no-such-device/scopes', {
      headers: { origin: instance.base }, stallBody: true,
    }),
    delay(2000).then(() => 'timeout'),
  ])
  assert.notEqual(answer, 'timeout', 'the 404 must not wait on a body it can never use')
  assert.equal(answer.status, 404)
  assert.equal(answer.json.error, 'not-found')
})

test('S6: adding attachments:write persists, and the device sees it after reconnecting', async (t) => {
  const instance = await factory(t, { deviceRows: [desktopRow()] })
  const first = await connectDevice(instance)
  assert.equal(first.hello.device.scopes.includes('attachments:write'), false, 'the old record lacks it')

  const answer = await instance.post(`devices/${DEVICE_ID}/scopes`, { add: ['attachments:write'] })
  assert.equal(answer.status, 200, JSON.stringify(answer.data))
  assert.deepEqual(answer.data.added, ['attachments:write'])
  assert.deepEqual(answer.data.removed, [])
  assert.ok(answer.data.device.scopes.includes('attachments:write'))
  // R3: on any change the device's live sockets close with the contract's re-auth code, so the next
  // connection carries the new scopes. The credential itself is untouched.
  assert.equal(await first.closed, 4401, 'the live socket is closed with the revoke/re-auth code')

  const second = await connectDevice(instance)
  assert.equal(second.hello.device.scopes.includes('attachments:write'), true, 'the reconnect carries the new scope')
  second.ws.close()

  // Persisted across a plugin restart: a fresh registry over the same device file (exactly what
  // plugin start-up builds) reads the new grant back, and the running instance's own view agrees.
  const row = createRegistry(instance.deviceFile).get(DEVICE_ID)
  assert.ok(row.scopes.includes('attachments:write'), 'the grant survives a restart')
  assert.equal((await instance.get('devices')).data.devices[0].scopes.includes('attachments:write'), true)
})

test('S7: removing a scope closes the live socket, and the reconnect lacks it', async (t) => {
  const instance = await factory(t, { deviceRows: [desktopRow(['sessions:read', 'prompt:send'])] })
  const live = await connectDevice(instance)
  assert.equal(live.hello.device.scopes.includes('prompt:send'), true)

  const answer = await instance.post(`devices/${DEVICE_ID}/scopes`, { remove: ['prompt:send'] })
  assert.equal(answer.status, 200, JSON.stringify(answer.data))
  assert.deepEqual(answer.data.removed, ['prompt:send'])
  assert.equal(await live.closed, 4401)

  const after = await connectDevice(instance)
  assert.equal(after.hello.device.scopes.includes('prompt:send'), false, 'the narrowing is in effect')
  after.ws.close()
})
