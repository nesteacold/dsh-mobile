import {
  isOwnTailscaleHost, isTailscaleIp, resolvePrivateHostname, resolveTailscaleCli, tailscaleInterfaceStatus, tailscaleMagicDnsName, verifiedAdvertiseHost,
} from '../lib/tailscale-addresses.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAllowedMobileSource, isLocalHostname, isPrivateNetworkHostname } from '../lib/network-addresses.mjs'

test('Tailscale shared IPv4 bounds and IPv4-mapped socket addresses are accepted', () => {
  for (const ip of ['100.64.0.0', '100.100.10.20', '100.127.255.255']) {
    assert.equal(isPrivateNetworkHostname(ip), true, ip)
    assert.equal(isAllowedMobileSource(ip), true, ip)
    assert.equal(isAllowedMobileSource(`::ffff:${ip}`), true, ip)
    assert.equal(isAllowedMobileSource(`[::ffff:${ip}]`), true, ip)
  }
})

test('other public ranges, malformed addresses and names cannot be accepted as socket sources', () => {
  for (const ip of ['100.63.255.255', '100.128.0.0', '100.255.255.255', '100.64.256.1', '100.64.1', '203.0.113.1', '8.8.8.8']) {
    assert.equal(isPrivateNetworkHostname(ip), false, ip)
    assert.equal(isAllowedMobileSource(ip), false, ip)
    assert.equal(isAllowedMobileSource(`::ffff:${ip}`), false, ip)
  }
  for (const value of ['', undefined, null, 'localhost', 'phone.local', 'host.example.ts.net', '100.64.1.1.example']) {
    assert.equal(isAllowedMobileSource(value), false, String(value))
  }
  assert.equal(isPrivateNetworkHostname('host.example.ts.net'), false)
})

test('LAN and IPv6 sources retain their existing behavior and loopback stays distinct', () => {
  for (const ip of ['127.0.0.1', '10.0.0.2', '172.16.0.1', '10.23.45.67', '::1', 'fd7a:115c:a1e0::1', 'fe80::1%en0']) {
    assert.equal(isAllowedMobileSource(ip), true, ip)
  }
  assert.equal(isPrivateNetworkHostname('host.local'), true)
  assert.equal(isLocalHostname('127.0.0.1'), true)
  assert.equal(isLocalHostname('100.100.10.20'), false)
  assert.equal(isLocalHostname('fd7a:115c:a1e0::1'), false)
})


test('Tailscale detection uses host tunnel interfaces and respects the actual listener binding', () => {
  const interfaces = {
    en0: [{ address: '10.23.45.66', internal: false }, { address: '100.64.1.1', internal: false }],
    utun5: [{ address: '100.64.0.10', internal: false }, { address: 'fd7a:115c:a1e0::7', internal: false }],
    Tailscale: [{ address: '100.64.0.10', internal: false }, { address: '100.128.0.1', internal: false }],
    lo: [{ address: '100.99.0.1', internal: true }],
  }
  const listener = { listening: true, host: '0.0.0.0', port: 3081, wsPath: '/ws/mobile' }
  const status = tailscaleInterfaceStatus(listener, interfaces)
  assert.deepEqual(status.addresses, ['100.64.0.10', 'fd7a:115c:a1e0::7'])
  assert.deepEqual(status.urls, ['wss://100.64.0.10:3081/ws/mobile'])
  assert.equal(tailscaleInterfaceStatus({ ...listener, host: '127.0.0.1' }, interfaces).urls.length, 0)
  assert.equal(tailscaleInterfaceStatus({ ...listener, listening: false }, interfaces).urls.length, 0)
  assert.equal(tailscaleInterfaceStatus({ ...listener, host: '::' }, interfaces).urls[1], 'wss://[fd7a:115c:a1e0::7]:3081/ws/mobile')
  assert.equal(tailscaleInterfaceStatus(listener, {}).addresses.length, 0)
  for (const value of ['100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0::1']) assert.equal(isTailscaleIp(value), true)
  for (const value of ['100.63.0.1', '100.128.0.1', '100.64.256.1', '100.64.1.2.example', 'fd7a:115c:a1e1::1', null]) assert.equal(isTailscaleIp(value), false)
})


