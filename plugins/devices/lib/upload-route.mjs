// Remote attachment bytes for a session that lives on ANOTHER Host (spec 013 R4,
// contract revision 8, constitution A1.1 amendment v1.3.0).
//
// Why this exists: the native composer sends attachment bytes over
// `POST /api/session/uploadFileBinary`, an HTTP route outside `dispatchRpc`, so
// lib/host-router.mjs cannot see them. A session the composer is showing may be
// `h:<host>:<id>`, and the bytes must reach THAT Host. This module wraps exactly
// one registered Fetch route — the live record
// `connection.fetchRoutes.get('/api/session/uploadFileBinary')` — and turns a
// host-tagged request into the revision-8 frames (`remote-upload-open|chunk|
// finish|cancel`) on the already-pinned link. The remote gateway alone decides
// (scope, size, content type, session visibility); this Host stores nothing.
//
// A1.1 conditions, all of them:
//  - live instance only: the record is read from the HostConnectionService the
//    plugin obtained through `ctx.get('connection')` — never a prototype, never a
//    module export, never a DSH file;
//  - a self-test against the pinned `engines.dsh` gates the wrap (see
//    `uploadSelfTest`); on a mismatch nothing is wrapped and `status()` carries
//    the reason for the Devices page;
//  - `uninstall()` restores the exact function it replaced, and only if it is
//    still ours;
//  - no authorization is weakened: an untagged request reaches the original
//    handler byte-for-byte, and the remote gateway remains the sole authority for
//    what this device may upload. This module adds no route, listener or port.
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { HOST_PREFIX, PINNED_DSH_VERSION, hostIdOfId } from './host-router.mjs'
import { RemoteInputError } from './remote-client.mjs'
import { restrictToOwnerSync } from './secure-file.mjs'

/** The one local route this module intercepts (contract revision 8). */
export const UPLOAD_PATH = '/api/session/uploadFileBinary'
/** The record's own content-type requirement, copied from the native handler. */
const UPLOAD_CONTENT_TYPE = 'application/octet-stream'
/** The kind of every answer to a `remote-upload-*` frame. */
const RESULT_KIND = 'remote-upload-result'
/**
 * The kind of a refusal the gateway mints BEFORE it dispatches the frame.
 *
 * Contract 8.2 says a TRANSFER failure never arrives as `kind: 'error'`, and that
 * holds: everything `handleRemoteUpload` answers is a `remote-upload-result`. But
 * the four frames still pass the dispatcher's own gates first — a live credential,
 * the socket's web lock, the frame's `requestId`, and `attachments:write` itself
 * (pinned gateway lib/index.mjs:5727-5751) — and those answer with the same
 * `kind: 'error'` frame every other op gets. The scope gate is the one that fires
 * in practice: `attachments:write` is in the desktop default OFFER but never on an
 * existing record, so a device paired before spec 013 has to be ticked by the owner.
 */
const ERROR_KIND = 'error'
/**
 * The largest body this side will stage before the remote has even been asked.
 * `fileUploadMaxBytes` is the remote Host's limit and is only known from the
 * `remote-upload-open` answer, which itself needs the size up front: so the spool
 * is bounded by the gateway's default here and the remote still enforces its own
 * (smaller, if configured) limit at open.
 */
export const MAX_SPOOL_BYTES = 512 * 1024 * 1024
/** Contract revision 8's own ceiling on one chunk, whatever the Host reports. */
const MAX_CHUNK_BYTES = 256 * 1024
/**
 * How many tagged uploads this Host will stage at once. Each one holds an
 * owner-only temporary file until its last chunk is sent, so an unbounded number
 * of concurrent composers is an unbounded number of files in the temp directory.
 */
const MAX_ACTIVE_SPOOLS = 3
/**
 * The longest transfer budget a remote may ask for. `idleTimeoutMs` comes from
 * the remote Host's own configuration, so it is clamped here rather than trusted:
 * an absurd value would otherwise pin one request (and its socket) for that long.
 */
