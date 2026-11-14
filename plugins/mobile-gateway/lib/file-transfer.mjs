// Split plan step 2 (2026-11-14): pure move of the file-transfer and server-directory code out of
// lib/index.mjs. proxyQuery/requireSessionId stay in index.mjs and are injected (no import cycle).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { log } from './logging.mjs'

export function fileTransferError(code, message, requestType, sessionId) {
  return {
    kind: 'error',
    code,
    message,
    requestType,
    ...(sessionId ? { sessionId } : {}),
  }
}

export function fileMediaType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.apk': return 'application/vnd.android.package-archive'
    case '.doc': return 'application/msword'
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.ipa': return 'application/octet-stream'
    case '.json': return 'application/json'
    case '.pdf': return 'application/pdf'
    case '.ppt': return 'application/vnd.ms-powerpoint'
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case '.txt': return 'text/plain'
    case '.xls': return 'application/vnd.ms-excel'
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case '.zip': return 'application/zip'
    default: return 'application/octet-stream'
  }
}

export function workspaceRelativePath(root, target) {
  const relative = path.relative(root, target)
  return relative ? relative.split(path.sep).join('/') : '.'
}

export function isInsideWorkspace(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function normalizedWorkspaceInput(value, { allowEmpty = false } = {}) {
  if (value === undefined && allowEmpty) return '.'
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed && allowEmpty) return '.'
  if (!trimmed || trimmed.includes('\0') || path.isAbsolute(trimmed)) return null
  if (trimmed.split(/[\\/]+/).includes('..')) return null
  return trimmed
}

