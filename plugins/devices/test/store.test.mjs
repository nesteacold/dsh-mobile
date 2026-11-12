// FR3: tokens are stored per remote in an owner-only file, never logged or
// returned, and wiped when the remote closes with 4401 (device revoked).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'

import { WebSocketServer, check, delay, finish, mountPlugin, pinOf, selfsigned, skip } from './helpers.mjs'
import { icaclsArgs, setSecureFileTestHooks } from '../lib/secure-file.mjs'

console.log('store')
const generated = await selfsigned.generate([{ name: 'commonName', value: 'fake-remote' }], { days: 1, keySize: 2048, algorithm: 'sha256',
  extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }] })
const TOKEN = 'S'.repeat(43)
const CODE = 'B'.repeat(43)
const GATEWAY_ID = '22222222-2222-4222-8222-222222222222'

/** Fake remote: pairing hands out TOKEN; an authenticated connection can be closed with any code on demand. */
async function fakeRemote() {
  const server = https.createServer({ cert: generated.cert, key: generated.private })
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (set) => (set.has('dsh-mobile-v1') ? 'dsh-mobile-v1' : false) })
  const state = { authenticated: [], connections: 0, rejectToken: false }
  server.on('upgrade', (req, socket, head) => {
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (bearer && bearer !== TOKEN) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => {
      state.connections += 1
      if (protocols.includes('dsh-pair.')) {
        ws.send(JSON.stringify({ kind: 'paired', token: TOKEN, device: { id: 'dev-1', kind: 'desktop', scopes: ['sessions:read'] }, gatewayId: GATEWAY_ID }))
      } else state.authenticated.push(ws)
      ws.send(JSON.stringify({ kind: 'hello', authenticated: true, device: { id: 'dev-1', kind: 'desktop', scopes: ['sessions:read'] } }))
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString())
        if (frame.type === 'sessions') ws.send(JSON.stringify({ kind: 'sessions', requestId: frame.requestId, items: [{ sessionId: 's1' }] }))
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return { state, address: `127.0.0.1:${port}`, url: `wss://127.0.0.1:${port}/ws/mobile`,
    close: () => { wss.close(); server.closeAllConnections?.(); server.close() } }
}
const pairingFor = (remote) => Buffer.from(JSON.stringify({ version: 3, publicUrl: remote.url, pairingCode: CODE,
  expiresAt: Date.now() + 120_000, certSha256: pinOf(generated.cert), gatewayId: GATEWAY_ID, gatewayName: 'fake', endpoints: [remote.url] })).toString('base64url')

const mounted = await mountPlugin({ requestTimeoutMs: 4000 })
const remote = await fakeRemote()
const tokensDir = path.join(mounted.dataDir, 'tokens')
let remoteId

await check('pairing stores the token in tokens/<id>.token, outside remotes.json, never in a response or log', async () => {
  const answer = await mounted.call('POST', '/devices/remotes', { body: { address: remote.address, pairingString: pairingFor(remote) } })
  assert.equal(answer.status, 201, answer.text)
  remoteId = answer.json.remote.id
  const file = path.join(tokensDir, `${remoteId}.token`)
  assert.equal(fs.readFileSync(file, 'utf8'), TOKEN)
  assert.ok(!fs.readFileSync(path.join(mounted.dataDir, 'remotes.json'), 'utf8').includes(TOKEN), 'remotes.json holds no secret')
  assert.ok(!answer.text.includes(TOKEN))
  assert.ok(!mounted.logs.some((line) => line.includes(TOKEN) || line.includes(CODE)))
  assert.equal(answer.json.remote.device.kind, 'desktop')
})

await check('token file permissions: 0600 on POSIX; owner-only ACL requested on Windows', async () => {
  const file = path.join(tokensDir, `${remoteId}.token`)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'token file')
    assert.equal(fs.statSync(tokensDir).mode & 0o777, 0o700, 'tokens dir')
    assert.equal(fs.statSync(path.join(mounted.dataDir, 'remotes.json')).mode & 0o777, 0o600, 'remotes.json')
    return
  }
  // NTFS ignores POSIX modes (Node reports 0666), so the guarantee is the ACL.
  // Assert the exact icacls invocation the plugin makes, through the runner seam.
  const calls = []
  const restore = setSecureFileTestHooks({ run: (command, args) => { calls.push([command, args]) } })
  try {
    const fresh = await mountPlugin({ requestTimeoutMs: 4000 })
    const other = await fakeRemote()
    try {
      const answer = await fresh.call('POST', '/devices/remotes', { body: { address: other.address, pairingString: pairingFor(other) } })
      assert.equal(answer.status, 201, answer.text)
      const tokenCall = calls.find(([, args]) => args[0].endsWith('.token'))
      assert.ok(tokenCall, `no icacls call for the token file: ${JSON.stringify(calls.map((call) => call[1][0]))}`)
      assert.equal(tokenCall[0], 'icacls')
      const user = (await import('node:os')).userInfo().username
      assert.deepEqual(tokenCall[1].slice(1), ['/inheritance:r', '/grant:r', `${user}:F`, '/c'])
      assert.ok(calls.some(([, args]) => args[0] === path.join(fresh.dataDir, 'tokens') && args[3].endsWith(':(OI)(CI)F')), 'tokens dir restricted too')
    } finally { other.close(); fresh.close() }
  } finally { restore() }
  assert.deepEqual(icaclsArgs('C:\\x', 'file', 'fixture-user'), ['C:\\x', '/inheritance:r', '/grant:r', 'fixture-user:F', '/c'])
  // Real ACL check where the sandbox lets us spawn; otherwise say so instead of passing silently.
  const real = spawnSync('icacls', [file], { encoding: 'utf8', windowsHide: true })
  if (real.error) skip('real icacls ACL read-back', `spawn unavailable: ${real.error.code}`)
  else {
    const user = (await import('node:os')).userInfo().username
    const lines = real.stdout.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('Successfully'))
    assert.ok(lines.length >= 1 && lines.every((line, index) => index === 0 || line.includes(user)), `ACL not owner-only:\n${real.stdout}`)
  }
})

