// Spec 038 real-gateway integration: a desktop controller behind the REAL
// plugins/mobile-gateway (pinned TLS/WSS listener) keeps its merged view while the
// Host link is down, holds a plain-text send pending, and replays it once with the
// original requestId when the link returns. No router state is injected: pairing,
// streams, prompts and link drops all cross the real gateway's socket.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { PINNED_DSH_VERSION } from '../lib/host-router.mjs'
import { check, delay, finish, mountPlugin, tempDir } from './helpers.mjs'
import { requestJson } from './fixture-http.mjs'

const gatewayPlugin = (await import('../../mobile-gateway/lib/index.mjs')).default
const { createTestConnection, createTestRemoteAccess } = await import('../../mobile-gateway/test/helpers/peer.mjs')

console.log('offline-gateway')

// A single slow step keeps the offline window stable: with a short backoff the
// supervisor redials into the disabled listener and the link flaps, so a stale
// baseline would be replaced by a fresh one before the test can observe it.
const BACKOFF = [4000]
const SCOPES = ['harness:remote', 'sessions:read', 'prompt:send', 'approval:respond']
const WORKSPACES = [{
  workspaceId: 'wb-alpha', path: '/work/alpha', title: 'Alpha workspace', sessionIds: ['sess-alpha'],
  createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
}]
const SESSIONS = [
  { sessionId: 'sess-alpha', running: false, updatedAt: 3,
    projections: { kind: 'sequenced', asOfSeq: 3, values: { title: 'Alpha' } } },
  { sessionId: 'sess-beta', running: true, updatedAt: 2,
    projections: { kind: 'sequenced', asOfSeq: 2, values: { title: 'Beta' } } },
]

/** The Host behind the real gateway: counts durable prompts per requestId. */
function offlineHost() {
  const prompts = []
  return {
    prompts,
    async invoke(request) {
      if (request?.namespace === 'session' && request?.method === 'list') return { items: SESSIONS }
      return {}
    },
    async dispatchRpc(endpoint, payload, signal, peer) { // eslint-disable-line no-unused-vars
      if (endpoint === 'session/list') return { ok: true, value: { items: SESSIONS } }
      if (endpoint === 'session/prompt') {
        const args = payload?.args ?? {}
        prompts.push({ requestId: args.requestId, sessionId: args.sessionId, text: args.text, mode: args.mode })
        return { ok: true, value: { accepted: true } }
      }
      return { ok: true, value: {} }
    },
    async openWireStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow) { // eslint-disable-line no-unused-vars
      return (async function* () {
        if (endpoint === 'workspace/follow') {
          yield { type: 'baseline', value: { items: WORKSPACES, archivedSessionIds: [], pinnedSessionIds: [] } }
        } else if (endpoint === 'session/follow') {
          yield { type: 'snapshot', header: { version: 4, id: 'sess-alpha' }, cursor: 1,
            records: [], projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } }
        } else {
          yield { type: 'baseline', value: { projections: {} } }
        }
        while (!signal?.aborted) await delay(10)
      })()
    },
    async stream(request) {
      return (async function* () {
        if (request?.namespace === 'session' && request?.method === 'follow') {
          yield { type: 'snapshot', header: { version: 4, id: request?.args?.request?.address?.sessionId ?? 'sess-alpha' },
            cursor: 1, records: [], projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } }
        } else {
          yield { type: 'baseline', value: request?.namespace === 'workspace'
            ? { items: WORKSPACES, archivedSessionIds: [] } : { projections: {} } }
        }
        while (!request?.signal?.aborted) await delay(10)
      })()
    },
  }
}

/** Real gateway over a TLS/WSS listener, with the Host behind it. */
async function startGateway() {
  const directory = tempDir('dsh-038-gw-')
  const host = offlineHost()
  let management
  let upgrade
  let dispose = () => {}
  const server = http.createServer((req, res) => {
    if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) {
      management.handler(req, res)
      return
    }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => { if (upgrade) upgrade.handler(req, socket, head); else socket.destroy() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => { management = undefined } },
      registerUpgrade(route) { upgrade = route; return () => { upgrade = undefined } },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: host,
    agentDefaultModel: {},
    on() { return () => {} },
    effect(fn) { dispose = fn() },
  }
  await gatewayPlugin.apply(ctx, {
    remoteControl: { enabled: true }, gatewayMode: 'persistent', gatewayWaitTimeoutMs: 60_000,
    gatewayName: `offline-038-${port}`, deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000, lanEnabled: true, lanHost: '127.0.0.1', lanPort: 0,
    requireHostApproval: false,
  })
  const base = `http://127.0.0.1:${port}`
  const api = {
    base, prompts: host.prompts,
    post(route, body) { return requestJson(base, 'POST', `/mgw/${route}`, { body: body ?? {}, headers: { Origin: base } }) },
    async get(route) { return (await requestJson(base, 'GET', `/mgw/${route}`)).data },
    async close() { dispose(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }) },
  }
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const status = await api.get('status')
    if (status.lan?.listening && status.lan.urls.length > 0) {
      api.lanUrl = status.lan.urls[0]
      return api
    }
    if (status.lan?.error) throw new Error(`gateway TLS listener failed: ${status.lan.error}`)
    await delay(20)
  }
  throw new Error('gateway TLS listener did not become ready')
}

