/**
 * Reviewer round 2: the runtime defects the fake used to mask. Every host points at a fake on
 * an ephemeral loopback port (the harness default), and nothing here reaches a browser.
 *
 * The page side runs the REAL snapshot script inside a VM document (`test/fixture-dom.mjs`),
 * so a made-up element number can no longer hide a numbering defect.
 */

import test from 'node:test'

import assert from 'node:assert/strict'
import { startFakeChrome } from './fake-chrome.mjs'
import { createHost, execOf } from './harness.mjs'
import { relayHost, relayOf, callRelay } from './relay-route.test.mjs'
import { documentOf, frameDocument } from './fixture-dom.mjs'
import { __internals } from '../lib/index.js'
import * as cdpClient from '../lib/cdp-client.js'

/** A bound host over one fake Chrome, with the client kept for inspection. */
async function fixture (t, { frameUrls = [], childFrames = [], unreadableFrames = [], targets } = {}) {
  const fake = await startFakeChrome({
    targets: targets ?? [{ id: 'T1', title: 'Example', url: 'https://example.com/' }],
    frameUrls,
    childFrames,
    unreadableFrames,
  })
  const host = relayHost({ config: { endpoint: fake.url } })
  const run = (name, args = {}, sessionId = 'session-1') => host.tools.get(name).execute(args, execOf(name, args, { sessionId }))
  const cdp = host.applied.state.cdp
  // One teardown for this fixture: every socket, server and timer it opened closes with it, so
  // the runner can exit once the last test finished (the sidebar's connection included). The
  // fake closes once here, so a test's own `t.after(() => fake.close())` only has to wait.
  t.after(async () => {
    cdp.dispose()
    await fake.close()
    await settle(60)
  })
  await run('chrome_open', { targetId: 'T1' })
  await cdp.page('T1', { sessionId: 'session-1' })
  return { fake, host, run, cdp }
}

const pageCalls = (fake) => fake.state.T1 ?? []
const settle = async (ms = 40) => { await new Promise((done) => setTimeout(done, ms)) }

// --- item 1: frame-local numbers -------------------------------------------------

test('item 1: top and child both print local 1; each page number resolves with its frame-local number', async (t) => {
  const { fake, run } = await fixture(t, { childFrames: [{ id: 'C1', url: 'https://child.example/' }] })
  t.after(() => fake.close())
  // The production script runs per document: both documents number their own element 1. The
  // router is told which frame's world the read ran in, so it never has to guess a context id.
  const child = frameDocument('C1', [{ tag: 'button', text: 'Child' }])
  fake.state.document = (contextId, frame) => (frame?.frameId === 'C1' ? child : frameDocument('top', [{ tag: 'a', href: '/top', text: 'Top' }]))
  const snapshot = await run('chrome_snapshot')
  assert.match(snapshot, /\[1\] a "Top"/)
  assert.match(snapshot, /\[2\] button "Child"/)
  // The click on page number 2 is looked up with the child's LOCAL number 1, in the child's
  // world, reading the document the snapshot script wrote it in.
  const text = await run('chrome_click', { index: 2 })
  assert.match(text, /<button> "Child"/)
  // The element lookup is the expression that names the frame-local attribute.
  const read = fake.state.evaluations.filter((entry) => String(entry.expression).includes('data-chrome-cdp-index=')).at(-1)
  assert.equal(read.contextId, 2, 'resolved in the child\u2019s world')
  assert.match(read.expression, /data-chrome-cdp-index="1"/, 'the lookup uses the frame-local number, never the page number')
})

test('item 1: the session\u2019s snapshot records the location and the frame-local number of every element', async (t) => {
  const { fake, cdp } = await fixture(t, { childFrames: [{ id: 'C1', url: 'https://child.example/' }] })
  t.after(() => fake.close())
  // Keyed by frame, not by context id: which ids the worlds get is the fake's own bookkeeping.
  fake.state.document = (contextId, frame) => (frame?.frameId === 'C1'
    ? frameDocument('C1', [{ tag: 'button', text: 'Child' }, { tag: 'input', attrs: { type: 'text', placeholder: 'q' } }])
    : frameDocument('top', [{ tag: 'a', href: '/top', text: 'Top' }]))
  const page = await cdp.page('T1', { sessionId: 'session-1' })
  await cdp.snapshot(page, { sessionId: 'session-1' })
  const snap = cdp.currentSnapshot(page, { sessionId: 'session-1' })
  assert.deepEqual({ ...snap.index.get(1) }.localIndex, 1)
  assert.deepEqual({ ...snap.index.get(2) }.localIndex, 1, 'the child\u2019s first element is local 1')
  assert.deepEqual({ ...snap.index.get(3) }.localIndex, 2)
  assert.equal(snap.index.get(2).contextId, 2)
  assert.equal(snap.index.get(2).sessionId, 'session-1', 'the number remembers the session that took it')
  assert.equal(snap.index.get(2).frame.sessionId, null, 'and the session the document is read in')
  assert.equal(snap.sessionId, 'session-1')
  // Another session has no numbers for this tab: its map is its own, never session-1's.
  assert.throws(() => cdp.currentSnapshot(page, { sessionId: 'session-2' }), /stale snapshot/)
})

