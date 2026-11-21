// Pairing-code QR (Devices "Pairing code" dialog).
//
// The dialog shows an 8-digit one-time code and "This device's address". This module adds:
//  - the address a pinning client can actually reach (`advertisedPairAddress`): only a configured
//    direct listener address. The PWA/serve origin is NOT one — its TLS leaf is the reverse proxy's,
//    not the listener's pin, so a native app or Desktop Remote pairing through it fails pin-mismatch;
//  - the QR payload (`pairQrPayload`): `https://<pwa-origin>/pair#a=<address>&c=<otp>&p=<pin>`. The
//    code and pin ride in the FRAGMENT, never the query: a fragment is not sent in the HTTP request,
//    so neither reaches a server log or a Referer header. With no known PWA origin the QR holds
//    plain text;
//  - an SVG rendering (`qrSvg`) from a vendored MIT encoder (lib/vendor/qrcode), fully local.
//
// Nothing here logs; the OTP and pin only pass through `pairQrPayload`/`qrSvg` into the HTTP reply.

import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isIP } from 'node:net'

const require = createRequire(import.meta.url)
const QRCode = require('./vendor/qrcode/index.js')
const QRErrorCorrectLevel = require('./vendor/qrcode/QRErrorCorrectLevel.js')

/** Port `tailscale serve` exposes the PWA and `/ws/mobile` on (owner setup). */
export const DEFAULT_SERVE_PORT = 30443

const isLoopbackHost = (host) => {
  const value = String(host || '').replace(/^\[|\]$/g, '').toLowerCase()
  return value === 'localhost' || value === '::1' || /^127\./.test(value)
}

/**
 * A superset of `isLoopbackHost`: also refuses unspecified and IPv4-mapped loopback forms.
 * `new URL()` canonicalises `0x7f000001` / `2130706433` to `127.0.0.1`, `localhost.` to
 * `localhost`, and `[::ffff:127.x.y.z]` to `::ffff:7fXX:*` across the whole 127/8 mapped
 * range, so those non-canonical spellings cannot slip past as a "direct" address on a
 * remote machine. Keep `isLoopbackHost` intact for its existing callers
 * (normalizePwaOrigin/resolvePwaOrigin behavior must not move).
 */
