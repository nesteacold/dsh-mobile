// Spec 013 R3 — the mandatory attachment-upload checks, one named test each.
//
// Part A drives the transfer manager the admin upload frames already use
// (`lib/file-upload.mjs`) through the spec-013 envelope, so every refusal is
// asserted against its exact code. Part B runs the plugin's real `apply()` on a
// fake Host over the TLS listener and asserts the authorization decisions the
// router owns (scope, device kind, session visibility, per-device cap) plus the
// receipt pass-through the devices plugin will rely on.
//
// R2: the frames are `remote-upload-open|chunk|finish|cancel`, answered with ONE
// `remote-upload-result` per request. Nothing here adds a listener or a port.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'

import WebSocket from 'ws'
import plugin from '../lib/index.mjs'
import * as contract from '@dsh-ext/mobile-protocol'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import { isRemoteUploadType, scopeDenial } from '../lib/allowlist.mjs'
import { hostEndpointAllowedForDevice } from '../lib/companion-access.mjs'
import { authorizeEndpoint } from '../lib/remote-bridge.mjs'
import {
  createFileUploadManager, handleRemoteUpload, REMOTE_UPLOAD_REQUEST_TYPES, REMOTE_UPLOAD_RESULT_KIND,
} from '../lib/file-upload.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

// The two lists must name the same four frames: the contract is the source of
// truth and the manager keeps its own set so an installed tarball needs no
// resolve. A drift here is exactly the kind of split this project forbids.
test('R2: the manager serves exactly the contract REMOTE_UPLOAD_CLIENT_TYPES', () => {
  assert.deepEqual([...REMOTE_UPLOAD_REQUEST_TYPES].sort(), [...contract.REMOTE_UPLOAD_CLIENT_TYPES].sort())
  for (const type of contract.REMOTE_UPLOAD_CLIENT_TYPES) assert.equal(isRemoteUploadType(type), true, type)
  assert.equal(REMOTE_UPLOAD_RESULT_KIND, contract.REMOTE_UPLOAD_RESULT_KIND)
  assert.equal(contract.ATTACHMENTS_WRITE_SCOPE, 'attachments:write')
})

// ---------------------------------------------------------------------------
// Part A — the transfer manager through the spec-013 envelope
// ---------------------------------------------------------------------------

function fixture(options = {}) {
  const stored = []
  const api = {
    sessions: { list: async () => ({ items: [{ sessionId: 's1' }, { sessionId: 's2' }] }) },
    files: {
      available: () => true,
      async upload({ sessionId, name, data, mediaType }, signal) {
        const chunks = []
        for await (const chunk of data) { signal.throwIfAborted(); chunks.push(chunk) }
        const bytes = Buffer.concat(chunks)
        stored.push({ sessionId, name, mediaType, bytes })
        const attachmentId = `sha256:${digest(bytes)}`
        // The Host's own receipt shapes (`FileUploads.upload{,Image}Stream`).
        return mediaType === undefined
          ? { receiptId: `receipt-${stored.length}`, file: { attachmentId, name, bytes: bytes.length } }
          : { receiptId: `receipt-${stored.length}`, image: { attachmentId, mediaType, bytes: bytes.length, width: 640, height: 480 } }
      },
    },
  }
  const manager = createFileUploadManager(api, {
    fileUploadChunkBytes: 4,
    imageLimits: () => ({ mediaTypes: ['image/png', 'image/jpeg'], maxImageBytes: 50 * 1024 * 1024 }),
    ...options,
  })
  const client = {}
  let counter = 0
  const send = async (type, args = {}, owner = client) => {
    const frame = await handleRemoteUpload(manager, owner, { type, requestId: `upload-${++counter}`, ...args })
    assert.equal(frame.kind, REMOTE_UPLOAD_RESULT_KIND, JSON.stringify(frame))
    return frame
  }
  const open = (bytes, args = {}, owner = client) => send('remote-upload-open',
    { sessionId: 's1', kind: 'file', name: 'report.pdf', size: bytes.length, sha256: digest(bytes), ...args }, owner)
  const chunk = (uploadId, bytes, offset = 0, owner = client) => send('remote-upload-chunk',
    { uploadId, offset, data: bytes.toString('base64') }, owner)
  /** Every chunk of `bytes` in the manager's own chunk size, so a test never trips the chunk bound. */
  const sendAll = async (uploadId, bytes, chunkBytes = 4, owner = client) => {
    let offset = 0
    while (offset < bytes.length) {
      const slice = bytes.subarray(offset, offset + chunkBytes)
      const accepted = await chunk(uploadId, slice, offset, owner)
      assert.equal(accepted.ok, true, JSON.stringify(accepted))
      offset = accepted.value.nextOffset
    }
  }
  return { api, manager, client, stored, send, open, chunk, sendAll }
}

