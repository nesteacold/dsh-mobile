// Spec 013 R4/R5 (contract revision 8): the native composer uploads attachment
// bytes over `POST /api/session/uploadFileBinary`, which the carrier wrapper in
// lib/host-router.mjs cannot see. lib/upload-route.mjs wraps that route's live
// record and turns a host-tagged request into `remote-upload-*` frames.
//
// These tests hold the line the constitution's A1.1 amendment draws: an untagged
// request reaches the native handler as the SAME object, the remote Host's answer
// travels back opaque, and nothing is wrapped when the self-test does not match
// the pinned release.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { PINNED_DSH_VERSION } from '../lib/host-router.mjs'
import { RemoteInputError } from '../lib/remote-client.mjs'
import { KNOWN_SCOPES, UPLOAD_PATH, createUploadRoute, splitTaggedSessionId } from '../lib/upload-route.mjs'

const HOST_ID = '2f1d1a52-6d7c-4d3e-9a58-1f0f1a2b3c4d'
const TAGGED = `h:${HOST_ID}:s-1`
const PINNED = PINNED_DSH_VERSION
const STREAMING = 'application/octet-stream'

/** A response body the tests can read with `.json()`, like the native route's. */
const json = (status, value) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
})

/** The frame the gateway answers every `remote-upload-*` request with (revision 8). */
const result = (value) => ({ kind: 'remote-upload-result', ok: true, value })
const refusal = (code, message, details) => ({ kind: 'remote-upload-result', ok: false,
  error: { code, message, ...(details === undefined ? {} : { details }) } })

/**
 * The live `connection` service as this wrapper sees it: a Map of exact Fetch
 * routes (`HostConnectionService.fetchRoutes`, dsh-client-connection lib/index.js:701)
 * whose records carry `{methods, requestBody, fetch}` (:840-853).
 */
function hostConnection({ native, requestBody = 'streaming', methods = ['POST'], path: routePath = UPLOAD_PATH } = {}) {
  const record = {
    methods: new Set(methods),
    requestBody,
    fetch: native ?? (async () => json(200, { ok: true, value: { native: true } })),
  }
  return { connection: { fetchRoutes: new Map([[routePath, record]]) }, record }
}

/** A body stream the route consumes exactly as the HTTP carrier hands it one. */
function bodyStream(buffer) {
  return new ReadableStream({
    start(controller) {
      if (buffer.length > 0) controller.enqueue(new Uint8Array(buffer))
      controller.close()
    },
  })
}

function uploadRequest({ sessionId, body = Buffer.alloc(0), name, mediaType, signal, contentLength, contentType = STREAMING } = {}) {
  const query = new URLSearchParams()
  if (sessionId !== undefined) query.set('sessionId', sessionId)
  if (name !== undefined) query.set('name', name)
  if (mediaType !== undefined) query.set('mediaType', mediaType)
  const headers = { 'content-type': contentType }
  if (contentLength !== undefined) headers['content-length'] = String(contentLength)
  return new Request(`http://dsh.internal${UPLOAD_PATH}?${query.toString()}`, {
    method: 'POST', headers, body: bodyStream(body), signal, duplex: 'half',
  })
}

/**
 * The pinned RemoteConnection as the frames cross it: `request()` resolves with
 * the `remote-upload-result` the remote gateway would send, and every frame the
 * route produced is kept so a test can assert the exact wire sequence.
 */
function fakeLink(answer) {
  const frames = []
  const link = {
    frames,
    requestTimeoutMs: 10_000,
    async request(frame, options = {}) {
      frames.push(frame)
      return answer(frame, options, link)
    },
  }
  return link
}

/** A transfer whose declared `chunkBytes` makes the client's own slicing visible. */
function chunkedAnswer({ chunkBytes = 4, hostValue, onChunk } = {}) {
  const bytes = Buffer.alloc(0)
  return (frame) => {
    if (frame.type === 'remote-upload-open') {
      return result({ uploadId: 'u-1', sessionId: 's-1', kind: frame.kind, size: frame.size,
        chunkBytes, maxBytes: 536_870_912, idleTimeoutMs: 120_000 })
    }
    if (frame.type === 'remote-upload-chunk') {
      onChunk?.(frame, bytes)
      const decoded = Buffer.from(frame.data, 'base64')
      return result({ uploadId: 'u-1', sessionId: 's-1', nextOffset: frame.offset + decoded.length })
    }
    if (frame.type === 'remote-upload-finish') return result(hostValue ?? {})
    throw new Error(`unexpected frame ${frame.type}`)
  }
}

