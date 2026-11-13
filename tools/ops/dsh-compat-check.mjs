#!/usr/bin/env node
// DSH auto-compat layer 3 (owner 2026-11-13). Given DSH_INSTALL_ROOT (the installed
// @deepseek-ai/dsh package root), this:
//   1. reads the installed DSH version;
//   2. prints docs/upgrade-guide/README.md sections newer than the last checked version
//      (stored in tools/ops/dsh-compat.json);
//   3. greps plugins/ for the code surfaces those sections name (backticked identifiers);
//   4. checks each plugin's engines.dsh accepts the installed version (semver, includePrerelease,
//      the way DSH's plugin manager evaluates it);
//   5. runs the gateway *-official tests and device-access-real test.
// Exit 0 = compatible; 1 = a failure; DSH_INSTALL_ROOT unset = prints SKIPPED and exits 0.
// Flags: --update records the installed version as last checked (only after a clean run);
//        --no-tests skips step 5.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..', '..')

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(v) {
  const m = typeof v === 'string' ? SEMVER.exec(v.trim()) : null
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] } : null
}

function comparePre(a, b) {
  if (a === undefined) return b === undefined ? 0 : 1
  if (b === undefined) return -1
  const x = a.split('.'), y = b.split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1
    if (y[i] === undefined) return 1
    const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i])
    if (nx && ny) { const d = +x[i] - +y[i]; if (d) return Math.sign(d); continue }
    if (nx !== ny) return nx ? -1 : 1
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  }
  return 0
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b)
  if (!x || !y) throw new Error(`not a semver version: ${!x ? a : b}`)
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return Math.sign(x[k] - y[k])
  return comparePre(x.pre, y.pre)
}

/**
 * semver.satisfies(version, range, { includePrerelease: true }) for the subset we use:
 * `||`-separated sets of space-separated comparators (>=, >, <=, <, =, bare version).
 */
export function satisfies(version, range) {
  if (typeof range !== 'string' || range.trim() === '' || !parseVersion(version)) return false
  return range.split('||').some(set => set.trim().split(/\s+/).every(c => {
    const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(c)
    if (!m || !parseVersion(m[2])) return false
    const d = compareVersions(version, m[2])
    return { '>=': d >= 0, '<=': d <= 0, '>': d > 0, '<': d < 0, '=': d === 0, undefined: d === 0 }[m[1]]
  }))
}

/** `## <version>` headed sections strictly newer than `since` and not newer than `upTo`. */
export function newerSections(markdown, since, upTo) {
  const out = []
  let cur = null
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^#{1,3}\s+.*?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(line)
    if (h) {
      cur = { version: h[1], heading: line.trim(), body: [] }
      const newer = !since || compareVersions(h[1], since) > 0
      const notFuture = !upTo || compareVersions(h[1], upTo) <= 0
      if (newer && notFuture) out.push(cur)
      continue
    }
    if (cur) cur.body.push(line)
  }
  return out.map(s => ({ ...s, body: s.body.join('\n') }))
}

/** Backticked identifiers a section names (APIs, services, files). */
export function surfacesOf(text) {
  const set = new Set()
  for (const m of text.matchAll(/`([^`\n]{3,80})`/g)) {
    const s = m[1].trim()
    if (/^[\w@$./:-]+$/.test(s) && !/^\d/.test(s)) set.add(s)
  }
  return [...set]
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const f = path.join(dir, e.name)
    if (e.isDirectory()) walk(f, out)
    else if (/\.(m?js|cjs|ts|tsx|json)$/.test(e.name) && !/lock\.(json|yaml)$/.test(e.name)) out.push(f)
  }
  return out
}

export function grepSurfaces(pluginsDir, surfaces, repo = REPO) {
  const hits = []
  if (!surfaces.length) return hits
  for (const f of walk(pluginsDir)) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
    lines.forEach((l, i) => {
      for (const s of surfaces) if (l.includes(s)) hits.push({ file: path.relative(repo, f), line: i + 1, surface: s })
    })
  }
  return hits
}

export function pluginManifests(pluginsDir) {
  return fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(pluginsDir, e.name, 'package.json')))
    .map(e => {
      const pkg = JSON.parse(fs.readFileSync(path.join(pluginsDir, e.name, 'package.json'), 'utf8'))
      return { dir: e.name, name: pkg.name, range: pkg.engines?.dsh }
    })
}

export function run({ env = process.env, argv = [], log = console.log, repo = REPO } = {}) {
  const root = env.DSH_INSTALL_ROOT
  if (!root) { log('DSH COMPAT CHECK: SKIPPED (DSH_INSTALL_ROOT is not set)'); return 0 }
  const failures = []
  const stateFile = path.join(repo, 'tools', 'ops', 'dsh-compat.json')
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}
  let installed
  try { installed = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version } catch (e) {
    log(`FAIL cannot read ${path.join(root, 'package.json')}: ${e.message}`); return 1
  }
  if (!parseVersion(installed)) { log(`FAIL installed version is not semver: ${installed}`); return 1 }
  log(`installed DSH ${installed}; last checked ${state.lastChecked ?? '(none)'}`)

  const guide = path.join(root, 'docs', 'upgrade-guide', 'README.md')
  if (fs.existsSync(guide)) {
    const sections = newerSections(fs.readFileSync(guide, 'utf8'), state.lastChecked, installed)
    log(`upgrade guide: ${sections.length} section(s) newer than ${state.lastChecked ?? '(none)'}`)
    for (const s of sections) {
      const surfaces = surfacesOf(s.body)
      log(`${s.heading} — ${surfaces.length} named surface(s)`)
      for (const h of grepSurfaces(path.join(repo, 'plugins'), surfaces, repo)) log(`  match ${h.file}:${h.line} ${h.surface}`)
    }
  } else {
    log(`upgrade guide: not present at ${guide} (nothing to grep)`)
  }

  for (const p of pluginManifests(path.join(repo, 'plugins'))) {
    if (typeof p.range !== 'string') { failures.push(`${p.dir}: no engines.dsh`); log(`FAIL ${p.dir}: no engines.dsh`); continue }
    const ok = satisfies(installed, p.range)
    log(`${ok ? 'ok  ' : 'FAIL'} ${p.dir}: engines.dsh "${p.range}" ${ok ? 'accepts' : 'rejects'} ${installed}`)
    if (!ok) failures.push(`${p.dir}: engines.dsh rejects ${installed}`)
  }

  if (!argv.includes('--no-tests')) {
    const gw = path.join(repo, 'plugins', 'mobile-gateway', 'test')
    const tests = fs.existsSync(gw)
      ? fs.readdirSync(gw).filter(f => /-official\.test\.mjs$/.test(f) || f === 'device-access-real.test.mjs').sort()
      : []
    for (const t of tests) {
      const r = spawnSync(process.execPath, [path.join(gw, t)], {
        cwd: path.dirname(gw), env: { ...env, DSH_REAL_REQUIRED: '1' }, encoding: 'utf8',
      })
      const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-1)[0] ?? ''
      log(`${r.status === 0 ? 'ok  ' : 'FAIL'} ${t}: ${tail}`)
      if (r.status !== 0) failures.push(`${t} exited ${r.status}`)
    }
  }

  if (failures.length) { log(`DSH COMPAT CHECK: FAILED (${failures.length})`); return 1 }
  if (argv.includes('--update')) {
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, lastChecked: installed }, null, 2) + '\n')
    log(`recorded lastChecked ${installed}`)
  }
  log(`DSH COMPAT CHECK: PASSED (DSH ${installed})`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run({ argv: process.argv.slice(2) })
}
