// Spec 031 Amendment A2/A3 (GATEWAY scope): the built PWA as static files on the loopback web
// (Serve) ingress. Leaf module: it never imports index.mjs and holds no socket.
//
// Ported from apps/mobile-companion/scripts/serve-web.mjs, which stood on a separate port (18480)
// behind its own Serve mount (A4 retires that). The request surface is the same and the safety
// rules are the same; what is new is that the SAME listener now answers `/ws/mobile` upgrades, so
// this module never sees an upgrade and serves a plain HTTP request only.
//
// WHY the header policy: `frame-ancestors` inside the app's <meta> CSP is IGNORED by browsers, so
// the clickjacking guard only exists if the host sends it as a response header. SQLite-style
// "belt and braces" for paths: every component must be a plain name, each segment must not be a
// symlink/junction/reparse point (a name check alone cannot catch a junction named `assets`), the
// final realpath must sit inside the realpathed root, and every fs error collapses to a generic
// 404/500 so no filesystem path is ever echoed and no exception can reach the request handler.
import { closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The repository default root: the BUILT PWA of this repository, resolved from this module's own
 * location (`plugins/mobile-gateway/lib` -> `apps/mobile-companion/dist`). It is deliberately a
 * repository path and not a package path: `dist/` is git-ignored and not in the npm `files` list,
 * so a disassembled install has no default and the owner points `DSH_MGW_WEB_ASSETS_DIR` at one.
 */
export const ASSET_ROOT_DEFAULT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'mobile-companion', 'dist',
)

/** Same directives the build injects as <meta>, sent as a header so they are all enforced. */
export const ASSET_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // The SAME-ORIGIN gateway socket is admitted by `wss://*.ts.net:*`: the PWA and the gateway share
  // one tailnet HTTPS origin (`tailscale serve` routes `/ws/mobile` to this listener), and the
  // derived address is always `<name>.ts.net:<port>` — a host-part suffix match with any port.
  // `'self'` stays as a second, belt-and-braces allowance. Keep in step with serve-web.mjs and
  // scripts/build-web.mjs, which inject the same policy as a <meta>.
  "connect-src 'self' wss://*.ts.net:*",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.css': 'text/css; charset=utf-8',
}

/** The manifest is advertised as application/manifest+json (docs/web-pwa.md §3): without it a
 *  browser does not parse it as a manifest at all. */
export function assetTypeFor(file) {
  return file.endsWith('manifest.json') ? 'application/manifest+json' : TYPES[path.extname(file)] || 'application/octet-stream'
}

function assetHeaders() {
  return {
    'Content-Security-Policy': ASSET_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Every served file is revalidated on each load: the build emits no validators of its own, and
    // `no-cache` on `index.html`/the service worker is what makes a redeploy reach a running PWA
    // (spec A2 names those two; the rest gain nothing from a stale copy).
    'Cache-Control': 'no-cache',
  }
}

const baseHeaders = () => ({
  'Content-Security-Policy': ASSET_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache',
})


// The real filesystem calls; uildAssetSnapshot takes overrides only as a TEST seam.
const fsOps = { closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync }

// Windows reports junctions as other-reparse points, not symlinks; both must be refused.
const isLink = (stats) => stats.isSymbolicLink()
  || (typeof stats.isReparsePoint === 'function' && stats.isReparsePoint())

// The routes the companion app's file router actually owns (`apps/mobile-companion/app`): one
// static entry each, and `s/[id]` plus `session/[id]` are the two dynamic routes (one plain-name
// segment). `s` and `session` also have their own index files (`s/index.tsx` redirects to `/`),
// so the bare `/<name>/` spelling is that index and is exactly a route too. The allowlist is
// spelled out rather than derived from a path shape, because a shape cannot tell an app route from
// a management/API one.
const SPA_ROUTES = new Set([
  '/', '/pair', '/privacy', '/schedules', '/settings', '/storage', '/conversations',
  '/s', '/s/index', '/session', '/session/index',
])
const SPA_DYNAMIC_ROUTES = ['/s', '/session']
/** The id of a dynamic route: a plain, dot-free name, so a dotted file request is never a page. */
const PLAIN_SEGMENT = /^[A-Za-z0-9_~-]+$/