async function until(fn, label, { tries = 900, every = 10 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await fn()
    if (value) return value
    await delay(every)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function stillPending(promise, label) {
  const outcome = await Promise.race([
    promise.then((value) => ({ done: true, value })),
    delay(80).then(() => ({ done: false })),
  ])
  assert.equal(outcome.done, false, `${label} must stay pending while queued`)
}

const viewOf = async (mounted, id) => (await mounted.call('GET', `/devices/remotes/${id}`)).json.remote
const aliasesOf = (answer) => answer.value.items.map((item) => item.sessionId).sort()
const mergedSessions = (carrier) => carrier.dispatchRpc('session/list', { args: {} }, undefined, {})
const routingOf = async (mounted) => (await mounted.call('GET', '/devices/remotes')).json.routing

/** A bounded pushable stream, with the local baseline the merged view is built on. */
function localStream(endpoint, signal) {
  const items = []
  const waiters = []
  let closed = false
  const push = (value) => {
    const waiter = waiters.shift()
    if (waiter) waiter({ value, done: false })
    else items.push(value)
  }
  if (endpoint === 'workspace/follow') {
    push({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
  } else if (endpoint === 'session/control') {
    push({ type: 'baseline', value: { projections: {} } })
  } else if (endpoint === '$events') {
    push({ type: 'ready', clientId: 'local-client' })
  }
  signal?.addEventListener('abort', () => {
    if (closed) return
    closed = true
    for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
  }, { once: true })
  return {
    [Symbol.asyncIterator]: () => ({
      async next() {
        if (items.length > 0) return { value: items.shift(), done: false }
        if (closed) return { value: undefined, done: true }
        return new Promise((resolve) => waiters.push(resolve))
      },
    }),
  }
}

/** The carrier the desktop Host's native UI would hand to the router. */
function carrier() {
  return {
    async dispatchRpc(endpoint, payload, signal, peer) { // eslint-disable-line no-unused-vars
      return { ok: true, value: endpoint === 'session/list' ? { items: [] } : {} }
    },
    async openWireStream(endpoint, payload, uplink, peer, signal, control, window) { // eslint-disable-line no-unused-vars
      return localStream(endpoint, control?.signal ?? signal)
    },
  }
}

/** Drain a stream continuously so no frame is lost to a timed-out `next()`. */
function drain(iterator) {
  const frames = []
  let running = true
  const done = (async () => {
    try {
      while (running) {
        const { value, done: ended } = await iterator.next()
        if (ended) break
        frames.push(value)
      }
    } catch { /* abort closes the stream */ }
  })()
  return { frames, stop: () => { running = false }, done }
}

async function pairDesktop(gateway, mounted) {
  const created = await gateway.post('pair', { kind: 'desktop', scopes: SCOPES, publicUrl: gateway.lanUrl })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const answer = await mounted.call('POST', '/devices/remotes',
    { body: { address: new URL(gateway.lanUrl).host, pairingString: created.data.pairingString } })
  assert.equal(answer.status, 201, answer.text)
  return answer.json.remote.id
}

async function setGateway(gateway, mode) {
  const answer = await gateway.post('gateway', { mode })
  assert.equal(answer.status, 200, JSON.stringify(answer.data))
}
async function waitLan(gateway, listening) {
  await until(async () => {
    const status = await gateway.get('status')
    return listening ? status.lan?.listening === true && status.lan.urls[0] === gateway.lanUrl
      : status.lan?.listening !== true
  }, `gateway TLS listener ${listening ? 'up' : 'down'}`)
}

await check('real gateway: offline workspace/session view, pending prompt and one replayed send with the original id', async () => {
  const gateway = await startGateway()
  // Keep the exact object the router wrapped: the native session/prompt dispatch
  // below goes through this carrier, not through an outbox API.
  const desktopCarrier = carrier()
  const mounted = await mountPlugin({ dataDir: tempDir(), requestTimeoutMs: 6000,
    reconnectDelaysMs: BACKOFF, reconnectStableMs: 100, testDshVersion: PINNED_DSH_VERSION,
    services: { typertGateway: desktopCarrier } })
  const workspaceControl = new AbortController()
  let workspace
  try {
    const remoteId = await pairDesktop(gateway, mounted)
    const remote = await until(async () => {
      const view = await viewOf(mounted, remoteId)
      return view.status === 'online' ? view : null
    }, 'desktop remote online')

    // (0) The pairing holds every scope this integration exercises.
    assert.deepEqual([...remote.device.scopes].sort(), [...SCOPES].sort())

    // (1) Establish the remote workspace/session view over the live link.
    const stream = await desktopCarrier.openWireStream('workspace/follow', { args: {} },
      undefined, {}, workspaceControl.signal, workspaceControl, 64)
    workspace = drain(stream[Symbol.asyncIterator]())
    const onlineAliases = [`h:${remoteId}:sess-alpha`, `h:${remoteId}:sess-beta`]
    const remoteWorkspace = await until(() => workspace.frames.find((frame) => frame?.value?.items?.length > 0),
      'the remote workspace row from the real gateway')
    assert.deepEqual(remoteWorkspace.value.items.map((item) => item.workspaceId), [`h:${remoteId}:wb-alpha`])
    const online = await mergedSessions(desktopCarrier)
    assert.equal(online.ok, true, JSON.stringify(online))
    assert.deepEqual(aliasesOf(online), onlineAliases)
    assert.equal(gateway.prompts.length, 0, 'no prompt has crossed the wire yet')

    // (2) Drop the Host link the way the reconnect tests do: stop the gateway's
    // TLS listener. Every frame below comes from the controller's own router.
    const beforeDrop = workspace.frames.length
    await setGateway(gateway, 'disabled')
    await waitLan(gateway, false)
    await until(async () => (await viewOf(mounted, remoteId)).status !== 'online', 'the desktop remote offline')

    // (3) The merged rows survive, and the Devices view marks the host offline.
    const offline = await mergedSessions(desktopCarrier)
    assert.equal(offline.ok, true, 'the merged list still answers while the Host is down')
    assert.deepEqual(aliasesOf(offline), onlineAliases, 'no session row vanished with the link')
    assert.equal(offline.value.items.every((row) => row.projections.kind === 'cached'), true,
      'retained rows are marked cached, never sequenced')
    const stale = await until(() => workspace.frames.slice(beforeDrop).find((frame) => frame?.type === 'replace'),
      'a stale workspace replace while offline')
    assert.deepEqual(stale.value.items.map((item) => item.workspaceId), [`h:${remoteId}:wb-alpha`],
      'the last workspace row stays on screen')
    const routing = await routingOf(mounted)
    const down = routing.disconnected.find((host) => host.hostId === remoteId)
    assert.ok(down, 'the host is reported as disconnected, not forgotten')
    assert.equal(down.online, false)
    assert.equal(down.retainedSessions, 2)
    assert.equal(down.retainedWorkspaces, 1)
    assert.equal(routing.hosts.some((host) => host.hostId === remoteId), false, 'no live route to the offline host')

    // (4) Send a plain-text prompt through the NATIVE session/prompt dispatch.
    // The router holds the call open; only the plugin outbox knows about it.
    const requestId = 'req-038-offline-original'
    const prompt = desktopCarrier.dispatchRpc('session/prompt', { args: {
      sessionId: `h:${remoteId}:sess-alpha`, requestId, text: 'plain offline send',
    } }, undefined, {})
    await stillPending(prompt, 'the queued native prompt')
    assert.equal(gateway.prompts.length, 0, 'nothing was sent to the Host while offline')
    const queuedRouting = await routingOf(mounted)
    assert.equal(queuedRouting.disconnected.find((host) => host.hostId === remoteId).queuedPrompts, 1,
      'exactly one item is in the plugin outbox')

    // (5) Restore the link. The router replays once, with the original id.
    await setGateway(gateway, 'persistent')
    await waitLan(gateway, true)
    await until(async () => (await viewOf(mounted, remoteId)).status === 'online', 'the desktop remote online again')
    const answer = await Promise.race([
      prompt,
      delay(8000).then(() => { throw new Error('the queued native prompt never settled') }),
    ])
    assert.equal(answer.ok, true, JSON.stringify(answer))
    await until(() => gateway.prompts.length === 1, 'one prompt received by the Host')
    assert.deepEqual(gateway.prompts, [{
      requestId, sessionId: 'sess-alpha', text: 'plain offline send', mode: undefined,
    }], 'the original requestId and plain-text args crossed once, unchanged')
    await until(async () => (await routingOf(mounted)).disconnected.every((host) => host.hostId !== remoteId),
      'the host is no longer disconnected')
    assert.equal((await routingOf(mounted)).hosts.some((host) => host.hostId === remoteId), true,
      'the host is routable again')
    const back = await mergedSessions(desktopCarrier)
    assert.deepEqual(aliasesOf(back), onlineAliases, 'the same session rows remain usable after replay')
    assert.equal(back.value.items.some((row) => row.projections.kind === 'cached'), false,
      'the fresh baseline replaces the retained copies')
    await delay(100)
    assert.equal(gateway.prompts.length, 1, 'no duplicate prompt was delivered')
  } finally {
    workspaceControl.abort()
    workspace?.stop()
    try { await setGateway(gateway, 'persistent') } catch { /* the fixture is closing */ }
    mounted.close()
    await gateway.close()
  }
})

finish('offline-gateway')
