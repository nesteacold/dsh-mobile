import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { restrictToOwner } from './secure-file.mjs'

export const FILE_UPLOAD_REQUEST_TYPES = new Set([
  'file-upload-open', 'file-upload-chunk', 'file-upload-finish', 'file-upload-cancel',
])
// Spec 013 (contract revision 8): the companion-facing frames. They are served to a
// device holding `attachments:write` (the scope decides, not the kind — spec 012)
// and are answered in the `{ ok, value | error }` envelope of the remote-bridge
// channel, not with the admin frames above. The names are also the contract's
// REMOTE_UPLOAD_CLIENT_TYPES; a test pins the two lists to each other rather than
// importing the contract here.
export const REMOTE_UPLOAD_REQUEST_TYPES = new Set([
  'remote-upload-open', 'remote-upload-chunk', 'remote-upload-finish', 'remote-upload-cancel',
])
/** `remote-upload-*` → the manager's own request type for the same operation. */
const MANAGER_TYPE_OF_REMOTE = Object.freeze({
  'remote-upload-open': 'file-upload-open',
  'remote-upload-chunk': 'file-upload-chunk',
  'remote-upload-finish': 'file-upload-finish',
  'remote-upload-cancel': 'file-upload-cancel',
})
/** Server → client kind of every answer to a `remote-upload-*` frame (contract revision 8). */
export const REMOTE_UPLOAD_RESULT_KIND = 'remote-upload-result'
export const FILE_UPLOAD_DEFAULTS = Object.freeze({
  fileUploadsEnabled: true,
  fileUploadMaxBytes: 512 * 1024 * 1024,
  fileUploadChunkBytes: 256 * 1024,
  fileUploadMaxTransfers: 4,
  fileUploadIdleMs: 2 * 60 * 1000,
  fileUploadCommitTimeoutMs: 180_000,
})

/** Upload destinations the contract allows (`kind` of `remote-upload-open`). */
export const REMOTE_UPLOAD_KINDS = Object.freeze(['file', 'image'])

/**
 * The failure codes this manager mints itself, all of them contract vocabulary.
 * Anything else is somebody else's error — a Host exception, an `ENOENT` from the
 * spool, a stream error — whose `code` is not a contract code and whose `message`
 * may name a Host filesystem path. Such a failure is reported to the device with
 * the generic text and logged locally instead.
 */
const GATEWAY_ERROR_CODES = new Set([
  'bad-request',
  'subagent/attachment-invalid',
  'session/attachment-invalid',
  'session-not-found',
  'file-too-large',
  'file-upload-busy',
  'file-upload-cancelled',
  'file-upload-checksum',
  'file-upload-disabled',
  'file-upload-failed',
  'file-upload-incomplete',
  'file-upload-invalid-data',
  'file-upload-invalid-response',
  'file-upload-limit',
  'file-upload-not-found',
  'file-upload-offset',
  'file-upload-size',
  'file-upload-timeout',
  'file-upload-unavailable',
  'file-upload-write-failed',
])


function failure(code, message) { return Object.assign(new Error(message), { code }) }
function check(condition, code, message) { if (!condition) throw failure(code, message) }
function validName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 255
    && name !== '.' && name !== '..' && !/[\x00-\x1f\x7f/\\]/.test(name)
}