test('R3-1 scope: a device without attachments:write is refused, one holding it passes the scope gate', () => {
  for (const type of contract.REMOTE_UPLOAD_CLIENT_TYPES) {
    const refused = scopeDenial({ kind: 'desktop', scopes: ['sessions:read'] }, type)
    assert.equal(refused.code, 'auth/forbidden-scope', type)
    assert.equal(refused.scope, 'attachments:write', type)
    assert.equal(scopeDenial({ kind: 'desktop', scopes: ['attachments:write'] }, type), undefined, type)
    // No record at all grants nothing.
    assert.equal(scopeDenial(undefined, type).code, 'auth/forbidden-scope', type)
  }
  // The scope IS the gate (spec 012): a phone holding `attachments:write` passes it
  // exactly as a desktop does, so nothing here depends on the device kind.
  assert.equal(scopeDenial({ kind: 'mobile', scopes: ['attachments:write'] }, 'remote-upload-open'), undefined)
})

test('R3-3 monotonic offset: an out-of-order chunk is refused and the accepted offset is kept', async (t) => {
  const f = fixture()
  t.after(() => f.manager.dispose())
  const bytes = Buffer.from('abcdef')
  const opened = await f.open(bytes)
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const { uploadId } = opened.value
  assert.equal(opened.value.kind, 'file')
  assert.equal(opened.value.chunkBytes, 4)
  assert.equal(opened.value.size, 6)
  // First chunk accepted at 0.
  assert.deepEqual((await f.chunk(uploadId, bytes.subarray(0, 4), 0)).value.nextOffset, 4)
  // Same bytes again, and a later offset: both refused, the transfer keeps working.
  for (const offset of [0, 2, 6]) {
    const reply = await f.chunk(uploadId, bytes.subarray(0, 4), offset)
    assert.equal(reply.ok, false, `offset ${offset} must be refused`)
    assert.equal(reply.error.code, 'file-upload-offset', `offset ${offset}`)
  }
  assert.deepEqual((await f.chunk(uploadId, bytes.subarray(4), 4)).value.nextOffset, 6)
})

test('R3-4 canonical base64: non-canonical, empty and oversized chunks are refused', async (t) => {
  const f = fixture()
  t.after(() => f.manager.dispose())
  const bytes = Buffer.from('abcdef')
  const { uploadId } = (await f.open(bytes)).value
  // `YQ` is valid base64url-ish input but not the canonical padded form, and it
  // does not round-trip; `!!` is not base64 at all.
  for (const data of ['YQ', '!!', '', 'YWJjZGVmZw==']) {
    const reply = await f.send('remote-upload-chunk', { uploadId, offset: 0, data })
    assert.equal(reply.ok, false, `data ${JSON.stringify(data)} must be refused`)
    assert.equal(reply.error.code, 'file-upload-invalid-data', JSON.stringify(data))
  }
  // A chunk above `chunkBytes` (4 here) is refused the same way.
  const oversized = await f.chunk(uploadId, Buffer.from('abcde'), 0)
  assert.equal(oversized.error.code, 'file-upload-invalid-data')
  // The canonical form is accepted.
  assert.equal((await f.chunk(uploadId, bytes.subarray(0, 4), 0)).ok, true)
})

test('R3-5 sha256: the whole file is verified at finish and nothing is stored on a mismatch', async (t) => {
  const f = fixture()
  t.after(() => f.manager.dispose())
  const bytes = Buffer.from('abcdef')
  const { uploadId } = (await f.open(bytes, { sha256: '0'.repeat(64) })).value
  await f.sendAll(uploadId, bytes)
  const finished = await f.send('remote-upload-finish', { uploadId })
  assert.equal(finished.ok, false)
  assert.equal(finished.error.code, 'file-upload-checksum')
  assert.deepEqual(f.stored, [], 'a checksum failure must not reach the Host')
  // The spool is gone: the transfer cannot be completed afterwards.
  assert.equal((await f.send('remote-upload-finish', { uploadId })).error.code, 'file-upload-not-found')
})

