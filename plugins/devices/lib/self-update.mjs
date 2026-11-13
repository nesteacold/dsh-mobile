// Spec 027: plugin self-update ("Check for updates") for the linked @dsh-ext/* checkout.
//
// Only these git subcommands are ever run: fetch, tag, log, merge-base, status,
// merge --ff-only, plus read-only show <tag>:<plugin>/package.json (engines.dsh at the tag)
// and optional erify-tag (both named by the spec).
// Fixed argv (no shell), a timeout, GIT_TERMINAL_PROMPT=0. Never reset/stash/
// checkout/clean/force; never restarts DSH; never reads credentials.
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REMOTE_URL = 'https://github.com/nesteacold/dsh-mobile.git'
export const ALLOWED_REMOTE = /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]nesteacold\/dsh-mobile(?:\.git)?\/?$/
const PLUGINS = ['plugins/devices', 'plugins/mobile-gateway']
const LOCKFILES = ['package-lock.json', ...PLUGINS.map((p) => `${p}/package-lock.json`)]
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export class SelfUpdateError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

export function parseSemver(v) {
  const m = SEMVER.exec(String(v).trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}

export function compareSemver(a, b) {
  const x = typeof a === 'string' ? parseSemver(a) : a
  const y = typeof b === 'string' ? parseSemver(b) : b
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : (x.pre.length ? -1 : 1)
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]; const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p); const qn = /^\d+$/.test(q)
    if (pn && qn) return +p < +q ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/** Minimal range check: space-separated comparators (>=,>,<=,<,=), `||` alternatives. */
export function satisfies(version, range) {
  const v = parseSemver(version)
  if (!v || typeof range !== 'string' || !range.trim()) return false
  return range.split('||').some((alt) => alt.trim().split(/\s+/).filter(Boolean).every((c) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(c)
    const r = parseSemver(m[2])
    if (!r) return false
    const d = compareSemver(v, r)
    switch (m[1] || '=') {
      case '>=': return d >= 0
      case '>': return d > 0
      case '<=': return d <= 0
      case '<': return d < 0
      default: return d === 0
    }
  }))
}

/** Real runner: fixed argv, no shell, timeout, no prompts. Returns stdout. */
export function createGitRunner({ cwd, timeoutMs = 60_000 } = {}) {
  return (args, { timeout = timeoutMs } = {}) => new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, timeout, windowsHide: true, shell: false, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never' },
    }, (error, stdout, stderr) => {
      if (error) {
        const e = new SelfUpdateError(error.killed || error.signal ? 'timeout' : 'git-failed',
          `git ${args[0]} failed${error.killed ? ' (timeout)' : ''}: ${String(stderr || error.message).trim().slice(-400)}`)
        reject(e)
      } else resolve(String(stdout))
    })
  })
}

export function createNpmCi({ cwd, timeoutMs = 300_000 } = {}) {
  return (dir) => new Promise((resolve) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    execFile(npm, ['ci', '--ignore-scripts'], { cwd: path.join(cwd, dir), timeout: timeoutMs, windowsHide: true, shell: process.platform === 'win32' },
      (error, stdout, stderr) => resolve({ dir, ok: !error, tail: `${stdout}\n${stderr}`.trim().split('\n').slice(-10).join('\n') }))
  })
}

export function defaultRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

/**
 * @param {{ git: (args: string[]) => Promise<string>, dshVersion?: string,
 *   npmCi?: (dir: string) => Promise<{dir:string, ok:boolean, tail:string}> }} deps
 */
