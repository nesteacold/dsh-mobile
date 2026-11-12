import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { startGateway } from './helpers.mjs'

// Handler-level proof that `isOwnTailscaleHost` is what POST /mgw/connection
// (tailscaleUrl) and POST /mgw/pair (publicUrl + each endpoint) actually call.
//
// No real `tailscale` CLI and no real DNS: the two Node builtins the lookup uses
// (`child_process.execFile` for `tailscale status --json`, `dns.promises.lookup`
// for the name verification) are replaced for this process BEFORE the plugin is
// imported, and `syncBuiltinESMExports()` carries the replacement into the ESM
// named bindings the plugin imports. Every other command and name goes to the
// originals. This machine has a real Tailscale install, so the seam is not
// optional: without it the handlers would answer from the real CLI.
const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')
const fsModule = require('node:fs')
const dnsPromises = require('node:dns').promises
const realExecFile = childProcess.execFile
const realExistsSync = fsModule.existsSync
const realLookup = dnsPromises.lookup
// The plugin runs the CLI by absolute install path and only when that file exists;
// a fake path that "exists" keeps this test independent of the machine's install.
const FAKE_CLI = process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : '/usr/bin/tailscale'

const OWN = 'host.example.ts.net'
const OTHER = 'phone.example.ts.net'
const TAILNET_IP = '100.64.0.9'

fsModule.existsSync = (target) => (target === FAKE_CLI ? true : realExistsSync(target))
childProcess.execFile = (command, args, options, callback) =>
  command === FAKE_CLI
    ? (queueMicrotask(() => callback(null, JSON.stringify({ Self: { DNSName: `${OWN}.`, HostName: 'box' } }))), {})
    : realExecFile(command, args, options, callback)
// Only the own name resolves (into the tailnet). The other tailnet machine
// resolves too — that is the point: "resolves into the tailnet" must NOT be
// enough for a route to be accepted.
dnsPromises.lookup = async (name, options) =>
  [OWN, OTHER].includes(String(name).toLowerCase())
    ? [{ address: TAILNET_IP, family: 4 }]
    : realLookup(name, options)
syncBuiltinESMExports()

const url = (host, suffix = ':3081/ws/mobile') => `wss://${host}${suffix}`
const TAILSCALE_REFUSAL = 'Tailscale address must use wss:// with a Tailscale IPv4 or IPv6 address'
const PAIR_REFUSAL = 'Tailscale pairing requires the host\'s Tailscale IP address or its verified MagicDNS name'

// The harness `request()` only exposes the status code; these tests assert the
// unchanged refusal text, so they post directly.
const post = async (gateway, route, body) => {
  const base = gateway.url.replace('ws:', 'http:').replace('/ws/mobile', '')
  const response = await fetch(`${base}/mgw/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
const errorText = (result) => JSON.stringify(result.body)

test('POST /mgw/connection: own MagicDNS name, any case, is accepted as tailscaleUrl and saved', async () => {
  const gateway = await startGateway({ enabled: false })
  try {
    for (const host of [OWN, OWN.toUpperCase(), `${OWN}.`]) {
      const accepted = await post(gateway, 'connection', { route: 'tailscale', tailscaleUrl: url(host) })
      assert.equal(accepted.status, 200, `${host}: ${errorText(accepted)}`)
      assert.equal(accepted.body.pairingRoute, 'tailscale')
      // The URL is stored as normalized by the handler (WHATWG lower-cases the host).
      assert.equal(new URL(accepted.body.tailscaleUrl).hostname.replace(/\.$/, ''), OWN, host)
    }
    // A Tailscale IP keeps working exactly as before.
    const ip = await post(gateway, 'connection', { route: 'tailscale', tailscaleUrl: url('100.64.0.10') })
    assert.equal(ip.status, 200, errorText(ip))
    assert.equal(ip.body.tailscaleUrl, url('100.64.0.10'))
  } finally { await gateway.close() }
})

test('POST /mgw/connection: another tailnet machine, a public name and a lookalike are refused with the unchanged message, saved value kept', async () => {
  const gateway = await startGateway({ enabled: false })
  try {
    const saved = url('100.64.0.10')
    assert.equal((await post(gateway, 'connection', { route: 'tailscale', tailscaleUrl: saved })).status, 200)
    const refused = [
      url(OTHER), // resolves into the tailnet, but is another machine
      url('cloud.example'),
      url(`evil-${OWN}`),
      url(`${OWN}.evil.com`),
      url('100.128.0.1'), // outside 100.64/10
      url('192.168.1.1'),
    ]
    for (const tailscaleUrl of refused) {
      const result = await post(gateway, 'connection', { route: 'tailscale', tailscaleUrl })
      assert.equal(result.status, 400, `${tailscaleUrl}: ${errorText(result)}`)
      assert.ok(errorText(result).includes(TAILSCALE_REFUSAL), `${tailscaleUrl}: ${errorText(result)}`)
    }
    // Refused earlier than the own-host check, by the URL rules: plaintext and userinfo.
    for (const tailscaleUrl of [`ws://${OWN}:3081/ws/mobile`, `wss://${OWN}@${OTHER}/ws/mobile`]) {
      const result = await post(gateway, 'connection', { route: 'tailscale', tailscaleUrl })
      assert.equal(result.status, 400, `${tailscaleUrl}: ${errorText(result)}`)
    }
    // The exact, unchanged message for the case this feature exists for.
    const other = await post(gateway, 'connection', { route: 'tailscale', tailscaleUrl: url(OTHER) })
    assert.equal(other.status, 400)
    assert.ok(errorText(other).includes(TAILSCALE_REFUSAL), errorText(other))
    const pub = await post(gateway, 'connection', { route: 'tailscale', tailscaleUrl: url('cloud.example') })
    assert.ok(errorText(pub).includes(TAILSCALE_REFUSAL), errorText(pub))
    assert.equal((await gateway.request('status')).tailscaleUrl, saved, 'a refused address never replaces the saved one')
  } finally { await gateway.close() }
})