test('R3-6 total size: size above fileUploadMaxBytes is refused at open, and a chunk may not exceed it', async (t) => {
  const f = fixture({ fileUploadMaxBytes: 8 })
  t.after(() => f.manager.dispose())
  const tooBig = await f.open(Buffer.alloc(9))
  assert.equal(tooBig.ok, false)
  assert.equal(tooBig.error.code, 'file-too-large')
  // Declared 3 bytes, then a legal 4-byte chunk that would cross the declaration.
  const { uploadId } = (await f.open(Buffer.alloc(3))).value
  const overrun = await f.chunk(uploadId, Buffer.from('abcd'), 0)
  assert.equal(overrun.error.code, 'file-upload-size')
})

test('R3-7 chunk size: chunkBytes is min(256 KiB, the payload budget) and the payload budget lowers it', async (t) => {
  const f = fixture()
  t.after(() => f.manager.dispose())
  const opened = (await f.open(Buffer.from('abc'))).value
  assert.equal(opened.chunkBytes, 4, 'the configured fileUploadChunkBytes is the effective bound here')
  // A gateway whose WS payload budget is below 256 KiB advertises the smaller
  // chunk size, which is what R3 pins: chunk <= min(256 KiB, maxPayloadBytes).
  const big = fixture({ fileUploadChunkBytes: contract.REMOTE_UPLOAD_MAX_CHUNK_BYTES })
  t.after(() => big.manager.dispose())
  const advertised = (await big.open(Buffer.from('abc'))).value
  assert.equal(advertised.chunkBytes, contract.REMOTE_UPLOAD_MAX_CHUNK_BYTES)
  const small = fixture({ fileUploadChunkBytes: contract.REMOTE_UPLOAD_MAX_CHUNK_BYTES, maxPayloadBytes: 64 * 1024 })
  t.after(() => small.manager.dispose())
  const narrowed = (await small.open(Buffer.from('abc'))).value
  assert.ok(narrowed.chunkBytes < 64 * 1024, `chunkBytes must follow the payload budget: ${narrowed.chunkBytes}`)
  assert.ok(narrowed.chunkBytes <= contract.REMOTE_UPLOAD_MAX_CHUNK_BYTES)
})

test('R3-9 concurrent transfers: the manager enforces a global backstop and reports per-client slots', async (t) => {
  const f = fixture({ fileUploadMaxTransfers: 1 })
  t.after(() => f.manager.dispose())
  const bytes = Buffer.from('abc')
  const first = await f.open(bytes)
  assert.equal(first.ok, true)
  assert.equal(f.manager.activeTransfers(f.client), 1)
  // The manager refuses ANY further transfer at the cap: its own bound is global,
  // the per-DEVICE bound is the router's (see the router test below), and this is
  // the backstop behind it.
  const blocked = await f.open(bytes)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error.code, 'file-upload-limit')
  const otherClient = {}
  assert.equal(f.manager.activeTransfers(otherClient), 0, 'another client holds no slot of its own')
  // Cancelling the first frees the slot for anyone.
  assert.equal((await f.send('remote-upload-cancel', { uploadId: first.value.uploadId })).value.cancelled, true)
  assert.equal(f.manager.activeTransfers(f.client), 0)
  assert.equal((await f.open(bytes)).ok, true)
  assert.equal(f.manager.activeTransfers(otherClient), 0)
})