// Receive bounded chunks in a private spool, verify exact bytes, then use DSH's
// streaming attachment admission. Never interpret client names as host paths.
export function createFileUploadManager(api, configuration = {}) {
  const options = { ...FILE_UPLOAD_DEFAULTS, ...configuration }
  // Local log sink, for the failures the device is only told generically.
  const log = typeof options.log === 'function' ? options.log : () => {}
  const payloadLimit = Math.max(0, Math.floor(((options.maxPayloadBytes ?? 144 * 1024 * 1024) - 4096) / 4) * 3)
  const chunkBytes = Math.min(options.fileUploadChunkBytes, payloadLimit)
  const transfers = new Map()
  const completed = new Map()
  const closedClients = new WeakSet()
  let disposed = false

  /**
   * The Host's own per-image admission limits (`ctx.attachments.imageLimits`, the
   * object `uploadImageStream` reads). Resolved per open so a service that mounts
   * after the plugin still applies; a missing service yields `undefined` and the
   * image path fails closed in `open`.
   */
  const imageLimits = () => {
    const source = options.imageLimits
    try { return typeof source === 'function' ? source() : source } catch { return undefined }
  }
  const imageMediaTypes = () => {
    const limits = imageLimits()
    return Array.isArray(limits?.mediaTypes) ? limits.mediaTypes : undefined
  }

  const cleanup = async transfer => {
    if (transfer.handle) {
      await transfer.handle.close().catch(() => {})
      transfer.handle = undefined
    }
    if (transfer.directory) await fsp.rm(transfer.directory, { recursive: true, force: true })
  }
  const release = async transfer => {
    try { await cleanup(transfer) } finally { transfers.delete(transfer.id) }
  }
  const stop = async transfer => {
    transfer.abort.abort(failure('file-upload-cancelled', 'File upload cancelled'))
    // Keep the slot reserved until its writes/Host commit have actually stopped.
    await transfer.operation?.catch(() => {})
    await release(transfer)
  }
  const assertActive = transfer => {
    transfer.abort.signal.throwIfAborted()
    check(!disposed && !closedClients.has(transfer.client), 'file-upload-cancelled', 'Upload connection closed')
  }
  const run = (transfer, task) => {
    check(!transfer.operation, 'file-upload-busy', 'An upload operation is already in progress')
    const operation = task()
    transfer.operation = operation
    return operation.finally(() => { if (transfer.operation === operation) transfer.operation = undefined })
  }

  const open = async (client, msg) => {
    check(!disposed && !closedClients.has(client), 'file-upload-cancelled', 'Upload connection closed')
    check(api.files?.available(), 'file-upload-unavailable', 'The official file upload service is unavailable')
    check(typeof msg.sessionId === 'string' && msg.sessionId.trim(), 'bad-request', 'An existing sessionId is required')
    check(msg.parentSessionId === undefined && msg.subagentMode === undefined, 'subagent/attachment-invalid', 'Subagent file uploads are unsupported')
    // Spec 013: a `kind` makes this a remote-upload transfer, whose destination is
    // the Host's verbatim file store (`file`) or its normalized image store
    // (`image`). The admin frames carry no `kind` and keep their original rules.
    const remote = msg.kind !== undefined
    check(!remote || REMOTE_UPLOAD_KINDS.includes(msg.kind), 'bad-request', "kind must be 'file' or 'image'")
    const kind = remote ? msg.kind : 'file'
    if (kind === 'image') {
      // The mediaType is checked against the Host's own accepted list here, so an
      // image the Host would refuse never moves a byte over the link.
      const accepted = imageMediaTypes()
      check(accepted !== undefined, 'file-upload-unavailable', 'The Host attachment store is unavailable for images')
      check(typeof msg.mediaType === 'string' && msg.mediaType.length > 0, 'bad-request', 'mediaType is required for an image upload')
      check(accepted.includes(msg.mediaType), 'session/attachment-invalid',
        `Image type ${msg.mediaType} is not accepted by this deployment.`)
    } else {
      check(msg.mediaType === undefined, 'bad-request', 'mediaType is only valid for an image upload')
    }
    // A remote transfer may omit the display name; the admin frames always carried one.
    check(remote ? (msg.name === undefined || validName(msg.name)) : validName(msg.name),
      'bad-request', 'name must be a leaf filename of 1..255 characters without control characters')
    check(Number.isSafeInteger(msg.size) && msg.size >= 0, 'bad-request', 'size must be a nonnegative safe integer')
    check(msg.size <= options.fileUploadMaxBytes, 'file-too-large', 'File exceeds the configured upload limit')
    check(typeof msg.sha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(msg.sha256), 'bad-request', 'sha256 must contain 64 hexadecimal digits')
    check(transfers.size < options.fileUploadMaxTransfers, 'file-upload-limit', 'Too many active uploads')
    const transfer = {
      id: crypto.randomUUID(), client, sessionId: msg.sessionId.trim(), kind,
      ...(msg.name === undefined ? {} : { name: msg.name }),
      ...(kind === 'image' ? { mediaType: msg.mediaType } : {}),
      size: msg.size, sha256: msg.sha256.toLowerCase(), offset: 0, hash: crypto.createHash('sha256'),
      abort: new AbortController(), lastActiveAt: Date.now(),
    }
    transfers.set(transfer.id, transfer)
    try {
      return await run(transfer, async () => {
        const sessions = await api.sessions.list({}, AbortSignal.any([
          transfer.abort.signal, AbortSignal.timeout(options.fileUploadCommitTimeoutMs),
        ]))
        check(sessions.items?.some(item => item.sessionId === transfer.sessionId && item.origin !== 'subagent'),
          'session-not-found', 'No visible ordinary session exists with this ID')
        assertActive(transfer)
        transfer.directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-mobile-upload-'))
        transfer.path = path.join(transfer.directory, 'payload')
        transfer.handle = await fsp.open(transfer.path, 'wx', 0o600)
        // Incoming file bytes are owner-only until the Host admits them.
        await restrictToOwner(transfer.path, 'file')
        assertActive(transfer)
        return { kind: 'file-upload-opened', uploadId: transfer.id, sessionId: transfer.sessionId, kindOf: transfer.kind,
          ...(transfer.name === undefined ? {} : { name: transfer.name }),
          ...(transfer.mediaType === undefined ? {} : { mediaType: transfer.mediaType }),
          size: transfer.size, chunkBytes, maxBytes: options.fileUploadMaxBytes,
          idleTimeoutMs: options.fileUploadIdleMs }
      })
    } catch (error) {
      await release(transfer)
      throw error
    }
  }

  const receive = async (client, msg) => {
    if (msg.type === 'file-upload-open') return open(client, msg)
    check(typeof msg.uploadId === 'string' && msg.uploadId.length > 0, 'bad-request', 'uploadId is required')
    const done = completed.get(msg.uploadId)
    if (done?.client === client && msg.type === 'file-upload-finish') return done.frame
    const transfer = transfers.get(msg.uploadId)
    check(transfer?.client === client, 'file-upload-not-found', 'Upload is unknown or belongs to another connection')
    if (msg.type === 'file-upload-cancel') {
      await stop(transfer)
      return { kind: 'file-upload-cancelled', uploadId: msg.uploadId, sessionId: transfer.sessionId }
    }
    assertActive(transfer)
    return run(transfer, async () => {
      transfer.lastActiveAt = Date.now()
      if (msg.type === 'file-upload-chunk') {
        check(Number.isSafeInteger(msg.offset) && msg.offset === transfer.offset,
          'file-upload-offset', 'offset must equal the next expected byte')
        check(typeof msg.data === 'string' && msg.data.length > 0 && msg.data.length <= Math.ceil(chunkBytes / 3) * 4,
          'file-upload-invalid-data', 'Chunk must be nonempty canonical base64 within chunkBytes')
        const bytes = Buffer.from(msg.data, 'base64')
        check(bytes.length > 0 && bytes.length <= chunkBytes && bytes.toString('base64') === msg.data,
          'file-upload-invalid-data', 'Chunk must be nonempty canonical base64 within chunkBytes')
        check(transfer.offset + bytes.length <= transfer.size, 'file-upload-size', 'Chunk exceeds declared size')
        try {
          let written = 0
          while (written < bytes.length) {
            assertActive(transfer)
            const result = await transfer.handle.write(bytes, written, bytes.length - written, transfer.offset + written)
            check(result.bytesWritten > 0, 'file-upload-write-failed', 'Upload write made no progress')
            written += result.bytesWritten
          }
        } catch (error) {
          transfer.abort.abort(error)
          await release(transfer)
          throw error
        }
        assertActive(transfer)
        transfer.hash.update(bytes)
        transfer.offset += bytes.length
        return { kind: 'file-upload-chunk-accepted', uploadId: transfer.id, sessionId: transfer.sessionId, nextOffset: transfer.offset }
      }
      check(transfer.offset === transfer.size, 'file-upload-incomplete', 'Not all declared bytes have arrived')
      try {
        check(transfer.hash.digest('hex') === transfer.sha256, 'file-upload-checksum', 'SHA-256 does not match the uploaded bytes')
        await transfer.handle.close()
        transfer.handle = undefined
        const signal = AbortSignal.any([transfer.abort.signal, AbortSignal.timeout(options.fileUploadCommitTimeoutMs)])
        const result = await api.files.upload({ sessionId: transfer.sessionId,
          ...(transfer.name === undefined ? {} : { name: transfer.name }),
          ...(transfer.mediaType === undefined ? {} : { mediaType: transfer.mediaType }),
          data: fs.createReadStream(transfer.path, { highWaterMark: chunkBytes }) }, signal)
        signal.throwIfAborted()
        assertActive(transfer)
        // An image is NORMALIZED by the Host, so its stored `bytes`/`width`/`height`
        // legitimately differ from what was uploaded; a file is stored verbatim.
        const reference = transfer.kind === 'image' ? result.image : result.file
        check(typeof result.receiptId === 'string' && result.receiptId.length > 0
          && typeof reference?.attachmentId === 'string' && reference.attachmentId.length > 0
          && (transfer.kind === 'image' ? Number.isSafeInteger(reference.bytes) : reference.bytes === transfer.size),
        'file-upload-invalid-response', 'Official upload result does not match the declared upload')
        // `value` is the Host's own result, byte for byte: the client hands it back
        // to the Host with a receipt, exactly as the native upload route's answer.
        const frame = { kind: 'file-upload-completed', uploadId: transfer.id, sessionId: transfer.sessionId,
          receiptId: result.receiptId, value: result,
          ...(transfer.kind === 'image' ? { image: reference } : { file: reference }),
          sha256: transfer.sha256 }
        completed.set(transfer.id, { client, frame, lastActiveAt: Date.now() })
        if (completed.size > 128) completed.delete(completed.keys().next().value)
        return frame
      } finally {
        await release(transfer)
      }
    })
  }

  return {
    async handle(client, msg) {
      const correlation = {
        ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}),
        ...(typeof msg.sessionId === 'string' ? { sessionId: msg.sessionId } : {}),
        ...(typeof msg.uploadId === 'string' ? { uploadId: msg.uploadId } : {}),
      }
      try {
        check(options.fileUploadsEnabled, 'file-upload-disabled', 'File uploads are disabled')
        check(typeof msg.requestId === 'string' && msg.requestId.trim().length > 0 && msg.requestId.length <= 128,
          'bad-request', 'requestId must contain 1..128 characters')
        const frame = await receive(client, msg)
        return { ...frame, requestId: msg.requestId }
      } catch (error) {
        const code = error.name === 'TimeoutError' ? 'file-upload-timeout'
          : typeof error.code === 'string' ? error.code : 'file-upload-failed'
        // Only a code this gateway mints is a contract code. Anything else (a Host
        // exception, a filesystem error) is reported as the generic failure: its
        // message can carry a Host path, and it is not a code the client can act on.
        const own = GATEWAY_ERROR_CODES.has(code)
        if (!own) log(`file upload ${msg.type} failed: ${error?.code ?? error?.name ?? 'error'}: ${error?.message ?? ''}`)
        return { kind: 'error', requestType: msg.type, ...correlation, code,
          message: own ? error.message || 'File upload failed' : 'File upload failed',
          // The Host's own failure details (e.g. `{ reason: 'UNSUPPORTED_IMAGE_TYPE' }`)
          // travel to the client unchanged; a gateway failure has none.
          ...(error.details === undefined ? {} : { details: error.details }) }
      }
    },
    async closeClient(client) {
      closedClients.add(client)
      await Promise.all([...transfers.values()].filter(transfer => transfer.client === client).map(stop))
      for (const [id, done] of completed) if (done.client === client) completed.delete(id)
    },
    /**
     * Transfers this client currently holds open (one slot each). The router sums
     * it over a device's connections to enforce the per-device transfer cap.
     */
    activeTransfers(client) {
      let total = 0
      for (const transfer of transfers.values()) if (transfer.client === client) total += 1
      return total
    },
    async expire() {
      const cutoff = Date.now() - options.fileUploadIdleMs
      await Promise.all([...transfers.values()].filter(transfer => !transfer.operation && transfer.lastActiveAt < cutoff).map(stop))
      for (const [id, done] of completed) if (done.lastActiveAt < cutoff) completed.delete(id)
    },
    async dispose() {
      disposed = true
      await Promise.all([...transfers.values()].map(stop))
      completed.clear()
    },
  }
}

