/**
 * R1 — one loopback CDP endpoint per Host, refused at activation otherwise; the plugin never
 * launches Chrome, never creates a profile and never changes ports.
 */

// The suite only ever talks to the loopback fakes test/fake-chrome.mjs starts: arming them
// switches the under-test refusal off in this process. An unarmed test process refuses every
// side effect, so a test that slipped through could never open a window on a real Chrome.
process.env.DSH_CHROME_CDP_ARM_FAKES = '1'

import test from 'node:test'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseEndpoint, DEFAULT_ENDPOINT } from '../lib/cdp.js'
import { normalizeConfig, __internals, inject } from '../lib/index.js'
import { createHost } from './harness.mjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the default endpoint is the owner Chrome on loopback', () => {
  assert.equal(DEFAULT_ENDPOINT, 'http://127.0.0.1:40222')
  assert.deepEqual(parseEndpoint(undefined), { url: 'http://127.0.0.1:40222', host: '127.0.0.1', port: 40222 })
  assert.deepEqual(parseEndpoint(''), { url: 'http://127.0.0.1:40222', host: '127.0.0.1', port: 40222 })
})

test('every loopback literal is accepted and normalized', () => {
  for (const [input, url, host] of [
    ['http://127.0.0.1:40222', 'http://127.0.0.1:40222', '127.0.0.1'],
    ['http://LOCALHOST:9222/', 'http://localhost:9222', 'localhost'],
    ['http://localhost', 'http://localhost:80', 'localhost'],
    ['http://[::1]:9222', 'http://[::1]:9222', '::1'],
    ['https://127.0.0.1:9443', 'https://127.0.0.1:9443', '127.0.0.1'],
  ]) {
    const parsed = parseEndpoint(input)
    assert.equal(parsed.url, url, input)
    assert.equal(parsed.host, host, input)
  }
})

test('anything that is not this machine is refused with a visible reason', () => {
  for (const input of [
    'http://192.168.7.9:9222',
    'http://10.0.0.5:9222',
    'http://example.com:9222',
    'http://0.0.0.0:9222',
    'http://chrome.internal:9222',
    'http://[::]:9222',
    'http://[fe80::1]:9222',
    'ws://127.0.0.1:9222',
    'file:///C:/chrome',
    'ftp://127.0.0.1:9222',
    'not a url',
  ]) {
    assert.throws(() => parseEndpoint(input), (error) => {
      assert.equal(error.name, 'TypeError', input)
      assert.match(error.message, /@dsh-ext\/chrome-cdp: config\.endpoint/, input)
      return true
    }, input)
  }
  // The exact sentence for a remote host names the loopback rule (R1).
  assert.throws(() => parseEndpoint('http://192.168.7.9:9222'), /not loopback.*127\.0\.0\.1, ::1 or localhost/s)
})

test('a path on the endpoint is refused: the plugin addresses /json/... itself', () => {
  assert.throws(() => parseEndpoint('http://127.0.0.1:40222/devtools'), /must not carry a path/)
})

test('launchPolicy accepts only "never" in v1 (the plugin never starts Chrome)', () => {
  assert.deepEqual(normalizeConfig({}).launchPolicy, 'never')
  for (const value of ['always', 'auto', 'on-demand', '', 1]) {
    assert.throws(() => normalizeConfig({ launchPolicy: value }), /not supported: v1 accepts "never" only/, String(value))
  }
})

test('normalizeConfig defaults, dataDir rule and the schema defaults agree', () => {
  const config = normalizeConfig({})
  assert.deepEqual(config, { endpoint: { url: 'http://127.0.0.1:40222', host: '127.0.0.1', port: 40222 }, launchPolicy: 'never', dataDir: '' })
  assert.throws(() => normalizeConfig({ dataDir: 'relative/dir' }), /absolute path or empty/)
  assert.throws(() => normalizeConfig([]), /config must be an object/)
  assert.deepEqual(Object.keys(__internals.DEFAULTS).sort(), ['dataDir', 'endpoint', 'launchPolicy'])
  // The manifest's patch carries the same defaults the code does.
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /endpoint: 'http:\/\/127\.0\.0\.1:40222'/)
  assert.match(patch, /launchPolicy: never/)
})

test('a remote endpoint refuses the plugin at activation, with the reason surfaced', () => {
  assert.throws(() => createHost({ config: { endpoint: 'http://192.168.7.9:9222' } }), /not loopback/)
})

test('the plugin ships no code that launches, spawns or kills a browser', () => {
  for (const file of ['../lib/index.js', '../lib/cdp.js', '../lib/cdp-client.js', '../lib/client.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /child_process|node:child_process|powershell|taskkill|\.spawn\(|\.exec\(/, file)
    assert.doesNotMatch(source, /--user-data-dir|user-data-dir|remote-debugging-port"\s*,\s*'start'/, file)
  }
})

test('the manifest declares the bundle patch, the web client and the exported files a skill ships', () => {
  assert.equal(manifest.name, '@dsh-ext/chrome-cdp')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-sidebar-right'])
  for (const subpath of ['.', './client', './locale/*.json', './icon']) assert.ok(manifest.exports[subpath], subpath)
  for (const entry of ['lib', 'locale', 'icon.svg', 'cordis.patch.yml', 'README.md', 'LICENSE']) assert.ok(manifest.files.includes(entry), entry)
  assert.equal(manifest.engines.dsh, __internals.DSH_VERSION, 'package.json engines.dsh and the code range must agree')
  assert.equal(manifest.scripts.test, 'node --test test/*.test.mjs')
})

test('the host module declares the tools and connection services it injects', () => {
  assert.deepEqual(inject, ['tools', 'connection'])
})
