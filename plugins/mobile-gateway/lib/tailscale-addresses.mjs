import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { isIP } from 'node:net'
import { execFile } from 'node:child_process'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isLocalHostname, isPrivateNetworkHostname } from './network-addresses.mjs'

export function isTailscaleIp(value) {
  if (typeof value !== 'string') return false
  const address = value.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number)
    return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
  }
  return isIP(address) === 6 && address.startsWith('fd7a:115c:a1e0:')
}

// MagicDNS (`<machine>.<tailnet>.ts.net`) is this node's stable handle: Tailscale
// may re-assign the tailnet address (node removed and re-added, tailnet move, key
// expiry re-registration), which strands every client that stored the literal IP.
// The name survives that, and it does not weaken authentication: TLS trust here is
// the pinned certificate fingerprint, never the hostname.
const MAGIC_DNS_CACHE_MS = 60_000
// A failed lookup is remembered only this long: every status poll would otherwise
// spawn the CLI and wait up to the 2 s budget when Tailscale is installed but the
// name never verifies, yet a transient error must not pin the IP for a minute.
const MAGIC_DNS_FAILURE_CACHE_MS = 8_000
const MAGIC_DNS_TIMEOUT_MS = 2_000
const MAGIC_DNS_MAX_NAME = 253
const MAGIC_DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const MAGIC_DNS_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

// `name` is a success (60 s); `failedUntil` a recent failure (8 s); `pending` the
// lookup in flight, shared by concurrent callers so they cause one spawn.
const magicDnsCache = { name: null, expiresAt: 0, failedUntil: 0, pending: null }

// Fixed install locations only: running whichever `tailscale` is first on PATH
// would let a PATH entry choose the binary. Nothing here is configurable.
function tailscaleCliCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return [env.ProgramFiles, env['ProgramFiles(x86)']]
      .filter((dir) => typeof dir === 'string' && dir !== '')
      .map((dir) => path.win32.join(dir, 'Tailscale', 'tailscale.exe'))
  }
  if (platform === 'darwin') return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale']
  if (platform === 'linux') return ['/usr/bin/tailscale', '/usr/sbin/tailscale']
  return []
}

/**
 * Absolute path of the installed Tailscale CLI, or `null` when none of the known
 * locations holds it (the caller then advertises the IP, as before).
 * @param {{platform?: string, env?: object, exists?: Function}} [options] injectable for tests
 * @returns {string|null}
 */
