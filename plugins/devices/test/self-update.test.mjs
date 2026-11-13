// Spec 027: self-update with a fake git runner (no real git, no network).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSelfUpdater, satisfies, compareSemver, SelfUpdateError, handleSelfUpdateRoute } from '../lib/self-update.mjs'

const HEAD = 'a'.repeat(40)
const TAGC = 'b'.repeat(40)
const ALLOWED = new Set(['fetch', 'tag', 'log', 'merge-base', 'status', 'merge', 'show', 'verify-tag'])

function fakeGit({ tags = ['v0.1.0', 'v0.2.0', 'v0.10.0-rc.1', 'nope'], dirty = false, ff = true,
  engines = '>=0.2.2-rc.3 <0.3.0-0', hang = false, changed = '' } = {}) {
  const calls = []
  const git = async (args) => {
    calls.push(args)
    assert.ok(ALLOWED.has(args[0]), `forbidden git ${args[0]}`)
    if (args[0] === 'merge') assert.deepEqual(args.slice(0, 2), ['merge', '--ff-only'])
    if (args[0] === 'fetch' && hang) {
      await new Promise((r) => setTimeout(r, 20))
      throw new SelfUpdateError('timeout', 'git fetch failed (timeout)')
    }
    switch (args[0]) {
      case 'status':
        return args.includes('--branch') ? '# branch.head main\n' : (dirty ? ' M plugins/devices/lib/x.mjs\n' : '')
      case 'log':
        if (args[1] === '-1') return args[3] === 'HEAD' ? HEAD : TAGC
        if (args[1] === '--format=') return changed
        return 'b1 feat: one\nb2 fix: two\n'
      case 'tag': return tags.join('\n')
      case 'show': {
        const tagRef = !args[1].startsWith('HEAD:')
        if (tagRef && engines === 'ABSENT') return JSON.stringify({ version: '0.10.0-rc.1' })
        return JSON.stringify({ version: tagRef ? '0.10.0-rc.1' : '0.1.0', engines: { dsh: engines } })
      }
      case 'merge-base': if (!ff) throw new SelfUpdateError('git-failed', 'not ancestor'); return ''
      default: return ''
    }
  }
  return { git, calls }
}

test('semver helpers', () => {
  assert.equal(compareSemver('0.10.0-rc.1', '0.2.0'), 1)
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1)
  assert.ok(satisfies('0.2.2-rc.3', '>=0.2.2-rc.3 <0.3.0-0'))
  assert.ok(!satisfies('0.3.0', '>=0.2.2-rc.3 <0.3.0-0'))
})

test('check picks highest semver tag and reports notes + engines', async () => {
  const { git, calls } = fakeGit()
  const u = createSelfUpdater({ git, dshVersion: '0.2.2-rc.3' })
  const r = await u.check()
  assert.equal(r.latest.tag, 'v0.10.0-rc.1')
  assert.equal(r.branch, 'main')
  assert.deepEqual(r.latest.notes, ['b1 feat: one', 'b2 fix: two'])
  assert.ok(r.latest.plugins.every((p) => p.accepts === true))
  assert.equal(r.latest.signature, 'unsigned')
  const fetch = calls.find((c) => c[0] === 'fetch')
  assert.ok(fetch.includes('https://github.com/nesteacold/dsh-mobile.git'))
  assert.ok(calls.find((c) => c[0] === 'tag').includes('origin/main'))
  assert.ok(!calls.some((c) => c[0] === 'merge'))
})

test('no tags', async () => {
  const u = createSelfUpdater({ git: fakeGit({ tags: [] }).git, dshVersion: '0.2.2-rc.3' })
  assert.equal((await u.check()).reason, 'no-tags')
  await assert.rejects(u.update(), { code: 'no-tags' })
})

test('clean + ff updates with merge --ff-only and reports restart', async () => {
  const { git, calls } = fakeGit({ changed: 'plugins/devices/package-lock.json\nREADME.md\n' })
  const npm = []
  const u = createSelfUpdater({ git, dshVersion: '0.2.2-rc.3', npmCi: async (dir) => { npm.push(dir); return { dir, ok: true, tail: 'added 0' } } })
  const r = await u.update('v0.10.0-rc.1')
  assert.equal(r.updated, true)
  assert.equal(r.message, 'Restart DSH to load v0.10.0-rc.1')
  assert.equal(r.previousHead, HEAD)
  assert.deepEqual(npm, ['plugins/devices'])
  assert.deepEqual(calls.find((c) => c[0] === 'merge'), ['merge', '--ff-only', 'v0.10.0-rc.1'])
  assert.equal(u.status().previousHead, HEAD)
})

test('dirty tree refused, no merge', async () => {
  const { git, calls } = fakeGit({ dirty: true })
  await assert.rejects(createSelfUpdater({ git, dshVersion: '0.2.2-rc.3' }).update(), { code: 'dirty' })
  assert.ok(!calls.some((c) => c[0] === 'merge'))
})