/** A scratch spool root so every test can prove the staged bytes are gone. */
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-devices-upload-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const noDial = () => { throw new Error('the local path must not dial a remote host') }
const route = (deps) => createUploadRoute({ dshVersion: PINNED, log: () => {}, ...deps })

test('an untagged sessionId reaches the native handler as the same request, its body untouched', async (t) => {
  const root = scratch(t)
  const seen = []
  const native = async (request) => {
    seen.push(request)
    // The native handler reads the body itself; a wrapper that had consumed or
    // replaced the stream would leave nothing here.
    const bytes = await request.arrayBuffer()
    return json(200, { ok: true, value: { native: bytes.byteLength } })
  }
  const { connection, record } = hostConnection({ native })
  const uploads = route({ connection, connect: noDial, tmpDir: root })
  assert.equal(uploads.status().wrapped, false)
  uploads.install()
  assert.notEqual(record.fetch, native, 'the route is wrapped once installed')

  const request = uploadRequest({ sessionId: 's-1', body: Buffer.from('hello') })
  const response = await record.fetch(request)
  assert.equal(seen.length, 1)
  assert.equal(seen[0], request, 'the native handler sees the SAME Request object')
  assert.deepEqual(await response.json(), { ok: true, value: { native: 5 } })
  assert.deepEqual(fs.readdirSync(root), [], 'no spool was written for a local upload')
})

test('a tag with no remote id is not an address: the native handler still answers', async (t) => {
  const root = scratch(t)
  const seen = []
  const { connection, record } = hostConnection({ native: async (request) => { seen.push(request); return json(200, { ok: true }) } })
  route({ connection, connect: noDial, tmpDir: root }).install()
  await record.fetch(uploadRequest({ sessionId: 'h:abc', body: Buffer.from('x') }))
  assert.equal(seen.length, 1)
  assert.equal(splitTaggedSessionId('h:abc'), null)
  assert.deepEqual(splitTaggedSessionId(TAGGED), { hostId: HOST_ID, sessionId: 's-1' })
})

test('a host-tagged upload to an offline host is a normal result, never a transport error', async (t) => {
  const root = scratch(t)
  const { connection, record } = hostConnection()
  const uploads = route({
    connection,
    connect: async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3081'), { code: 'ECONNREFUSED' }) },
    tmpDir: root,
  })
  uploads.install()
  const response = await record.fetch(uploadRequest({ sessionId: TAGGED, body: Buffer.from('bytes') }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'remote/host-offline')
  assert.deepEqual(body.error.details, { hostId: HOST_ID })
  assert.deepEqual(fs.readdirSync(root), [], 'nothing was staged for a host that cannot be reached')
})

test('the happy path: sequential chunks sized by the open answer, whole-file sha256, opaque receipt', async (t) => {
  const root = scratch(t)
  const payload = Buffer.from('0123456789')
  const expected = crypto.createHash('sha256').update(payload).digest('hex')
  const hostValue = { receiptId: 'rcpt-1', file: { attachmentId: 'sha256:abc', name: 'report.txt', bytes: payload.length } }
  const link = fakeLink(chunkedAnswer({ hostValue }))
  const { connection, record } = hostConnection()
  const uploads = route({ connection, connect: async () => ({ connection: link }), tmpDir: root })
  uploads.install()

  const response = await record.fetch(uploadRequest({ sessionId: TAGGED, body: payload, name: 'report.txt' }))
  assert.equal(response.status, 200)
  // The remote Host's own result travels back verbatim: the composer sends its
  // `receiptId` with the next prompt, so it must never be rebuilt here.
  assert.deepEqual(await response.json(), { ok: true, value: hostValue })

  const open = link.frames.find((frame) => frame.type === 'remote-upload-open')
  assert.equal(open.sessionId, 's-1', 'the remote receives the UNTAGGED remote-local session id')
  assert.equal(open.kind, 'file')
  assert.equal(open.name, 'report.txt')
  assert.equal(open.size, payload.length)
  assert.equal(open.sha256, expected, 'the digest is over the whole file, computed while staging')
  assert.equal('mediaType' in open, false, 'contract 8.2: mediaType must be absent for a file')

  const chunks = link.frames.filter((frame) => frame.type === 'remote-upload-chunk')
  assert.deepEqual(chunks.map((frame) => frame.offset), [0, 4, 8])
  assert.deepEqual(chunks.map((frame) => Buffer.from(frame.data, 'base64').length), [4, 4, 2])
  for (const frame of chunks) {
    const decoded = Buffer.from(frame.data, 'base64')
    // Canonical base64 is a contract requirement (check 5); re-encoding proves it.
    assert.equal(decoded.toString('base64'), frame.data)
    assert.equal(decoded.toString(), payload.subarray(frame.offset, frame.offset + decoded.length).toString())
  }
  assert.equal(link.frames.at(-1).type, 'remote-upload-finish')
  assert.equal(link.frames.at(-1).uploadId, 'u-1')
  assert.deepEqual(fs.readdirSync(root), [], 'the staged copy is deleted on success')
})

test('an image upload names its media type, so the remote stores a normalized image', async (t) => {
  const root = scratch(t)
  const link = fakeLink(chunkedAnswer({ chunkBytes: 256 * 1024, hostValue: { receiptId: 'r', image: { attachmentId: 'sha256:img', mediaType: 'image/png', bytes: 3 } } }))
  const { connection, record } = hostConnection()
  route({ connection, connect: async () => ({ connection: link }), tmpDir: root }).install()

  const response = await record.fetch(uploadRequest({
    sessionId: TAGGED, body: Buffer.from('png'), name: 'photo.png', mediaType: 'image/png',
  }))
  assert.deepEqual(await response.json(), { ok: true, value: { receiptId: 'r', image: { attachmentId: 'sha256:img', mediaType: 'image/png', bytes: 3 } } })
  const open = link.frames[0]
  assert.equal(open.kind, 'image')
  assert.equal(open.mediaType, 'image/png')
})

test('a refusal from the remote is mirrored untouched and stops the transfer', async (t) => {
  const root = scratch(t)
  const link = fakeLink((frame) => {
    if (frame.type === 'remote-upload-open') {
      return refusal('session/attachment-invalid', 'Image type image/bmp is not accepted by this deployment.',
        { reason: 'UNSUPPORTED_IMAGE_TYPE' })
    }
    throw new Error(`no frame may follow a refusal, got ${frame.type}`)
  })
  const { connection, record } = hostConnection()
  route({ connection, connect: async () => ({ connection: link }), tmpDir: root }).install()

  const response = await record.fetch(uploadRequest({
    sessionId: TAGGED, body: Buffer.from('bmp'), mediaType: 'image/bmp',
  }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'session/attachment-invalid', message: 'Image type image/bmp is not accepted by this deployment.',
      details: { reason: 'UNSUPPORTED_IMAGE_TYPE' } },
  })
  assert.deepEqual(link.frames.map((frame) => frame.type), ['remote-upload-open'])
  assert.deepEqual(fs.readdirSync(root), [], 'a refused transfer stages nothing')
})