await check('the live connection works with the stored token (sessions round trip)', async () => {
  const answer = await mounted.call('GET', `/devices/remotes/${remoteId}/sessions`)
  assert.equal(answer.status, 200, answer.text)
  assert.deepEqual(answer.json.sessions, [{ sessionId: 's1' }])
  assert.equal((await mounted.call('GET', `/devices/remotes/${remoteId}`)).json.remote.status, 'online')
  assert.equal(remote.state.authenticated.length, 1, 'one live connection per remote')
  await mounted.call('GET', `/devices/remotes/${remoteId}/sessions`)
  assert.equal(remote.state.authenticated.length, 1, 'a second request reuses it')
})

await check('close 4401 wipes the token, marks the remote revoked and does not reconnect', async () => {
  const file = path.join(tokensDir, `${remoteId}.token`)
  assert.ok(fs.existsSync(file))
  const before = remote.state.connections
  for (const ws of remote.state.authenticated) ws.close(4401, 'device revoked')
  for (let attempt = 0; attempt < 100 && fs.existsSync(file); attempt += 1) await delay(20)
  assert.equal(fs.existsSync(file), false, 'token file deleted')
  const listed = (await mounted.call('GET', '/devices/remotes')).json.remotes[0]
  assert.equal(listed.status, 'revoked')
  assert.deepEqual(listed.approvals, [])
  assert.match(mounted.logs.join('\n'), /revoked this device \(4401\); token wiped/)
  // Persisted: survives a restart, and requests are refused without dialing again.
  const persisted = JSON.parse(fs.readFileSync(path.join(mounted.dataDir, 'remotes.json'), 'utf8'))
  assert.equal(persisted.remotes[0].revoked, true)
  const refused = await mounted.call('GET', `/devices/remotes/${remoteId}/sessions`)
  assert.equal(refused.status, 401)
  assert.equal(refused.json.error, 'auth/revoked')
  await delay(150)
  assert.equal(remote.state.connections, before, 'no reconnect attempt after 4401')
  assert.ok(!mounted.logs.some((line) => line.includes(TOKEN)))
})