test('non-ff refused', async () => {
  const { git, calls } = fakeGit({ ff: false })
  await assert.rejects(createSelfUpdater({ git, dshVersion: '0.2.2-rc.3' }).update(), { code: 'not-ff' })
  assert.ok(!calls.some((c) => c[0] === 'merge'))
})

test('engines mismatch refused', async () => {
  const { git, calls } = fakeGit({ engines: '>=0.3.0 <0.4.0-0' })
  await assert.rejects(createSelfUpdater({ git, dshVersion: '0.2.2-rc.3' }).update(), { code: 'engines-mismatch' })
  assert.ok(!calls.some((c) => c[0] === 'merge'))
})

test('timeout surfaces as timeout (504 through the route)', async () => {
  const u = createSelfUpdater({ git: fakeGit({ hang: true }).git, dshVersion: '0.2.2-rc.3' })
  let sent
  const handled = await handleSelfUpdateRoute(u, ['devices', 'self-update', 'check'], { method: 'POST' },
    async () => ({}), (s, v) => { sent = [s, v] })
  assert.ok(handled)
  assert.equal(sent[0], 504)
  assert.equal(sent[1].error, 'timeout')
  assert.equal(u.status().busy, false)
})

test('concurrent check refused as busy', async () => {
  const u = createSelfUpdater({ git: fakeGit({ hang: true }).git, dshVersion: '0.2.2-rc.3' })
  const first = u.check().catch((e) => e)
  await assert.rejects(u.check(), { code: 'busy' })
  await assert.rejects(u.update(), { code: 'busy' })
  assert.equal((await first).code, 'timeout')
})

test('stale tag refused', async () => {
  const u = createSelfUpdater({ git: fakeGit().git, dshVersion: '0.2.2-rc.3' })
  await assert.rejects(u.update('v0.2.0'), { code: 'stale' })
})

for (const [label, engines] of [['absent', 'ABSENT'], ['empty', ''], ['null', null]]) {
  test(`engines.dsh ${label} at tag fails closed`, async () => {
    const { git, calls } = fakeGit({ engines })
    await assert.rejects(createSelfUpdater({ git, dshVersion: '0.2.2-rc.3' }).update(), { code: 'engines-mismatch' })
    assert.ok(!calls.some((c) => c[0] === 'merge'))
  })
}

test('unreadable package.json at tag fails closed', async () => {
  const { git: inner, calls } = fakeGit()
  const git = async (args) => (args[0] === 'show' && !args[1].startsWith('HEAD:') ? 'not json' : inner(args))
  await assert.rejects(createSelfUpdater({ git, dshVersion: '0.2.2-rc.3' }).update(), { code: 'engines-mismatch' })
  assert.ok(!calls.some((c) => c[0] === 'merge'))
})

test('npm ci not run when no lockfile changed', async () => {
  const { git } = fakeGit({ changed: 'README.md\nplugins/devices/lib/x.mjs\n' })
  const npm = []
  const r = await createSelfUpdater({ git, dshVersion: '0.2.2-rc.3', npmCi: async (d) => { npm.push(d) } }).update()
  assert.equal(r.updated, true)
  assert.deepEqual(npm, [])
  assert.deepEqual(r.npm, [])
})

test('HTTP guards: forwarded request and POST without Origin are 403', async () => {
  const { mountPlugin } = await import('./helpers.mjs')
  const { git, calls } = fakeGit()
  const mounted = await mountPlugin({ selfUpdateGit: git })
  try {
    const origin = 'http://127.0.0.1:3080'
    for (const h of [{ 'x-forwarded-for': '1.2.3.4' }, { forwarded: 'for=1.2.3.4' }, { 'tailscale-user-login': 'x' }, { host: 'box.tailnet.ts.net' }]) {
      for (const [m, u] of [['GET', '/devices/self-update'], ['POST', '/devices/self-update/check'], ['POST', '/devices/self-update/update'], ['GET', '/devices/remotes']]) {
        const a = await mounted.call(m, u, { body: {}, headers: { origin, ...h } })
        assert.equal(a.status, 403, `${m} ${u} ${JSON.stringify(h)}: ${a.text}`)
      }
    }
    for (const u of ['/devices/self-update/check', '/devices/self-update/update']) {
      const a = await mounted.call('POST', u, { body: {} })
      assert.equal(a.status, 403, a.text)
      assert.match(a.json.message, /Origin/)
    }
    assert.ok(!calls.some((c) => c[0] === 'fetch' || c[0] === 'merge'))
    const ok = await mounted.call('POST', '/devices/self-update/check', { body: {}, headers: { origin } })
    assert.equal(ok.status, 200, ok.text)
  } finally { mounted.close() }
})

test('route ignores other paths', async () => {
  const u = createSelfUpdater({ git: fakeGit().git })
  assert.equal(await handleSelfUpdateRoute(u, ['devices', 'remotes'], { method: 'GET' }, null, null), false)
})