const isUnreachableHost = (host) => {
  const value = String(host || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  return isLoopbackHost(value)
    || value === '0.0.0.0' || value === '::' || value === ''
    || /^::ffff:(127(?:\.[0-9]{1,3}){3}|7f[0-9a-f]{2}:[0-9a-f]{1,4})$/i.test(value)
}

/**
 * Normalize a configured PWA URL to its origin (`https://host[:port]`), or null. Only https:
 * a phone camera opening an http:// page would hand the code to an unencrypted origin.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizePwaOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try { url = new URL(value.trim()) } catch { return null }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null
  return url.origin
}

/**
 * The PWA origin to put in the QR: explicit `pwaUrl` config first, else `https://<dnsName>:30443`
 * when this node's MagicDNS name is known, else null.
 * @param {{pwaUrl?: string, dnsName?: string|null}} input
 */
export function resolvePwaOrigin({ pwaUrl, dnsName } = {}) {
  const configured = normalizePwaOrigin(pwaUrl)
  if (configured) return configured
  if (typeof dnsName === 'string' && /^[a-z0-9.-]+$/i.test(dnsName) && isIP(dnsName) === 0) {
    return `https://${dnsName.toLowerCase()}:${DEFAULT_SERVE_PORT}`
  }
  return null
}

/**
 * The direct listener address to show and encode: the configured `advertisedAddress`, or null.
 * A configured address is the OWNER's explicit choice and is passed through even when it names
 * the serve origin (that owner then carries that origin's pin knowingly) — config is not
 * overridden here. The PWA/serve origin is NEVER inferred as a direct address: a pinning
 * client would dial it with the reverse proxy's certificate, not the listener leaf whose
 * SHA-256 the offer pins, so every native/Desktop pairing would fail with `pin-mismatch`.
 * @param {{advertisedAddress?: string}} input
 * @returns {string|null}
 */
export function advertisedPairAddress({ advertisedAddress } = {}) {
  if (typeof advertisedAddress === 'string' && /^[^\s/?#@]+:\d{1,5}$/.test(advertisedAddress.trim())) {
    return advertisedAddress.trim()
  }
  return null
}

/** Whether a port is the `tailscale serve` origin (never a direct listener port). */
const isServeOriginPort = (port) => String(port) === String(DEFAULT_SERVE_PORT)

/**
 * First DIRECT listener address from `candidates` (`host:port` or a full https:/wss: URL), or null.
 * A pinning client can dial only a non-loopback host on a non-serve port whose certificate is the
 * listener leaf. Credentials are refused (never hand a secret to a card), plain http is refused,
 * loopback/unspecified (incl. numeric and trailing-dot spellings) is refused, and the serve port
 * is refused (different TLS leaf). Every candidate is normalised through the URL parser before
 * those checks, then reduced to `host:port` (IPv6 keeps brackets) so a URL's path/query never
 * leaks into the offer. Junk entries are ignored, not fatal.
 * @param {unknown[]} candidates
 * @returns {string|null}
 */
export function firstDirectAddress(candidates) {
  for (const entry of Array.isArray(candidates) ? candidates : []) {
    if (typeof entry !== 'string') continue
    const raw = entry.trim()
    if (!raw) continue
    // Normalise EVERY candidate through the URL parser first. It canonicalises numeric
    // and trailing-dot loopback spellings that a regex would let through, and gives the
    // bracketed hostname an IPv6 form needs (`url.hostname` includes the brackets).
    let url
    try {
      url = /^[^\s/?#@]+:\d{1,5}$/.test(raw) ? new URL(`wss://${raw}`) : new URL(raw)
    } catch { continue }
    if (url.protocol !== 'https:' && url.protocol !== 'wss:') continue
    if (url.username || url.password) continue
    const host = url.hostname
    const port = url.port
    if (!host || !port) continue // a direct listener always names its port; never invent one
    if (isUnreachableHost(host) || isServeOriginPort(port)) continue
    // `url.hostname` keeps IPv6 brackets, so the output stays a reconstructible
    // `[ipv6]:port`; for IPv4/DNS it is the plain lowercased `host:port`.
    return `${host}:${port}`
  }
  return null
}

/**
 * QR text. With a PWA origin: `https://<origin>/pair#a=<address>&c=<otp>&p=<pin>`; without one: the
 * plain `address` and code on two lines (a camera shows it as text; nothing is opened).
 * Spec 054: a native app needs `p` to pin the TLS leaf before it spends a proof; an omitted or
 * malformed pin leaves it out, so a web link (which cannot pin) never carries a bogus fingerprint.
 * @param {{pwaOrigin: string|null, address: string|null, otp: string, pin?: string}} input
 */
export function pairQrPayload({ pwaOrigin, address, otp, pin }) {
  const code = String(otp ?? '').replace(/\D/g, '')
  if (!/^\d{8}$/.test(code)) throw new TypeError('otp must be 8 digits')
  const addr = typeof address === 'string' ? address.trim() : ''
  const fingerprint = typeof pin === 'string' && /^[0-9a-f]{64}$/.test(pin.trim().toLowerCase())
    ? pin.trim().toLowerCase()
    : null
  if (pwaOrigin) {
    const params = new URLSearchParams()
    if (addr) params.set('a', addr)
    params.set('c', code)
    if (fingerprint) params.set('p', fingerprint)
    return `${pwaOrigin}/pair#${params.toString()}`
  }
  return addr ? `${addr}\n${code}` : code
}

/**
 * Render `text` as a standalone SVG string (black modules on white, 4-module quiet zone).
 * @param {string} text
 * @param {{scale?: number}} [options]
 */
export function qrSvg(text, { scale = 4 } = {}) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M)
  qr.addData(String(text))
  qr.make()
  const count = qr.getModuleCount()
  const quiet = 4
  const size = count + quiet * 2
  let d = ''
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) d += `M${col + quiet} ${row + quiet}h1v1h-1z`
    }
  }
  const px = size * scale
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${px}" height="${px}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}

// ---- MagicDNS name of this node (fixed CLI paths, no shell, cached) -------------------------------

const cache = { name: null, at: 0, pending: null }
const CACHE_MS = 60_000

function cliPath(platform = process.platform, env = process.env) {
  const candidates = platform === 'win32'
    ? [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map((dir) => path.win32.join(dir, 'Tailscale', 'tailscale.exe'))
    : platform === 'darwin' ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale']
      : ['/usr/bin/tailscale', '/usr/sbin/tailscale']
  return candidates.find((candidate) => { try { return fs.existsSync(candidate) } catch { return false } }) ?? null
}

/** `Self.DNSName` from `tailscale status --json`, without the trailing dot, or null. */
export function parseSelfDnsName(output) {
  let status
  try { status = JSON.parse(output) } catch { return null }
  const raw = status?.Self?.DNSName
  if (typeof raw !== 'string') return null
  const name = raw.trim().replace(/\.+$/, '').toLowerCase()
  if (!name || name.length > 253 || isIP(name) !== 0) return null
  return name.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? name : null
}

/** This node's MagicDNS name, or null (never throws). */
export function tailscaleDnsName({ run } = {}) {
  if (cache.name && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.name)
  if (cache.pending) return cache.pending
  const exec = run || (() => new Promise((resolve, reject) => {
    const cli = cliPath()
    if (!cli) { reject(new Error('no cli')); return }
    execFile(cli, ['status', '--json'], { timeout: 2000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
  }))
  cache.pending = (async () => {
    let name = null
    try { name = parseSelfDnsName(await exec()) } catch { name = null }
    if (name) { cache.name = name; cache.at = Date.now() }
    return name
  })().finally(() => { cache.pending = null })
  return cache.pending
}