await check('removing a remote deletes its token file and record', async () => {
  const other = await fakeRemote()
  try {
    const answer = await mounted.call('POST', '/devices/remotes', { body: { address: other.address, pairingString: pairingFor(other) } })
    assert.equal(answer.status, 201, answer.text)
    const id = answer.json.remote.id
    const file = path.join(tokensDir, `${id}.token`)
    assert.ok(fs.existsSync(file))
    assert.equal((await mounted.call('DELETE', `/devices/remotes/${id}`)).status, 200)
    assert.equal(fs.existsSync(file), false)
    assert.equal((await mounted.call('GET', `/devices/remotes/${id}`)).status, 404)
  } finally { other.close() }
})

// --- PATCH /devices/remotes/:id — the endpoint an owner edits when the other
// machine's Tailscale IP moves, instead of forgetting the host and pairing it
// again. One record, one pin: only `address`/`publicUrl` change.
console.log('store: address edit')
const edited = await mountPlugin({ requestTimeoutMs: 4000 })
const before = await fakeRemote()
const target = await fakeRemote()
const patch = (body, id) => edited.call('PATCH', `/devices/remotes/${id}`, { body })
const recordOnDisk = (id) => JSON.parse(fs.readFileSync(path.join(edited.dataDir, 'remotes.json'), 'utf8')).remotes.find((record) => record.id === id)
const until = async (predicate, what) => {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await predicate()) return
    await delay(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}
