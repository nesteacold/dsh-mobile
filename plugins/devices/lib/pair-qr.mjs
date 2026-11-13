// Pairing-code QR (Devices "Pairing code" dialog).
//
// The dialog shows an 8-digit one-time code and "This device's address". This module adds:
//  - the address a phone can actually reach (`advertisedPairAddress`): when the gateway listener is
//    loopback-only behind `tailscale serve`, the listener's own `127.0.0.1:30081`/`<host>:30081` is
//    unreachable from another device; the served HTTPS origin (`<dnsName>:30443`) is;
//  - the QR payload (`pairQrPayload`): `https://<pwa-origin>/pair#a=<address>&c=<otp>`. The code
//    rides in the FRAGMENT, never the query: a fragment is not sent in the HTTP request, so it never
//    reaches a server log or a Referer header. With no known PWA origin the QR holds plain text;
//  - an SVG rendering (`qrSvg`) from a vendored MIT encoder (lib/vendor/qrcode), fully local.
//
// Nothing here logs; the OTP only passes through `pairQrPayload`/`qrSvg` into the HTTP reply.

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
 * The address to show and encode. `advertisedAddress` config wins; otherwise, when the gateway is
 * loopback-bound (it sits behind `tailscale serve`) the PWA origin's host:port is the reachable
 * one; otherwise null (the caller keeps the listener's own addresses).
 * @param {{advertisedAddress?: string, pwaOrigin?: string|null, lanHost?: string|null}} input
 * @returns {string|null}
 */
export function advertisedPairAddress({ advertisedAddress, pwaOrigin, lanHost } = {}) {
  if (typeof advertisedAddress === 'string' && /^[^\s/?#@]+:\d{1,5}$/.test(advertisedAddress.trim())) {
    return advertisedAddress.trim()
  }
  if (pwaOrigin && isLoopbackHost(lanHost)) {
    const url = new URL(pwaOrigin)
    return `${url.hostname}:${url.port || DEFAULT_SERVE_PORT}`
  }
  return null
}

/**
 * QR text. With a PWA origin: `https://<origin>/pair#a=<address>&c=<otp>`; without one: the plain
 * `address` and code on two lines (a camera shows it as text; nothing is opened).
 * @param {{pwaOrigin: string|null, address: string|null, otp: string}} input
 */
export function pairQrPayload({ pwaOrigin, address, otp }) {
  const code = String(otp ?? '').replace(/\D/g, '')
  if (!/^\d{8}$/.test(code)) throw new TypeError('otp must be 8 digits')
  const addr = typeof address === 'string' ? address.trim() : ''
  if (pwaOrigin) {
    const params = new URLSearchParams()
    if (addr) params.set('a', addr)
    params.set('c', code)
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