test('POST /mgw/pair on the tailscale route: own name accepted as publicUrl, other names refused with the unchanged message', async () => {
  const gateway = await startGateway({ enabled: false })
  try {
    const own = url(OWN)
    assert.equal((await post(gateway, 'connection', { route: 'tailscale', tailscaleUrl: own })).status, 200)
    for (const publicUrl of [own, url(OWN.toUpperCase()), url(`${OWN}.`), url('100.64.0.10')]) {
      const created = await post(gateway, 'pair', { publicUrl })
      assert.equal(created.status, 201, `${publicUrl}: ${errorText(created)}`)
      assert.equal(new URL(created.body.payload.publicUrl).hostname.replace(/\.$/, ''), new URL(publicUrl).hostname.replace(/\.$/, ''))
    }
    for (const publicUrl of [url(OTHER), url('cloud.example'), url(`evil-${OWN}`), url(`${OWN}.evil.com`), url('100.128.0.1'),
      'wss://old.trycloudflare.com/ws/mobile']) {
      const refused = await post(gateway, 'pair', { publicUrl })
      assert.equal(refused.status, 400, `${publicUrl}: ${errorText(refused)}`)
      assert.ok(errorText(refused).includes(PAIR_REFUSAL), `${publicUrl}: ${errorText(refused)}`)
    }
  } finally { await gateway.close() }
})

test('POST /mgw/pair payload endpoints: only this host\'s entries survive, in order; nothing else is dropped or reordered', async () => {
  const gateway = await startGateway({ enabled: false })
  try {
    const own = url(OWN)
    assert.equal((await post(gateway, 'connection', { route: 'tailscale', tailscaleUrl: own })).status, 200)
    const mixed = [
      url('cloud.example'), // dropped
      url('100.64.0.10'), // kept: this host's tailnet address
      url(OTHER), // dropped: another tailnet machine
      url(OWN.toUpperCase(), ':4443/ws/alt'), // kept (same name, different port/path)
      url('100.128.0.5'), // dropped
      url(`evil-${OWN}`), // dropped
      url('100.64.0.99'), // kept: a second distinct address of this host
    ]
    const created = await post(gateway, 'pair', { publicUrl: own, endpoints: mixed })
    assert.equal(created.status, 201, errorText(created))
    const endpoints = created.body.payload.endpoints
    // The primary comes first, then the owner list in the order given.
    assert.deepEqual(endpoints, [own, url('100.64.0.10'), url(OWN, ':4443/ws/alt'), url('100.64.0.99')])
    for (const endpoint of endpoints) assert.ok(!/cloud\.example|phone\.example\.ts\.net|evil|100\.128/.test(endpoint), endpoint)
    // Every kept endpoint is this host; a duplicate of the primary is not repeated.
    assert.equal(new Set(endpoints).size, endpoints.length)
  } finally { await gateway.close() }
})

test('POST /mgw/pair payload endpoints on a non-tailscale route are not filtered by this check', async () => {
  const gateway = await startGateway({ enabled: false })
  try {
    // Default route is not `tailscale`: the own-host rule applies to the tailscale route only.
    assert.notEqual((await gateway.request('status')).pairingRoute, 'tailscale')
    const created = await post(gateway, 'pair', { publicUrl: url(OWN), endpoints: [url(OTHER), url('100.64.0.10')] })
    assert.equal(created.status, 201, errorText(created))
    // The gateway's own LAN listener URL is appended by advertisedEndpoints(); it is kept here
    // (it would be dropped on the tailscale route, see the previous test).
    const endpoints = created.body.payload.endpoints
    assert.deepEqual(endpoints.slice(0, 3), [url(OWN), url(OTHER), url('100.64.0.10')])
    assert.ok(endpoints.length >= 3)
  } finally { await gateway.close() }
})
