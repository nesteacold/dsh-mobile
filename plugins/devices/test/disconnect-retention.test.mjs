// Spec 008 connection lifecycle: a remote Host that drops its link must not take the
// user's sessions off the screen, and the same sessions must come back — under the
// same aliases — when the link returns, WITHOUT restarting DSH.
//
// The bug this pins down (reported by the owner): on a disconnect every remote session
// vanished from the merged list, because `session/list` contributed only from
// CONNECTED hosts. A session the user had open then had no row to be reopened from, and
// the only way back was to restart the process. The fix is retention in the router: the
// last rows a host listed are kept, renamed, and replayed while it is disconnected;
// only an explicit forget or a 4401 revoke drops them.
//
// The remote is the REAL plugins/mobile-gateway run in-process (as e2e.test.mjs does);
// its TLS listener is switched off and on to move the link, exactly as
// auto-reconnect.test.mjs does. Nothing in the gateway is edited.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { check, delay, finish, mountPlugin, tempDir } from './helpers.mjs'
import { requestJson } from './fixture-http.mjs'

const gatewayPlugin = (await import('../../mobile-gateway/lib/index.mjs')).default
const { createTestConnection, createTestRemoteAccess } = await import('../../mobile-gateway/test/helpers/peer.mjs')

console.log('disconnect-retention')

const BACKOFF = [100, 150, 250, 400]

/** The sessions this Host offers; the test re-reads the list around every link move. */
const SESSIONS = [
  { sessionId: 'sess-alpha', running: false, updatedAt: 3, projections: { values: { title: 'Alpha' } } },
  { sessionId: 'sess-beta', running: true, updatedAt: 2, projections: { values: { title: 'Beta' } } },
  { sessionId: 'sess-gamma', running: false, updatedAt: 1, projections: { values: { title: 'Gamma' } } },
]

async function startGateway() {
  const directory = tempDir('dsh-devices-gw-')
  let management
  let upgrade
  let dispose = () => {}
  const server = http.createServer((req, res) => {
    if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) { management.handler(req, res); return }
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
    typertGateway: {
      async invoke(request) {
        if (request.namespace === 'session' && request.method === 'list') return { items: SESSIONS }
        if (request.namespace === 'session' && request.method === 'prompt') return { accepted: true }
        return {}
      },
      // The remote bridge forwards a device's `sessions:read`/`harness:remote` calls
      // through this carrier, exactly as e2e.test.mjs sets it up: the merged list a
      // controller sees is this answer, renamed.
      async dispatchRpc(endpoint) {
        if (endpoint === 'session/list') return { ok: true, value: { items: SESSIONS } }
        return { ok: true, value: {} }
      },
      // The bridge serves `session/follow` off its own session stream; the snapshot is
      // the opening frame the controller's client validates.
      async openWireStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow) { // eslint-disable-line no-unused-vars
        return (async function* () { while (true) await delay(10) })()
      },
      async stream(request) {
        return (async function* () {
          if (request.namespace === 'session' && request.method === 'follow') {
            yield { type: 'snapshot', header: { version: 4, id: request.args.request.address.sessionId }, cursor: 1,
              records: [], hasMore: false, projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } }
          } else {
            yield { type: 'baseline', value: request.namespace === 'workspace' ? { items: [], archivedSessionIds: [] } : { projections: {} } }
          }
          while (!request.signal.aborted) await delay(10)
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(fn) { dispose = fn() },
  }
  await gatewayPlugin.apply(ctx, {
    remoteControl: { enabled: true }, gatewayMode: 'persistent', gatewayWaitTimeoutMs: 60_000, gatewayName: `retention-${port}`,
    deviceFile: path.join(directory, 'devices.json'), publicUrlFile: path.join(directory, 'no-public-url'),
    pairingTtlMs: 60_000, lanEnabled: true, lanHost: '127.0.0.1', lanPort: 0,
    requireHostApproval: false,
  })
  const base = `http://127.0.0.1:${port}`
  const api = {
    base,
    post(route, body) { return requestJson(base, 'POST', `/mgw/${route}`, { body: body ?? {}, headers: { Origin: base } }) },
    async get(route) { return (await requestJson(base, 'GET', `/mgw/${route}`)).data },
    async close() { dispose(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }) },
  }
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const status = await api.get('status')
    if (status.lan?.listening && status.lan.urls.length > 0) { api.lanUrl = status.lan.urls[0]; return api }
    if (status.lan?.error) throw new Error(`TLS listener failed: ${status.lan.error}`)
    await delay(20)
  }
  throw new Error('TLS listener did not become ready')
}