// Owns only workspace-scoped, regular-file downloads. The host API has an
// image-only attachment read path, so arbitrary document/archive bytes must be
// guarded here instead of accepting a host path from the mobile client.
export function createFileTransferManager(api, options, { proxyQuery, requireSessionId }) {
  const transfers = new Map()

  const closeTransfer = async (transferId) => {
    const transfer = transfers.get(transferId)
    if (!transfer) return false
    transfers.delete(transferId)
    try {
      await transfer.handle.close()
    } catch {
      // A failed close cannot make a completed or cancelled transfer usable.
    }
    return true
  }

  const resolveSessionRoot = async (sessionId, requestType) => {
    const sessions = await proxyQuery(api, requestType, api.sessions.list.bind(api.sessions), {})
    if (sessions.kind === 'error') return sessions
    const item = Array.isArray(sessions.items)
      ? sessions.items.find((entry) => entry && String(entry.sessionId) === sessionId)
      : null
    if (!item) return fileTransferError('session-not-found', 'no such session', requestType, sessionId)
    if (typeof item.cwd !== 'string' || !item.cwd.trim()) {
      return fileTransferError('file-workspace-unavailable', 'the session has no working directory', requestType, sessionId)
    }
    try {
      const root = await fsp.realpath(item.cwd)
      const stat = await fsp.stat(root)
      if (!stat.isDirectory()) {
        return fileTransferError('file-workspace-unavailable', 'the session working directory is unavailable', requestType, sessionId)
      }
      return { root, inputRoot: path.resolve(item.cwd) }
    } catch {
      return fileTransferError('file-workspace-unavailable', 'the session working directory is unavailable', requestType, sessionId)
    }
  }

  const resolveWorkspaceTarget = async (sessionId, rawPath, requestType, inputOptions) => {
    // Only the resolver accepts native absolute paths from recorded deliveries
    // or Markdown links. Download requests remain workspace-relative.
    const absoluteInput = inputOptions?.allowAbsolute === true
      && typeof rawPath === 'string' && path.isAbsolute(rawPath.trim())
    const requested = absoluteInput
      ? (rawPath.includes('\0') || rawPath.trim().split(/[\\/]+/).includes('..') ? null : rawPath.trim())
      : normalizedWorkspaceInput(rawPath, inputOptions)
    if (!requested) {
      return fileTransferError('bad-request', `${requestType} requires a valid ${inputOptions?.allowAbsolute ? '' : 'relative '}workspace path`, requestType, sessionId)
    }
    const rootResult = await resolveSessionRoot(sessionId, requestType)
    if (rootResult.kind === 'error') return rootResult
    // macOS commonly exposes one workspace as both /var/... and /private/var/...
    // (and cwd itself may be a symlink). Map only the known cwd alias before
    // enforcing the canonical root, then still verify the target's realpath.
    const candidate = absoluteInput && isInsideWorkspace(rootResult.inputRoot, requested)
      ? path.resolve(rootResult.root, path.relative(rootResult.inputRoot, requested))
      : path.resolve(rootResult.root, requested)
    if (!isInsideWorkspace(rootResult.root, candidate)) {
      return fileTransferError('file-not-allowed', 'path must stay inside the session working directory', requestType, sessionId)
    }
    try {
      const target = await fsp.realpath(candidate)
      if (!isInsideWorkspace(rootResult.root, target)) {
        return fileTransferError('file-not-allowed', 'path must stay inside the session working directory', requestType, sessionId)
      }
      const stat = await fsp.stat(target)
      return { root: rootResult.root, target, stat }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return fileTransferError('file-not-found', 'file does not exist', requestType, sessionId)
      }
      return fileTransferError('file-unreadable', 'file cannot be read', requestType, sessionId)
    }
  }

  const resolveFile = async (msg) => {
    const session = requireSessionId(msg)
    if (session.error) return session.error
    if (typeof msg.requestId !== 'string' || !msg.requestId.trim()) {
      return fileTransferError('bad-request', 'file-resolve requires a requestId', 'file-resolve', session.value)
    }
    const resolved = await resolveWorkspaceTarget(session.value, msg.path, 'file-resolve', { allowAbsolute: true })
    if (resolved.kind === 'error') return resolved
    if (!resolved.stat.isFile()) {
      return fileTransferError('file-not-regular', 'only regular files can be previewed', 'file-resolve', session.value)
    }
    if (resolved.stat.size > options.fileDownloadMaxBytes) {
      return fileTransferError('file-too-large', 'file exceeds the configured download limit', 'file-resolve', session.value)
    }
    return {
      kind: 'file-resolved', requestId: msg.requestId, sessionId: session.value,
      path: workspaceRelativePath(resolved.root, resolved.target),
      name: path.basename(resolved.target), mediaType: fileMediaType(resolved.target),
      size: resolved.stat.size, modifiedAt: resolved.stat.mtimeMs,
    }
  }

  const fileList = async (msg) => {
    const session = requireSessionId(msg)
    if (session.error) return session.error
    const resolved = await resolveWorkspaceTarget(session.value, msg.path, 'file-list', { allowEmpty: true })
    if (resolved.kind === 'error') return resolved
    if (!resolved.stat.isDirectory()) {
      return fileTransferError('file-not-directory', 'path is not a directory', 'file-list', session.value)
    }
    try {
      const dirents = await fsp.readdir(resolved.target, { withFileTypes: true })
      const entries = []
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) continue
        const child = path.join(resolved.target, dirent.name)
        if (dirent.isDirectory()) {
          entries.push({ name: dirent.name, path: workspaceRelativePath(resolved.root, child), kind: 'directory' })
        } else if (dirent.isFile()) {
          const stat = await fsp.stat(child)
          entries.push({
            name: dirent.name,
            path: workspaceRelativePath(resolved.root, child),
            kind: 'file',
            bytes: stat.size,
            modifiedAt: stat.mtimeMs,
            mediaType: fileMediaType(child),
          })
        }
      }
      entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1))
      const requestId = typeof msg.requestId === 'string' && msg.requestId.trim() ? msg.requestId.trim() : null
      return {
        kind: 'file-list',
        ...(requestId ? { requestId } : {}),
        sessionId: session.value,
        path: workspaceRelativePath(resolved.root, resolved.target),
        entries,
      }
    } catch {
      return fileTransferError('file-unreadable', 'directory cannot be read', 'file-list', session.value)
    }
  }

  const open = async (client, msg) => {
    const requestId = typeof msg.requestId === 'string' && msg.requestId.trim() ? msg.requestId.trim() : null
    const session = requireSessionId(msg)
    if (!requestId) return fileTransferError('bad-request', 'file-download-open requires a requestId', 'file-download-open')
    if (session.error) return session.error
    if (transfers.size >= options.fileDownloadMaxTransfers) {
      return fileTransferError('file-transfer-limit', 'too many active file downloads', 'file-download-open', session.value)
    }
    const resolved = await resolveWorkspaceTarget(session.value, msg.path, 'file-download-open')
    if (resolved.kind === 'error') return resolved
    if (!resolved.stat.isFile()) {
      return fileTransferError('file-not-regular', 'only regular files can be downloaded', 'file-download-open', session.value)
    }
    if (resolved.stat.size > options.fileDownloadMaxBytes) {
      return fileTransferError('file-too-large', 'file exceeds the configured download limit', 'file-download-open', session.value)
    }

    let handle
    try {
      // Reject a last-moment leaf symlink replacement after the realpath
      // containment check above. macOS and Linux both support O_NOFOLLOW.
      handle = await fsp.open(resolved.target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size !== resolved.stat.size) {
        await handle.close()
        return fileTransferError('file-changed', 'file changed before download could start', 'file-download-open', session.value)
      }
    } catch {
      return fileTransferError('file-unreadable', 'file cannot be opened', 'file-download-open', session.value)
    }

    const transferId = crypto.randomUUID()
    const transfer = {
      client,
      handle,
      sessionId: session.value,
      path: workspaceRelativePath(resolved.root, resolved.target),
      name: path.basename(resolved.target),
      mediaType: fileMediaType(resolved.target),
      size: resolved.stat.size,
      offset: 0,
      hash: crypto.createHash('sha256'),
      reading: false,
      lastActiveAt: Date.now(),
    }
    transfers.set(transferId, transfer)
    log(`file download opened: transfer=${transferId} session=${transfer.sessionId} bytes=${transfer.size}`)
    return {
      kind: 'file-download-opened',
      requestId,
      transferId,
      sessionId: transfer.sessionId,
      path: transfer.path,
      name: transfer.name,
      mediaType: transfer.mediaType,
      size: transfer.size,
      chunkBytes: options.fileDownloadChunkBytes,
    }
  }

  const read = async (client, msg) => {
    const transferId = typeof msg.transferId === 'string' && msg.transferId.trim() ? msg.transferId.trim() : null
    if (!transferId) return fileTransferError('bad-request', 'file-download-read requires a transferId', 'file-download-read')
    const transfer = transfers.get(transferId)
    if (!transfer || transfer.client !== client) {
      return fileTransferError('file-transfer-not-found', 'file download is no longer active', 'file-download-read')
    }
    if (!Number.isSafeInteger(msg.offset) || msg.offset !== transfer.offset) {
      return fileTransferError('file-transfer-offset', 'offset must match the next unread byte', 'file-download-read', transfer.sessionId)
    }
    if (transfer.reading) {
      return fileTransferError('file-transfer-busy', 'a chunk read is already in progress', 'file-download-read', transfer.sessionId)
    }

    transfer.reading = true
    try {
      const remaining = transfer.size - transfer.offset
      const bytesToRead = Math.min(options.fileDownloadChunkBytes, remaining)
      const chunk = Buffer.allocUnsafe(bytesToRead)
      const { bytesRead } = bytesToRead === 0
        ? { bytesRead: 0 }
        : await transfer.handle.read(chunk, 0, bytesToRead, transfer.offset)
      if (bytesRead !== bytesToRead) {
        await closeTransfer(transferId)
        return fileTransferError('file-changed', 'file changed during download', 'file-download-read', transfer.sessionId)
      }
      const payload = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead)
      transfer.hash.update(payload)
      const offset = transfer.offset
      transfer.offset += bytesRead
      transfer.lastActiveAt = Date.now()
      const eof = transfer.offset === transfer.size
      const frame = {
        kind: 'file-download-chunk',
        transferId,
        offset,
        data: payload.toString('base64'),
        eof,
      }
      if (eof) {
        frame.sha256 = transfer.hash.digest('hex')
        await closeTransfer(transferId)
        log(`file download completed: transfer=${transferId} bytes=${transfer.size}`)
      }
      return frame
    } catch {
      await closeTransfer(transferId)
      return fileTransferError('file-unreadable', 'file cannot be read', 'file-download-read', transfer.sessionId)
    } finally {
      transfer.reading = false
    }
  }

  const cancel = async (client, msg) => {
    const transferId = typeof msg.transferId === 'string' && msg.transferId.trim() ? msg.transferId.trim() : null
    if (!transferId) return fileTransferError('bad-request', 'file-download-cancel requires a transferId', 'file-download-cancel')
    const transfer = transfers.get(transferId)
    if (!transfer || transfer.client !== client) {
      return fileTransferError('file-transfer-not-found', 'file download is no longer active', 'file-download-cancel')
    }
    await closeTransfer(transferId)
    log(`file download cancelled: transfer=${transferId}`)
    return { kind: 'file-download-cancelled', transferId }
  }

  const expire = async () => {
    const cutoff = Date.now() - options.fileDownloadIdleMs
    for (const [transferId, transfer] of transfers) {
      if (transfer.lastActiveAt < cutoff && !transfer.reading) {
        await closeTransfer(transferId)
        log(`file download expired: transfer=${transferId}`)
      }
    }
  }

  return {
    async handle(client, msg) {
      const correlation = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
      if (!options.fileDownloadsEnabled) {
        return { ...fileTransferError('file-download-disabled', 'file downloads are disabled by gateway configuration', msg.type), ...correlation }
      }
      if (msg.type === 'file-resolve') return { ...await resolveFile(msg), ...correlation }
      if (msg.type === 'file-list') return fileList(msg)
      if (msg.type === 'file-download-open') return open(client, msg)
      if (msg.type === 'file-download-read') return read(client, msg)
      if (msg.type === 'file-download-cancel') return cancel(client, msg)
      return null
    },
    async closeClient(client) {
      for (const [transferId, transfer] of transfers) {
        if (transfer.client === client) await closeTransfer(transferId)
      }
    },
    async dispose() {
      for (const transferId of [...transfers.keys()]) await closeTransfer(transferId)
    },
    expire,
  }
}

