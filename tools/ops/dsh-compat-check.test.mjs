// Tests for tools/ops/dsh-compat-check.mjs: temp fixtures only, no network, no real DSH.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { satisfies, newerSections, surfacesOf, run } from './dsh-compat-check.mjs'

const RANGE = '>=0.2.2-rc.1 <0.3.0-0'

test('range matches DSH semantics (includePrerelease)', () => {
  for (const v of ['0.2.2-rc.1', '0.2.2-rc.3', '0.2.2', '0.2.9', '0.2.3-rc.1']) assert.ok(satisfies(v, RANGE), v)
  for (const v of ['0.2.1', '0.2.2-beta.1', '0.3.0-rc.1', '0.3.0', 'x']) assert.ok(!satisfies(v, RANGE), v)
  assert.ok(!satisfies('0.2.2', ''))
  assert.ok(satisfies('1.0.0', '0.2.2 || >=1.0.0'))
})

test('newer sections and named surfaces', () => {
  const md = '# Guide\n## 0.2.2-rc.3\nold `typertGateway`\n## 0.2.2\nrenamed `dispatchRpc` and `fetchRoutes`\n## 0.3.0\nfuture `x.y.z`\n'
  const s = newerSections(md, '0.2.2-rc.3', '0.2.2')
  assert.deepEqual(s.map(x => x.version), ['0.2.2'])
  assert.deepEqual(surfacesOf(s[0].body), ['dispatchRpc', 'fetchRoutes'])
})

function fixture(t, { version, range, guide }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const repo = path.join(dir, 'repo'), root = path.join(dir, 'dsh')
  fs.mkdirSync(path.join(repo, 'tools', 'ops'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'plugins', 'p', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'tools', 'ops', 'dsh-compat.json'), '{"lastChecked":"0.2.2-rc.3"}')
  fs.writeFileSync(path.join(repo, 'plugins', 'p', 'package.json'), JSON.stringify({ name: 'p', engines: { dsh: range } }))
  fs.writeFileSync(path.join(repo, 'plugins', 'p', 'lib', 'a.mjs'), 'gateway.dispatchRpc()\n')
  fs.mkdirSync(path.join(root, 'docs', 'upgrade-guide'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }))
  if (guide) fs.writeFileSync(path.join(root, 'docs', 'upgrade-guide', 'README.md'), guide)
  return { repo, root }
}

test('skips without DSH_INSTALL_ROOT', () => {
  const lines = []
  assert.equal(run({ env: {}, log: l => lines.push(l) }), 0)
  assert.match(lines.join('\n'), /SKIPPED/)
})

test('passes, prints surface matches, and --update records the version', (t) => {
  const { repo, root } = fixture(t, { version: '0.2.4', range: RANGE, guide: '## 0.2.4\n`dispatchRpc` changed\n' })
  const lines = []
  assert.equal(run({ env: { DSH_INSTALL_ROOT: root }, argv: ['--no-tests', '--update'], log: l => lines.push(l), repo }), 0)
  assert.match(lines.join('\n'), /match plugins[\\/]p[\\/]lib[\\/]a\.mjs:1 dispatchRpc/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'tools', 'ops', 'dsh-compat.json'), 'utf8')).lastChecked, '0.2.4')
})

test('fails when an engines range rejects the installed version', (t) => {
  const { repo, root } = fixture(t, { version: '0.3.0', range: RANGE })
  const lines = []
  assert.equal(run({ env: { DSH_INSTALL_ROOT: root }, argv: ['--no-tests', '--update'], log: l => lines.push(l), repo }), 1)
  assert.match(lines.join('\n'), /FAIL p: engines\.dsh/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'tools', 'ops', 'dsh-compat.json'), 'utf8')).lastChecked, '0.2.2-rc.3')
})