const gateway = await startGateway()

async function until(fn, label, { tries = 500, every = 10 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await fn()
    if (value) return value
    await delay(every)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const viewOf = async (mounted, id) => (await mounted.call('GET', `/devices/remotes/${id}`)).json.remote
const listOf = async (mounted) => (await mounted.call('GET', '/devices/remotes')).json
/** The merged native session list, as the wrapped `session/list` answers it. */
const mergedSessions = async (mounted) => (await mounted.gateway.dispatchRpc('session/list', { args: {} }, undefined, {}))
const aliasesOf = (answer) => answer.value.items.map((item) => item.sessionId).sort()

async function setGateway(mode) {
  const answer = await gateway.post('gateway', { mode })
  assert.equal(answer.status, 200, JSON.stringify(answer.data))
}
async function waitLan(listening) {
  await until(async () => {
    const status = await gateway.get('status')
    return listening ? status.lan?.listening === true && status.lan.urls[0] === gateway.lanUrl : status.lan?.listening !== true
  }, `gateway TLS listener ${listening ? 'up' : 'down'}`)
}
async function ensureGatewayOn() {
  try {
    const status = await gateway.get('status')
    if (status.lan?.listening !== true) { await gateway.post('gateway', { mode: 'persistent' }); await waitLan(true) }
  } catch { /* the next check reports it */ }
}

/**
 * Mount the plugin over a fake Host carrier so the wrapped `session/list` can be
 * called directly, then pair the fixture gateway into it.
 */
async function mountWithCarrier() {
  const { PINNED_DSH_VERSION } = await import('../lib/host-router.mjs')
  const carrier = {
    // rc.1 signatures. The opener's arity is what `host-router.selfTest` probes
    // (`length >= 5`), so the explicit parameter list matters here.
    async dispatchRpc(endpoint, payload, signal, peer) { // eslint-disable-line no-unused-vars
      return { ok: true, value: { items: [] } }
    },
    async openWireStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow) { // eslint-disable-line no-unused-vars
      return (async function* () { while (true) await delay(10) })()
    },
  }
  const mounted = await mountPlugin({ dataDir: tempDir(), requestTimeoutMs: 6000, reconnectDelaysMs: BACKOFF,
    reconnectStableMs: 100, testDshVersion: PINNED_DSH_VERSION, services: { typertGateway: carrier } })
  mounted.gateway = carrier
  const created = await gateway.post('pair', { kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'harness:remote'], publicUrl: gateway.lanUrl })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const answer = await mounted.call('POST', '/devices/remotes',
    { body: { address: new URL(gateway.lanUrl).host, pairingString: created.data.pairingString } })
  assert.equal(answer.status, 201, answer.text)
  return { mounted, remoteId: answer.json.remote.id }
}