let movedId
let original
// Dials to the OLD address at the moment the edit lands (pairing handshake + the
// authenticated dial), so a late redial to the superseded endpoint shows up as a delta.
let oldAddressDials = 0
try {
  await check('pairing the host that will move (control: it connects to the old address)', async () => {
    const answer = await edited.call('POST', '/devices/remotes', { body: { address: before.address, pairingString: pairingFor(before) } })
    assert.equal(answer.status, 201, answer.text)
    movedId = answer.json.remote.id
    original = answer.json.remote
    assert.equal(original.address, before.address)
    // The public view has never carried `publicUrl` (it shows `address`); the record does.
    assert.equal(recordOnDisk(movedId).publicUrl, before.url)
    await until(() => before.state.authenticated.length === 1, 'the first connection')
    await until(async () => (await edited.call('GET', `/devices/remotes/${movedId}`)).json.remote.status === 'online', 'the link to report online')
    oldAddressDials = before.state.connections
  })

  await check('invalid scheme, missing port, public host and a bad url are refused like the add path, and nothing changes', async () => {
    const refusals = [
      ['ws://127.0.0.1:3081/ws/mobile', 400, 'bad-request', /look like/],
      ['http://127.0.0.1:3081/ws/mobile', 400, 'bad-request', /look like/],
      ['wss://user:pw@127.0.0.1:3081/ws/mobile', 400, 'bad-request', /look like/],
      ['wss://127.0.0.1/ws/mobile', 400, 'bad-request', /must include a port/],
      ['wss://127.0.0.1:3081/ws/mobile?x=1', 400, 'bad-request', /look like/],
      ['wss://203.0.113.9:3081/ws/mobile', 403, 'forbidden', /private-network/],
      ['wss://example.com:3081/ws/mobile', 403, 'forbidden', /private-network/],
      ['', 400, 'bad-request', /required/],
    ]
    for (const [url, status, code, message] of refusals) {
      const answer = await patch({ url }, movedId)
      assert.equal(answer.status, status, `${url || '(empty)'}: ${answer.text}`)
      assert.equal(answer.json.error, code, `${url || '(empty)'}: ${answer.text}`)
      assert.match(answer.json.message, message)
    }
    const missing = await patch({}, movedId)
    assert.equal(missing.status, 400)
    assert.match(missing.json.message, /required/)
    // A refused edit leaves the record AND the live link exactly as they were.
    const current = (await edited.call('GET', `/devices/remotes/${movedId}`)).json.remote
    assert.equal(current.address, before.address)
    assert.equal(recordOnDisk(movedId).publicUrl, before.url)
    assert.equal(current.status, 'online')
    assert.equal(before.state.authenticated.length, 1, 'the old link was not torn down')
  })

  await check('PATCH stores the new endpoint and keeps id, name and the pin', async () => {
    const answer = await patch({ url: target.url }, movedId)
    assert.equal(answer.status, 200, answer.text)
    assert.equal(answer.json.remote.id, movedId)
    assert.equal(answer.json.remote.name, original.name)
    assert.equal(answer.json.remote.certSha256, original.certSha256, 'the pin is untouched')
    assert.equal(answer.json.remote.address, new URL(target.url).host)
    const record = recordOnDisk(movedId)
    assert.equal(record.address, new URL(target.url).host)
    assert.equal(record.publicUrl, target.url)
    assert.equal(record.id, original.id)
    assert.equal(record.name, original.name)
    assert.equal(record.certSha256, original.certSha256)
    assert.equal(record.gatewayId, original.gatewayId)
    assert.equal(record.createdAt, original.createdAt)
    assert.ok(!fs.readFileSync(path.join(edited.dataDir, 'remotes.json'), 'utf8').includes(TOKEN), 'remotes.json still holds no token')
  })

  await check('a connected link is redialled at the new address (old socket closed, no dial to the old one)', async () => {
    await until(() => target.state.authenticated.length === 1, 'a connection at the new address')
    await until(() => before.state.authenticated.every((ws) => ws.readyState === 3), 'the old socket to close')
    await until(async () => (await edited.call('GET', `/devices/remotes/${movedId}`)).json.remote.status === 'online', 'the link to report online again')
    assert.ok(oldAddressDials >= 2, `baseline captured (${oldAddressDials})`)
    assert.equal(before.state.connections, oldAddressDials, 'the superseded address is not dialled again')
  })

  await check('a url that would change the pin is refused and the pin stays put', async () => {
    const otherPin = original.certSha256 === 'f'.repeat(64) ? '0'.repeat(64) : 'f'.repeat(64)
    const forged = await patch({ url: target.url, certSha256: otherPin }, movedId)
    assert.equal(forged.status, 409, forged.text)
    assert.equal(forged.json.error, 'pin-immutable')
    assert.match(forged.json.message, /never changes the certificate pin/)
    assert.equal(recordOnDisk(movedId).certSha256, original.certSha256)
    // Sending the pin that is already recorded is not an attempt to change it.
    const same = await patch({ url: target.url, certSha256: original.certSha256.toUpperCase() }, movedId)
    assert.equal(same.status, 200, same.text)
    assert.equal(same.json.remote.certSha256, original.certSha256)
  })

  await check('a bare host:port keeps the pairing path instead of resetting it', async () => {
    const answer = await patch({ url: target.address }, movedId)
    assert.equal(answer.status, 200, answer.text)
    assert.equal(answer.json.remote.address, target.address)
    assert.equal(recordOnDisk(movedId).publicUrl, `wss://${target.address}/ws/mobile`)
  })

  await check('unknown ids are the existing 404 not-found, and so is an unsupported method', async () => {
    const unknown = await patch({ url: target.url }, '00000000-0000-4000-8000-000000000001')
    assert.equal(unknown.status, 404, unknown.text)
    assert.deepEqual(unknown.json, { error: 'not-found', message: 'unknown remote device' })
    assert.equal((await patch({ url: target.url }, 'not-a-uuid')).status, 404)
    assert.equal((await edited.call('PUT', `/devices/remotes/${movedId}`, { body: { url: target.url } })).status, 404)
    assert.equal(recordOnDisk(movedId).publicUrl, `wss://${target.address}/ws/mobile`, 'no refused call wrote the record')
  })

  await check('PATCH racing a DELETE: a remote removed while the body is read is a 404, not a 500', async () => {
    const racer = await fakeRemote()
    try {
      // A distinct gatewayId: pairing the same gateway again replaces its record.
      const racerPairing = Buffer.from(JSON.stringify({ version: 3, publicUrl: racer.url, pairingCode: CODE,
        expiresAt: Date.now() + 120_000, certSha256: pinOf(generated.cert), gatewayId: '33333333-3333-4333-8333-333333333333',
        gatewayName: 'racer', endpoints: [racer.url] })).toString('base64url')
      const added = await edited.call('POST', '/devices/remotes', { body: { address: racer.address, pairingString: racerPairing } })
      assert.equal(added.status, 201, added.text)
      const id = added.json.remote.id
      assert.notEqual(id, movedId, 'the racer is its own record')
      // `requireRemote` has already passed when the body starts arriving; the DELETE
      // lands in between, so `store.update` finds nothing to update.
      const answer = await new Promise((resolve) => {
        const body = Buffer.from(JSON.stringify({ url: racer.url }))
        const req = {
          method: 'PATCH', url: `/devices/remotes/${id}`, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' },
          on(event, handler) {
            if (event === 'data') queueMicrotask(() => handler(body))
            if (event === 'end') {
              queueMicrotask(async () => {
                assert.equal((await edited.call('DELETE', `/devices/remotes/${id}`)).status, 200)
                handler()
              })
            }
            return req
          },
        }
        const res = {
          writeHead(status) { res.status = status },
          end(text) { resolve({ status: res.status, json: text ? JSON.parse(text) : undefined }) },
        }
        edited.route().handler(req, res)
      })
      assert.equal(answer.status, 404, JSON.stringify(answer.json))
      assert.deepEqual(answer.json, { error: 'not-found', message: 'unknown remote device' })
      assert.equal((await edited.call('GET', `/devices/remotes/${id}`)).status, 404, 'the remote stays gone')
    } finally { racer.close() }
  })

  await check('an explicit :443 is a typed port (accepted); a genuinely absent port is still refused', async () => {
    // 127.0.0.1 is private, so only the port rule is under test; nothing listens on :443
    // and the dial failing afterwards is irrelevant to the stored record.
    for (const [url, publicUrl] of [
      ['127.0.0.1:443', 'wss://127.0.0.1/ws/mobile'],
      ['wss://127.0.0.1:443/ws/mobile', 'wss://127.0.0.1/ws/mobile'],
    ]) {
      const accepted = await patch({ url }, movedId)
      assert.equal(accepted.status, 200, `${url}: ${accepted.text}`)
      assert.equal(recordOnDisk(movedId).publicUrl, publicUrl, url)
    }
    for (const url of ['127.0.0.1', 'wss://127.0.0.1/ws/mobile']) {
      const refused = await patch({ url }, movedId)
      assert.equal(refused.status, 400, `${url}: ${refused.text}`)
      assert.match(refused.json.message, /must include a port/, url)
    }
    // Put the record back on the live fixture so the checks below keep a reachable endpoint.
    assert.equal((await patch({ url: target.url }, movedId)).status, 200)
  })

  await check('the record is written through the atomic writer (parses at once, no temp file left)', async () => {
    const file = path.join(edited.dataDir, 'remotes.json')
    assert.equal((await patch({ url: target.url }, movedId)).status, 200)
    // One rename over the live name: the file is never observed half-written, and
    // the temp the writer stages under never survives it.
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).remotes.find((record) => record.id === movedId).publicUrl, target.url)
    assert.deepEqual(fs.readdirSync(edited.dataDir).filter((name) => /\.tmp$/.test(name)), [])
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'owner-only, as every mutation leaves it')
  })
} finally {
  before.close()
  target.close()
  edited.close()
}

remote.close()
mounted.close()
finish('store')
