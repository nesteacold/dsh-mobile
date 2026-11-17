// Offline transcript cache for remote sessions (spec 008 P2c / T025).
//
// The session follower in lib/host-router.mjs appends every frame of a remote
// `session/follow` stream here, one JSON object per line, per (host, session).
// When that host is offline the same frames are replayed read-only — by the
// router (native conversation) and by `GET …/sessions/:sid/history` (Devices
// page) — so a transcript stays browsable after the host is gone.
//
// Two boundaries, both by construction:
//  - Only `session/follow` frames are ever written (the caller passes nothing
//    else), so no token, pairing code or header can reach these files. The
//    per-remote device token lives in tokens/<id>.token and is never read here.
//  - An id is NEVER used as a file name. Both parts are hashed (SHA-256 of the
//    exact id) and only a short readable slug survives, so an id containing `:`
//    (an NTFS alternate data stream), `..`, a rotation-shaped suffix (`s.1`) or
//    two ids differing only by case cannot alias another file, and the files are
//    owner-only like the rest of the data dir.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { SECRET_FILE_MODE, ensureOwnerOnlyDirectory, restrictToOwnerSync, writeSecretFile } from './secure-file.mjs'

/** Current file budget before it rotates (one transcript file). */
export const SESSION_CACHE_MAX_BYTES = 2 * 1024 * 1024
/** Rotated files kept per session (`.1` newest … `.N` oldest, in `rot/`). */
export const SESSION_CACHE_ROTATIONS = 2
/** Subdirectory holding the rotated files of a session. */
const ROTATION_DIRECTORY = 'rot'
/** Hex digits of the SHA-256 digest kept in a name (128 bits; keeps paths short). */
const HASH_CHARS = 32
/** Longest readable slug kept in front of the digest. */
const SLUG_CHARS = 24

// A cached id is an identifier, not a path: no separator, no dot-only name, no NUL.
// It is hashed before it becomes a file name, so the rest of the alphabet (including
// `:`, `.` and `-`) is safe here and stays useful for real DSH ids.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
export const isCacheId = (value) => typeof value === 'string' && SAFE_ID.test(value)

/** The readable part of a hashed file name: no dot, no colon, never empty. */
const slugOf = (value) => {
  const flat = String(value).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return (flat.slice(0, SLUG_CHARS) || 'id').replace(/-+$/g, '') || 'id'
}

/** `slug-<sha256(id) prefix>`: distinct for every distinct id, case included. */
const fileNameOf = (value) => `${slugOf(value)}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, HASH_CHARS)}`

/**
 * @param {object} options
 * @param {string} options.dir the cache root (plugin data dir + `/sessions`)
 * @param {(line: string) => void} [options.log]
 * @param {number} [options.maxBytes] per-session file budget (test seam)
 * @param {number} [options.rotations] how many rotated files to keep
 * @returns {{append: Function, read: Function, history: Function, remove: Function, fileFor: Function,
 *   dir: string, maxBytes: number, rotations: number}}
 */