/**
 * Whether a request pathname is one the SPA fallback may answer with `index.html`: an ALLOWLIST of
 * the app's own routes (`/`, `/pair`, `/privacy`, `/schedules`, `/settings`, `/storage`,
 * `/conversations`, `/s/<id>`, `/session/<id>`), each with an optional trailing `/`.
 *
 * WHY an allowlist and not the old "extension-less path" shape: a shape rule handed `index.html`
 * to every path a router MIGHT own — `/api/sessions`, `/dsh/x`, `/ws/mobile` — so a plain HTTP
 * `GET` to the browser's own WS path answered 200 with the entry page (measured: the A2/A1 live
 * checks). A path that is not a route is a 404 here unless a real file of that name exists.
 * @param {string} pathname raw pathname, leading `/`
 */
export function spaFallback(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return false
  // Routing sugar, never part of a route's identity: `/pair/` is `/pair`, and the bare `/s/`
  // spelling is the `s/index` route.
  let trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  if (trimmed === '/s' || trimmed === '/session') trimmed = `${trimmed}/index`
  if (SPA_ROUTES.has(trimmed)) return true
  const segments = trimmed.split('/').filter(Boolean)
  return segments.length === 2
    && SPA_DYNAMIC_ROUTES.includes(`/${segments[0]}`)
    && PLAIN_SEGMENT.test(segments[1])
}

// ---------------------------------------------------------------------------------------------
// SNAPSHOT. The asset root is walked ONCE (when the listener opens) and its bytes are read into a
// Map; requests are answered from that Map and never touch the filesystem. That removes the whole
// class of per-request path races (a link swapped between check and read), and lets the admission
// rules below be one strict allowlist applied to RELATIVE names instead of a pile of checks on a
// resolved path.
//
// TRUST BOUNDARY: the asset root is the OWNER's build output. Someone who can write into it already
// has the owner's authority, so the checks below are defence in depth against a mistaken or racing
// change, NOT an isolation boundary. Node on Windows has no O_NOFOLLOW, so a file is opened, then
// its identity (dev, ino) is compared with the lstat taken just before, its realpath is required to
// stay inside the realpathed root, its bytes are read THROUGH the fd, and the pathname is lstat'ed
// again afterwards. ANY mismatch discards the WHOLE snapshot (fail closed: empty, status
// `unstable`) — a partial tree is never served. Budgets cover every entry examined, bytes and time,
// with the same fail-closed outcome.
//
// Identity is compared as BigInt: on Windows a file id exceeds Number.MAX_SAFE_INTEGER, where two
// different ids can collapse to the same Number. Every stat used for identity is taken with
// `{ bigint: true }`; `size` becomes a Number only after a BigInt check that it is >= 0 and fits the
// byte budget.
//
// SCOPE OF THE GUARANTEE: it holds for a build root the owner controls. It does NOT defend against a
// local writer who can swap an ANCESTOR of the root (the root is realpathed once and an ancestor
// can be re-pointed under it); such a writer already has the owner's authority. The deadline is
// COOPERATIVE: it is checked between steps and cannot interrupt a syscall that is blocked, so it
// is not a hard timeout.
// ---------------------------------------------------------------------------------------------

/** Every segment of a served file: a plain name, never a dotfile, never a `:` (NTFS stream) or `~`. */
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
/** Win32 device names are reserved with or without an extension (`CON`, `nul.txt`, `COM1.js`). */
const DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i
/** Limits so a mis-pointed root (a home directory, a drive) cannot exhaust memory or the event loop. */
export const SNAPSHOT_MAX_ENTRIES = 10_000
export const SNAPSHOT_MAX_FILES = 4096
export const SNAPSHOT_MAX_BYTES = 128 * 1024 * 1024
export const SNAPSHOT_DEADLINE_MS = 2000
const SNAPSHOT_MAX_DEPTH = 16

/** Whether a relative path (already split) names a file this surface may ever serve. */
function admissibleSegments(segments) {
  if (segments.length === 0) return false
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) return false
    if (DEVICE_NAME.test(segment)) return false
  }
  // Source maps expose the source tree: refuse them whatever their case (`.map` suffix of the file).
  if (segments[segments.length - 1].toLowerCase().endsWith('.map')) return false
  return true
}

/** Thrown inside the walk; caught once so every failure is the same empty, `unstable` outcome. */
class SnapshotUnstable extends Error {
  constructor(reason) {
    super(reason)
    this.reason = reason
  }
}

// BigInt stats only: `dev`/`ino` stay BigInt so `ino + 1n` is always a different identity.
const sameIdentity = (a, b) => typeof a.dev === 'bigint' && typeof a.ino === 'bigint'
  && a.dev === b.dev && a.ino === b.ino