// ---- MagicDNS: the stable handle for a tailnet node ----------------------------
// No real tailscale and no real DNS: the CLI output, the resolver and the clock
// are all injected, and every test owns its cache slot.
const selfStatus = (dnsName) => JSON.stringify({ Self: { DNSName: dnsName, HostName: 'box' } })
const answer = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
const fresh = () => ({ name: null, expiresAt: 0 })

test('MagicDNS name is read from `tailscale status --json`, stripped of the root dot, and verified', async () => {
  const seen = []
  const name = await tailscaleMagicDnsName({
    statusCommand: async () => selfStatus('Host.Example-1234.ts.net.'),
    lookup: async (host, options) => { seen.push([host, options.all]); return answer('100.64.0.10')() },
    cache: fresh(),
  })
  assert.equal(name, 'host.example-1234.ts.net')
  assert.deepEqual(seen, [['host.example-1234.ts.net', true]], 'the stripped name is what gets resolved, with all=true')
})

test('without a verified name the IP is advertised exactly as before (CLI missing, bad output, bad name)', async () => {
  const lookup = answer('100.64.0.10')
  const cases = {
    'cli missing': async () => { throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' }) },
    'cli timed out': async () => { throw Object.assign(new Error('timed out'), { killed: true }) },
    'not json': async () => 'tailscale is stopped',
    'no Self': async () => JSON.stringify({ Peer: {} }),
    'DNSName not a string': async () => JSON.stringify({ Self: { DNSName: 7 } }),
    'empty DNSName': async () => selfStatus('.'),
    'IP literal as DNSName': async () => selfStatus('100.64.0.10'),
    'shell metacharacters': async () => selfStatus('host;calc.example.ts.net.'),
  }
  for (const [label, statusCommand] of Object.entries(cases)) {
    assert.equal(await tailscaleMagicDnsName({ statusCommand, lookup, cache: fresh() }), null, label)
  }
  const interfaces = { Tailscale: [{ address: '100.64.0.10', internal: false }] }
  const status = tailscaleInterfaceStatus({ listening: true, host: '100.64.0.10', port: 30081, wsPath: '/ws/mobile', dnsName: null }, interfaces)
  assert.deepEqual(status.urls, ['wss://100.64.0.10:30081/ws/mobile'])
  assert.equal(status.dnsName, null)
})

test('a name that does not verify is dropped: public, mixed, loopback-only, empty, failed or hung lookup', async () => {
  const statusCommand = async () => selfStatus('host.example.ts.net.')
  const lookups = {
    public: answer('203.0.113.9'),
    'one public among tailnet answers': answer('100.64.0.10', '8.8.8.8'),
    'loopback only': answer('127.0.0.1'),
    empty: async () => [],
    'lookup error': async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) },
  }
  for (const [label, lookup] of Object.entries(lookups)) {
    assert.equal(await tailscaleMagicDnsName({ statusCommand, lookup, cache: fresh() }), null, label)
  }
})

test('a lookup that never answers is a failure after the 2 s budget, not a hang', async () => {
  // Real clock on purpose: the budget is a fixed constant, and a mocked timer
  // would only test the mock. ~2 s once.
  const started = Date.now()
  const name = await tailscaleMagicDnsName({
    statusCommand: async () => selfStatus('host.example.ts.net.'),
    lookup: () => new Promise(() => {}),
    cache: fresh(),
  })
  const elapsed = Date.now() - started
  assert.equal(name, null)
  assert.ok(elapsed >= 1_800 && elapsed < 5_000, `expected ~2 s, took ${elapsed} ms`)
})

