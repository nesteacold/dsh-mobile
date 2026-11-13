#!/usr/bin/env node
// Roadmap P1-3: every test file in a package's test/ tree must be referenced by that
// package's `npm test` (directly, through a glob, or through an `npm run <script>` it
// calls), unless it is listed in OPT_OUT with a reason. Exits 1 on an unwired file or a
// stale opt-out entry.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PACKAGES = {
  'plugins/devices': {},
  'apps/mobile-companion': {},
  'plugins/mobile-gateway': {
    'test/package-install.test.mjs': 'opt-in: npm run test:package (packs and installs; slow, needs npm)',
    'test/agent-team-official.test.mjs': 'opt-in: needs a real DSH install (official surface)',
    'test/dsh-022-official.test.mjs': 'opt-in: needs a real DSH install (official surface)',
    'test/file-upload-official.test.mjs': 'opt-in: needs a real DSH install (official surface)',
    'test/host-official.test.mjs': 'opt-in: needs a real DSH install (official surface)',
    'test/speech-official.test.mjs': 'opt-in: needs a real DSH install (official surface)',
    'test/tool-images-official.test.mjs': 'opt-in: needs a real DSH install (official surface)',
    // GAP found 2026-11-14 by this tool: not wired, not intentionally opt-in. Kept visible
    // here until a gateway-scoped task wires them into npm test (then delete these lines).
  },
}

const TEST_FILE = /\.test\.(?:mjs|cjs|js|ts)$/

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'fixtures') walk(p, out) }
    else if (TEST_FILE.test(e.name)) out.push(p)
  }
  return out
}

function expandScript(scripts, name, seen = new Set()) {
  if (seen.has(name) || !scripts[name]) return ''
  seen.add(name)
  let text = scripts[name]
  for (const m of text.matchAll(/npm run ([\w:.-]+)/g)) text += ' ' + expandScript(scripts, m[1], seen)
  return text
}

function globToRegex(glob) {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$')
}

let failures = 0
for (const [pkg, optOut] of Object.entries(PACKAGES)) {
  const dir = path.join(root, pkg)
  const scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {}
  const cmd = expandScript(scripts, 'test')
  const tokens = cmd.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, '')).filter((t) => t.startsWith('test/'))
  const matchers = tokens.map((t) => (t.includes('*') ? globToRegex(t) : t))
  const files = walk(path.join(dir, 'test')).map((f) => path.relative(dir, f).split(path.sep).join('/'))
  let wired = 0
  for (const f of files) {
    const hit = matchers.some((m) => (typeof m === 'string' ? m === f : m.test(f)))
    if (hit && optOut[f]) { console.error(`${pkg}: ${f} is wired but listed as opt-out — remove the entry`); failures++ }
    else if (hit) wired++
    else if (!optOut[f]) { console.error(`${pkg}: ${f} is not referenced by npm test (wire it or add an opt-out with a reason)`); failures++ }
  }
  for (const f of Object.keys(optOut)) {
    if (!files.includes(f)) { console.error(`${pkg}: stale opt-out ${f} (file not found)`); failures++ }
  }
  console.log(`${pkg}: ${files.length} test files, ${wired} wired, ${Object.keys(optOut).length} opt-out`)
}
if (failures) { console.error(`check-test-wiring: ${failures} problem(s)`); process.exit(1) }
console.log('check-test-wiring: OK')
