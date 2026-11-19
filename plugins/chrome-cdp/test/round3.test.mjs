/**
 * Reviewer round 3, items 3 and 4.
 *
 * Item 3: a snapshot belongs to the session that took it. Session B reading the tab after A
 * must never change what a number means for A; a number outside the caller's own snapshot is
 * refused as stale, and a click never takes a read of its own for it.
 *
 * Item 4: a forwarded pointer move or wheel carries the modifier keys the view reported.
 */

import test from 'node:test'

import assert from 'node:assert/strict'
import { startFakeChrome } from './fake-chrome.mjs'
import { execOf } from './harness.mjs'
import { relayHost, relayOf, callRelay } from './relay-route.test.mjs'

/** A bound host over one fake Chrome, with the client and its page kept for inspection. */
async function fixture (t) {
  const fake = await startFakeChrome({ targets: [{ id: 'T1', title: 'Example', url: 'https://example.com/' }] })
  const host = relayHost({ config: { endpoint: fake.url } })
  const run = (name, args = {}, sessionId = 'session-1') => host.tools.get(name).execute(args, execOf(name, args, { sessionId }))
  const cdp = host.applied.state.cdp
  t.after(async () => { cdp.dispose(); await fake.close() })
  await run('chrome_open', { targetId: 'T1' }, 'session-a')
  await run('chrome_open', { targetId: 'T1' }, 'session-1')
  await run('chrome_snapshot', {}, 'session-1')
  const page = cdp.pages.get('T1')
  return { fake, host, run, cdp, page }
}

/** A page-side answer: one document, one button with the given label and rect. */
const oneButton = (label, x, y) => (expression) => (expression.includes('function')
  ? { title: 't', url: 'https://example.com/', viewport: { w: 10, h: 10 }, elements: [{ index: 1, tag: 'button', label }] }
  : { x, y, tag: 'button', text: label })

const settle = async (ms = 60) => { await new Promise((done) => setTimeout(done, ms)) }

// --- item 3: a snapshot belongs to its session ---------------------------------

test('item 3: B\u2019s snapshot after A\u2019s never changes A\u2019s numbers', async (t) => {
  const { fake, cdp, page } = await fixture(t)
  // A reads the page: number 1 is "Pay". B reads it again with different content.
  fake.state.expressionAnswer = oneButton('Pay', 40, 20)
  await cdp.snapshot(page, { sessionId: 'session-a' })
  fake.state.expressionAnswer = oneButton('Delete', 5, 5)
  await cdp.snapshot(page, { sessionId: 'session-b' })
  // The element lookup answers for A: "Pay" is still what A's number 1 points at.
  fake.state.expressionAnswer = () => ({ x: 40, y: 20, tag: 'button', text: 'Pay' })
  // Each session's map is its own, and both still hold their own number 1.
  const a = cdp.currentSnapshot(page, { sessionId: 'session-a' })
  const b = cdp.currentSnapshot(page, { sessionId: 'session-b' })
  assert.notEqual(a, b, 'two sessions never share one snapshot map')
  assert.equal(a.index.get(1).localIndex, 1)
  assert.equal(b.index.get(1).localIndex, 1)
  // A's click resolves against A's map: it reads "Pay", not the number B printed later.
  const hit = await cdp.click(page, 1, { task: { sessionId: 'session-a' } })
  assert.equal(hit.text, 'Pay')
})

test('item 3: a number outside the caller\u2019s snapshot is refused as stale, never re-read', async (t) => {
  const { fake, cdp, page } = await fixture(t)
  // Only session-b has a snapshot with a number later than the one session-1 took.
  fake.state.expressionAnswer = oneButton('Pay', 4, 4)
  await cdp.snapshot(page, { sessionId: 'session-b' })
  page.snapshots.delete('session-1')
  const reads = fake.state.evaluations.length
  await assert.rejects(() => cdp.click(page, 1, { task: { sessionId: 'session-1' } }), /stale snapshot: this session has no chrome_snapshot/)
  assert.equal(fake.state.evaluations.length, reads, 'the refusal took no snapshot of its own')
  // Session-b's own snapshot still resolves.
  const hit = await cdp.click(page, 1, { task: { sessionId: 'session-b' } })
  assert.equal(hit.text, 'Pay')
})