const MAX_REMOTE_IDLE_TIMEOUT_MS = 10 * 60_000
/** The most a remote's `error.details` may weigh before it is dropped. */
const MAX_DETAILS_BYTES = 512

/**
 * Marks this module's wrapper with the function it replaced, so a reload that
 * installs a second upload route finds the TRUE native handler instead of
 * wrapping a wrapper. Same convention as lib/host-router.mjs (`ORIGINAL`), which
 * cannot be reused directly because that module does not export its symbol.
 */
const ORIGINAL = Symbol.for('@dsh-ext/devices.uploadRouteOriginal')

/** The native handler underneath any number of our wrappers. */
function rootOriginal(fn) {
  let current = fn
  for (let depth = 0; depth < 8; depth += 1) {
    const next = current?.[ORIGINAL]
    if (typeof next !== 'function') return current
    current = next
  }
  return current
}

/** A refusal this module produced: `code` rides the contract's revision-8 vocabulary. */
export class UploadFailure extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'UploadFailure'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

const failure = (code, message, details) => new UploadFailure(code, message, details)
const cancelled = () => failure('file-upload-cancelled', 'the upload was cancelled')

/**
 * A short, displayable rendering of text that may have come from a remote Host.
 * The composer shows this verbatim, so it is bounded and stripped of control
 * characters instead of being trusted to be a tidy one-liner.
 */
function publicText(value, fallback = 'the remote Host refused the file') {
  if (typeof value !== 'string' || value === '') return fallback
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return clean === '' ? fallback : clean.slice(0, 300)
}

/**
 * The contract's `error.code` is a short identifier (`file-upload-offset`,
 * `session/attachment-invalid`, `gateway/internal`). Anything else a remote sends
 * is answered as a generic failure, so the composer never branches on a code it
 * cannot know — exactly what §5a asks of unknown codes.
 */
const REMOTE_CODE = /^[A-Za-z][A-Za-z0-9/._:-]{0,63}$/
const publicCode = (value) => (typeof value === 'string' && REMOTE_CODE.test(value) ? value : 'gateway/internal')

/**
 * Scope names a dispatcher refusal may name. A plain frozen copy of the contract's
 * `SCOPES` (a test fails on drift): a remote-controlled `scope` string is relayed
 * only when it is one of these, so a hostile Host cannot put free text in the
 * composer's mouth.
 */
export const KNOWN_SCOPES = Object.freeze([
  'sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'files:write',
  'settings:write', 'stats:read', 'web:unlock', 'harness:remote', 'commands:execute',
  'workspace:manage', 'credentials:write', 'plugins:manage', 'schedule:write',
  'schedule:read', 'terminal', 'sessions:author', 'attachments:write',
  'browser:control', 'permission:lower',
])
const knownScope = (value) => typeof value === 'string' && KNOWN_SCOPES.includes(value)

/**
 * A remote's `error.details` is forwarded only while it is a small flat map of
 * primitives — the shape the contract gives it (`{reason: 'UNSUPPORTED_IMAGE_TYPE'}`).
 * A nested or oversized value is remote-controlled data the composer would render,
 * so it is dropped instead of relayed; `undefined` means "no details".
 */
function publicDetails(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return undefined
  for (const entry of Object.values(value)) {
    const kind = typeof entry
    if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') return undefined
  }
  let json
  try { json = JSON.stringify(value) } catch { return undefined }
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_DETAILS_BYTES) return undefined
  return value
}

/**
 * The `{ok, error}` body the native route uses, built without touching the shape
 * the composer reads (`ok`, `error.code`, `error.message`, `error.details`).
 */
const jsonResponse = (status, value, extraHeaders = {}) => new Response(JSON.stringify(value), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  },
})