export function createSelfUpdater({ git, dshVersion, npmCi = null, verifySignatures = false }) {
  let busy = false
  let lastCheck = null
  let previousHead = null

  const exclusive = async (fn) => {
    if (busy) throw new SelfUpdateError('busy', 'a check or update is already running')
    busy = true
    try { return await fn() } finally { busy = false }
  }

  const readManifest = async (ref, dir) => {
    try { return JSON.parse(await git(['show', `${ref}:${dir}/package.json`])) } catch { return null }
  }

  async function doCheck() {
    // The remote URL is fixed here, never read from config nor editable from the UI.
    const remote = REMOTE_URL
    const st = await git(['status', '--porcelain=v2', '--branch', '--untracked-files=no'])
    const branch = (/^# branch\.head (.+)$/m.exec(st)?.[1] ?? '').trim()
    const head = (await git(['log', '-1', '--format=%H', 'HEAD'])).trim()
    await git(['fetch', '--no-write-fetch-head', '--tags', REMOTE_URL, '+refs/heads/main:refs/remotes/origin/main'])
    const tagOut = await git(['tag', '--list', 'v*', '--merged', 'origin/main'])
    const tags = tagOut.split('\n').map((t) => t.trim()).filter((t) => parseSemver(t))
      .sort((a, b) => compareSemver(b, a))
    const current = {}
    for (const p of PLUGINS) { const m = await readManifest('HEAD', p); current[p] = m?.version ?? null }
    const result = { remote, branch, head, current, dshVersion: dshVersion ?? null, latest: null, upToDate: true }
    if (!tags.length) { result.reason = 'no-tags'; return result }
    const tag = tags[0]
    const tagCommit = (await git(['log', '-1', '--format=%H', tag])).trim()
    const notes = tagCommit === head ? [] : (await git(['log', '--oneline', `HEAD..${tag}`])).split('\n').filter(Boolean)
    const plugins = []
    for (const p of PLUGINS) {
      const m = await readManifest(tag, p)
      const range = m?.engines?.dsh ?? null
      plugins.push({ dir: p, version: m?.version ?? null, enginesDsh: range,
        accepts: range && dshVersion ? satisfies(dshVersion, range) : null })
    }
    let ff = false
    try { await git(['merge-base', '--is-ancestor', 'HEAD', tag]); ff = true } catch { ff = false }
    let signature = 'unsigned'
    if (verifySignatures) {
      try { await git(['verify-tag', tag]); signature = 'verified' } catch { signature = 'unverified' }
    }
    Object.assign(result, { latest: { tag, commit: tagCommit, notes, plugins, fastForward: ff, signature },
      upToDate: tagCommit === head || notes.length === 0 })
    return result
  }

  async function check() {
    return exclusive(async () => { lastCheck = await doCheck(); return lastCheck })
  }

  async function update(expectedTag) {
    return exclusive(async () => {
      const info = await doCheck()
      lastCheck = info
      if (!info.latest) throw new SelfUpdateError('no-tags', 'no release tag on origin')
      if (expectedTag && expectedTag !== info.latest.tag) throw new SelfUpdateError('stale', 'a newer release appeared; check again')
      if (info.upToDate) return { updated: false, tag: info.latest.tag, message: 'already up to date' }
      const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).trim()
      if (dirty) throw new SelfUpdateError('dirty', 'the working tree has uncommitted changes')
      if (!info.latest.fastForward) throw new SelfUpdateError('not-ff', 'HEAD is not an ancestor of the release tag')
      if (!info.dshVersion) throw new SelfUpdateError('dsh-version-unknown', 'the running DSH version is unknown')
      const reject = info.latest.plugins.find((p) => p.accepts !== true)
      if (reject) throw new SelfUpdateError('engines-mismatch', reject.enginesDsh
        ? `${reject.dir} requires DSH ${reject.enginesDsh}`
        : `${reject.dir} declares no readable engines.dsh at ${info.latest.tag}`)
      const before = info.head
      const changed = (await git(['log', '--format=', '--name-only', `HEAD..${info.latest.tag}`]))
        .split('\n').map((s) => s.trim()).filter(Boolean)
      await git(['merge', '--ff-only', info.latest.tag])
      previousHead = before
      const npm = []
      if (npmCi) {
        for (const lock of LOCKFILES) if (changed.includes(lock)) npm.push(await npmCi(path.posix.dirname(lock)))
      }
      const version = info.latest.tag.replace(/^v/, '')
      return { updated: true, tag: info.latest.tag, previousHead: before, npm,
        message: `Restart DSH to load v${version}`,
        rollback: `previous commit ${before} (roll back manually; no destructive git is run here)` }
    })
  }

  return {
    check, update,
    status: () => ({ busy, lastCheck, previousHead }),
  }
}

export default createSelfUpdater

const STATUS = { busy: 409, dirty: 409, 'not-ff': 409, 'engines-mismatch': 409, stale: 409,
  'dsh-version-unknown': 409, 'no-tags': 404, timeout: 504, 'git-failed': 502 }

/**
 * `/devices/self-update[/check|/update]`. Mounted behind the loopback + same-origin
 * guards of the devices handler, so it is reachable only from the local owner UI.
 * @returns {Promise<boolean>} whether the request was handled
 */
export async function handleSelfUpdateRoute(updater, parts, req, readBody, sendJson) {
  if (parts[0] !== 'devices' || parts[1] !== 'self-update') return false
  try {
    if (parts.length === 2 && req.method === 'GET') sendJson(200, updater.status())
    else if (parts[2] === 'check' && parts.length === 3 && req.method === 'POST') sendJson(200, await updater.check())
    else if (parts[2] === 'update' && parts.length === 3 && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}))
      sendJson(200, await updater.update(typeof body?.tag === 'string' ? body.tag : undefined))
    } else sendJson(404, { error: 'not-found' })
  } catch (error) {
    const code = error instanceof SelfUpdateError ? error.code : 'internal'
    sendJson(STATUS[code] ?? 500, { error: code, message: error?.message ?? String(error) })
  }
  return true
}