test('R3-10 idle timeout: an idle transfer expires, its spool is deleted and its slot freed', async (t) => {
  // Observe the spool by pointing the OS temp dir at a directory of our own. All three variables
  // are set because `os.tmpdir()` reads TMPDIR on POSIX and TEMP then TMP on Windows.
  const spoolRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-upload-idle-'))
  const TEMP_VARS = ['TMPDIR', 'TEMP', 'TMP']
  const savedTemp = new Map(TEMP_VARS.map((name) => [name, process.env[name]]))
  for (const name of TEMP_VARS) process.env[name] = spoolRoot
  const f = fixture({ fileUploadIdleMs: -1, fileUploadMaxTransfers: 1 })
  t.after(async () => {
    await f.manager.dispose()
    // Restore by DELETING what was unset: assigning `undefined` stores the string "undefined",
    // after which `os.tmpdir()` answers "undefined" for every later test in this file (POSIX has
    // no TEMP/TMP at all, so that is the normal case on CI).
    for (const name of TEMP_VARS) {
      const value = savedTemp.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await fsp.rm(spoolRoot, { recursive: true, force: true })
  })
  const bytes = Buffer.from('abcdef')
  const { uploadId } = (await f.open(bytes)).value
  await f.chunk(uploadId, bytes.subarray(0, 3))
  assert.equal((await fsp.readdir(spoolRoot)).length, 1, 'the partial bytes are spooled while the transfer lives')
  await f.manager.expire()
  assert.deepEqual(await fsp.readdir(spoolRoot), [], 'the partial data is deleted by the idle timeout')
  // The slot is free again and the transfer is unknown.
  assert.equal(f.manager.activeTransfers(f.client), 0)
  const after = await f.chunk(uploadId, bytes.subarray(0, 3), 0)
  assert.equal(after.ok, false)
  assert.equal(after.error.code, 'file-upload-not-found')
  assert.equal((await f.open(bytes)).ok, true)
})

test('R3-11 image media type: checked against the Host imageLimits before a byte moves', async (t) => {
  const f = fixture()
  t.after(() => f.manager.dispose())
  const bytes = Buffer.from('89504e47', 'hex')
  const reject = await f.open(bytes, { kind: 'image', mediaType: 'image/svg+xml', name: undefined })
  assert.equal(reject.ok, false)
  assert.equal(reject.error.code, 'session/attachment-invalid')
  assert.match(reject.error.message, /not accepted by this deployment/)
  // mediaType is required for an image and forbidden for a file.
  assert.equal((await f.open(bytes, { kind: 'image' })).error.code, 'bad-request')
  assert.equal((await f.open(bytes, { kind: 'file', mediaType: 'image/png' })).error.code, 'bad-request')
  // A Host without an attachment service cannot stage images at all.
  const bare = fixture({ imageLimits: () => undefined })
  t.after(() => bare.manager.dispose())
  const unavailable = await bare.open(bytes, { kind: 'image', mediaType: 'image/png' })
  assert.equal(unavailable.error.code, 'file-upload-unavailable')
  // The accepted type moves and is staged as an image.
  const opened = await f.open(bytes, { kind: 'image', mediaType: 'image/png', name: undefined })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  assert.equal(opened.value.kind, 'image')
  assert.equal(opened.value.mediaType, 'image/png')
  assert.equal(Object.hasOwn(opened.value, 'name'), false, 'an omitted name stays omitted')
  await f.chunk(opened.value.uploadId, bytes)
  const finished = await f.send('remote-upload-finish', { uploadId: opened.value.uploadId })
  assert.equal(finished.ok, true, JSON.stringify(finished))
  assert.equal(f.stored[0].mediaType, 'image/png')
})

// ---------------------------------------------------------------------------
// R2 — the receipt is the Host's own value, passed through opaque
// ---------------------------------------------------------------------------

test('R2 file receipt: finish answers exactly the Host value the native upload route returns', async (t) => {
  const f = fixture()
  t.after(() => f.manager.dispose())
  const bytes = Buffer.from([0, 255, 1, 10, 13, 128, 42])
  const opened = (await f.open(bytes)).value
  await f.chunk(opened.uploadId, bytes.subarray(0, 4), 0)
  await f.chunk(opened.uploadId, bytes.subarray(4), 4)
  const finished = await f.send('remote-upload-finish', { uploadId: opened.uploadId })
  assert.equal(finished.ok, true, JSON.stringify(finished))
  assert.deepEqual(finished.value, {
    receiptId: 'receipt-1',
    file: { attachmentId: `sha256:${digest(bytes)}`, name: 'report.pdf', bytes: bytes.length },
  })
  assert.deepEqual(f.stored[0].bytes, bytes, 'the Host received the exact bytes')
  assert.equal(f.stored[0].name, 'report.pdf')
  assert.equal(f.stored[0].mediaType, undefined, 'a file upload carries no mediaType')
  // Repeating finish on the same connection is idempotent and stores nothing twice.
  const again = await f.send('remote-upload-finish', { uploadId: opened.uploadId })
  assert.deepEqual(again.value, finished.value)
  assert.equal(f.stored.length, 1)
})

test('R2 image receipt: an image finishes with the Host image reference and its normalized metadata', async (t) => {
  const f = fixture()
  t.after(() => f.manager.dispose())
  // 6 bytes of fake PNG; the Host decides the stored/normalized size.
  const bytes = Buffer.from('89504e470d0a', 'hex')
  const opened = (await f.open(bytes, { kind: 'image', mediaType: 'image/png' })).value
  await f.chunk(opened.uploadId, bytes.subarray(0, 4), 0)
  await f.chunk(opened.uploadId, bytes.subarray(4), 4)
  const finished = await f.send('remote-upload-finish', { uploadId: opened.uploadId })
  assert.equal(finished.ok, true, JSON.stringify(finished))
  assert.deepEqual(finished.value, {
    receiptId: 'receipt-1',
    image: { attachmentId: `sha256:${digest(bytes)}`, mediaType: 'image/png', bytes: bytes.length, width: 640, height: 480 },
  })
  assert.equal(Object.hasOwn(finished.value, 'file'), false)
})

// ---------------------------------------------------------------------------
// R3 — the generic RPC and the read path
// ---------------------------------------------------------------------------

test('R3: the generic fileUploads/upload RPC stays denied; session/attachment stays allowed for sessions:read', () => {
  const full = { kind: 'desktop', scopes: [...contract.SCOPES] }
  // Deny by default: the generic upload endpoint is not on the allowlist.
  const denied = authorizeEndpoint(full, 'fileUploads/upload')
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'op/forbidden')
  // The device adapter's positive guard refuses it too (second, independent layer).
  assert.equal(hostEndpointAllowedForDevice('fileUploads', 'upload'), false)
  // The existing deny entries are untouched by this revision. (`pluginInventory/list`
  // and `workspace/initializeDefault` used to be among them; spec 012's owner ruling
  // 2026-11-11 made them `plugins:manage` / `workspace:manage`, so the untouched
  // examples are the ones that still are.)
  for (const endpoint of ['credentials/resolve', 'remoteAccess/anything']) {
    assert.equal(authorizeEndpoint(full, endpoint).code, 'op/forbidden', endpoint)
  }
  // The image-preview read: already on the allowlist under sessions:read (revision
  // 4), so a bridge device holding `harness:remote` + `sessions:read` may call it —
  // on a phone exactly as on a desktop (spec 012 rule 3: kind is not policy).
  const attachment = authorizeEndpoint({ kind: 'desktop', scopes: ['sessions:read', 'harness:remote'] }, 'session/attachment')
  assert.deepEqual(attachment, { ok: true, scope: 'sessions:read' })
  assert.deepEqual(authorizeEndpoint({ kind: 'mobile', scopes: ['sessions:read', 'harness:remote'] }, 'session/attachment'),
    { ok: true, scope: 'sessions:read' })
  assert.equal(authorizeEndpoint({ kind: 'mobile', scopes: ['sessions:read'] }, 'session/attachment').ok, false,
    'a phone without harness:remote gets nothing')
  assert.equal(hostEndpointAllowedForDevice('session', 'attachment'), false,
    'the remote bridge uses an owner Peer; the device adapter still denies it directly')
})