const STAT = { bigint: true }
const foldCase = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
/** Whether `target` is `root` or below it, compared on a path-separator boundary. */
const withinRoot = (root, target) => {
  const r = foldCase(root)
  const t = foldCase(target)
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/**
 * Walk `root` (already realpathed) once and return `{snapshot, error}`. On any instability
 * (identity change, a link where a plain entry was, a path escaping the root, a read that does not
 * match its fstat) or any exceeded budget the snapshot is EMPTY and `error` names a short, path-free
 * reason; otherwise `error` is `null`. A symlink, junction or other reparse point at ANY level is
 * skipped (a link seen by `lstat` is simply not served), as is every entry whose name fails the
 * allowlist and every non-regular file. Never throws.
 * @param {string|null} root realpathed asset root
 * @param {object} [options] test seams only: `fs` overrides (`lstatSync`, `fstatSync`, `openSync`,
 *   `closeSync`, `readSync`, `realpathSync`, `opendirSync`), `now()` and the four limits
 * @returns {{snapshot: Map<string, {body: Buffer, headers: object}>, error: string|null}}
 */
export function buildAssetSnapshot(root, options = {}) {
  const empty = () => new Map()
  if (typeof root !== 'string' || root === '') return { snapshot: empty(), error: null }
  const io = { ...fsOps, ...(options.fs || {}) }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const maxEntries = options.maxEntries ?? SNAPSHOT_MAX_ENTRIES
  const maxFiles = options.maxFiles ?? SNAPSHOT_MAX_FILES
  const maxBytes = options.maxBytes ?? SNAPSHOT_MAX_BYTES
  const deadline = now() + (options.deadlineMs ?? SNAPSHOT_DEADLINE_MS)
  const snapshot = new Map()
  let entriesSeen = 0
  let files = 0
  let bytes = 0
  const tick = () => {
    if (now() > deadline) throw new SnapshotUnstable('deadline')
  }
  const countEntry = () => {
    entriesSeen += 1
    if (entriesSeen > maxEntries) throw new SnapshotUnstable('entry-budget')
    tick()
  }
  const lstatPlain = (full) => {
    const stats = io.lstatSync(full, STAT)
    if (isLink(stats)) throw new SnapshotUnstable('link')
    return stats
  }

  const readFileThroughFd = (full, before, rel) => {
    let fd = -1
    try {
      fd = io.openSync(full, 'r')
      const opened = io.fstatSync(fd, STAT)
      if (!opened.isFile() || !sameIdentity(opened, before)) throw new SnapshotUnstable('identity')
      // Size is judged as BigInt first; only a value in [0, remaining] ever becomes a Number.
      const remainingBytes = BigInt(maxBytes - bytes)
      if (typeof opened.size !== 'bigint' || opened.size < 0n) throw new SnapshotUnstable('identity')
      if (opened.size > remainingBytes) throw new SnapshotUnstable('byte-budget')
      const openedSize = Number(opened.size)
      if (!withinRoot(root, io.realpathSync(full))) throw new SnapshotUnstable('outside-root')
      const remaining = maxBytes - bytes
      // One byte past the remaining budget proves "too big" without trusting the size field.
      const buffer = Buffer.allocUnsafe(Math.min(openedSize, remaining) + 1)
      let filled = 0
      while (filled < buffer.length) {
        const n = io.readSync(fd, buffer, filled, buffer.length - filled, null)
        if (n === 0) break
        filled += n
        tick()
      }
      if (filled > remaining) throw new SnapshotUnstable('byte-budget')
      if (filled !== openedSize) throw new SnapshotUnstable('identity')
      const after = lstatPlain(full)
      if (!sameIdentity(after, before)) throw new SnapshotUnstable('identity')
      bytes += filled
      files += 1
      snapshot.set(rel, { body: buffer.subarray(0, filled), headers: { 'Content-Type': assetTypeFor(rel) } })
    } finally {
      if (fd !== -1) {
        try { io.closeSync(fd) } catch { /* the descriptor is gone either way */ }
      }
    }
  }

  const walk = (dir, segments, dirStats) => {
    if (segments.length > SNAPSHOT_MAX_DEPTH) throw new SnapshotUnstable('depth')
    if (!withinRoot(root, io.realpathSync(dir))) throw new SnapshotUnstable('outside-root')
    // Entries are collected from the iterator one at a time and the count is checked on every one,
    // so a directory of millions of names stops the walk long before it is held in memory. Order
    // is made stable by sorting only the (bounded) names of THIS directory.
    const names = []
    const handle = io.opendirSync(dir)
    try {
      for (;;) {
        const entry = handle.readSync()
        if (entry === null) break
        countEntry()
        names.push(entry.name)
      }
    } finally {
      try { handle.closeSync() } catch { /* already closed */ }
    }
    names.sort()
    for (const name of names) {
      tick()
      // A name that could never be a path segment of a served file is not worth reading at all.
      if (!SEGMENT.test(name) || DEVICE_NAME.test(name)) continue
      const next = [...segments, name]
      const full = path.join(dir, name)
      let stats
      try {
        stats = io.lstatSync(full, STAT)
      } catch {
        throw new SnapshotUnstable('vanished')
      }
      if (isLink(stats)) continue
      if (stats.isDirectory()) {
        walk(full, next, stats)
        continue
      }
      if (!stats.isFile() || !admissibleSegments(next)) continue
      if (files >= maxFiles) throw new SnapshotUnstable('file-budget')
      if (typeof stats.size !== 'bigint' || stats.size < 0n) throw new SnapshotUnstable('identity')
      if (stats.size > BigInt(maxBytes - bytes)) throw new SnapshotUnstable('byte-budget')
      readFileThroughFd(full, stats, `/${next.join('/')}`)
    }
    // The directory must still be the same object that was listed.
    const after = lstatPlain(dir)
    if (!sameIdentity(after, dirStats)) throw new SnapshotUnstable('identity')
  }

  try {
    walk(root, [], lstatPlain(root))
    return { snapshot, error: null }
  } catch (error) {
    // Fail closed: a partial tree is never served. The reason is a short fixed word, never a path.
    return { snapshot: empty(), error: error instanceof SnapshotUnstable ? error.reason : 'unstable' }
  }
}

/**
 * The ONE asset root this gateway may serve: `DSH_MGW_WEB_ASSETS_DIR` when the owner set it (realpathed,
 * must be an existing directory), else `fallback`. Resolved ONCE per listener, so a link swapped
 * under a served path after start cannot move the root. An env value that does not name a usable
 * directory is reported as such (`configured: true`, `root: null`) and NEVER silently replaced by
 * the default: serving a different tree than the one the owner named would hide the mistake.
 * `root: null` means the caller serves a generic page-less 404 rather than starting a root-less
 * server or inventing another root. The files are read ONCE here into `snapshot` and requests are
 * answered from it alone; an unstable or over-budget tree yields an empty `snapshot` and a
 * `snapshotError` word (`'identity'`, `'link'`, `'outside-root'`, `'entry-budget'`, `'byte-budget'`,
 * `'file-budget'`, `'deadline'`, ...).
 * @param {string|undefined} configured the env value ('' / undefined = not configured)
 * @param {string} fallback the built PWA's default location
 * @param {object} [options] passed to `buildAssetSnapshot` (test seams)
 * @returns {{root: string|null, configured: boolean, source: 'env'|'default'|'none', snapshot: Map<string, {body: Buffer, headers: object}>, snapshotError: string|null}}
 */
export function resolveAssetRoot(configured, fallback, options) {
  const named = typeof configured === 'string' ? configured.trim() : ''
  const found = (root, configuredFlag, source) => {
    const built = buildAssetSnapshot(root, options)
    return { root, configured: configuredFlag, source, snapshot: built.snapshot, snapshotError: built.error }
  }
  if (named !== '') {
    try {
      const root = realpathSync(named)
      if (statSync(root).isDirectory()) return found(root, true, 'env')
    } catch {
      // Missing or unreadable: reported by `configured`/`indexPresent`, never a crash and never
      // a path in the answer — and deliberately no attempt at the default below.
    }
    return found(null, true, 'env')
  }
  try {
    const root = realpathSync(fallback)
    if (statSync(root).isDirectory()) return found(root, false, 'default')
  } catch {
    // The repository default is not built on this machine: nothing to serve.
  }
  return found(null, false, 'none')
}

/** Whether the snapshot holds `/index.html`: the entry a browser load needs. */
export function indexPresent(source) {
  try {
    const snapshot = source && typeof source === 'object' ? source.snapshot : null
    return snapshot instanceof Map && snapshot.has('/index.html')
  } catch {
    return false
  }
}

// The RAW request target must be this and nothing else: no `%` (so no encoded separator, dot, NUL or
// second decoding pass), no `\`, no `:` (NTFS streams, drive letters), no space, no control byte.
const RAW_PATH = /^\/[A-Za-z0-9._\-/]*$/
const SERVED_PREFIXES = ['/mgw', '/api', '/dsh']
const isWsPath = (raw) => {
  const lower = raw.toLowerCase()
  return lower === '/ws' || lower.startsWith('/ws/')
}
const hasPrefix = (raw, prefix) => {
  const lower = raw.toLowerCase()
  return lower === prefix || lower.startsWith(`${prefix}/`)
}

const plain = (res, status, extra = {}) => res.writeHead(status, { ...baseHeaders(), 'Content-Type': 'text/plain', ...extra }).end()

/**
 * Answer `req` on the web ingress from the SNAPSHOT of the built PWA. GET and HEAD only; every other
 * method is 405. Never throws: an unexpected error becomes a generic 500 (an uncaught throw would
 * take the listener's process down, and the message would echo a filesystem path). The filesystem
 * is never read here.
 *
 * The RAW `req.url` is judged, never a normalised form of it (`new URL()` collapses `/x/../f`,
 * `/%2e/f` and `//host/f` into something plausible, which is exactly what must stay refused).
 * Order: method -> `/ws` (426, even with no root) -> `/mgw` `/api` `/dsh` (404 always, even for a
 * file of that name) -> exact snapshot lookup -> SPA allowlist -> 404.
 * @param {object} req the plain HTTP request (never an upgrade)
 * @param {object} res the response
 * @param {{snapshot: Map<string, {body: Buffer, headers: object}>}|null} source from `resolveAssetRoot`
 */
export function serveWebAsset(req, res, source) {
  try {
    const method = req.method || 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      plain(res, 405, { Allow: 'GET, HEAD' })
      return
    }
    const target = typeof req.url === 'string' ? req.url : '/'
    if (target.includes('#')) { plain(res, 400); return }
    const query = target.indexOf('?')
    const raw = query === -1 ? target : target.slice(0, query)
    // `/ws` and every `/ws/...` path belong to the UPGRADE handler (contract §2): a plain HTTP
    // request there is not this surface's client at all. It is classified BEFORE the root or the
    // path shape is looked at, so a missing root cannot turn it into a 404.
    if (isWsPath(raw)) {
      plain(res, 426, { Upgrade: 'websocket' })
      return
    }
    if (!RAW_PATH.test(raw) || raw.includes('//')) { plain(res, 404); return }
    for (const segment of raw.split('/')) {
      if (segment === '.' || segment === '..') { plain(res, 404); return }
    }
    // No management or DSH route is reachable here, whatever file the snapshot might hold.
    if (SERVED_PREFIXES.some((prefix) => hasPrefix(raw, prefix))) { plain(res, 404); return }
    const snapshot = source && typeof source === 'object' && source.snapshot instanceof Map ? source.snapshot : null
    if (snapshot === null || snapshot.size === 0) { plain(res, 404); return }
    let entry = snapshot.get(raw)
    if (!entry && spaFallback(raw)) entry = snapshot.get('/index.html')
    if (!entry) { plain(res, 404); return }
    // A HEAD response carries the same headers a GET would, including Content-Length, and no body.
    res.writeHead(200, {
      ...assetHeaders(),
      ...entry.headers,
      'Content-Length': entry.body.length,
    }).end(method === 'HEAD' ? undefined : entry.body)
  } catch {
    try {
      res.writeHead(500, { ...baseHeaders(), 'Content-Type': 'text/plain' }).end()
    } catch {
      // The socket is already gone; nothing left to answer.
    }
  }
}