test('an answer that is not a revision-8 result is refused instead of trusted', async (t) => {
  const root = scratch(t)
  const link = fakeLink(() => ({ kind: 'sessions', items: [] }))
  const { connection, record } = hostConnection()
  route({ connection, connect: async () => ({ connection: link }), tmpDir: root }).install()
  const body = await (await record.fetch(uploadRequest({ sessionId: TAGGED, body: Buffer.from('x') }))).json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'gateway/internal')
})

test('a dispatcher refusal before dispatch keeps its own code and scope', async (t) => {
  // The gateway answers the four frames with `kind:'error'` when one of its own
  // gates refuses them BEFORE the upload manager runs (pinned lib/index.mjs:
  // 5727-5751: live credential, web lock, `requestId`, `attachments:write`).
  // Contract 8.2's "a failure never arrives as kind:'error'" is about TRANSFER
  // outcomes, so these are not a contract violation — but flattening them to
  // "unexpected frame" hid the one that fires in practice: `attachments:write` is
  // in the desktop default OFFER and never on an existing record, so a device
  // paired before spec 013 uploads nothing until the owner ticks it, and the
  // composer must be able to say so (R5) instead of reporting a generic failure.
  const root = scratch(t)
  const refused = {
    'auth/forbidden-scope': { scope: 'attachments:write', message: 'this device was not paired with attachments:write' },
    'bad-request': { message: 'requestId must be 1..64 characters from [A-Za-z0-9._-]' },
    'auth/revoked': { message: 'this device credential is no longer valid' },
  }
  for (const [code, extra] of Object.entries(refused)) {
    const link = fakeLink((frame) => ({ kind: 'error', code, requestType: frame.type, requestId: 'gw-1', ...extra }))
    const { connection, record } = hostConnection()
    route({ connection, connect: async () => ({ connection: link }), tmpDir: root }).install()
    const body = await (await record.fetch(uploadRequest({ sessionId: TAGGED, body: Buffer.from('x') }))).json()
    assert.equal(body.ok, false, code)
    assert.equal(body.error.code, code, `a dispatcher refusal must keep ${code}`)
    assert.equal(body.error.message, extra.message, code)
    // The scope travels in `details`, the one map the route forwards to the
    // composer: a flat string is what the page can render as the missing grant.
    assert.deepEqual(body.error.details, extra.scope === undefined ? {} : { scope: extra.scope }, code)
  }

  // The same hardening the transfer path gets: a dispatcher frame is remote data
  // too, so a code the contract does not define is generic and the text is
  // bounded and stripped before the composer renders it.
  const hostile = fakeLink((frame) => ({ kind: 'error', code: { nested: true }, requestType: frame.type,
    requestId: 'gw-9', message: `bad\u0000request${'x'.repeat(1000)}` }))
  const { connection, record } = hostConnection()
  route({ connection, connect: async () => ({ connection: hostile }), tmpDir: root }).install()
  const body = await (await record.fetch(uploadRequest({ sessionId: TAGGED, body: Buffer.from('x') }))).json()
  assert.equal(body.error.code, 'gateway/internal', 'an unknown dispatcher code is not relayed')
  assert.equal(body.error.message.startsWith('bad request'), true)
  assert.equal(body.error.message.length <= 300, true)
  assert.equal(body.error.message.includes('\u0000'), false)
})