/**
 * Can this Fetch route be wrapped at all? Constitution A1.1: the wrap is allowed
 * only while the self-test matches the pinned `engines.dsh`; an unknown or
 * different running version, or a route that no longer looks like the one this
 * wrapper was written for, means no wrap and a reason the Devices page shows.
 *
 * Every condition is a fact about the pinned release, read from source:
 * `HostConnectionService.fetchRoutes` is a Map (dsh-client-connection
 * lib/index.js:701), `registerFetchRoute` stores `{methods, requestBody, fetch}`
 * (:840-853), the dispatcher re-reads `route.fetch` per request (:826-832), and
 * dsh-client-file-upload registers `POST` with `requestBody: 'streaming'`
 * (lib/index.js:179-184).
 * @param {object} connection the live `connection` service, or undefined
 * @param {{dshVersion?: string}} [options] the running DSH version
 * @returns {string|null} a short reason, or null when the route matches
 */
export function uploadSelfTest(connection, { dshVersion } = {}) {
  if (!connection || (typeof connection !== 'object' && typeof connection !== 'function')) return 'no-connection'
  if (!(connection.fetchRoutes instanceof Map)) return 'fetchRoutes-missing'
  if (typeof connection.fetchRoutes.get !== 'function') return 'fetchRoutes-missing'
  const route = connection.fetchRoutes.get(UPLOAD_PATH)
  if (!route || typeof route !== 'object') return 'route-missing'
  if (!(route.methods instanceof Set) || !route.methods.has('POST')) return 'route-methods'
  if (route.requestBody !== 'streaming') return 'route-request-body'
  if (typeof route.fetch !== 'function') return 'route-fetch'
  // The version is checked last: a Host with no such route reports that, not a
  // version reason, whatever it runs (same ordering as the carrier self-test).
  if (typeof dshVersion !== 'string' || dshVersion === '') return 'dsh-version-unknown'
  if (dshVersion !== PINNED_DSH_VERSION) return 'dsh-version-mismatch'
  return null
}

/**
 * `h:<hostId>:<rawId>` -> `{hostId, sessionId}`. Anything else is null, and a
 * caller must treat that as untagged: the request then belongs to the native
 * handler, which answers for a local session exactly as it always did.
 */
export function splitTaggedSessionId(value) {
  const hostId = hostIdOfId(value)
  if (hostId === null) return null
  const sessionId = value.slice(HOST_PREFIX.length + hostId.length + 1)
  // A tag with an empty or absurd remainder is not an address this Host listed.
  if (sessionId === '' || sessionId.length > 256) return null
  return { hostId, sessionId }
}

/**
 * The remote attachment bridge for one applied plugin.
 *
 * `deps.connect(hostId)` resolves the paired remote as
 * `{connection, name}` (dialling it the same way every other remote route does)
 * and throws when the host cannot be reached.
 */
export class UploadRoute {
  #connection
  #connect
  #dshVersion
  #log
  #tmpDir
  #maxSpoolBytes
  /** Tagged uploads currently holding a spool slot on this Host. */
  #activeSpools = 0
  /** The record we wrapped, the function it carried, and the TRUE native handler. */
  #record = null
  #originals = null
  #root = null
  #wrapped = null
  #installed = false
  /** Why the wrap was refused (A1.1): shown by the Devices page while it is off. */
  #reason = null

  constructor(deps = {}) {
    this.#connection = deps.connection
    this.#connect = typeof deps.connect === 'function' ? deps.connect : null
    this.#dshVersion = typeof deps.dshVersion === 'string' ? deps.dshVersion : undefined
    this.#log = typeof deps.log === 'function' ? deps.log : () => {}
    this.#tmpDir = typeof deps.tmpDir === 'string' && deps.tmpDir !== '' ? deps.tmpDir : os.tmpdir()
    this.#maxSpoolBytes = Number.isSafeInteger(deps.maxSpoolBytes) && deps.maxSpoolBytes > 0
      ? deps.maxSpoolBytes : MAX_SPOOL_BYTES
  }

