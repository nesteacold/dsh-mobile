// Spec 028 packaging gate: the dsh-mobile bundle resolves, from its own directory, the three
// plugins' patches, their Host entry points, their Client manifests and the gateway's vendored
// contract. This is a LOCAL link bundle check; it does not claim a publishable tarball.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundleDir = path.resolve(here, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'package.json'), 'utf8'))
const ROWS = [
  ['devices', '@dsh-ext/devices', 'plugins/devices'],
  ['mobile-gateway', '@dsh-ext/mobile-gateway', 'plugins/mobile-gateway'],
  ['sidebar-browser', '@dsh-ext/sidebar-browser', 'plugins/sidebar-browser'],
]

// The same join DSH uses (dsh-app-boot/src/profile.ts bundlePatchPaths).
const patchPaths = () => [].concat(manifest.dsh.bundle.patch).map((file) => path.join(bundleDir, file))

/** Minimal reader for the patches' `- insert:` rows: id, name, top-level config keys. */
function readRows(file) {
  const rows = []
  let row = null
  let inConfig = false
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue
    let m
    if ((m = /^ {4}- id:\s*(\S+)/.exec(line))) { row = { id: m[1].replace(/['"]/g, ''), name: null, config: [] }; rows.push(row); inConfig = false; continue }
    if (row && (m = /^ {6}name:\s*(\S+)/.exec(line))) { row.name = m[1].replace(/['"]/g, ''); continue }
    if (row && /^ {6}config:\s*$/.test(line)) { inConfig = true; continue }
    if (row && inConfig && (m = /^ {8}([A-Za-z][\w]*):/.exec(line))) row.config.push(m[1])
  }
  return rows
}

test('bundle manifest: one bundle, display metadata, engines range', () => {
  assert.equal(manifest.name, '@dsh-mobile/bundle')
  assert.equal(manifest.engines.dsh, '>=0.2.2-rc.3 <0.3.0-0')
  for (const lang of ['en', 'vi']) {
    const meta = JSON.parse(fs.readFileSync(path.join(bundleDir, 'locale', `${lang}.json`), 'utf8')).meta
    assert.equal(meta.title, 'dsh-mobile')
    assert.ok(meta.description.length > 40)
  }
  const icon = fs.readFileSync(path.join(bundleDir, 'icon.svg'), 'utf8')
  assert.match(icon, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.ok(Buffer.byteLength(icon) < 256 * 1024)
})

test('the patch stays inside the bundle (DSH reads it at the node_modules link path) and is in sync', async () => {
  for (const file of patchPaths()) assert.ok(!path.relative(bundleDir, file).startsWith('..'), `${file} escapes the bundle`)
  const { render, TARGET } = await import(pathToFileURL(path.join(bundleDir, 'scripts/sync-patch.mjs')).href)
  assert.equal(fs.readFileSync(TARGET, 'utf8'), render())
})

test('patches resolve beside the bundle and insert the same three rows, ids and names', () => {
  const rows = patchPaths().flatMap((file) => { assert.ok(fs.existsSync(file), file); return readRows(file) })
  assert.deepEqual(rows.map((r) => [r.id, r.name]), ROWS.map(([id, name]) => [id, name]))
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.ok(byId.devices.config.includes('dataDir') && byId.devices.config.includes('pwaUrl'))
  assert.ok(byId['mobile-gateway'].config.includes('lanHost') && byId['mobile-gateway'].config.includes('adminLoopbackOnly'))
  assert.deepEqual(byId['sidebar-browser'].config, ['dataDir', 'grantedScopes', 'tab'])
})

test('the plugin packages are no longer bundles of their own', () => {
  for (const [, name, dir] of ROWS) {
    const pkg = JSON.parse(fs.readFileSync(path.join(bundleDir, '..', dir, 'package.json'), 'utf8'))
    assert.equal(pkg.name, name)
    assert.equal(pkg.dsh?.bundle, undefined, `${name} must not declare dsh.bundle`)
  }
})

test('host entries, client manifests and the vendored contract resolve from the bundle context', async () => {
  for (const [, name, dir] of ROWS) {
    const root = path.join(bundleDir, '..', dir)
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    // Host half: exports["."] exists and imports.
    const host = path.join(root, pkg.exports['.'])
    assert.ok(fs.existsSync(host), `${name} host entry`)
    const mod = await import(pathToFileURL(host).href)
    assert.ok(mod.plugin || mod.apply || mod.default, `${name} exports a plugin`)
    // Client half: dsh.client web + exports["./client"] (dsh-client-modules resolveMeta rule).
    assert.equal(pkg.dsh.client.platform, 'web')
    const client = path.join(root, pkg.exports['./client'])
    assert.match(fs.readFileSync(client, 'utf8'), new RegExp(`__ModuleLoader__\\.load\\(\\{\\s*id: '${name.replace('/', '\\/')}'`))
  }
  const vendor = path.join(bundleDir, '..', 'plugins/mobile-gateway/lib/vendor/mobile-protocol.mjs')
  const contract = await import(pathToFileURL(vendor).href)
  assert.equal(typeof contract.validatePushSubscribe, 'function')
})