test('a verified name is cached ~60 s; a failure is cached only ~8 s, never as a name', async () => {
  let clock = 1_000
  let runs = 0
  let outcome = 'transient-error'
  const cache = fresh()
  const options = {
    statusCommand: async () => {
      runs += 1
      if (outcome === 'transient-error') throw new Error('tailscaled is restarting')
      return selfStatus('host.example.ts.net.')
    },
    lookup: answer('100.64.0.10'),
    now: () => clock,
    cache,
  }
  assert.equal(await tailscaleMagicDnsName(options), null, 'transient error: IP fallback')
  assert.equal(cache.name, null, 'a failure never stores a name')
  assert.equal(runs, 1)

  // Inside the negative window the CLI is not run again, even though it would now succeed.
  outcome = 'ok'
  clock += 7_999
  assert.equal(await tailscaleMagicDnsName(options), null, 'failure not retried inside 8 s')
  assert.equal(runs, 1, 'no CLI spawn inside the negative window')

  // After 8 s it is retried, and the success is cached for 60 s.
  clock += 1
  assert.equal(await tailscaleMagicDnsName(options), 'host.example.ts.net', 'retried after 8 s')
  assert.equal(runs, 2)

  clock += 59_999
  outcome = 'transient-error'
  assert.equal(await tailscaleMagicDnsName(options), 'host.example.ts.net', 'served from cache inside 60 s')
  assert.equal(runs, 2, 'no CLI call while cached')

  clock += 1
  assert.equal(await tailscaleMagicDnsName(options), null, 'cache expired: the CLI runs again and its failure is not masked')
  assert.equal(runs, 3)
  clock += 8_000
  assert.equal(await tailscaleMagicDnsName(options), null)
  assert.equal(runs, 4, 'the negative window ends after 8 s')
})

test('an unverifiable name (resolves publicly) is also a cached failure, not a spawn per poll', async () => {
  let clock = 0
  let runs = 0
  const options = {
    statusCommand: async () => { runs += 1; return selfStatus('host.example.ts.net.') },
    lookup: answer('203.0.113.9'),
    now: () => clock,
    cache: fresh(),
  }
  for (let i = 0; i < 5; i += 1) assert.equal(await tailscaleMagicDnsName(options), null)
  assert.equal(runs, 1)
  clock += 8_000
  assert.equal(await tailscaleMagicDnsName(options), null)
  assert.equal(runs, 2)
})

test('concurrent callers share one in-flight lookup (one CLI spawn)', async () => {
  let runs = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const options = {
    statusCommand: async () => { runs += 1; await gate; return selfStatus('host.example.ts.net.') },
    lookup: answer('100.64.0.10'),
    now: () => 0,
    cache: fresh(),
  }
  const calls = [tailscaleMagicDnsName(options), tailscaleMagicDnsName(options), tailscaleMagicDnsName(options)]
  release()
  assert.deepEqual(await Promise.all(calls), ['host.example.ts.net', 'host.example.ts.net', 'host.example.ts.net'])
  assert.equal(runs, 1, 'three concurrent callers, one spawn')
  assert.equal(options.cache.pending, null, 'the in-flight slot is released')
})

test('a failing in-flight lookup is shared too, and releases the slot', async () => {
  let runs = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const options = {
    statusCommand: async () => { runs += 1; await gate; throw new Error('boom') },
    lookup: answer('100.64.0.10'),
    now: () => 0,
    cache: fresh(),
  }
  const calls = [tailscaleMagicDnsName(options), tailscaleMagicDnsName(options)]
  release()
  assert.deepEqual(await Promise.all(calls), [null, null])
  assert.equal(runs, 1)
  assert.equal(options.cache.pending, null)
})