await check('a disconnect keeps every session listed, read-only, and marked disconnected', async () => {
  const { mounted, remoteId } = await mountWithCarrier()
  try {
    await until(async () => (await viewOf(mounted, remoteId)).status === 'online', 'the pairing online')
    const online = await mergedSessions(mounted)
    assert.equal(online.ok, true, JSON.stringify(online))
    const aliases = aliasesOf(online)
    assert.deepEqual(aliases, [`h:${remoteId}:sess-alpha`, `h:${remoteId}:sess-beta`, `h:${remoteId}:sess-gamma`],
      'the merged list carries every remote session under its host alias')

    await setGateway('disabled')
    await waitLan(false)

    // The list still carries the same aliases: NOTHING vanished.
    const offline = await mergedSessions(mounted)
    assert.equal(offline.ok, true, 'the merged list still answers with the host down')
    assert.deepEqual(aliasesOf(offline), aliases, 'every session stayed listed across the disconnect')
    // And they are the SAME ids, so the native catalog replaces rows instead of
    // inventing a second identity for the same session.
    assert.deepEqual(offline.value.items.map((item) => item.projections.values.title).sort(), ['Alpha', 'Beta', 'Gamma'])

    // The Devices list says the host is only disconnected, and how much is retained.
    const listed = await listOf(mounted)
    assert.equal(listed.remotes[0].status !== 'online', true, 'the host itself reads as not online')
    const gone = listed.routing.disconnected.find((host) => host.hostId === remoteId)
    assert.ok(gone, 'the disconnected set names the paired host')
    assert.equal(gone.online, false)
    assert.equal(gone.retainedSessions, 3, 'all three rows are retained')
    assert.equal(listed.routing.hosts.some((host) => host.hostId === remoteId), false,
      'it is not in the connected set, so no routed call can reach it')

    // An unsafe write is refused while disconnected: the retention is read-only.
    const refused = await mounted.call('POST', `/devices/remotes/${remoteId}/prompt`, { body: { sessionId: 'sess-alpha', text: 'x' } })
    assert.ok(refused.status >= 400, `a prompt while disconnected must be refused, got ${refused.status}`)
    assert.ok(['remote/host-offline', 'remote/unreachable'].includes(refused.json.error) || refused.status === 409,
      `the refusal names the link, got ${refused.json.error}`)
    assert.equal(mounted.logs.some((line) => line.includes('session/prompt')), false, 'nothing was sent to the host')
  } finally { await ensureGatewayOn(); mounted.close() }
})

await check('reconnect restores the same aliases with no duplicate row, twice in a row, without a restart', async () => {
  const { mounted, remoteId } = await mountWithCarrier()
  try {
    await until(async () => (await viewOf(mounted, remoteId)).status === 'online', 'the pairing online')
    const first = aliasesOf(await mergedSessions(mounted))
    assert.equal(first.length, 3)

    // Two full disconnect → reconnect cycles on the SAME mounted process. A restart is
    // exactly what the owner must not need, so the second cycle has to behave like
    // the first one.
    for (const round of [1, 2]) {
      await setGateway('disabled')
      await waitLan(false)
      const down = await mergedSessions(mounted)
      assert.deepEqual(aliasesOf(down), first, `round ${round}: kept through the disconnect`)
      assert.ok((await listOf(mounted)).routing.disconnected.some((host) => host.hostId === remoteId),
        `round ${round}: reported as disconnected`)

      await setGateway('persistent')
      await waitLan(true)
      await until(async () => (await viewOf(mounted, remoteId)).status === 'online', `round ${round}: online again`)

      const back = await mergedSessions(mounted)
      assert.deepEqual(aliasesOf(back), first, `round ${round}: the very same aliases came back`)
      assert.equal(back.value.items.length, first.length, `round ${round}: no duplicate row was minted`)
      // The identical ids are what lets an already-open session resume: the native
      // catalog keys rows by id, so nothing has to be re-opened under a new name.
      assert.deepEqual(back.value.items.map((item) => item.sessionId).sort(), first, `round ${round}: id-for-id`)
      const listed = await listOf(mounted)
      assert.equal(listed.routing.disconnected.some((host) => host.hostId === remoteId), false,
        `round ${round}: no longer in the disconnected set`)
      assert.ok(listed.routing.hosts.some((host) => host.hostId === remoteId), `round ${round}: routable again`)
    }

    // Resume is real, not just a list: a session opened before the drop is readable
    // over the live link again, and a prompt goes through.
    const history = await mounted.call('GET', `/devices/remotes/${remoteId}/history?sessionId=sess-alpha`)
    assert.equal(history.status, 200, history.text)
    assert.equal(history.json.history.kind, 'history')
    const prompt = await mounted.call('POST', `/devices/remotes/${remoteId}/prompt`, { body: { sessionId: 'sess-alpha', text: 'resume me' } })
    assert.equal(prompt.status, 200, prompt.text)
    assert.equal(prompt.json.sent.kind, 'sent')
  } finally { await ensureGatewayOn(); mounted.close() }
})