// List one directory level directly with node:fs, mirroring the official
// browse backend's semantics (crumbs + name-sorted child directories). Works
// on every deployment regardless of the composed picker capability, which
// `host.listDirectory` would otherwise gate behind the `browse` capability.
export async function listServerDirectory(target) {
  try {
    const home = os.homedir()
    const requested = target ? path.resolve(target) : home
    const crumbs = []
    let cur = requested
    for (;;) {
      crumbs.unshift({ name: cur === path.parse(cur).root ? cur : path.basename(cur), path: cur, hidden: false })
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
    const entries = []
    const dirents = await fsp.readdir(requested, { withFileTypes: true })
    for (const dirent of dirents) {
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
      entries.push({ name: dirent.name, path: path.join(requested, dirent.name), hidden: dirent.name.startsWith('.') })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    log(`query ok: directories (${requested}, ${entries.length} entries)`)
    return { kind: 'directories', path: requested, home, crumbs, entries, truncated: false }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    log(`query failed: directories -> ${message}`)
    return { kind: 'error', code: 'directory-unreadable', message, requestType: 'directories' }
  }
}

export function directoryCreateError(code, message) {
  return { kind: 'error', code, message, requestType: 'directory-create' }
}

// Create one child directory directly on the host filesystem. This deliberately
// shares the same backend as `directories`: macOS native Directory Picker only
// exposes its system dialog and does not implement remote createDirectory RPCs.
export async function createServerDirectory(parentPath, directoryName) {
  if (typeof parentPath !== 'string' || parentPath.trim() === '') {
    return directoryCreateError('bad-request', 'directory-create requires an absolute parent path')
  }
  const parent = path.resolve(parentPath.trim())
  if (!path.isAbsolute(parentPath.trim())) {
    return directoryCreateError('bad-request', 'directory-create path must be absolute')
  }

  if (typeof directoryName !== 'string') {
    return directoryCreateError('bad-request', 'directory-create requires a folder name')
  }
  const name = directoryName.trim()
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return directoryCreateError('bad-request', 'directory-create name must be a single non-empty folder name')
  }

  try {
    const stat = await fsp.stat(parent)
    if (!stat.isDirectory()) {
      return directoryCreateError('directory-create-failed', 'parent path is not a directory')
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    log(`query failed: directory-create -> ${message}`)
    return directoryCreateError('directory-create-failed', message)
  }

  const target = path.join(parent, name)
  try {
    await fsp.mkdir(target)
    log(`query ok: directory-create (${target})`)
    return { kind: 'directory-create', path: target }
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return directoryCreateError('directory-exists', 'directory already exists')
    }
    const message = error && error.message ? error.message : String(error)
    log(`query failed: directory-create -> ${message}`)
    return directoryCreateError('directory-create-failed', message)
  }
}