test('a remote-controlled `scope` is relayed only when it is a known scope name', async (t) => {
  const root = scratch(t)
  const run = async (scope) => {
    const link = fakeLink((frame) => ({ kind: 'error', code: 'auth/forbidden-scope', requestType: frame.type,
      requestId: 'gw-1', message: 'refused', scope }))
    const { connection, record } = hostConnection()
    route({ connection, connect: async () => ({ connection: link }), tmpDir: root }).install()
    return (await (await record.fetch(uploadRequest({ sessionId: TAGGED, body: Buffer.from('x') }))).json()).error
  }
  assert.deepEqual((await run('attachments:write')).details, { scope: 'attachments:write' })
  for (const hostile of ['<script>alert(1)</script>', 'attachments:write ', 'not-a-scope', '', 42, { a: 1 }, null]) {
    assert.equal('scope' in (await run(hostile)).details, false, `scope ${JSON.stringify(hostile)} must be omitted`)
  }
})

test('KNOWN_SCOPES is frozen and matches the contract scope list', async () => {
  const { SCOPES } = await import('../../../packages/mobile-protocol/src/index.mjs')
  assert.equal(Object.isFrozen(KNOWN_SCOPES), true)
  assert.deepEqual([...KNOWN_SCOPES].sort(), [...SCOPES].sort())
})

test('every failure carries a `details` record, because the composer requires one', async (t) => {
  // The native route answers the Host's own details (`{}` at worst) and the
  // desktop composer's `parseUploadResult` (dsh-client-file-upload
  // lib/client.js:294-309) THROWS `file upload transport returned an invalid
  // failure` when `error.details` is not a record. An omitted `details` is
  // therefore not "no details": it is a failure the composer cannot display at
  // all. Measured before this test: a remote `file-upload-offset` refusal with no
  // details, and every dispatcher refusal, took exactly that path.
  const root = scratch(t)
  const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
  const cases = [
    // A transfer refusal from the manager itself, with and without details.
    ['no details', () => ({ kind: 'remote-upload-result', ok: false,
      error: { code: 'file-upload-offset', message: 'offset must equal the next expected byte' } })],
    ['with details', () => ({ kind: 'remote-upload-result', ok: false,
      error: { code: 'session/attachment-invalid', message: 'Image type image/bmp is not accepted.',
        details: { reason: 'UNSUPPORTED_IMAGE_TYPE' } } })],
    // Host-side failures this module mints, which carry no details of their own.
    ['host offline', () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3081') }],
  ]
  for (const [label, answer] of cases) {
    const { connection, record } = hostConnection()
    route({
      connection,
      connect: async () => ({ connection: { requestTimeoutMs: 5_000, async request(frame) { return answer(frame) } } }),
      tmpDir: root,
    }).install()
    const body = await (await record.fetch(uploadRequest({ sessionId: TAGGED, body: Buffer.from('x') }))).json()
    assert.equal(body.ok, false, label)
    assert.equal(isRecord(body.error.details), true, `${label}: details must be a record, got ${JSON.stringify(body.error.details)}`)
  }
  // The same holds for a file the local bound refuses: a DECLARED length is
  // refused before any dial, and it must still carry a record.
  const { connection, record } = hostConnection()
  route({ connection, connect: noDial, tmpDir: root, maxSpoolBytes: 1 }).install()
  const oversized = await (await record.fetch(uploadRequest({
    sessionId: TAGGED, body: Buffer.from('0123456789'), contentLength: 10,
  }))).json()
  assert.equal(oversized.error.code, 'file-too-large')
  assert.equal(isRecord(oversized.error.details), true)
  assert.equal(oversized.error.details.maxBytes, 1)
})

test('a typed dial refusal keeps its own code, as every other remote route answers it', async (t) => {
  // `…/prompt` and `…/history` let a typed refusal through instead of flattening
  // it to "offline"; an upload must not be the one route that hides a revocation.
  const root = scratch(t)
  const { connection, record } = hostConnection()
  route({
    connection,
    connect: async () => { throw new RemoteInputError('the remote revoked this device; pair it again', 401, 'auth/revoked') },
    tmpDir: root,
  }).install()
  const body = await (await record.fetch(uploadRequest({ sessionId: TAGGED, body: Buffer.from('x') }))).json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'auth/revoked')
  assert.equal(body.error.message, 'the remote revoked this device; pair it again')
  assert.deepEqual(body.error.details, { hostId: HOST_ID })
})