test('Self.DNSName must be a valid hostname: total <= 253, labels 1..63 of [a-z0-9-] without edge hyphens', async () => {
  const label63 = 'a'.repeat(63)
  const ok = async (dnsName) => tailscaleMagicDnsName({
    statusCommand: async () => selfStatus(dnsName), lookup: answer('100.64.0.10'), cache: fresh(),
  })
  assert.equal(await ok('host.example44.ts.net.'), 'host.example44.ts.net', 'a normal name passes')
  assert.equal(await ok(`${label63}.ts.net`), `${label63}.ts.net`, 'a 63-char label is fine')
  assert.equal(await ok('single'), 'single', 'no .ts.net suffix is required')
  // 253 characters total passes, 254 does not.
  const total253 = [label63, label63, label63, 'a'.repeat(61)].join('.')
  assert.equal(total253.length, 253)
  assert.equal(await ok(total253), total253, '253 chars')
  const total254 = [label63, label63, label63, 'a'.repeat(62)].join('.')
  assert.equal(total254.length, 254)
  assert.equal(await ok(total254), null, '254-char name')
  const bad = {
    '64-char label': `${'a'.repeat(64)}.ts.net`,
    'empty label a..b': 'a..b.example.ts.net',
    'leading-hyphen label': '-host.example.ts.net',
    'trailing-hyphen label': 'host-.example.ts.net',
    'leading-hyphen inner label': 'host.-example.ts.net',
    'trailing-hyphen inner label': 'host.example-.ts.net',
    'leading dot': '.host.example.ts.net',
  }
  for (const [label, dnsName] of Object.entries(bad)) assert.equal(await ok(dnsName), null, label)
})