export function resolveTailscaleCli({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  for (const candidate of tailscaleCliCandidates(platform, env)) {
    try { if (exists(candidate)) return candidate } catch { /* unreadable location: try the next */ }
  }
  return null
}

/**
 * Run the Tailscale CLI without a shell. The argument vector is fixed here, so
 * neither config nor an operator string can ever become part of the command.
 * @param {{resolveCli?: Function}} [options] `resolveCli` is injectable for tests
 * @returns {Promise<string>} raw stdout of `tailscale status --json`
 */
function tailscaleStatusJson({ resolveCli = resolveTailscaleCli } = {}) {
  return new Promise((resolve, reject) => {
    const cli = resolveCli()
    if (!cli) { reject(Object.assign(new Error('tailscale CLI not found'), { code: 'ENOENT' })); return }
    execFile(cli, ['status', '--json'],
      { timeout: MAGIC_DNS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => { if (error) reject(error); else resolve(String(stdout)) })
  })
}

/**
 * `Self.DNSName` without the trailing root label, or `null` when the output is
 * not a usable hostname. A MagicDNS name is a name: an IP literal is not one,
 * and the resolver is never asked about anything that cannot be a hostname.
 * @param {string} output raw `tailscale status --json`
 * @returns {string|null}
 */
function parseMagicDnsName(output) {
  let status
  try { status = JSON.parse(output) } catch { return null }
  const raw = status?.Self?.DNSName
  if (typeof raw !== 'string') return null
  const name = raw.trim().replace(/\.+$/, '').toLowerCase()
  if (!name || name.length > MAGIC_DNS_MAX_NAME || isIP(name) !== 0 || !MAGIC_DNS_NAME.test(name)) return null
  // Every label 1..63 characters, no leading/trailing hyphen: `a..b` has an empty label.
  return name.split('.').every((label) => MAGIC_DNS_LABEL.test(label)) ? name : null
}

/**
 * Resolve a name, but never wait longer than the MagicDNS budget: an
 * unanswered DNS query is a failure like any other, and the status route must
 * not hang on it.
 */
async function lookupWithin(name, lookup) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, MAGIC_DNS_TIMEOUT_MS, null)
    // A pending answer must not keep the Host process alive.
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    // Awaited here, not returned: `finally` must run only after the race settles,
    // or it would clear the budget timer before it could ever fire.
    return await Promise.race([Promise.resolve().then(() => lookup(name, { all: true, verbatim: true })), timeout])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The addresses `hostname` resolves to, but only when EVERY one of them is a
 * Tailscale or private LAN address and at least one is reachable off this host.
 * A public answer, a loopback-only answer, an empty answer, a lookup error and
 * a lookup timeout all return `null`: the caller then keeps what it had.
 * @param {string} hostname
 * @param {{lookup?: Function}} [options] `lookup` is injectable for tests
 * @returns {Promise<string[]|null>} the verified addresses, or `null`
 */
export async function resolvePrivateHostname(hostname, { lookup = dnsLookup } = {}) {
  const name = typeof hostname === 'string' ? hostname.trim() : ''
  if (!name) return null
  const records = await lookupWithin(name, lookup)
  if (records === null || records === undefined) return null
  const addresses = (Array.isArray(records) ? records : [records])
    .map((record) => (typeof record === 'string' ? record : record && record.address))
    .filter((address) => typeof address === 'string' && address !== '')
  if (addresses.length === 0) return null
  if (!addresses.every((address) => isTailscaleIp(address) || isPrivateNetworkHostname(address))) return null
  if (addresses.every((address) => isLocalHostname(address))) return null
  return addresses
}

/**
 * This node's verified MagicDNS name, or `null`. `null` — never an exception —
 * when the CLI is missing, exits non-zero, times out or prints something else,
 * and when the name does not resolve to Tailscale/private addresses. The caller
 * then advertises the IP exactly as before: the name is an improvement, not a
 * new failure mode.
 * @param {object} [options]
 * @param {Function} [options.statusCommand] returns raw CLI output (injectable)
 * @param {Function} [options.lookup] DNS resolver (injectable)
 * @param {Function} [options.now] clock, in milliseconds (injectable)
 * @param {{name: string|null, expiresAt: number, failedUntil?: number, pending?: Promise|null}} [options.cache] cache slot (injectable)
 * @param {Function} [options.resolveCli] absolute CLI path resolver (injectable; used by the default `statusCommand`)
 * @returns {Promise<string|null>}
 */
export function tailscaleMagicDnsName({
  statusCommand,
  lookup = dnsLookup,
  now = Date.now,
  cache = magicDnsCache,
  resolveCli,
} = {}) {
  const run = statusCommand || (() => tailscaleStatusJson({ resolveCli }))
  if (cache.name && now() < cache.expiresAt) return Promise.resolve(cache.name)
  // A failure inside the short window is not retried: no CLI spawn per poll.
  if (cache.failedUntil && now() < cache.failedUntil) return Promise.resolve(null)
  // Concurrent callers share the one lookup in flight.
  if (cache.pending) return cache.pending
  cache.pending = (async () => {
    let name = null
    try { name = parseMagicDnsName(await run()) } catch { name = null }
    // Verification is part of the lookup: a name that does not resolve to this
    // tailnet is no better than no name at all.
    if (name && !(await resolvePrivateHostname(name, { lookup }))) name = null
    if (name) {
      cache.name = name
      cache.expiresAt = now() + MAGIC_DNS_CACHE_MS
      cache.failedUntil = 0
    } else {
      cache.name = null
      cache.expiresAt = 0
      cache.failedUntil = now() + MAGIC_DNS_FAILURE_CACHE_MS
    }
    return name
  })().finally(() => { cache.pending = null })
  return cache.pending
}

/**
 * Whether `hostname` (a URL hostname) names THIS host on the tailnet: a bare
 * Tailscale IP, or exactly this node's verified MagicDNS name. Deliberately NOT
 * "any name that resolves into the tailnet": that would let a route point at a
 * different tailnet machine. Comparison is case-insensitive and ignores a single
 * trailing root dot (`host.example.ts.net.` == `host.example.ts.net`), as the verified
 * name itself is stored without it. When the name is unavailable (CLI missing,
 * verification failed) only the IP form is accepted, exactly as before.
 * @param {unknown} hostname
 * @param {{magicDnsName?: Function}} [options] `magicDnsName` is injectable for tests
 * @returns {Promise<boolean>}
 */
export async function isOwnTailscaleHost(hostname, { magicDnsName = tailscaleMagicDnsName } = {}) {
  if (typeof hostname !== 'string') return false
  if (isTailscaleIp(hostname)) return true
  const candidate = hostname.trim().replace(/\.$/, '').toLowerCase()
  // An IP literal is never a name: only a Tailscale IP passed the check above.
  if (!candidate || isIP(candidate.replace(/^\[|\]$/g, '')) !== 0) return false
  let own = null
  try { own = await magicDnsName() } catch { own = null }
  return typeof own === 'string' && own !== '' && candidate === own.toLowerCase()
}

/**
 * The advertise host to name in a listener URL (or a certificate SAN). An
 * address the private check already accepts needs no lookup and keeps its
 * existing meaning; any other IP literal is refused; a hostname is accepted
 * only when it resolves to Tailscale/private addresses. `null` for a public,
 * loopback-only or unresolvable name, so such a name is never advertised and
 * never enters a trusted certificate.
 * @param {unknown} value the configured advertise host
 * @param {{lookup?: Function}} [options] `lookup` is injectable for tests
 * @returns {Promise<string|null>}
 */
export async function verifiedAdvertiseHost(value, { lookup = dnsLookup } = {}) {
  if (typeof value !== 'string') return null
  const host = value.trim()
  if (!host) return null
  if (isPrivateNetworkHostname(host)) return host
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) return null
  return (await resolvePrivateHostname(host, { lookup })) ? host : null
}