test('a remote error with an unusable code or unbounded text is reported generically', async (t) => {
  // The text reaches the composer verbatim, so it is bounded and stripped rather
  // than trusted; a code the contract does not define is the generic failure §5a
  // already prescribes for anything a client does not know.
  const root = scratch(t)
  const link = fakeLink(() => ({ kind: 'remote-upload-result', ok: false,
    error: { code: { nested: true }, message: `bad\u0000file${'x'.repeat(1000)}` } }))
  const { connection, record } = hostConnection()
  route({ connection, connect: async () => ({ connection: link }), tmpDir: root }).install()
  const body = await (await record.fetch(uploadRequest({ sessionId: TAGGED, body: Buffer.from('x') }))).json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'gateway/internal')
  assert.equal(body.error.message.startsWith('bad file'), true)
  assert.equal(body.error.message.length <= 300, true)
  assert.equal(body.error.message.includes('\u0000'), false)
})

test('aborting the request cancels the remote transfer and frees the staged bytes', async (t) => {
  const root = scratch(t)
  const controller = new AbortController()
  const link = fakeLink((frame) => {
    if (frame.type === 'remote-upload-open') {
      return result({ uploadId: 'u-1', sessionId: 's-1', kind: 'file', size: 12, chunkBytes: 4, maxBytes: 1024, idleTimeoutMs: 50 })
    }
    if (frame.type === 'remote-upload-chunk') {
      const after = frame.offset + Buffer.from(frame.data, 'base64').length
      if (after === 4) controller.abort() // the user closed the composer after the first chunk
      return result({ uploadId: 'u-1', sessionId: 's-1', nextOffset: after })
    }
    if (frame.type === 'remote-upload-cancel') return result({ uploadId: 'u-1', sessionId: 's-1', cancelled: true })
    throw new Error(`unexpected frame ${frame.type}`)
  })
  const { connection, record } = hostConnection()
  route({ connection, connect: async () => ({ connection: link }), tmpDir: root }).install()

  const response = await record.fetch(uploadRequest({
    sessionId: TAGGED, body: Buffer.from('0123456789ab'), signal: controller.signal,
  }))
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'file-upload-cancelled')
  assert.deepEqual(link.frames.map((frame) => frame.type),
    ['remote-upload-open', 'remote-upload-chunk', 'remote-upload-cancel'],
    'no chunk is sent after the abort, and the remote spool is released')
  assert.equal(link.frames.at(-1).uploadId, 'u-1')
  assert.deepEqual(fs.readdirSync(root), [], 'the staged copy is gone after a cancel')
})

test('a body over the local bound is refused before it is staged or opened', async (t) => {
  const root = scratch(t)
  let dialled = false
  const link = fakeLink(() => { throw new Error('no frame may be sent for an oversized file') })
  const { connection, record } = hostConnection()
  route({
    connection,
    connect: async () => { dialled = true; return { connection: link } },
    tmpDir: root,
    maxSpoolBytes: 4,
  }).install()

  // Declared length: refused before the dial, so an oversized upload costs nothing.
  const declared = await (await record.fetch(uploadRequest({
    sessionId: TAGGED, body: Buffer.from('0123456789'), contentLength: 10,
  }))).json()
  assert.equal(declared.ok, false)
  assert.equal(declared.error.code, 'file-too-large')
  assert.equal(dialled, false)

  // No declared length: caught while staging, and still nothing is sent.
  const streamed = await (await record.fetch(uploadRequest({ sessionId: TAGGED, body: Buffer.from('0123456789') }))).json()
  assert.equal(streamed.ok, false)
  assert.equal(streamed.error.code, 'file-too-large')
  assert.deepEqual(link.frames, [])
  assert.deepEqual(fs.readdirSync(root), [])
})