/**
 * Spec A3: the owner-facing asset report, reported SEPARATELY from `listening`/`active` — an asset
 * root never stands in for a listener, and a missing root never claims readiness (spec §7).
 * `configured` is "the owner named a root" (env), not "a root was found": an unusable env value is
 * `configured: true` with `indexPresent: false`. `source` says where the bytes WOULD come from:
 * `'default'` (this repository's built PWA), `'env'`, or `'none'` (no usable root at all).
 * `indexPresent` reads the snapshot taken when the listener opened.
 * @param {{root: string|null, configured: boolean, source: 'env'|'default'|'none', snapshot: Map}|null} resolved
 *   from `resolveAssetRoot` (`null` before a listener attempt resolved one)
 */
export function webAssetsStatus(source) {
  const resolved = source && typeof source === 'object' ? source : null
  const report = {
    configured: resolved?.configured === true,
    indexPresent: indexPresent(resolved),
    source: resolved?.source === 'env' || resolved?.source === 'default' ? resolved.source : 'none',
  }
  // An unstable or over-budget tree served nothing at all: say so (a fixed word, never a path)
  // instead of leaving it indistinguishable from a build with no `index.html`. Absent when stable.
  if (typeof resolved?.snapshotError === 'string' && resolved.snapshotError !== '') report.unstable = resolved.snapshotError
  return report
}
