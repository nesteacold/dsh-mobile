/**
 * M3 (second reviewer pass) — the tools never load, and never drive a tab that is already
 * on, a local address: loopback (127.0.0.0/8), `::1`, `localhost` and `*.localhost`,
 * 0.0.0.0, or this DSH Host's own listener. Only absolute `http:`/`https:` URLs are
 * accepted. The host half checks every target before it is sent; `lib/client.js` applies
 * the same guard to the tab it picks.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createHost, runTool } from './harness.mjs'
import { pageUrlProblem } from '../lib/url-guard.js'

/** A Host listener on a LAN interface, so "the Host's own host:port" is a real case. */
const OWN = { host: '192.168.7.9', port: 13210 }

/** [label, URL, this Host's listener or null] — every one of these must be refused. */
const BLOCKED = [
  ['loopback IPv4', 'http://127.0.0.1/', null],
  ['the whole 127/8', 'http://127.255.255.254:8080/x', null],
  ['decimal IP', 'http://2130706433/', null],
  ['hex IP', 'http://0x7f000001/', null],
  ['octal IP', 'http://0177.0.0.1/', null],
  ['localhost', 'http://localhost/', null],
  ['uppercase with a root dot', 'http://LOCALHOST./', null],
  ['a localhost subdomain', 'https://app.localhost.:8443/x', null],
  ['the unspecified IPv4', 'http://0.0.0.0:3000/', null],
  ['IPv6 loopback', 'http://[::1]:8080/', null],
  ['expanded IPv6 loopback', 'http://[0:0:0:0:0:0:0:1]/', null],
  ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/', null],
  ['hex IPv4-mapped loopback', 'http://[::ffff:7f00:1]/', null],
  ['the unspecified IPv6', 'http://[::]/', null],
  ['userinfo in front of loopback', 'http://user:pw@127.0.0.1/', null],
  ["this Host's own listener", 'http://192.168.7.9:13210/app', OWN],
  ["this Host's own listener over https", 'https://192.168.7.9:13210/app', OWN],
]

/** [label, URL, this Host's listener or null] — every one of these must be allowed. */
const ALLOWED = [
  ['a public site', 'https://example.com/', null],
  ['a public site on a port', 'http://example.com:8080/x', null],
  ['a name that merely ends in localhost', 'https://notlocalhost/', null],
  ['another name that starts with localhost', 'https://localhost.example.com/', null],
  ['another service on the Host interface', 'http://192.168.7.9:8080/', OWN],
  ['another address on the Host port', 'http://192.168.7.8:13210/', OWN],
  ['a mapped, non-loopback IPv4', 'http://[::ffff:192.168.7.9]/', null],
]

test('M3: every local address form is refused, public ones are allowed', () => {
  for (const [label, url, own] of BLOCKED) {
    const problem = pageUrlProblem(url, own)
    assert.equal(typeof problem, 'string', `${label} (${url}) must be refused`)
    assert.match(problem, /will not load|only http and https/, `${label} (${url})`)
  }
  for (const [label, url, own] of ALLOWED) {
    assert.equal(pageUrlProblem(url, own), null, `${label} (${url}) must be allowed`)
  }
})