test('at most 3 uploads are staged at once; the next is refused before any host is dialled', async (t) => {
  // Each staged upload holds an owner-only temp file for the whole transfer, so
  // the count is bounded rather than left to however many composers open at once.
  const root = scratch(t)
  const parked = []
  let dials = 0
  let park = true
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
  const link = {
    requestTimeoutMs: 10_000,
    async request(frame) {
      if (frame.type === 'remote-upload-open') {
        const opened = result({ uploadId: 'u-1', sessionId: 's-1', kind: frame.kind, size: frame.size,
          chunkBytes: 4, maxBytes: 1024, idleTimeoutMs: 1_000 })
        if (!park) return opened
        // Park the transfer at its open frame so the slot stays held.
        return new Promise((resolve) => parked.push(() => resolve(opened)))
      }
      if (frame.type === 'remote-upload-finish') return result({})
      throw new Error(`unexpected frame ${frame.type}`)
    },
  }
  const { connection, record } = hostConnection()
  route({ connection, connect: async () => { dials += 1; return { connection: link } }, tmpDir: root }).install()

  const running = [0, 1, 2].map(() => record.fetch(uploadRequest({ sessionId: TAGGED, body: Buffer.alloc(0) })))
  const deadline = Date.now() + 5_000
  while (parked.length < 3 && Date.now() < deadline) await tick()
  assert.equal(parked.length, 3, 'the first three uploads reached the remote')
  assert.equal(dials, 3)

  const refused = await (await record.fetch(uploadRequest({ sessionId: TAGGED, body: Buffer.alloc(0) }))).json()
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'file-upload-limit')
  assert.equal(dials, 3, 'a refused upload costs no missing remote connection')

  // Releasing the three lets their transfers finish, which frees the slots.
  park = false
  for (const release of parked) release()
  for (const response of await Promise.all(running)) assert.equal((await response.json()).ok, true)

  const after = await (await record.fetch(uploadRequest({ sessionId: TAGGED, body: Buffer.alloc(0) }))).json()
  assert.equal(after.ok, true, JSON.stringify(after))
  assert.deepEqual(fs.readdirSync(root), [], 'every spool is removed')
})

test('the remote transfer budget is clamped to ten minutes and a non-integer value is ignored', async (t) => {
  const root = scratch(t)
  const budgets = async (idleTimeoutMs) => {
    const seen = []
    const link = fakeLink((frame, options) => {
      seen.push({ type: frame.type, timeoutMs: options.timeoutMs })
      if (frame.type === 'remote-upload-open') {
        return result({ uploadId: 'u-1', sessionId: 's-1', kind: 'file', size: frame.size, chunkBytes: 4,
          maxBytes: 1024, ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }) })
      }
      if (frame.type === 'remote-upload-chunk') {
        return result({ uploadId: 'u-1', sessionId: 's-1', nextOffset: frame.offset + Buffer.from(frame.data, 'base64').length })
      }
      if (frame.type === 'remote-upload-finish') return result({})
      throw new Error(`unexpected frame ${frame.type}`)
    })
    const { connection, record } = hostConnection()
    route({ connection, connect: async () => ({ connection: link }), tmpDir: root }).install()
    const answer = await (await record.fetch(uploadRequest({ sessionId: TAGGED, body: Buffer.from('ab') }))).json()
    assert.equal(answer.ok, true, JSON.stringify(answer))
    const chunk = seen.find((entry) => entry.type === 'remote-upload-chunk')
    return { chunk, open: seen.find((entry) => entry.type === 'remote-upload-open') }
  }
  // The remote cannot pin a request longer than ten minutes, however it is configured.
  assert.equal((await budgets(Number.MAX_SAFE_INTEGER)).chunk.timeoutMs, 10 * 60_000)
  // Values that are not safe positive integers are ignored: the connection's own budget stays.
  for (const value of ['900000', 1.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
    const { chunk } = await budgets(value)
    assert.equal(chunk.timeoutMs, 10_000, `idleTimeoutMs=${String(value)} must be ignored`)
  }
  // A sane value is honored, as before.
  assert.equal((await budgets(120_000)).chunk.timeoutMs, 120_000)
})

