// Spec 027: self-update with a fake git runner (no real git, no network).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSelfUpdater, satisfies, compareSemver, SelfUpdateError, handleSelfUpdateRoute, TAG_REF_PREFIX } from '../lib/self-update.mjs'

const HEAD = 'a'.repeat(40)
const TAGC = 'b'.repeat(40)
const ALLOWED = new Set(['fetch', 'for-each-ref', 'log', 'merge-base', 'status', 'merge', 'show', 'verify-tag'])
const MAIN_REF = 'refs/remotes/origin/main'

function fakeGit({ tags = ['v0.1.0', 'v0.2.0', 'v0.10.0-rc.1', 'nope'], dirty = false, ff = true,
  engines = '>=0.2.2-rc.3 <0.3.0-0', hang = false, changed = '' } = {}) {
  const calls = []
  const git = async (args) => {
    calls.push(args)
    assert.ok(ALLOWED.has(args[0]), `forbidden git ${args[0]}`)
    if (args[0] === 'merge') assert.deepEqual(args.slice(0, 2), ['merge', '--ff-only'])
    if (args[0] === 'fetch') {
      // This checkout already holds an old v0.4.3 tag. A `--tags` fetch of the
      // force-moved upstream tag is rejected with exactly the owner's error.
      if (args.includes('--tags')) throw new SelfUpdateError('git-failed',
        'git fetch failed: ! [rejected] v0.4.3 -> v0.4.3 (would clobber existing tag)')
      // Git follows advertised tags by default; only --no-tags keeps every fetched
      // ref inside our private remote-tracking namespace.
      assert.ok(args.includes('--no-tags'), 'automatic local tag following is still on')
      assert.ok(args.includes('--no-prune-tags'), 'owner fetch.pruneTags=true must not prune local tags')
      assert.ok(args.includes('--prune'), 'deleted upstream release tags must leave the private namespace')
      assert.ok(args.includes(`+refs/heads/main:${MAIN_REF}`), 'main refspec missing')
      assert.ok(args.includes(`+refs/tags/v*:${TAG_REF_PREFIX}/v*`), 'private tag refspec missing')
      if (hang) {
        await new Promise((r) => setTimeout(r, 20))
        throw new SelfUpdateError('timeout', 'git fetch failed (timeout)')
      }
    }
    switch (args[0]) {
      case 'status':
        return args.includes('--branch') ? '# branch.head main\n' : (dirty ? ' M plugins/devices/lib/x.mjs\n' : '')
      case 'log':
        if (args[1] === '-1') return args[3] === 'HEAD' ? HEAD : TAGC
        if (args[1] === '--format=') return changed
        return 'b1 feat: one\nb2 fix: two\n'
      case 'for-each-ref':
        assert.ok(args.includes(`--merged=${MAIN_REF}`), 'candidates must be merged into origin/main')
        return tags.map((t) => `${TAG_REF_PREFIX}/${t}`).join('\n')
      case 'show': {
        const tagRef = args[1].startsWith(`${TAG_REF_PREFIX}/`)
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
  assert.ok(!fetch.includes('--tags'), 'fetch must not write local tags')
  assert.ok(calls.find((c) => c[0] === 'for-each-ref').includes(`${TAG_REF_PREFIX}/v*`))
  assert.equal(r.latest.commit, TAGC)
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
  assert.deepEqual(calls.find((c) => c[0] === 'merge'), ['merge', '--ff-only', `${TAG_REF_PREFIX}/v0.10.0-rc.1`])
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

test('a force-moved remote tag is fetched without clobbering local tags', async () => {
  // The fake fetch rejects `--tags` with the owner's exact "would clobber
  // existing tag" error. Only the private refspec can complete this check.
  const { git, calls } = fakeGit({ tags: ['v0.4.3'] })
  const u = createSelfUpdater({ git, dshVersion: '0.2.2-rc.3' })
  const r = await u.check()
  assert.equal(r.latest.tag, 'v0.4.3')
  assert.equal(r.latest.commit, TAGC)
  const ref = `${TAG_REF_PREFIX}/v0.4.3`
  const reads = calls.filter((c) => ['log', 'show', 'merge-base', 'verify-tag'].includes(c[0]))
  assert.ok(reads.some((c) => c.some((a) => typeof a === 'string' && a.includes(ref))),
    'reads resolve the private ref')
  assert.ok(!reads.some((c) => c.some((a) => a === 'v0.4.3' || a.startsWith('v0.4.3:'))),
    'no read uses a bare local tag')
  assert.ok(!calls.some((c) => c[0] === 'fetch' && c.includes('--tags')))
})

test('signature verification checks the fetched tag ref, not a local tag', async () => {
  const { git, calls } = fakeGit()
  const u = createSelfUpdater({ git, dshVersion: '0.2.2-rc.3', verifySignatures: true })
  const r = await u.check()
  assert.equal(r.latest.signature, 'verified')
  assert.deepEqual(calls.find((c) => c[0] === 'verify-tag'), ['verify-tag', `${TAG_REF_PREFIX}/v0.10.0-rc.1`])
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

// The desktop shell serves the page as `dsh-app://app` and forwards its requests to
// the Host after deleting `origin` (and `sec-fetch-site`), so the Host sees no Origin
// at all. Spec 027 therefore lets the two self-update POSTs through only when the
// client's own marker and a JSON body travel with them, and keeps every present
// Origin on the original same-origin rule.
const MARKER = { 'x-dsh-devices-request': 'self-update' }
const JSON_TYPE = 'application/json'

test('absent Origin is accepted for the two self-update POSTs only with the client marker + JSON', async () => {
  const { mountPlugin } = await import('./helpers.mjs')
  const { git, calls } = fakeGit()
  const mounted = await mountPlugin({ selfUpdateGit: git })
  try {
    // The exact request lib/client.js makes: no Origin, our marker, a JSON body.
    // What proves the guard let it through is that the ROUTE answered: `check` says
    // 200, and `update` answers with one of its own verdicts (its fake checkout is
    // dirty / cannot name the running DSH), never the guard's 403 `forbidden`.
    const check = await mounted.call('POST', '/devices/self-update/check', { body: {}, headers: { ...MARKER, 'content-type': JSON_TYPE } })
    assert.equal(check.status, 200, check.text)
    const update = await mounted.call('POST', '/devices/self-update/update', { body: {}, headers: { ...MARKER, 'content-type': JSON_TYPE } })
    assert.notEqual(update.status, 403, `update: ${update.text}`)
    assert.notEqual(update.json.error, 'forbidden', `update: ${update.text}`)
    // The update reached the updater's own gates: a check ran.
    assert.ok(calls.some((c) => c[0] === 'fetch'), 'the route ran a check')
    // Without the marker, with the wrong value, or with a non-JSON body: 403, and
    // nothing was run.
    const before = calls.length
    for (const [u, headers] of [
      ['/devices/self-update/check', { 'content-type': JSON_TYPE }],
      ['/devices/self-update/update', { 'content-type': JSON_TYPE }],
      ['/devices/self-update/check', { ...MARKER, 'x-dsh-devices-request': 'other', 'content-type': JSON_TYPE }],
      ['/devices/self-update/update', { ...MARKER, 'x-dsh-devices-request': 'other', 'content-type': JSON_TYPE }],
      ['/devices/self-update/check', { ...MARKER, 'content-type': 'text/plain' }],
      ['/devices/self-update/update', { ...MARKER, 'content-type': 'text/plain' }],
      ['/devices/self-update/check', { ...MARKER }],
      ['/devices/self-update/update', { ...MARKER }],
    ]) {
      const a = await mounted.call('POST', u, { body: {}, headers })
      assert.equal(a.status, 403, `${u} ${JSON.stringify(headers)}: ${a.text}`)
      assert.match(a.json.message, /Origin/)
    }
    assert.equal(calls.length, before, 'a refused request ran no git')
    // A present Origin is judged exactly as before — cross-site, `null` and a
    // mismatched authority stay refused even with the marker and a JSON body.
    for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:9999', 'http://localhost:3080', '::bad']) {
      for (const u of ['/devices/self-update/check', '/devices/self-update/update']) {
        const a = await mounted.call('POST', u, { body: {}, headers: { origin, ...MARKER, 'content-type': JSON_TYPE } })
        assert.equal(a.status, 403, `${origin} ${u}: ${a.text}`)
      }
    }
    // The marker opens nothing else. The other /devices routes keep their own
    // rule unchanged: an absent Origin is same-origin there (only these two writes
    // ever demanded one), while a cross-site `null` is still refused with the marker.
    const nulled = await mounted.call('POST', '/devices/remotes', { body: {}, headers: { origin: 'null', ...MARKER, 'content-type': JSON_TYPE } })
    assert.equal(nulled.status, 403, `POST /devices/remotes origin null: ${nulled.text}`)
    assert.match(nulled.json.message, /cross-origin/)
    // The read stays as it was: a GET needs no Origin (that rule is unchanged).
    assert.equal((await mounted.call('GET', '/devices/self-update')).status, 200)
  } finally { mounted.close() }
})

test('a cross-site origin never gets a permissive CORS answer, and OPTIONS is not granted', async () => {
  const { mountPlugin } = await import('./helpers.mjs')
  const { git } = fakeGit()
  const mounted = await mountPlugin({ selfUpdateGit: git })
  try {
    for (const [method, url] of [['OPTIONS', '/devices/self-update/check'], ['OPTIONS', '/devices/self-update/update'],
      ['OPTIONS', '/devices/self-update'], ['POST', '/devices/self-update/check'], ['POST', '/devices/self-update/update']]) {
      const a = await mounted.call(method, url, { method, body: {}, headers: { origin: 'https://evil.example',
        'access-control-request-method': 'POST' } })
      assert.equal(a.status, 403, `${method} ${url}: ${a.text}`)
      // A preflight is answered only by a 2xx with `Access-Control-Allow-*`; a 403
      // without them fails the preflight and the browser never sends the POST.
      assert.ok(!Object.keys(a.headers ?? {}).some((name) => name.toLowerCase().startsWith('access-control-')),
        `${method} ${url} answered ${JSON.stringify(a.headers)}`)
    }
    // Even the answer a same-origin request gets carries no CORS grant.
    const same = await mounted.call('POST', '/devices/self-update/check', { body: {}, headers: { origin: 'http://127.0.0.1:3080' } })
    assert.equal(same.status, 200)
    assert.ok(!Object.keys(same.headers).some((name) => name.toLowerCase().startsWith('access-control-')))
  } finally { mounted.close() }
})

test('route ignores other paths', async () => {
  const u = createSelfUpdater({ git: fakeGit().git })
  assert.equal(await handleSelfUpdateRoute(u, ['devices', 'remotes'], { method: 'GET' }, null, null), false)
})