  /**
   * Wrap the live route record; on any self-test mismatch nothing is patched and
   * `status()` says why.
   * @returns {{route: string, wrapped: boolean, reason: string|null, dshVersion: string|undefined,
   *   pinned: string}}
   */
  install() {
    if (this.#installed) return this.status()
    const reason = uploadSelfTest(this.#connection, { dshVersion: this.#dshVersion })
    if (reason !== null) {
      this.#reason = reason
      this.#log(`remote attachments disabled: ${reason} (running DSH ${this.#dshVersion ?? 'unknown'}, pinned ${PINNED_DSH_VERSION})`)
      return this.status()
    }
    const route = this.#connection.fetchRoutes.get(UPLOAD_PATH)
    // Restore target: exactly what was there before us (another wrapper, on a
    // reload). Local requests target the ROOT native handler instead, so a
    // stacked wrapper can never route a local upload back into us.
    const previous = route.fetch
    const root = rootOriginal(previous)
    this.#record = route
    this.#originals = { fetch: previous }
    this.#root = { fetch: root }
    const uploads = this
    // Explicit arity of one, like the native handler: the dispatcher calls
    // `route.fetch(request)` and the native closure ignores `this`.
    const wrapped = function (request) {
      return uploads.#fetch(request)
    }
    Object.defineProperty(wrapped, ORIGINAL, { value: root })
    this.#wrapped = wrapped
    route.fetch = wrapped
    this.#installed = true
    this.#reason = null
    this.#log(`remote attachments active on POST ${UPLOAD_PATH}`)
    return this.status()
  }

  /**
   * Restore the function we replaced. A wrapper installed after us is never
   * clobbered: if the record no longer carries ours, the newer one is left in
   * place and only logged.
   */
  uninstall() {
    const route = this.#record
    const wrapped = this.#wrapped
    this.#installed = false
    if (route === null || wrapped === null) return
    if (route.fetch === wrapped) route.fetch = this.#originals.fetch
    else this.#log('the upload route is no longer ours; left in place')
    this.#record = null
    this.#wrapped = null
    // The retained references are two functions; keeping them (rather than
    // nulling) mirrors the carrier wrapper, whose inner wrapper must keep
    // working after Cordis disposed the outer plugin.
  }

  /**
   * What the Devices page shows (A1.1: the failure mode is visible). `wrapped` is
   * measured now, not remembered: a reload of the file-upload plugin replaces the
   * route record and silently drops our wrapper, and that must be visible rather
   * than every tagged upload failing with the native 404.
   * @returns {{route: string, wrapped: boolean, reason: string|null, dshVersion: string|undefined,
   *   pinned: string}}
   */
  status() {
    const route = this.#connection?.fetchRoutes?.get?.(UPLOAD_PATH)
    const live = this.#installed && typeof route?.fetch === 'function' && route.fetch === this.#wrapped
    const reason = this.#installed ? (live ? null : 'route-replaced') : this.#reason
    return { route: UPLOAD_PATH, wrapped: live, reason, dshVersion: this.#dshVersion, pinned: PINNED_DSH_VERSION }
  }

  /**
   * The intercepted route. An untagged (or unparseable) request is handed to the
   * native handler as the SAME object, with its body untouched, so the local
   * upload path is exactly what it was before this plugin.
   */
  async #fetch(request) {
    const original = this.#root?.fetch
    if (typeof original !== 'function') {
      return this.#failureResponse(failure('gateway/internal', 'the host upload handler is unavailable'))
    }
    let url
    try { url = new URL(request.url) } catch {
      return Reflect.apply(original, this.#record, [request])
    }
    const rawSessionId = url.searchParams.get('sessionId')
    // No sessionId is not a host-tagged request: the native handler's own 400 is
    // the right answer and it runs before it ever reads the body.
    const tagged = rawSessionId === null || rawSessionId === '' ? null : splitTaggedSessionId(rawSessionId)
    if (tagged === null) return Reflect.apply(original, this.#record, [request])
    return this.#upload(request, url, tagged)
  }

  /** One host-tagged upload: the revision-8 frame sequence, answered as the route does. */
  async #upload(request, url, { hostId, sessionId }) {
    // Same refusals, in the same order and with the same answers, as
    // `handleFileUploadHttp`: these are protocol-level, not transfer outcomes.
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== UPLOAD_CONTENT_TYPE) {
      return new Response('content type must be application/octet-stream', { status: 415 })
    }
    // `mediaType` is what selects the Host's image store on the native route, so
    // it selects `kind` here too; `name` is forwarded only when it is usable.
    const mediaType = url.searchParams.get('mediaType') ?? undefined
    const rawName = url.searchParams.get('name') ?? undefined
    const name = typeof rawName === 'string' && rawName !== '' ? rawName : undefined
    const kind = mediaType === undefined ? 'file' : 'image'
    const declared = Number(request.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > this.#maxSpoolBytes) {
      return this.#failureResponse(failure('file-too-large',
        `the file is larger than the ${this.#maxSpoolBytes}-byte upload bound`,
        { maxBytes: this.#maxSpoolBytes }))
    }

    // The spool slot is taken before the remote is even dialled: refusing here
    // costs nothing, where dialling first would open a link nobody uses.
    if (this.#activeSpools >= MAX_ACTIVE_SPOOLS) {
      this.#log(`upload to ${hostId} refused: file-upload-limit`)
      return this.#failureResponse(failure('file-upload-limit',
        `this Host is already staging ${MAX_ACTIVE_SPOOLS} uploads; try again when one finishes`))
    }
    this.#activeSpools += 1
    let holdsSpool = true
    const releaseSpool = () => {
      if (!holdsSpool) return
      holdsSpool = false
      this.#activeSpools -= 1
    }

    let host
    try {
      host = await this.#connectHost(hostId)
    } catch (error) {
      releaseSpool()
      // Offline is a composer-visible outcome, not a transport error: revision 8
      // answers it in the route's own envelope, so the attach control can say so.
      // A typed refusal keeps its own code and text (that is how `…/prompt` and
      // `…/history` answer the same failures, e.g. `auth/revoked`); anything else
      // is simply "this host cannot be reached".
      this.#log(`upload to ${hostId} not sent: ${error?.code ?? error?.name ?? 'error'}`)
      if (error instanceof RemoteInputError) {
        return this.#failureResponse(failure(error.code, publicText(error.message), { hostId }))
      }
      return this.#failureResponse(failure('remote/host-offline', `${hostId} is offline; the file was not attached`, { hostId }))
    }

    const connection = host.connection
    // The transfer's own budget, so a big file is not cut off by the generic
    // per-request timeout; the remote Host reports it at open (contract 8.2).
    let timeoutMs = connection.requestTimeoutMs
    let spool = null
    let uploadId = null
    try {
      spool = await this.#spool(request)
      const opened = await this.#frame(connection, {
        type: 'remote-upload-open', sessionId, kind, ...(name === undefined ? {} : { name }),
        ...(mediaType === undefined ? {} : { mediaType }), size: spool.size, sha256: spool.sha256,
      }, { signal: request.signal, timeoutMs })
      uploadId = opened.value?.uploadId
      const chunkBytes = opened.value?.chunkBytes
      if (typeof uploadId !== 'string' || uploadId === '' || !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
        throw failure('gateway/internal', 'the remote Host did not open a usable transfer')
      }
      if (Number.isSafeInteger(opened.value?.idleTimeoutMs) && opened.value.idleTimeoutMs > 0) {
        timeoutMs = Math.max(timeoutMs, Math.min(opened.value.idleTimeoutMs, MAX_REMOTE_IDLE_TIMEOUT_MS))
      }
      await this.#sendChunks(connection, uploadId, spool, Math.min(chunkBytes, MAX_CHUNK_BYTES),
        { signal: request.signal, timeoutMs })
      const finished = await this.#frame(connection, { type: 'remote-upload-finish', uploadId },
        { signal: request.signal, timeoutMs })
      // `value` is the remote Host's own upload result — the very object its
      // native route answers with — and is returned opaque: `receiptId` and
      // `attachmentId` are never read, rebuilt or rewritten here.
      return jsonResponse(200, { ok: true, value: finished.value })
    } catch (error) {
      if (uploadId !== null) await this.#cancel(connection, uploadId)
      if (error instanceof UploadFailure) {
        this.#log(`upload to ${hostId} refused: ${error.code}`)
        return this.#failureResponse(error)
      }
      this.#log(`upload to ${hostId} failed: ${error?.code ?? error?.name ?? 'error'}`)
      // A cancelled request has no live caller to read the body, but the route
      // must still return a Response; the bridge drops the write.
      return this.#failureResponse(failure(error?.code === 'cancelled' ? 'file-upload-cancelled' : 'gateway/internal',
        error?.code === 'cancelled' ? 'the upload was cancelled' : 'the file could not be attached'))
    } finally {
      if (spool !== null) await fsp.rm(spool.dir, { recursive: true, force: true }).catch(() => { /* best effort */ })
      releaseSpool()
    }
  }

  /** One frame in, one `remote-upload-result` out; a refusal becomes our own failure. */
  async #frame(connection, frame, { signal, timeoutMs }) {
    if (signal?.aborted) throw cancelled()
    const reply = await connection.request(frame, { signal, timeoutMs })
    if (reply?.kind === ERROR_KIND) {
      // A dispatcher refusal, not a transfer outcome: the gateway answers these
      // before it ever reaches the manager (see ERROR_KIND). Relayed with its own
      // code and scope so the composer can say what is actually wrong — an
      // unticked `attachments:write` is the common one, and flattening it to
      // "unexpected frame" hid both the cause and the fix.
      const details = publicDetails(reply.details)
      throw failure(publicCode(reply.code), publicText(reply.message), {
        ...(details ?? {}),
        ...(knownScope(reply.scope) ? { scope: reply.scope } : {}),
      })
    }
    if (reply?.kind !== RESULT_KIND) throw failure('gateway/internal', 'the remote Host answered with an unexpected frame')
    if (reply.ok !== true) {
      // The remote's code and text are mirrored, but only in the shape the
      // composer can act on: a bounded identifier and bounded display text.
      // `details` travels only while it is the small flat map the contract
      // defines (e.g. `{reason: 'UNSUPPORTED_IMAGE_TYPE'}`); anything else is
      // remote-controlled structure the composer must not render.
      throw failure(publicCode(reply.error?.code), publicText(reply.error?.message), publicDetails(reply.error?.details))
    }
    return reply
  }

  /** Strictly sequential chunks: the next offset is the Host's, never ours. */
  async #sendChunks(connection, uploadId, spool, chunkBytes, transfer) {
    if (spool.size === 0) return
    const handle = await fsp.open(spool.file, 'r')
    try {
      const buffer = Buffer.alloc(chunkBytes)
      let offset = 0
      while (offset < spool.size) {
        if (transfer.signal?.aborted) throw cancelled()
        const want = Math.min(chunkBytes, spool.size - offset)
        const { bytesRead } = await handle.read(buffer, 0, want, offset)
        if (bytesRead <= 0) throw failure('gateway/internal', 'the staged copy of the file ended early')
        const answer = await this.#frame(connection, {
          type: 'remote-upload-chunk', uploadId, offset, data: buffer.subarray(0, bytesRead).toString('base64'),
        }, transfer)
        if (answer.value?.nextOffset !== offset + bytesRead) {
          throw failure('file-upload-offset', 'the remote Host did not accept the chunk at its offset')
        }
        offset += bytesRead
      }
    } finally {
      await handle.close().catch(() => { /* already closed */ })
    }
  }

  /** Release the remote spool. Best effort: the failure that got us here matters more. */
  async #cancel(connection, uploadId) {
    try {
      await connection.request({ type: 'remote-upload-cancel', uploadId }, { timeoutMs: connection.requestTimeoutMs })
    } catch (error) {
      this.#log(`upload cancel not delivered: ${error?.code ?? error?.name ?? 'error'}`)
    }
  }

  /**
   * Stage the request body in a private spool while hashing it.
   *
   * `remote-upload-open` needs the whole-file `size` and `sha256` BEFORE a byte is
   * sent (contract 8.2), and the streaming carrier gives this route a body stream
   * with no length. So the body is written to an owner-only temporary file — never
   * to memory — and the digest is computed as it arrives; the file is deleted on
   * every path and the size is bounded by `maxSpoolBytes`.
   * @returns {Promise<{dir: string, file: string, size: number, sha256: string}>}
   */
  async #spool(request) {
    const dir = await fsp.mkdtemp(path.join(this.#tmpDir, 'dsh-devices-upload-'))
    restrictToOwnerSync(dir, 'directory')
    const file = path.join(dir, 'payload')
    let handle
    try {
      // `wx` refuses a pre-existing name, and 0600 keeps the bytes owner-only
      // until the remote Host admits them (the local Host stores nothing else).
      handle = await fsp.open(file, 'wx', 0o600)
      restrictToOwnerSync(file, 'file')
      const hash = crypto.createHash('sha256')
      let size = 0
      if (request.body !== null) {
        const reader = request.body.getReader()
        try {
          for (;;) {
            if (request.signal?.aborted) throw cancelled()
            const chunk = await reader.read()
            if (chunk.done) break
            const bytes = Buffer.from(chunk.value)
            size += bytes.length
            if (size > this.#maxSpoolBytes) {
              throw failure('file-too-large', `the file is larger than the ${this.#maxSpoolBytes}-byte upload bound`,
                { maxBytes: this.#maxSpoolBytes })
            }
            await handle.write(bytes)
            hash.update(bytes)
          }
        } finally {
          try { reader.releaseLock() } catch { /* already released */ }
        }
      }
      await handle.close()
      handle = undefined
      return { dir, file, size, sha256: hash.digest('hex') }
    } catch (error) {
      try { await handle?.close() } catch { /* already closed */ }
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ })
      throw error
    }
  }

  async #connectHost(hostId) {
    if (this.#connect === null) throw failure('remote/host-offline', 'no remote host can be reached from this Host')
    const host = await this.#connect(hostId)
    if (!host || typeof host.connection?.request !== 'function') {
      throw failure('remote/host-offline', 'the remote host is not connected')
    }
    return host
  }

  /**
   * The route's own failure envelope: HTTP 200, exactly like the native handler.
   *
   * `details` is ALWAYS a record, even when this module has nothing to put in it.
   * The native route answers the Host's own `remoteErrorOf` details — `{}` at
   * worst — and the composer's parser requires that shape: `parseUploadResult`
   * (dsh-client-file-upload lib/client.js:294-309) throws
   * `TypeError: file upload transport returned an invalid failure` when
   * `error.details` is not a record, so an omitted `details` is not "no details",
   * it is a failure the composer cannot even display. Measured: a remote
   * `file-upload-offset` refusal without details took that path.
   */
  #failureResponse(error) {
    const envelope = { code: error.code ?? 'gateway/internal', message: error.message ?? 'the file could not be attached',
      details: error.details ?? {} }
    return jsonResponse(200, { ok: false, error: envelope })
  }
}

/** @param {object} deps see {@link UploadRoute} */
export const createUploadRoute = (deps) => new UploadRoute(deps)