test('remote details travel only as the small flat map the contract defines', async (t) => {
  const root = scratch(t)
  const cases = [
    // The contract's own shape (and a number/boolean) is forwarded verbatim.
    [{ reason: 'UNSUPPORTED_IMAGE_TYPE', retryable: false, limit: 12 }, { reason: 'UNSUPPORTED_IMAGE_TYPE', retryable: false, limit: 12 }],
    // Nested, oversized, array, scalar and null values are remote-controlled
    // structure the composer would render, so they are DROPPED — and what is left
    // is still a record (`{}`), never an omitted field: the native route always
    // answers details (`{}` at worst) and the composer's parser requires a
    // record, so `undefined` here would be a failure it cannot display.
    [{ nested: { path: '/home/someone/secret.png' } }, {}],
    [{ note: 'x'.repeat(600) }, {}],
    [{ values: ['a'] }, {}],
    ['a string', {}],
    [null, {}],
  ]
  for (const [details, expected] of cases) {
    const link = fakeLink(() => refusal('session/attachment-invalid', 'the remote refused it', details))
    const { connection, record } = hostConnection()
    route({ connection, connect: async () => ({ connection: link }), tmpDir: root }).install()
    const body = await (await record.fetch(uploadRequest({ sessionId: TAGGED, body: Buffer.from('x') }))).json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'session/attachment-invalid')
    assert.deepEqual(body.error.details, expected, JSON.stringify(details))
    // A dropped structure never leaks into the envelope in any form.
    if (expected !== details && typeof details === 'object' && details !== null) {
      assert.equal(JSON.stringify(body.error).includes('secret.png'), false)
    }
  }
})

test('the transfer method and content type are checked exactly as the native route checks them', async (t) => {
  const root = scratch(t)
  const { connection, record } = hostConnection()
  route({ connection, connect: noDial, tmpDir: root }).install()

  const wrongType = await record.fetch(uploadRequest({
    sessionId: TAGGED, body: Buffer.from('x'), contentType: 'text/plain',
  }))
  assert.equal(wrongType.status, 415)
  assert.equal(await wrongType.text(), 'content type must be application/octet-stream')

  const wrongMethod = await record.fetch(new Request(`http://dsh.internal${UPLOAD_PATH}?sessionId=${TAGGED}`,
    { method: 'GET' }))
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('allow'), 'POST')
})

test('dispose restores the exact function, and never clobbers a later wrapper', async (t) => {
  const root = scratch(t)
  const native = async () => json(200, { ok: true, value: { native: true } })
  const { connection, record } = hostConnection({ native })
  const first = route({ connection, connect: noDial, tmpDir: root })
  first.install()
  const firstWrapper = record.fetch
  assert.notEqual(firstWrapper, native)

  // A reload stacks a second route on ours: it must find the TRUE native handler,
  // not wrap a wrapper (the same anti-stacking rule the carrier wrapper follows).
  const second = route({ connection, connect: noDial, tmpDir: root })
  second.install()
  const secondWrapper = record.fetch
  assert.notEqual(secondWrapper, firstWrapper)
  assert.equal(secondWrapper[Symbol.for('@dsh-ext/devices.uploadRouteOriginal')], native)

  second.uninstall()
  assert.equal(record.fetch, firstWrapper, 'the older wrapper is restored, not the native one')
  first.uninstall()
  assert.equal(record.fetch, native, 'dispose puts the exact original back')

  // A wrapper installed after us by someone else is left alone.
  const foreign = async () => json(200, { ok: true })
  const third = route({ connection, connect: noDial, tmpDir: root })
  third.install()
  record.fetch = foreign
  third.uninstall()
  assert.equal(record.fetch, foreign, 'a route that is no longer ours is never clobbered')
  assert.equal(third.status().wrapped, false)
})