// --- item 2: OOPIF worlds use the target's real root frame ----------------------

test('item 2: an OOPIF world is created with the target\u2019s own root frame id, from its own frame tree', async (t) => {
  const { fake, run } = await fixture(t, { frameUrls: ['https://oopif.example/'] })
  t.after(() => fake.close())
  await run('chrome_snapshot')
  // Chrome refuses a world without a frame id, and the fake now refuses it too.
  assert.deepEqual(fake.state.badWorldCalls, [])
  const oopifWorld = fake.state.worldCalls.find((call) => call.sessionId === 'S1')
  assert.equal(oopifWorld.frameId, 'frame-S1', 'the OOPIF target\u2019s own root frame, not a guess')
  // The OOPIF's frame tree was read on its own session, before the world.
  const oopifTree = pageCalls(fake).filter((call) => call.method === 'Page.getFrameTree')
  assert.ok(oopifTree.length >= 1, 'the target\u2019s tree is read')
})

test('item 2: an unreadable frame stays in the results as unreadable, never silently dropped', async (t) => {
  const { fake, run } = await fixture(t, { childFrames: [{ id: 'C1', url: 'https://child.example/' }], unreadableFrames: ['C1'] })
  t.after(() => fake.close())
  // Every frame holds the same document here; the click below never happens.
  fake.state.document = () => documentOf([{ tag: 'a', href: '/', text: 'Home' }], 'https://example.com/')
  const text = await run('chrome_snapshot')
  assert.match(text, /\[frame\] deep frame https:\/\/child\.example\/: not readable \(Chrome gave this frame no isolated world/)
  assert.match(text, /\[1\] a "Home"/, 'the readable document is still listed')
  assert.match(text, /in 2 frame\(s\)/, 'the unreadable frame is counted, not dropped')
})

test('item 2: the fake refuses a world call without its required frameId', async (t) => {
  const { fake, cdp } = await fixture(t)
  t.after(() => fake.close())
  const page = cdp.pages.get('T1')
  await assert.rejects(() => page.connection.send('Page.createIsolatedWorld', { worldName: 'x' }), /required property frameId is missing/)
  assert.equal(fake.state.badWorldCalls.length, 1)
})

// --- item 3: selections per session, exclusion by lease only --------------------

test('item 3: selecting a tab for one session never deletes another session\u2019s selection', async (t) => {
  const { cdp } = await fixture(t)
  t.after(() => {})
  cdp.bind('session-a', 'T1', 'https://example.com/')
  cdp.bind('session-b', 'T2', 'https://other.example/')
  cdp.bind('session-b', 'T1', 'https://example.com/')
  assert.equal(cdp.bindingFor('session-a')?.targetId, 'T1', 'A\u2019s selection survives B selecting the same tab')
  assert.equal(cdp.bindingFor('session-b')?.targetId, 'T1')
  cdp.unbind('session-b')
  assert.equal(cdp.bindingFor('session-a')?.targetId, 'T1', 'B unbinding does not touch A')
})

test('item 3: only an ACTIVE lease excludes, and after it lapses the sidebar and an agent share the connection', async (t) => {
  const { fake, cdp, host, run } = await fixture(t)
  t.after(() => fake.close())
  const secret = host.bridgeSecret()
  const shot = relayOf(host.registrations, 'shot')
  // The agent acts: its lease is active, so the sidebar is refused under the same rule.
  cdp.lease('session-1', 'T1')
  const refused = await callRelay(shot, { secret, body: { targetId: 'T1' } })
  assert.equal(refused.body.ok, false)
  assert.match(refused.body.error, /tab in use by another session/)
  // 60 s later the lease is gone: the sidebar gets the SAME live connection and agent A keeps
  // its selection, then the agent acts again and keeps using the connection too.
  cdp.leases.get('T1').at = Date.now() - 61_000
  const answer = await callRelay(shot, { secret, body: { targetId: 'T1' } })
  assert.equal(answer.body.ok, true, JSON.stringify(answer.body))
  assert.equal(cdp.bindingFor('session-1')?.targetId, 'T1', 'the agent\u2019s selection is untouched')
  assert.equal(cdp.pages.size, 1, 'one live connection is shared, never replaced')
  await run('chrome_snapshot')
  assert.equal(cdp.pages.size, 1)
})

test('item 3: the sidebar screenshot renews the view\u2019s lease and never locks agents out forever', async (t) => {
  const { fake, cdp, host } = await fixture(t)
  t.after(() => fake.close())
  const secret = host.bridgeSecret()
  const shot = relayOf(host.registrations, 'shot')
  const first = await callRelay(shot, { secret, body: { targetId: 'T1' } })
  assert.equal(first.body.ok, true)
  assert.equal(cdp.isLeasedBy('chrome-sidebar', 'T1'), true, 'the view holds its lease while it polls')
  // The 60 s idle window ends: the tab is free, and an agent acts on it without any release.
  cdp.leases.get('T1').at = Date.now() - 61_000
  assert.equal(cdp.isLeasedBy('chrome-sidebar', 'T1'), false, 'after the idle window the tab is free')
  cdp.bind('session-1', 'T1', 'https://example.com/')
  assert.doesNotThrow(() => cdp.lease('session-1', 'T1'))
  assert.equal(cdp.isLeasedBy('session-1', 'T1'), true)
  // The view stops polling: its lease lapses on its own even if it never returns.
  cdp.leases.get('T1').at = Date.now() - 61_000
  assert.equal(cdp.isLeasedBy('session-1', 'T1'), false)
  assert.equal((await callRelay(shot, { secret, body: { targetId: 'T1' } })).body.ok, true, 'the view comes back after the idle window')
})

// --- item 4: real gestures ------------------------------------------------------

test('item 4: a mousedown is a press only; move and up arrive in order and only up releases', async (t) => {
  const { fake, host } = await fixture(t)
  t.after(() => fake.close())
  const secret = host.bridgeSecret()
  const route = relayOf(host.registrations, 'input')
  const send = (data) => callRelay(route, { secret, body: { targetId: 'T1', op: 'mouse', data } })
  const mouse = () => pageCalls(fake).filter((call) => call.method === 'Input.dispatchMouseEvent').map((call) => call.params)

  await send({ type: 'mousePressed', x: 4, y: 5, button: 'left', buttons: 1, modifiers: 2 })
  assert.deepEqual(mouse().map((params) => params.type), ['mousePressed'], 'a press is not turned into a click')
  // Each move is the owner's movement: the newest one replaces whatever is still in the single
  // slot, and the page sees only what was sent.
  // Each move is delivered before its request returns, so the page has seen it by now.
  await send({ type: 'mouseMoved', x: 20, y: 21, buttons: 1, modifiers: 2 })
  await send({ type: 'mouseReleased', x: 20, y: 21, button: 'left', buttons: 0, modifiers: 2 })
  await settle()
  const seen = mouse()
  const moves = seen.filter((params) => params.type === 'mouseMoved')
  assert.ok(moves.length >= 1, 'the pointer movement reached the page')
  assert.deepEqual({ x: moves.at(-1).x, y: moves.at(-1).y }, { x: 20, y: 21 }, 'the newest position arrives')
  assert.equal(moves.at(-1).buttons, 1, 'the move keeps the held button')
  assert.equal(seen.at(-1).type, 'mouseReleased', 'the release comes after the moves')
  assert.equal(seen.at(-1).buttons, 0)
  assert.deepEqual({ x: seen.at(-1).x, y: seen.at(-1).y }, { x: 20, y: 21 })
})

test('item 4: the pending move slot is one, and a burst coalesces to the newest position', async (t) => {
  const { fake, host } = await fixture(t)
  t.after(() => fake.close())
  const secret = host.bridgeSecret()
  const route = relayOf(host.registrations, 'input')
  const moves = () => pageCalls(fake).filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseMoved').map((call) => call.params)
  // A burst of twelve concurrent moves: one send is in flight and the single slot keeps only
  // the newest, so a burst never becomes one send per request.
  await Promise.all(Array.from({ length: 12 }, (_, i) => callRelay(route, { secret, body: { targetId: 'T1', op: 'mouse', data: { type: 'mouseMoved', x: i, y: i, buttons: 0 } } })))
  await settle(80)
  const seen = moves()
  assert.ok(seen.length >= 1 && seen.length <= 4, `a burst of 12 never becomes 12 sends, saw ${seen.length}`)
  assert.ok(seen.at(-1).x >= 9, `the newest positions win, saw x=${seen.at(-1).x}`)
})

test('item 4: a leave releases only what the view actually pressed', async (t) => {
  const { fake, host } = await fixture(t)
  t.after(() => fake.close())
  const secret = host.bridgeSecret()
  const route = relayOf(host.registrations, 'input')
  const send = (data) => callRelay(route, { secret, body: { targetId: 'T1', op: 'mouse', data } })
  const mouse = () => pageCalls(fake).filter((call) => call.method === 'Input.dispatchMouseEvent').map((call) => call.params)
  // A leave with nothing held sends nothing: no press/release pair is invented.
  await callRelay(route, { secret, body: { targetId: 'T1', op: 'cancel', data: { x: 0, y: 0 } } })
  await settle()
  assert.deepEqual(mouse(), [])
  await send({ type: 'mousePressed', x: 8, y: 9, button: 'left', buttons: 1 })
  await callRelay(route, { secret, body: { targetId: 'T1', op: 'cancel', data: { x: 0, y: 0 } } })
  await settle()
  const seen = mouse()
  assert.equal(seen.at(-1).type, 'mouseReleased')
  assert.deepEqual({ x: seen.at(-1).x, y: seen.at(-1).y }, { x: 8, y: 9 })
  assert.equal(seen.at(-1).buttons, 0)
})

test('item 4: sidebar input and navigation act under the same lease rule as an agent', async (t) => {
  const { fake, cdp, host } = await fixture(t)
  t.after(() => fake.close())
  const secret = host.bridgeSecret()
  const input = relayOf(host.registrations, 'input')
  cdp.bind('session-a', 'T1', 'https://example.com/')
  cdp.lease('session-a', 'T1')
  const refused = await callRelay(input, { secret, body: { targetId: 'T1', op: 'key', data: { key: 'a' } } })
  assert.equal(refused.body.ok, false)
  assert.match(refused.body.error, /tab in use by another session/)
  cdp.release('session-a', 'T1')
  const accepted = await callRelay(input, { secret, body: { targetId: 'T1', op: 'key', data: { key: 'a' } } })
  assert.equal(accepted.body.ok, true)
  assert.equal(cdp.isLeasedBy('chrome-sidebar', 'T1'), true, 'the view\u2019s own lease starts on its first event')
})

// --- item 5: the Host merges, the page does not recurse -------------------------

test('item 5: the page script is one document\u2019s read, with no page-side frame bridge', async (t) => {
  const { fake, run } = await fixture(t, { childFrames: [{ id: 'C1', url: 'https://child.example/' }] })
  t.after(() => fake.close())
  fake.state.document = () => documentOf([{ tag: 'a', href: '/', text: 'Home' }], 'https://example.com/')
  await run('chrome_snapshot')
  const reads = fake.state.evaluations.filter((entry) => String(entry.expression).includes('function'))
  assert.equal(reads.length, 2, 'one read per document, merged on the Host')
  for (const read of reads) {
    assert.doesNotMatch(read.expression, /this\.evaluate|send\s*\(|"children"|frameId/, 'no page-side recursion')
  }
})

test('item 5: the test-process guard is the client transport, and global fetch is left alone', async () => {
  const real = globalThis.fetch
  const host = createHost()
  // The plugin wraps only the transport it hands its client: `globalThis.fetch` is the same
  // function before and after, and no process-wide flag is left behind.
  assert.equal(globalThis.fetch, real, 'building a host installs no process-wide override')
  assert.equal(globalThis.__dshChromeCdpFetchGuard, undefined, 'no process-wide guard flag is installed')
  // Asked to guard the platform transport in a test process, the plugin returns a wrapper that
  // refuses the owner's port before any socket opens.
  const transport = () => {
    const error = new Error('reached')
    error.reached = true
    throw error
  }
  const guarded = __internals.installOwnerPortGuard(transport, { NODE_TEST_CONTEXT: 'child-v8' })
  assert.notEqual(guarded, transport, 'a test-process transport is wrapped')
  await assert.rejects(() => guarded('http://127.0.0.1:40222/json/list'), /port 40222/)
  void host
  assert.equal(__internals.installOwnerPortGuard(transport, {}) === transport, true, 'a normal Host transport is unchanged')
})