// Only inspect this gateway process's network namespace; never infer a phone IP.
// A detected interface address does not prove tailnet login or phone reachability.
// `urls` names the plugin-owned TLS listener only: FR-003 has no plaintext remote
// endpoint, so every advertised address is `wss://` (T018).
export function tailscaleInterfaceStatus({ listening, host, port, wsPath, dnsName = null }, interfaces = os.networkInterfaces()) {
  const addresses = []
  for (const [name, records] of Object.entries(interfaces)) {
    const entries = (records || []).filter(record => record && !record.internal)
    const knownInterface = /^(tailscale|utun|tun\d)/i.test(name) ||
      entries.some(record => isIP(record.address) === 6 && isTailscaleIp(record.address))
    if (!knownInterface) continue
    for (const record of entries) {
      if (isTailscaleIp(record.address) && !addresses.includes(record.address)) addresses.push(record.address)
    }
  }
  addresses.sort((a, b) => isIP(a) - isIP(b))
  const boundHost = (host || '').replace(/^\[|\]$/g, '')
  const name = typeof dnsName === 'string' && dnsName ? dnsName.toLowerCase() : null
  // The advertised URL names the node when a verified MagicDNS name exists; the
  // `addresses` (and the socket behind them) keep the address the listener is
  // bound to, so the owner still sees the IP and nothing here moves a bind.
  const advertised = listening ? addresses.filter(address =>
    boundHost === '::' || boundHost === address || (boundHost === '0.0.0.0' && isIP(address) === 4))
    .map(address => (name && isTailscaleIp(address) ? name : address)) : []
  const urls = [...new Set(advertised.map(value =>
    `wss://${isIP(value) === 6 ? `[${value}]` : value}:${port}${wsPath}`))]
  return { addresses, urls, dnsName: urls.length ? name : null }
}