export function createSessionCache({ dir, log = () => {}, maxBytes = SESSION_CACHE_MAX_BYTES,
  rotations = SESSION_CACHE_ROTATIONS } = {}) {
  const root = String(dir ?? '')
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : SESSION_CACHE_MAX_BYTES
  const keep = Number.isSafeInteger(rotations) && rotations >= 0 ? rotations : SESSION_CACHE_ROTATIONS
  /** `${hostId}/${sessionId}` -> bytes of the current (non-rotated) file. */
  const sizes = new Map()
  /** Host directories already created and restricted (the ACL pass is not free). */
  const prepared = new Set()

  const hostDirName = (hostId) => fileNameOf(hostId)
  const hostDir = (hostId) => path.join(root, hostDirName(hostId))
  // Rotation files are structurally different from the live one (their own
  // directory), so `<id>.1.jsonl` can never be confused with a session whose id
  // happens to be `s.1`.
  const fileFor = (hostId, sessionId, index = 0) => {
    const name = fileNameOf(sessionId)
    return index === 0
      ? path.join(hostDir(hostId), `${name}.jsonl`)
      : path.join(hostDir(hostId), ROTATION_DIRECTORY, `${name}.${index}.jsonl`)
  }

  const ensureDir = (hostId) => {
    if (!root) return false
    if (prepared.has(hostId)) return true
    ensureOwnerOnlyDirectory(root)
    const target = hostDir(hostId)
    try {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      fs.mkdirSync(path.join(target, ROTATION_DIRECTORY), { recursive: true, mode: 0o700 })
    } catch (error) {
      log(`transcript cache directory unavailable [${error.code ?? 'error'}]`)
      return false
    }
    prepared.add(hostId)
    return true
  }

  const sizeOf = (key, hostId, sessionId) => {
    const known = sizes.get(key)
    if (known !== undefined) return known
    let size = 0
    try { size = fs.statSync(fileFor(hostId, sessionId, 0)).size } catch { size = 0 }
    sizes.set(key, size)
    return size
  }

  /** Move the current file to `.1` and shift the older ones, dropping the oldest. */
  const rotate = (hostId, sessionId) => {
    if (keep <= 0) {
      // No rotation configured: the file is replaced instead of growing forever.
      try { fs.rmSync(fileFor(hostId, sessionId, 0), { force: true }) } catch { /* absent */ }
      return 0
    }
    try { fs.rmSync(fileFor(hostId, sessionId, keep), { force: true }) } catch { /* absent */ }
    for (let index = keep - 1; index >= 1; index -= 1) {
      try { fs.renameSync(fileFor(hostId, sessionId, index), fileFor(hostId, sessionId, index + 1)) } catch {
        /* nothing at this depth yet */
      }
    }
    try { fs.renameSync(fileFor(hostId, sessionId, 0), fileFor(hostId, sessionId, 1)) } catch {
      /* nothing to rotate */
    }
    return 0
  }

  /**
   * Append one `session/follow` frame. A frame that cannot be serialized is
   * skipped (never written half-way); a frame larger than the whole budget still
   * gets written into a fresh file, because it is a page the user is reading —
   * the next append rotates it out of the live file.
   * @returns {boolean} whether the frame was written
   */
  const append = (hostId, sessionId, frame) => {
    if (!isCacheId(hostId) || !isCacheId(sessionId)) return false
    let line
    try { line = JSON.stringify(frame) } catch { return false }
    if (typeof line !== 'string' || line === '') return false
    const bytes = Buffer.byteLength(line, 'utf8') + 1
    const key = `${hostId}/${sessionId}`
    const file = fileFor(hostId, sessionId, 0)
    try {
      if (!ensureDir(hostId)) return false
      const existed = fs.existsSync(file)
      let size = sizeOf(key, hostId, sessionId)
      // The live file is full (or the frame alone fills it): start a new one
      // instead of growing past the budget.
      if (size > 0 && size + bytes > limit) size = rotate(hostId, sessionId)
      fs.appendFileSync(file, `${line}\n`, { mode: SECRET_FILE_MODE })
      // Owner-only on creation (re-applying an ACL on every append is not free,
      // and the mode/ACL does not change for an existing file).
      if (!existed) restrictToOwnerSync(file, 'file')
      sizes.set(key, size + bytes)
      return true
    } catch (error) {
      sizes.delete(key)
      log(`transcript cache write failed [${error.code ?? 'error'}]`)
      return false
    }
  }

  /** Parse the rotation chain oldest-first; a torn tail line is skipped. */
  const readAll = (hostId, sessionId) => {
    if (!isCacheId(hostId) || !isCacheId(sessionId)) return null
    const frames = []
    let found = false
    for (let index = keep; index >= 0; index -= 1) {
      let text
      try { text = fs.readFileSync(fileFor(hostId, sessionId, index), 'utf8') } catch { continue }
      found = true
      for (const line of text.split('\n')) {
        if (!line) continue
        try {
          const frame = JSON.parse(line)
          if (frame && typeof frame === 'object' && !Array.isArray(frame)) frames.push(frame)
        } catch { /* a torn line from a crash mid-write is not a frame */ }
      }
    }
    return found ? frames : null
  }

  /**
   * The frames a follow stream can replay: the newest opening snapshot plus every
   * increment after it.
   *
   * A follow stream must OPEN with a snapshot (the client validates the opening
   * frame), so a cache whose baseline has already rotated out replays nothing:
   * the caller keeps its normal offline refusal instead of handing the UI a
   * stream it would reject. `history()` still serves the increments it kept.
   * @returns {object[]|null} null when nothing is cached or no baseline survived
   */
  const read = (hostId, sessionId) => {
    const frames = readAll(hostId, sessionId)
    if (!frames || frames.length === 0) return null
    let start = -1
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      if (frames[index].type === 'snapshot') { start = index; break }
    }
    if (start < 0) return null
    return frames.slice(start)
  }

  /**
   * `GET …/history` shape built from the local copy (`{kind:'history', events}`),
   * marked `cached` so the caller can tell it apart from a live page. A rotated-out
   * baseline does not matter here: a page of events is still readable.
   * @returns {object|null} null when nothing (or nothing readable) is cached
   */
  const history = (hostId, sessionId) => {
    const frames = readAll(hostId, sessionId)
    if (!frames) return null
    const events = []
    for (const frame of frames) {
      if (frame.type === 'snapshot') {
        for (const record of Array.isArray(frame.records) ? frame.records : []) {
          if (record?.type === 'event' && record.event) events.push(record.event)
        }
        continue
      }
      if (frame.type === 'event' && frame.event) events.push(frame.event)
    }
    if (events.length === 0) return null
    return { kind: 'history', sessionId, events, cached: true, readOnly: true, hasMore: false, source: 'cache' }
  }

  /**
   * Delete every file of one (host, session): the live file and its rotations.
   *
   * The P2b single-page `<id>.json` is not handled here, because this module never
   * turns a raw id into a file name (see the header). The one caller that removes
   * a copy (`DELETE …/sessions/:sid`) sweeps that older file itself.
   */
  const remove = (hostId, sessionId) => {
    if (!isCacheId(hostId) || !isCacheId(sessionId)) return false
    let removed = false
    const files = []
    for (let index = 0; index <= keep; index += 1) files.push(fileFor(hostId, sessionId, index))
    for (const file of files) {
      try {
        fs.rmSync(file)
        removed = true
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    sizes.delete(`${hostId}/${sessionId}`)
    return removed
  }

  return { append, read, history, remove, fileFor, dir: root, maxBytes: limit, rotations: keep }
}

export default createSessionCache

// -- bounded retention snapshots (spec 038 R1/R2/R7) -------------------------
//
// The merged workspace and session rows of a paired Host are kept in ONE
// plugin-owned JSON file, beside the transcript files. No DSH state or file is
// touched. Ids are values in that file, never file names, and nothing here logs
// a row body, an id, or a prompt.

/** Defaults from spec 038 R7. */
export const RETENTION_MAX_HOSTS = 32
export const RETENTION_MAX_SESSION_ROWS = 200
export const RETENTION_MAX_WORKSPACE_ROWS = 200
export const RETENTION_MAX_BYTES = 2 * 1024 * 1024
export const RETENTION_MAX_HOST_BYTES = 256 * 1024
export const RETENTION_TTL_MS = 7 * 24 * 60 * 60 * 1000

const RETENTION_FILE = 'retention.json'
const isRetentionObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isRetentionId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256
const cloneRetention = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

/**
 * @param {object} options
 * @param {string} options.dir plugin data dir (the file is `<dir>/retention.json`)
 * @param {(line: string) => void} [options.log]
 * @param {number} [options.maxHosts]
 * @param {number} [options.maxSessionRows]
 * @param {number} [options.maxWorkspaceRows]
 * @param {number} [options.maxBytes]
 * @param {number} [options.maxHostBytes]
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.now] test seam
 */
export function createRetentionStore({ dir, log = () => {}, maxHosts = RETENTION_MAX_HOSTS,
  maxSessionRows = RETENTION_MAX_SESSION_ROWS, maxWorkspaceRows = RETENTION_MAX_WORKSPACE_ROWS,
  maxBytes = RETENTION_MAX_BYTES, maxHostBytes = RETENTION_MAX_HOST_BYTES,
  ttlMs = RETENTION_TTL_MS, now = Date.now } = {}) {
  const root = String(dir ?? '')
  const file = path.join(root, RETENTION_FILE)
  const hostLimit = Number.isSafeInteger(maxHosts) && maxHosts > 0 ? maxHosts : RETENTION_MAX_HOSTS
  const sessionLimit = Number.isSafeInteger(maxSessionRows) && maxSessionRows > 0 ? maxSessionRows : RETENTION_MAX_SESSION_ROWS
  const workspaceLimit = Number.isSafeInteger(maxWorkspaceRows) && maxWorkspaceRows > 0 ? maxWorkspaceRows : RETENTION_MAX_WORKSPACE_ROWS
  const byteLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : RETENTION_MAX_BYTES
  const hostByteLimit = Number.isFinite(maxHostBytes) && maxHostBytes > 0 ? Math.floor(maxHostBytes) : RETENTION_MAX_HOST_BYTES
  const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : RETENTION_TTL_MS
  const nowOf = () => {
    const value = Number(now())
    return Number.isFinite(value) ? value : Date.now()
  }

  const sessionRows = (value) => (Array.isArray(value) ? value : [])
    .filter((row) => isRetentionObject(row) && isRetentionId(row.sessionId))
    .slice(0, sessionLimit)

  const workspaceSnapshot = (value, hostId, hostName) => {
    if (!isRetentionObject(value)) return null
    const items = (Array.isArray(value.items) ? value.items : [])
      .filter((item) => isRetentionObject(item) && isRetentionId(item.workspaceId))
      .slice(0, workspaceLimit)
    const ids = new Set(items.map((item) => item.workspaceId))
    const boundedList = (input) => (Array.isArray(input) ? input : [])
      .filter((id) => isRetentionId(id) && ids.has(id))
      .slice(0, workspaceLimit)
    return {
      hostId,
      hostName: typeof value.hostName === 'string' && value.hostName !== '' ? value.hostName : hostName,
      items,
      order: boundedList(value.order),
      archived: boundedList(value.archived),
      pinned: boundedList(value.pinned),
    }
  }

  const normaliseHost = (value) => {
    if (!isRetentionObject(value) || !isRetentionId(value.hostId)) return null
    const hostId = value.hostId
    const hostName = typeof value.hostName === 'string' && value.hostName !== '' ? value.hostName : hostId
    const sessions = sessionRows(value.sessions)
    const workspace = workspaceSnapshot(value.workspace, hostId, hostName)
    if (sessions.length === 0 && workspace === null) return null
    const savedAt = Number.isFinite(value.savedAt) ? value.savedAt : 0
    return { hostId, hostName, savedAt, sessions, workspace }
  }

  let hosts = []
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const at = nowOf()
    hosts = (Array.isArray(parsed?.hosts) ? parsed.hosts : [])
      .map(normaliseHost)
      .filter((host) => host && (ttl === 0 || at - host.savedAt <= ttl))
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`retention snapshot unreadable, starting empty [${error?.code ?? 'parse error'}]`)
  }

  const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')

  const shrinkHost = (host) => {
    const trim = () => {
      if (host.workspace) {
        const ids = new Set(host.workspace.items.map((item) => item.workspaceId))
        host.workspace.order = host.workspace.order.filter((id) => ids.has(id))
      }
    }
    while (host.workspace && host.workspace.items.length > 0 && bytesOf(host) > hostByteLimit) {
      host.workspace.items.pop()
      trim()
    }
    if (host.workspace && bytesOf(host) > hostByteLimit) host.workspace = null
    while (host.sessions.length > 0 && bytesOf(host) > hostByteLimit) host.sessions.pop()
  }

  const prune = () => {
    for (const host of hosts) shrinkHost(host)
    hosts = hosts.filter((host) => host && (host.sessions.length > 0 || host.workspace !== null))
    hosts.sort((a, b) => b.savedAt - a.savedAt)
    hosts = hosts.slice(0, hostLimit)
    while (hosts.length > 0 && bytesOf({ version: 1, hosts }) > byteLimit) hosts.pop()
  }

  prune()

  const save = () => {
    prune()
    try {
      ensureOwnerOnlyDirectory(root)
      writeSecretFile(file, JSON.stringify({ version: 1, savedAt: nowOf(), hosts }, null, 2))
    } catch (error) {
      log(`retention snapshot write failed [${error?.code ?? 'error'}]`)
    }
  }

  const hostOf = (hostId) => hosts.find((host) => host.hostId === hostId) ?? null
  const put = (hostId, patch, hostName) => {
    if (!isRetentionId(hostId)) return false
    const old = hostOf(hostId)
    const next = normaliseHost({
      ...(old ?? {}),
      ...patch,
      hostId,
      hostName: typeof hostName === 'string' && hostName !== '' ? hostName : (old?.hostName ?? hostId),
      savedAt: nowOf(),
    })
    hosts = next ? [next, ...hosts.filter((host) => host.hostId !== hostId)] : hosts.filter((host) => host.hostId !== hostId)
    save()
    return true
  }

  return {
    file,
    /** All usable snapshots, detached from the store's own state. */
    list: () => hosts.map((host) => ({ ...cloneRetention(host), sessions: cloneRetention(host.sessions), workspace: cloneRetention(host.workspace) })),
    readHost(hostId) {
      const host = hostOf(hostId)
      if (!host) return null
      return { sessions: cloneRetention(host.sessions), workspace: cloneRetention(host.workspace), savedAt: host.savedAt }
    },
    setSessions(hostId, rows, hostName) { return put(hostId, { sessions: sessionRows(rows), workspace: hostOf(hostId)?.workspace ?? null }, hostName) },
    setWorkspace(hostId, snapshot, hostName) { return put(hostId, { workspace: workspaceSnapshot(snapshot, hostId, hostName), sessions: hostOf(hostId)?.sessions ?? [] }, hostName) },
    removeHost(hostId) {
      if (!isRetentionId(hostId)) return false
      const before = hosts.length
      hosts = hosts.filter((host) => host.hostId !== hostId)
      if (hosts.length !== before) save()
      return hosts.length !== before
    },
  }
}