test('the CLI is resolved to an absolute install path, never by bare name; none found -> null', () => {
  const win = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }
  const seen = []
  const only = (target) => (p) => { seen.push(p); return p === target }
  assert.equal(resolveTailscaleCli({ platform: 'win32', env: win, exists: only('C:\\Program Files\\Tailscale\\tailscale.exe') }),
    'C:\\Program Files\\Tailscale\\tailscale.exe')
  assert.equal(resolveTailscaleCli({ platform: 'win32', env: win, exists: only('C:\\Program Files (x86)\\Tailscale\\tailscale.exe') }),
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe')
  assert.equal(resolveTailscaleCli({ platform: 'darwin', env: {}, exists: only('/usr/local/bin/tailscale') }), '/usr/local/bin/tailscale')
  assert.equal(resolveTailscaleCli({ platform: 'darwin', env: {}, exists: only('/Applications/Tailscale.app/Contents/MacOS/Tailscale') }),
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  assert.equal(resolveTailscaleCli({ platform: 'linux', env: {}, exists: only('/usr/sbin/tailscale') }), '/usr/sbin/tailscale')
  assert.equal(resolveTailscaleCli({ platform: 'linux', env: {}, exists: only('/usr/bin/tailscale') }), '/usr/bin/tailscale')
  // Nothing installed (or no ProgramFiles in the environment): null, never a bare command.
  assert.equal(resolveTailscaleCli({ platform: 'linux', env: {}, exists: () => false }), null)
  assert.equal(resolveTailscaleCli({ platform: 'win32', env: {}, exists: () => true }), null)
  assert.equal(resolveTailscaleCli({ platform: 'freebsd', env: {}, exists: () => true }), null)
  assert.equal(resolveTailscaleCli({ platform: 'linux', env: {}, exists: () => { throw new Error('EACCES') } }), null)
  assert.ok(seen.every((candidate) => /^([A-Za-z]:\\|\/)/.test(candidate)), 'only absolute paths are probed')
})

test('no installed CLI is the clean IP fallback; the default command never runs without a resolved absolute path', async () => {
  assert.equal(await tailscaleMagicDnsName({ resolveCli: () => null, lookup: answer('100.64.0.10'), cache: fresh() }), null)
})

test('status carries the name AND the IP; the bind and the address list stay on the IP', () => {
  const interfaces = {
    Tailscale: [{ address: '100.64.0.10', internal: false }, { address: 'fd7a:115c:a1e0::7', internal: false }],
  }
  const named = { dnsName: 'host.example.ts.net', wsPath: '/ws/mobile', port: 30081 }
  const status = tailscaleInterfaceStatus({ ...named, listening: true, host: '100.64.0.10' }, interfaces)
  assert.deepEqual(status.addresses, ['100.64.0.10', 'fd7a:115c:a1e0::7'], 'the IP stays visible')
  assert.deepEqual(status.urls, ['wss://host.example.ts.net:30081/ws/mobile'], 'the advertised URL names the node')
  assert.equal(status.dnsName, 'host.example.ts.net')
  // Both tailnet families collapse to the one name instead of repeating it.
  assert.deepEqual(tailscaleInterfaceStatus({ ...named, listening: true, host: '::' }, interfaces).urls,
    ['wss://host.example.ts.net:30081/ws/mobile'])
  // Nothing advertised, nothing named: not listening, or bound elsewhere.
  for (const idle of [{ listening: false, host: '100.64.0.10' }, { listening: true, host: '127.0.0.1' }]) {
    const quiet = tailscaleInterfaceStatus({ ...named, ...idle }, interfaces)
    assert.deepEqual(quiet.urls, [])
    assert.equal(quiet.dnsName, null)
    assert.deepEqual(quiet.addresses, ['100.64.0.10', 'fd7a:115c:a1e0::7'])
  }
})

test('resolvePrivateHostname accepts only all-private answers with at least one off-host address', async () => {
  assert.deepEqual(await resolvePrivateHostname('a.example.ts.net', { lookup: answer('100.64.0.10', 'fd7a:115c:a1e0::5') }),
    ['100.64.0.10', 'fd7a:115c:a1e0::5'])
  assert.deepEqual(await resolvePrivateHostname('nas.lan', { lookup: answer('192.168.1.20') }), ['192.168.1.20'])
  for (const refused of [['203.0.113.1'], ['100.128.0.1'], ['127.0.0.1'], ['::1'], ['10.0.0.1', '1.1.1.1'], []]) {
    assert.equal(await resolvePrivateHostname('x.example', { lookup: answer(...refused) }), null, refused.join(','))
  }
  assert.equal(await resolvePrivateHostname('', { lookup: answer('10.0.0.1') }), null)
  assert.equal(await resolvePrivateHostname(undefined, { lookup: answer('10.0.0.1') }), null)
})

test('advertise host: private IPs and names keep working; hostnames must resolve privately', async () => {
  const never = async () => { throw new Error('an address the private check accepts must not be looked up') }
  for (const accepted of ['100.64.0.10', '192.168.1.5', 'fd7a:115c:a1e0::7', 'localhost', 'phone.local', ' 10.0.0.2 ']) {
    assert.equal(await verifiedAdvertiseHost(accepted, { lookup: never }), accepted.trim(), accepted)
  }
  assert.equal(await verifiedAdvertiseHost('host.example.ts.net', { lookup: answer('100.64.0.10') }), 'host.example.ts.net')
  assert.equal(await verifiedAdvertiseHost('nas.home.example', { lookup: answer('192.168.1.20') }), 'nas.home.example')
})

test('advertise host refusals: public IPs, public names, loopback-only names, unresolvable names, non-strings', async () => {
  const never = async () => { throw new Error('an IP literal must be refused without a lookup') }
  for (const ip of ['203.0.113.1', '8.8.8.8', '100.128.0.1', '2001:db8::1']) {
    assert.equal(await verifiedAdvertiseHost(ip, { lookup: never }), null, ip)
  }
  assert.equal(await verifiedAdvertiseHost('example.com', { lookup: answer('93.184.216.34') }), null, 'public name')
  assert.equal(await verifiedAdvertiseHost('mixed.example', { lookup: answer('10.0.0.1', '93.184.216.34') }), null, 'public among private')
  assert.equal(await verifiedAdvertiseHost('rebind.example', { lookup: answer('127.0.0.1') }), null, 'loopback-only name')
  assert.equal(await verifiedAdvertiseHost('gone.example', { lookup: async () => { throw new Error('ENOTFOUND') } }), null, 'does not resolve')
  assert.equal(await verifiedAdvertiseHost('empty.example', { lookup: async () => [] }), null, 'resolves to nothing')
  for (const value of ['', '   ', undefined, null, 42]) assert.equal(await verifiedAdvertiseHost(value, { lookup: never }), null, String(value))
})


// ---- isOwnTailscaleHost: "this host", never "any tailnet machine" -----------------
// `magicDnsName` is injected, so no real CLI or DNS is touched.
const ownName = async () => 'host.example.ts.net'

test('own host: a Tailscale IP is accepted, anything else that is an IP or a public name is not', async () => {
  for (const ip of ['100.64.0.0', '100.64.0.10', '100.127.255.255', 'fd7a:115c:a1e0::1', '[fd7a:115c:a1e0::1]']) {
    assert.equal(await isOwnTailscaleHost(ip, { magicDnsName: ownName }), true, ip)
  }
  for (const value of ['100.63.255.255', '100.128.0.0', '192.168.1.1', '10.0.0.1', '8.8.8.8', '127.0.0.1', '::1', '[::1]', '2001:db8::1',
    'example.com', 'cloud.example', 'localhost', 'phone.local']) {
    assert.equal(await isOwnTailscaleHost(value, { magicDnsName: ownName }), false, value)
  }
})

test('own host: only THIS node\'s verified MagicDNS name matches, case-insensitively; another tailnet machine does not', async () => {
  for (const name of ['host.example.ts.net', 'HOST.Example.TS.NET', 'Host.example.ts.net']) {
    assert.equal(await isOwnTailscaleHost(name, { magicDnsName: ownName }), true, name)
  }
  // The verified name itself may come back in any case.
  assert.equal(await isOwnTailscaleHost('host.example.ts.net', { magicDnsName: async () => 'HOST.Example.ts.net' }), true)
  // The security property: a route must not be pointable at ANOTHER tailnet machine.
  for (const other of ['other.example.ts.net', 'phone.example.ts.net', 'host.other-tailnet.example.ts.net', 'other2.example.ts.net', 'ts.net', 'box']) {
    assert.equal(await isOwnTailscaleHost(other, { magicDnsName: ownName }), false, other)
  }
})

test('own host: without a verified name only the IP form is accepted, and nothing throws', async () => {
  const unavailable = {
    'cli missing / unverified': async () => null,
    'resolver throws': async () => { throw new Error('tailscale: not found') },
    'resolver rejects with code': async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    'empty name': async () => '',
    'non-string name': async () => 7,
    'undefined name': async () => undefined,
  }
  for (const [label, magicDnsName] of Object.entries(unavailable)) {
    assert.equal(await isOwnTailscaleHost('host.example.ts.net', { magicDnsName }), false, `${label}: name refused`)
    assert.equal(await isOwnTailscaleHost('100.64.0.1', { magicDnsName }), true, `${label}: IP still accepted`)
    assert.equal(await isOwnTailscaleHost('8.8.8.8', { magicDnsName }), false, `${label}: public IP still refused`)
  }
})

test('own host: ONE trailing root dot is ignored (callers pass `new URL(x).hostname`, which keeps it); two are not', async () => {
  assert.equal(await isOwnTailscaleHost('host.example.ts.net.', { magicDnsName: ownName }), true)
  assert.equal(await isOwnTailscaleHost('HOST.EXAMPLE.TS.NET.', { magicDnsName: ownName }), true)
  assert.equal(await isOwnTailscaleHost('host.example.ts.net..', { magicDnsName: ownName }), false)
  assert.equal(await isOwnTailscaleHost('other.example.ts.net.', { magicDnsName: ownName }), false)
  // Same through the real parsing the handlers do.
  assert.equal(new URL('wss://HOST.example.ts.net./ws/mobile').hostname, 'host.example.ts.net.')
  assert.equal(await isOwnTailscaleHost(new URL('wss://HOST.example.ts.net./ws/mobile').hostname, { magicDnsName: ownName }), true)
})

test('own host: hostile, empty, non-string and lookalike input is refused', async () => {
  for (const value of [undefined, null, 42, true, {}, [], ['host.example.ts.net'], () => 'host.example.ts.net']) {
    assert.equal(await isOwnTailscaleHost(value, { magicDnsName: ownName }), false, String(typeof value))
  }
  for (const value of ['', ' ', '.', '..']) assert.equal(await isOwnTailscaleHost(value, { magicDnsName: ownName }), false, JSON.stringify(value))
  // A name that merely contains the real one as a prefix, suffix or fragment.
  for (const value of ['evil-host.example.ts.net', 'xhost.example.ts.net', 'host.example.ts.net.evil.com', 'host.example.ts.net.evil.example.ts.net', 'evil.com.host.example.ts.net',
    'host.example.ts.net-evil', 'host-tail.example.ts.net', 'host.example.ts.neT.evil.com']) {
    assert.equal(await isOwnTailscaleHost(value, { magicDnsName: ownName }), false, value)
  }
  // Userinfo / port / path never reach a hostname after URL parsing; what the parser extracts is judged instead.
  const hostnameOf = (url) => new URL(url).hostname
  assert.equal(await isOwnTailscaleHost(hostnameOf('wss://host.example.ts.net@evil.com/ws'), { magicDnsName: ownName }), false, 'name in userinfo, evil host')
  assert.equal(await isOwnTailscaleHost(hostnameOf('wss://host.example.ts.net%2eevil.com/ws'), { magicDnsName: ownName }), false, 'percent-encoded dot')
  assert.equal(await isOwnTailscaleHost(hostnameOf('wss://host.example.ts.net:3081/ws'), { magicDnsName: ownName }), true, 'port is not part of the hostname')
  // Unicode / punycode lookalikes: the URL parser punycodes them, and neither form equals the ASCII name.
  assert.equal(await isOwnTailscaleHost('b\u043ex.example.ts.net', { magicDnsName: ownName }), false, 'cyrillic o')
  assert.equal(await isOwnTailscaleHost(hostnameOf('wss://b\u043ex.example.ts.net/ws'), { magicDnsName: ownName }), false, 'cyrillic o via URL')
  assert.equal(await isOwnTailscaleHost(hostnameOf('wss://b\u00f3x.example.ts.net/ws'), { magicDnsName: ownName }), false, 'o-acute via URL')
  assert.equal(await isOwnTailscaleHost('xn--bx-fmc.example.ts.net', { magicDnsName: ownName }), false, 'punycode form')
  // An IP-shaped "name" can never match a name, even if the resolver (wrongly) returned it.
  assert.equal(await isOwnTailscaleHost('8.8.8.8', { magicDnsName: async () => '8.8.8.8' }), false)
  assert.equal(await isOwnTailscaleHost('[::1]', { magicDnsName: async () => '::1' }), false)
})

test('own host: surrounding whitespace is trimmed (a URL hostname never has any, so this widens nothing)', async () => {
  // Documented actual behaviour, pinned so a change is deliberate. `new URL()` strips/rejects whitespace
  // before any handler gets here, so the trim cannot be used to smuggle a different name past the check.
  assert.equal(await isOwnTailscaleHost(' host.example.ts.net ', { magicDnsName: ownName }), true)
  assert.equal(await isOwnTailscaleHost(' other.example.ts.net ', { magicDnsName: ownName }), false)
  assert.throws(() => new URL('wss://host.example.ts.net /ws'), 'a space inside a URL authority is refused by the parser')
})