await check('only an explicit forget drops the retained rows; a revoke drops them too', async () => {
  const { mounted, remoteId } = await mountWithCarrier()
  try {
    await until(async () => (await viewOf(mounted, remoteId)).status === 'online', 'the pairing online')
    assert.equal(aliasesOf(await mergedSessions(mounted)).length, 3)
    await setGateway('disabled')
    await waitLan(false)
    assert.equal(aliasesOf(await mergedSessions(mounted)).length, 3, 'retained while merely disconnected')

    // Explicit forget: the one thing that ends the retention.
    const removed = await mounted.call('DELETE', `/devices/remotes/${remoteId}`)
    assert.equal(removed.status, 200, removed.text)
    const after = await mergedSessions(mounted)
    assert.deepEqual(aliasesOf(after), [], 'a forgotten host leaves nothing behind, not even a retained row')
    const listed = await listOf(mounted)
    assert.deepEqual(listed.routing.disconnected, [], 'and it is not reported as disconnected either')
    await ensureGatewayOn()
  } finally { await mounted.close() }

  // A revoke (4401) is the other explicit end: the grant is gone, so the rows are not
  // "briefly away", they are sessions this device may no longer read.
  const second = await mountWithCarrier()
  try {
    await until(async () => (await viewOf(second.mounted, second.remoteId)).status === 'online', 'the second pairing online')
    assert.equal(aliasesOf(await mergedSessions(second.mounted)).length, 3)
    // THIS remote's own device row: the fixture gateway still holds the devices of the
    // earlier checks, and revoking one of those would prove nothing.
    const deviceId = (await viewOf(second.mounted, second.remoteId)).device.id
    assert.equal((await gateway.post(`devices/${deviceId}/revoke`)).status, 200)
    await until(async () => (await viewOf(second.mounted, second.remoteId)).status === 'revoked', 'the revoke to land')
    await until(async () => aliasesOf(await mergedSessions(second.mounted)).length === 0,
      'the retained rows to go with the revoked grant')
    const listed = await listOf(second.mounted)
    assert.equal(listed.routing.disconnected.some((host) => host.hostId === second.remoteId), false,
      'a revoked host is not "disconnected": the grant is gone, not the link')
  } finally { second.mounted.close() }
})

await check('a refusal from the host is not retention: a short grant lists nothing', async () => {
  // The distinction the retention must keep: a transport failure means "away for a
  // moment" (keep the rows), a refusal means "nothing for you" (drop them). A read-only
  // desktop re-paired with a scope that cannot list gets the second answer.
  const { mounted, remoteId } = await mountWithCarrier()
  try {
    await until(async () => (await viewOf(mounted, remoteId)).status === 'online', 'the pairing online')
    assert.equal(aliasesOf(await mergedSessions(mounted)).length, 3)
    // A host that answers with an error is simulated on the connection the router sees:
    // the same shape a `auth/forbidden-scope` refusal arrives in.
    const entry = mounted.instance.live.get(remoteId)
    const realCall = entry.connection.call.bind(entry.connection)
    entry.connection.call = async (endpoint, args, options) => {
      if (endpoint === 'session/list') throw Object.assign(new Error('scope refused'), { code: 'auth/forbidden-scope', scope: 'harness:remote' })
      return realCall(endpoint, args, options)
    }
    const refused = await mergedSessions(mounted)
    assert.equal(refused.ok, true, 'a refused remote must not fail the merged list')
    assert.deepEqual(aliasesOf(refused), [], 'a refused list is not "retained": the grant no longer covers it')
  } finally { await ensureGatewayOn(); mounted.close() }
})

await gateway.close()
finish('disconnect-retention')