test('M3: only http and https URLs are accepted', () => {
  for (const url of ['data:text/html,<p>x</p>', 'file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'about:blank']) {
    assert.match(pageUrlProblem(url, null), /only http and https/, `${url} must be refused`)
  }
  assert.match(pageUrlProblem('not a url', null), /not an absolute URL/)
})

test("M3: a Host listener with no bound port yet is refused on every port", () => {
  // `webServer.port` is undefined before the listener binds; the host is still this Host.
  assert.match(pageUrlProblem('http://192.168.7.9:9999/', { host: '192.168.7.9', port: null }), /DSH Host's own listener/)
})

test('M3: an IPv6 Host listener is matched by address, not by spelling', () => {
  const own = { host: 'fe80::1', port: 13210 }
  assert.match(pageUrlProblem('http://[fe80::1]:13210/', own), /DSH Host's own listener/)
  assert.equal(pageUrlProblem('http://[fe80::1]:8080/', own), null)
})

test('M3: navigate and open refuse a local target before any command is sent', async () => {
  const host = createHost()
  const sent = []
  const respond = async (op) => { sent.push(op); return true }
  for (const url of ['http://127.0.0.1:3080/', 'http://localhost/', 'http://[::1]/', 'file:///etc/passwd', 'data:text/html,x']) {
    // The tools add `https://` to a scheme-less argument, so `data:`/`file:` are refused
    // either as an unsupported scheme or as an unparseable host — never sent.
    for (const tool of ['internal_browser_navigate', 'internal_browser_open']) {
      await assert.rejects(
        () => runTool(host, tool, { url }, { respond }),
        /will not load|only http and https|not an absolute URL/,
        `${tool} ${url} must be refused`,
      )
    }
  }
  assert.deepEqual(sent, [], 'no command may reach the page for a refused URL')
})

test("M3: a Host-bound listener is refused for its own host:port only", async () => {
  const host = createHost({ webServer: OWN })
  const sent = []
  await assert.rejects(
    () => runTool(host, 'internal_browser_navigate', { url: 'http://192.168.7.9:13210/' }, {
      respond: async (op) => { sent.push(op); return true },
    }),
    /DSH Host's own listener/,
  )
  assert.deepEqual(sent, [])

  const text = await runTool(host, 'internal_browser_navigate', { url: 'http://192.168.7.9:8080/' }, {
    respond: async (op, args) => {
      if (op === 'navigate') return true
      assert.equal(op, 'eval')
      if (args.code.includes('readyState')) return 'complete'
      if (args.code.includes('location.href')) return 'http://192.168.7.9:8080/'
      return 'Dev server'
    },
  })
  assert.match(text, /Dev server/)
})

test('M3: a public target still reaches the window and comes back wrapped', async () => {
  const host = createHost()
  const text = await runTool(host, 'internal_browser_navigate', { url: 'https://example.com/login' }, {
    respond: async (op, args) => {
      if (op === 'navigate') {
        assert.equal(args.url, 'https://example.com/login')
        return true
      }
      assert.equal(op, 'eval')
      if (args.code.includes('readyState')) return 'complete'
      if (args.code.includes('location.href')) return 'https://example.com/login'
      return 'Login'
    },
  })
  assert.match(text, /<untrusted-page-content/)
  assert.match(text, /Login/)
})

test('M3: the client half never targets a tab on a local address', () => {
  const local = guest('http://127.0.0.1:13210/app', 'DSH')
  const publicTab = guest('https://example.com/', 'Example')
  const client = loadClient({ guests: [local, publicTab] })
  assert.equal(client.__internals.pick(), publicTab, 'the local tab is skipped')
  assert.equal(client.__internals.pick('example'), publicTab)
  // A fragment that names the refused tab is refused too: acting on a different page while
  // the caller asked for that tab would be the surprise this guard exists to prevent.
  assert.throws(() => client.__internals.pick('127.0.0.1'), (error) => error.message === 'no-usable-guest')
  assert.throws(() => client.__internals.pick('dsh'), (error) => error.message === 'no-usable-guest')
})

test('M3: a window whose only tabs are local says so instead of guessing', () => {
  const client = loadClient({ guests: [guest('http://localhost:3000/', 'dev')] })
  assert.throws(() => client.__internals.pick(), (error) => error.message === 'no-usable-guest')
  // No page tab at all keeps the original "no window" code, which the host explains.
  const empty = loadClient({ guests: [] })
  assert.throws(() => empty.__internals.pick(), (error) => error.message === 'no-guest')
})

test('M3: the client copy and the host copy of the guard answer alike', () => {
  for (const [label, url, own] of [...BLOCKED, ...ALLOWED]) {
    const client = loadClient({
      location: own === null
        ? { protocol: 'file:', hostname: '', port: '' }
        : { protocol: 'http:', hostname: own.host, port: String(own.port) },
    })
    const clientAllowed = client.__internals.guestUrlAllowed(url)
    const hostAllowed = pageUrlProblem(url, own) === null
    assert.equal(clientAllowed, hostAllowed, `${label} (${url}): client ${clientAllowed} vs host ${hostAllowed}`)
  }
})

test('M3: the client copy matches an IPv6 Host listener too', () => {
  const client = loadClient({ location: { protocol: 'http:', hostname: '[fe80::1]', port: '13210' } })
  assert.equal(client.__internals.guestUrlAllowed('http://[fe80::1]:13210/'), false)
  assert.equal(client.__internals.guestUrlAllowed('http://[fe80::1]:8080/'), true)
})

/** A fake sidebar guest with the three methods the client half calls on it. */
function guest (url, title = '', visible = true) {
  return {
    getURL: () => url,
    getTitle: () => title,
    getBoundingClientRect: () => (visible ? { width: 400, height: 300 } : { width: 0, height: 0 }),
  }
}

/**
 * Run `lib/client.js` in a fresh VM context with a fake app-window DOM. The file is a
 * plain script that registers through `window.__ModuleLoader__`, so a context is the
 * closest thing to the shell without a browser; nothing else in it reaches the DOM until
 * a tool operation runs.
 * @param {{guests?: object[], location?: object}} options - fake window state.
 */
function loadClient ({ guests = [], location = { protocol: 'http:', hostname: '127.0.0.1', port: '13210' } } = {}) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded = null
  const document = {
    querySelectorAll: (selector) => (String(selector).includes('data-sidebar-browser-frame') ? guests : []),
    querySelector: () => null,
  }
  const window = { __ModuleLoader__: { load: ({ factory }) => { loaded = factory() } } }
  // `URL` stands in for the browser's; the VM context otherwise has only JS intrinsics.
  const context = vm.createContext({ window, document, location, console, setTimeout, URL })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.notEqual(loaded, null, 'the client half must register through window.__ModuleLoader__')
  return loaded
}