// ---------------------------------------------------------------------------
// Part B — the router's own decisions, through the real plugin
// ---------------------------------------------------------------------------

const DESK = 'desk0000-0000-4000-8000-0000000000a1'
const MOBILE = 'mob00000-0000-4000-8000-0000000000a2'
const PHONE = 'mob00000-0000-4000-8000-0000000000a3'
const frames = new WeakMap()
let counter = 0

function record(ws) {
  const seen = []
  frames.set(ws, seen)
  ws.on('message', (data) => { try { seen.push(JSON.parse(data.toString())) } catch { /* not ours */ } })
  ws.on('error', () => {})
  return seen
}
const seenOf = (ws) => frames.get(ws) ?? record(ws)
async function take(ws, predicate, timeoutMs = 5_000) {
  const seen = seenOf(ws)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const frame = seen.find(predicate); if (frame) return frame; await delay(5) }
  throw new Error(`timed out waiting for a frame (saw ${seen.map((frame) => frame.kind).join(', ')})`)
}
const open = (instance, protocols, headers = {}) => instance.track(new WebSocket(instance.lanUrl, protocols, {
  headers: { 'X-DSH-Cert-SHA256': instance.lanPin, ...headers }, origin: undefined, rejectUnauthorized: false,
}))
async function negotiate(ws) {
  const requestId = `hello-${++counter}`
  ws.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: 'test', platform: 'ios' }))
  await take(ws, (frame) => frame.kind === 'client-hello' && frame.requestId === requestId)
}
async function pairDevice(instance, deviceId, offer = {}) {
  const created = await instance.post('pair', { name: deviceId, publicUrl: instance.lanUrl, ...offer })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const ws = open(instance, ['dsh-mobile-v1', `dsh-pair.${created.data.payload.pairingCode}`], { 'X-DSH-Device-ID': deviceId })
  record(ws)
  await once(ws, 'open')
  const paired = await take(ws, (frame) => frame.kind === 'paired')
  await take(ws, (frame) => frame.kind === 'hello')
  await negotiate(ws)
  return { ws, device: paired.device }
}
async function connectToken(instance, token, deviceId) {
  const ws = open(instance, ['dsh-mobile-v1'], { Authorization: `Bearer ${token}`, 'X-DSH-Device-ID': deviceId })
  record(ws)
  await once(ws, 'open')
  await take(ws, (frame) => frame.kind === 'hello')
  await negotiate(ws)
  return ws
}
/**
 * One `remote-upload-*` request, awaiting the answer that echoes its requestId.
 * A successful/refused *transfer* answers `remote-upload-result`; an
 * authorization refusal is an error frame like every other scope refusal, so the
 * helper accepts either and the assertion decides which it must be.
 */