/**
 * Serve one `remote-upload-*` frame (contract revision 8) from the same manager:
 * the chunk/offset/sha256/size rules are the manager's, and the answer is the
 * remote-bridge envelope `{ ok: true, value } | { ok: false, error }` instead of
 * the admin frame shapes. A single result kind keeps the client's correlation
 * trivial: one request, one answer, always echoing `requestId`.
 *
 * Authorization is NOT decided here: the router checks the scope, the device kind,
 * the session's visibility and the per-device transfer cap before it calls this.
 * @param {ReturnType<typeof createFileUploadManager>} manager
 * @param {object} client the socket the transfer belongs to
 * @param {object} msg the client frame (`type` is `remote-upload-*`)
 */
export async function handleRemoteUpload(manager, client, msg) {
  const type = MANAGER_TYPE_OF_REMOTE[msg?.type]
  if (type === undefined) return undefined
  const requestId = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
  const frame = await manager.handle(client, { ...msg, type })
  if (frame.kind === 'error') {
    return { kind: REMOTE_UPLOAD_RESULT_KIND, ...requestId,
      ok: false,
      error: { code: frame.code, message: frame.message,
        ...(frame.details === undefined ? {} : { details: frame.details }) } }
  }
  return { kind: REMOTE_UPLOAD_RESULT_KIND, ...requestId, ok: true, value: remoteUploadValue(frame) }
}

/**
 * The `value` of a successful remote frame. `finish` carries the Host's own upload
 * result (`{receiptId, file|image}`) unchanged, because the client sends its
 * `receiptId` back with the next prompt and the Host resolves it there.
 */
function remoteUploadValue(frame) {
  switch (frame.kind) {
    case 'file-upload-opened':
      return { uploadId: frame.uploadId, sessionId: frame.sessionId, kind: frame.kindOf,
        ...(frame.name === undefined ? {} : { name: frame.name }),
        ...(frame.mediaType === undefined ? {} : { mediaType: frame.mediaType }),
        size: frame.size, chunkBytes: frame.chunkBytes, maxBytes: frame.maxBytes,
        idleTimeoutMs: frame.idleTimeoutMs }
    case 'file-upload-chunk-accepted':
      return { uploadId: frame.uploadId, sessionId: frame.sessionId, nextOffset: frame.nextOffset }
    case 'file-upload-completed':
      return frame.value
    case 'file-upload-cancelled':
      return { uploadId: frame.uploadId, sessionId: frame.sessionId, cancelled: true }
    default:
      return {}
  }
}