test('a self-test mismatch wraps nothing and reports the reason for the Devices page', async (t) => {
  const root = scratch(t)
  const native = async () => json(200, { ok: true })
  const cases = [
    ['no-connection', undefined],
    ['fetchRoutes-missing', { fetchRoutes: {} }],
    ['route-missing', { fetchRoutes: new Map() }],
    ['route-methods', { fetchRoutes: new Map([[UPLOAD_PATH, { methods: new Set(['PUT']), requestBody: 'streaming', fetch: native }]]) }],
    ['route-request-body', { fetchRoutes: new Map([[UPLOAD_PATH, { methods: new Set(['POST']), requestBody: 'buffered', fetch: native }]]) }],
    ['route-fetch', { fetchRoutes: new Map([[UPLOAD_PATH, { methods: new Set(['POST']), requestBody: 'streaming', fetch: 'nope' }]]) }],
  ]
  for (const [reason, connection] of cases) {
    const record = connection?.fetchRoutes instanceof Map ? connection.fetchRoutes.get(UPLOAD_PATH) : undefined
    const before = record?.fetch
    const uploads = route({ connection, connect: noDial, tmpDir: root })
    const status = uploads.install()
    assert.equal(status.wrapped, false, `${reason}: not wrapped`)
    assert.equal(status.reason, reason)
    assert.equal(status.pinned, PINNED)
    if (record) assert.equal(record.fetch, before, `${reason}: the record is untouched`)
  }

  // The pinned version is part of the self-test: a different or unknown running
  // DSH means no wrap at all (A1.1), never a guess.
  const { connection, record } = hostConnection({ native })
  for (const [dshVersion, reason] of [[undefined, 'dsh-version-unknown'], ['0.3.0-rc.1', 'dsh-version-out-of-range'], ['0.2.1', 'dsh-version-out-of-range']]) {
    const uploads = createUploadRoute({ connection, connect: noDial, tmpDir: root, dshVersion, log: () => {} })
    const status = uploads.install()
    assert.equal(status.wrapped, false)
    assert.equal(status.reason, reason)
    assert.equal(record.fetch, native, `DSH ${dshVersion}: the route stays the native handler`)
  }
  // A later 0.2.x patch with the same live route shape is wrapped (layer 2).
  {
    const later = hostConnection({ native })
    const status = createUploadRoute({ connection: later.connection, connect: noDial, tmpDir: root, dshVersion: '0.2.5', log: () => {} }).install()
    assert.equal(status.wrapped, true)
    assert.equal(status.dshVersion, '0.2.5')
  }
})

test('status notices a route record that was replaced under us', async (t) => {
  const root = scratch(t)
  const native = async () => json(200, { ok: true })
  const { connection, record } = hostConnection({ native })
  const uploads = route({ connection, connect: noDial, tmpDir: root })
  uploads.install()
  assert.deepEqual(uploads.status(), {
    route: UPLOAD_PATH, wrapped: true, reason: null, dshVersion: PINNED, pinned: PINNED, range: '>=0.2.2-rc.3 <0.3.0-0',
  })
  // A reload of the file-upload plugin registers a fresh record; ours is dropped.
  record.fetch = native
  const status = uploads.status()
  assert.equal(status.wrapped, false)
  assert.equal(status.reason, 'route-replaced')
})

test('the applied plugin wraps the live route and reports it in the Devices status payload', async (t) => {
  // The whole composition: `apply` reads the `connection` service the Host
  // composes, wraps its route record, and the page's own status route says so.
  const { mountPlugin, tempDir } = await import('./helpers.mjs')
  const native = async () => json(200, { ok: true, value: { native: true } })
  const record = { methods: new Set(['POST']), requestBody: 'streaming', fetch: native }
  const connection = { fetchRoutes: new Map([[UPLOAD_PATH, record]]) }
  const mounted = await mountPlugin({
    dataDir: tempDir('dsh-devices-upload-int-'),
    services: { connection },
    testDshVersion: PINNED,
    autoReconnect: false,
  })
  try {
    assert.notEqual(record.fetch, native, 'the live route record is wrapped')
    const response = await mounted.call('GET', '/devices/remotes')
    assert.equal(response.status, 200)
    assert.deepEqual(response.json.uploads, { route: UPLOAD_PATH, wrapped: true, reason: null, dshVersion: PINNED, pinned: PINNED, range: '>=0.2.2-rc.3 <0.3.0-0' })
    assert.equal(mounted.instance.uploads.status().wrapped, true, 'also reachable through the internals seam')
  } finally {
    mounted.close()
  }
  assert.equal(record.fetch, native, 'dispose puts the native handler back')
})

test('a Host that composes no connection service reports the reason instead of wrapping', async (t) => {
  const { mountPlugin, tempDir } = await import('./helpers.mjs')
  const mounted = await mountPlugin({
    dataDir: tempDir('dsh-devices-upload-int-'),
    testDshVersion: PINNED,
    autoReconnect: false,
  })
  try {
    const response = await mounted.call('GET', '/devices/remotes')
    // A1.1: the failure mode is on the page, not in a log line only.
    assert.deepEqual(response.json.uploads, {
      route: UPLOAD_PATH, wrapped: false, reason: 'no-connection', dshVersion: PINNED, pinned: PINNED, range: '>=0.2.2-rc.3 <0.3.0-0',
    })
  } finally {
    mounted.close()
  }
})