async function upload(ws, frame) {
  const requestId = `up-${++counter}`
  const reply = take(ws, (candidate) => candidate.requestId === requestId
    && (candidate.kind === 'remote-upload-result' || candidate.kind === 'error'))
  ws.send(JSON.stringify({ requestId, ...frame }))
  return reply
}

/**
 * The plugin on a fake Host. `uploads` records what the Host's own
 * `/api/session/uploadFileBinary` route would receive and answers with the
 * receipt shape the real route produces.
 */
async function factory(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-upload-'))
  const uploads = []
  const sockets = []
  const listeners = new Map()
  let management
  let upgrade
  let dispose = () => {}
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
      register(route) { management = route; return () => {} },
      registerUpgrade(route) { upgrade = route; return () => {} },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      async invoke(request) {
        if (request.namespace === 'session' && request.method === 'list') {
          return { items: (options.sessionList ?? ['s1']).map((sessionId) => ({ sessionId })) }
        }
        if (request.namespace === 'session' && request.method === 'search') return { items: [], hasMore: false }
        return {}
      },
      async stream(request) {
        return (async function* () {
          if (request.namespace === 'workspace') yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
          else yield { type: 'baseline', value: { projections: {} } }
          while (!request.signal.aborted) await delay(10)
        })()
      },
    },
    // `ctx.get` is how the plugin reaches an optional Host service; the attachment
    // store is the one whose `imageLimits` the image check reads.
    get(name) {
      if (name !== 'attachments') return undefined
      return { imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        maxImageBytes: 50 * 1024 * 1024 } }
    },
    agentDefaultModel: {},
    on(name, handler) { listeners.set(name, handler); return () => {} },
    effect(fn) { dispose = fn() },
  }
  ctx.connection.createSharedFetchHandler = (channel) => {
    assert.equal(channel, '/api')
    return {
      requestBodyMode: () => 'streaming',
      async fetch(request) {
        const url = new URL(request.url)
        const bytes = Buffer.from(await request.arrayBuffer())
        const mediaType = url.searchParams.get('mediaType')
        uploads.push({ sessionId: url.searchParams.get('sessionId'), name: url.searchParams.get('name'), mediaType, bytes })
        const attachmentId = `sha256:${digest(bytes)}`
        return Response.json({ ok: true, value: mediaType === null
          ? { receiptId: `receipt-${uploads.length}`, file: { attachmentId, name: url.searchParams.get('name'), bytes: bytes.length } }
          : { receiptId: `receipt-${uploads.length}`, image: { attachmentId, mediaType, bytes: bytes.length, width: 2, height: 3 } } })
      },
    }
  }
  await plugin.apply(ctx, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    gatewayWaitTimeoutMs: 60_000,
    gatewayName: `remote-upload-${port}`,
    deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000,
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
    requireHostApproval: false,
    tlsCertificateDir: path.join(directory, 'tls'),
    ...(options.config ?? {}),
  })
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    try { dispose() } catch { /* already disposed */ }
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const instance = {
    uploads, listeners,
    base: `http://127.0.0.1:${port}`,
    track(socket) { sockets.push(socket); return socket },
    async post(route, body) {
      const response = await fetch(`${instance.base}/mgw/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: instance.base }, body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, data: await response.json() }
    },
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await (await fetch(`${instance.base}/mgw/status`)).json()
    if (status.lan?.listening && status.lan.urls.length > 0) {
      instance.lanUrl = status.lan.urls[0]
      instance.lanPin = status.lan.certSha256
      return instance
    }
    if (status.lan?.error) throw new Error(`TLS listener failed: ${status.lan.error}`)
    await delay(20)
  }
  throw new Error('TLS listener did not become ready')
}

test('R3-1/R3-2 router: the frames need attachments:write, and nothing reaches the Host without it', async (t) => {
  const instance = await factory(t)
  // Spec 012: the scope is the policy, not the device kind. A desktop and a phone
  // without `attachments:write` are refused alike.
  const desktop = await pairDevice(instance, DESK, { kind: 'desktop', scopes: ['sessions:read'] })
  const mobile = await pairDevice(instance, MOBILE, { kind: 'mobile', scopes: ['sessions:read'] })
  const bytes = Buffer.from('abc')
  for (const socket of [desktop.ws, mobile.ws]) {
    for (const type of contract.REMOTE_UPLOAD_CLIENT_TYPES) {
      const reply = await upload(socket, { type, sessionId: 's1', kind: 'file', size: 3, sha256: digest(bytes) })
      assert.equal(reply.kind, 'error', `${type} must be refused: ${JSON.stringify(reply)}`)
      assert.equal(reply.code, 'auth/forbidden-scope', type)
      assert.equal(reply.scope, 'attachments:write', type)
      assert.equal(reply.requestType, type)
    }
  }
  assert.deepEqual(instance.uploads, [], 'a refused frame never reaches the Host upload route')
  // A PHONE holding the scope is not refused for being a phone: it passes the gate
  // and is judged by the session check instead (this session is not visible).
  const phone = await pairDevice(instance, PHONE, { kind: 'mobile', scopes: ['sessions:read', 'attachments:write'] })
  assert.equal(phone.device.scopes.includes('attachments:write'), true, 'the grant is stored as offered')
  const gated = await upload(phone.ws, { type: 'remote-upload-open', sessionId: 's-invisible',
    kind: 'file', size: 3, sha256: digest(bytes) })
  assert.equal(gated.ok, false, JSON.stringify(gated))
  assert.equal(gated.error.code, 'session-not-found')
  assert.deepEqual(instance.uploads, [], 'still nothing reached the Host upload route')
})

test('R3-3 router: a session this device cannot see is refused before any transfer starts', async (t) => {
  const instance = await factory(t, { sessionList: ['s1'] })
  const layout = await pairDevice(instance, DESK, { kind: 'desktop', scopes: ['sessions:read', 'attachments:write'] })
  await delay(150)
  const bytes = Buffer.from('abc')
  const hidden = await upload(layout.ws, { type: 'remote-upload-open', sessionId: 's-invisible',
    kind: 'file', size: 3, sha256: digest(bytes) })
  assert.equal(hidden.ok, false, JSON.stringify(hidden))
  assert.equal(hidden.error.code, 'session-not-found')
  assert.deepEqual(instance.uploads, [])
  // The visible one is accepted (fresh pair token, same device id).
  const visible = await upload(layout.ws, { type: 'remote-upload-open', sessionId: 's1',
    kind: 'file', size: 3, sha256: digest(bytes) })
  assert.equal(visible.ok, true, JSON.stringify(visible))
})

test('R3-9 router: the concurrent-transfer cap is per device, not per socket', async (t) => {
  const instance = await factory(t, { config: { fileUploadMaxTransfers: 1 } })
  const created = await instance.post('pair', { name: DESK, publicUrl: instance.lanUrl, kind: 'desktop',
    scopes: ['sessions:read', 'attachments:write'] })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  // Pair on one socket, then open a SECOND socket for the same device credential.
  const ws = open(instance, ['dsh-mobile-v1', `dsh-pair.${created.data.payload.pairingCode}`], { 'X-DSH-Device-ID': DESK })
  record(ws)
  await once(ws, 'open')
  const paired = await take(ws, (frame) => frame.kind === 'paired')
  await take(ws, (frame) => frame.kind === 'hello')
  await negotiate(ws)
  const second = await connectToken(instance, paired.token, DESK)
  await delay(150)

  const bytes = Buffer.from('abc')
  const first = await upload(ws, { type: 'remote-upload-open', sessionId: 's1', kind: 'file',
    size: 3, sha256: digest(bytes) })
  assert.equal(first.ok, true, JSON.stringify(first))
  // The other socket of the SAME device is over the cap.
  const blocked = await upload(second, { type: 'remote-upload-open', sessionId: 's1', kind: 'file',
    size: 3, sha256: digest(bytes) })
  assert.equal(blocked.ok, false, JSON.stringify(blocked))
  assert.equal(blocked.error.code, 'file-upload-limit')
  // Cancelling frees the device's slot.
  const cancelled = await upload(ws, { type: 'remote-upload-cancel', uploadId: first.value.uploadId })
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
  const again = await upload(second, { type: 'remote-upload-open', sessionId: 's1', kind: 'file',
    size: 3, sha256: digest(bytes) })
  assert.equal(again.ok, true, JSON.stringify(again))
})

test('R2 router: a file and an image travel end to end and return the Host receipt verbatim', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, DESK, { kind: 'desktop', scopes: ['sessions:read', 'attachments:write'] })
  await delay(150)
  const file = Buffer.from([0, 255, 1, 10, 13, 128, 42])
  const opened = await upload(layout.ws, { type: 'remote-upload-open', sessionId: 's1', kind: 'file',
    name: 'report.pdf', size: file.length, sha256: digest(file) })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const { uploadId, chunkBytes } = opened.value
  assert.equal(opened.value.sessionId, 's1')
  assert.equal(opened.value.kind, 'file')
  assert.equal(opened.value.name, 'report.pdf')
  assert.equal(opened.value.maxBytes, 512 * 1024 * 1024)
  assert.equal(opened.value.idleTimeoutMs, 120_000)
  assert.ok(chunkBytes > 0 && chunkBytes <= contract.REMOTE_UPLOAD_MAX_CHUNK_BYTES)
  let offset = 0
  while (offset < file.length) {
    const slice = file.subarray(offset, offset + chunkBytes)
    const accepted = await upload(layout.ws, { type: 'remote-upload-chunk', uploadId, offset,
      data: slice.toString('base64') })
    assert.equal(accepted.ok, true, JSON.stringify(accepted))
    offset = accepted.value.nextOffset
  }
  const finished = await upload(layout.ws, { type: 'remote-upload-finish', uploadId })
  assert.equal(finished.ok, true, JSON.stringify(finished))
  assert.deepEqual(finished.value, {
    receiptId: 'receipt-1',
    file: { attachmentId: `sha256:${digest(file)}`, name: 'report.pdf', bytes: file.length },
  })
  assert.equal(instance.uploads.length, 1)
  assert.deepEqual(instance.uploads[0].bytes, file, 'the Host route received the exact bytes')
  assert.equal(instance.uploads[0].sessionId, 's1')
  assert.equal(instance.uploads[0].name, 'report.pdf')
  assert.equal(instance.uploads[0].mediaType, null, 'a file upload sends no mediaType')

  // An image: `mediaType` selects the Host's image route, and the receipt carries `image`.
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const imageOpen = await upload(layout.ws, { type: 'remote-upload-open', sessionId: 's1', kind: 'image',
    mediaType: 'image/png', size: png.length, sha256: digest(png) })
  assert.equal(imageOpen.ok, true, JSON.stringify(imageOpen))
  const imageAccepted = await upload(layout.ws, { type: 'remote-upload-chunk', uploadId: imageOpen.value.uploadId,
    offset: 0, data: png.toString('base64') })
  assert.equal(imageAccepted.ok, true, JSON.stringify(imageAccepted))
  const imageDone = await upload(layout.ws, { type: 'remote-upload-finish', uploadId: imageOpen.value.uploadId })
  assert.equal(imageDone.ok, true, JSON.stringify(imageDone))
  assert.equal(imageDone.value.receiptId, 'receipt-2')
  assert.equal(imageDone.value.image.mediaType, 'image/png')
  assert.equal(Object.hasOwn(imageDone.value, 'file'), false)
  assert.equal(instance.uploads[1].mediaType, 'image/png')
  assert.equal(instance.uploads[1].name, null, 'an omitted name is not sent as a query parameter')
})

test('R3 router: a chunk without a requestId is refused as bad-request (revision 8 requires one)', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, DESK, { kind: 'desktop', scopes: ['sessions:read', 'attachments:write'] })
  await delay(150)
  layout.ws.send(JSON.stringify({ type: 'remote-upload-open', sessionId: 's1', kind: 'file', size: 0, sha256: digest('') }))
  const reply = await take(layout.ws, (frame) => frame.kind === 'error' && frame.requestType === 'remote-upload-open')
  assert.equal(reply.code, 'bad-request')
})