test('item 3: a generation the caller quotes must match its current snapshot', async (t) => {
  const { fake, cdp, page } = await fixture(t)
  fake.state.expressionAnswer = oneButton('x', 1, 1)
  const first = await cdp.snapshot(page, { sessionId: 'session-a' })
  await cdp.snapshot(page, { sessionId: 'session-a' })
  // The same session, quoting the generation of a snapshot it has since replaced.
  const stale = () => cdp.currentSnapshot(page, { sessionId: 'session-a', generation: first.generation })
  let error
  try {
    stale()
  } catch (thrown) {
    error = thrown
  }
  assert.match(String(error?.message), /stale snapshot: the numbers came from snapshot/)
})

test('item 3: a navigation after the snapshot makes the numbers stale', async (t) => {
  const { fake, cdp, page } = await fixture(t)
  fake.state.expressionAnswer = oneButton('x', 1, 1)
  await cdp.snapshot(page, { sessionId: 'session-a' })
  page.document += 1 // what a Page.frameNavigated on the top document does
  await assert.rejects(() => cdp.resolveElement(page, 1, { task: { sessionId: 'session-a' } }), /stale snapshot: the page navigated/)
})

// --- round 4 item 1: chrome_fill resolves the calling session's map ---------------

test('round 4 item 1: B\u2019s fill on a connection A opened resolves B\u2019s snapshot', async (t) => {
  const { fake, run, cdp } = await fixture(t)
  const page = cdp.pages.get('T1')
  // Rewind the fixture's ownership to the order this finding is about: A opens the connection.
  page.owner = 'session-a'
  // A and B take their own snapshot of the same tab.
  fake.state.expressionAnswer = oneButton('From A', 11, 12)
  await cdp.snapshot(page, { sessionId: 'session-a' })
  fake.state.expressionAnswer = oneButton('From B', 21, 22)
  await cdp.snapshot(page, { sessionId: 'session-b' })
  await run('chrome_open', { targetId: 'T1' }, 'session-b')
  // Each session's number 1 is a different element at a different rect. With B's task carried
  // through, the fill's lookup, focus click and typing are all B's.
  const typed = await run('chrome_fill', { index: 1, text: 'hello' }, 'session-b')
  assert.match(typed, /5 char\(s\) into element \[1\]: <button> "From B"/)
  const pressed = (fake.state.T1 ?? []).filter((call) => call.params && call.params.type === 'mousePressed')
  assert.equal(pressed.length, 1, 'one fill is one focus click')
  assert.deepEqual({ x: pressed[0].params.x, y: pressed[0].params.y }, { x: 21, y: 22 }, 'B\u2019s rect, not the connection owner\u2019s')
  assert.equal((fake.state.T1 ?? []).filter((call) => call.method === 'Input.insertText').length, 1)
  // A's own map is still A's, and B's number 1 resolved against B's rect above, not A's.
  assert.equal(cdp.currentSnapshot(page, { sessionId: 'session-a' }).index.size, 1)
  // A session with no map of its own is refused rather than answered with A's numbers.
  try {
    await cdp.fill(page, 1, 'x', { task: { sessionId: 'chrome-sidebar' } })
    assert.fail('a session without a snapshot of the tab must be refused')
  } catch (error) {
    assert.match(String(error?.message), /stale snapshot: this session has no chrome_snapshot/)
  }
})

// --- item 4: modifiers on moves and wheel --------------------------------------

test('item 4: a forwarded move and wheel carry the validated modifiers', async (t) => {
  const { fake, host, cdp } = await fixture(t)
  cdp.dispose()
  const secret = host.bridgeSecret()
  const route = relayOf(host.registrations, 'input')
  // Ctrl+Shift on a move, Alt on a wheel; the view reports them the way a browser does.
  await callRelay(route, { secret, body: { targetId: 'T1', op: 'mouse', data: { type: 'mouseMoved', x: 5, y: 6, buttons: 0, modifiers: 10 } } })
  await settle()
  await callRelay(route, { secret, body: { targetId: 'T1', op: 'mouse', data: { type: 'mouseWheel', x: 7, y: 8, deltaX: 0, deltaY: 120, modifiers: 1 } } })
  await settle()
  const moves = (fake.state.T1 ?? []).filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseMoved')
  const wheels = (fake.state.T1 ?? []).filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseWheel')
  assert.ok(moves.length >= 1, 'the move reached the page')
  assert.equal(moves.at(-1).params.modifiers, 10, 'the move carries its modifier bits')
  assert.ok(wheels.length >= 1, 'the wheel reached the page')
  assert.equal(wheels.at(-1).params.modifiers, 1, 'the wheel carries its modifier bits')
})
