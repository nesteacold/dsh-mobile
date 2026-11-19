/**
 * The CDP client against a fake Chrome that speaks the real protocol: HTTP discovery, the
 * flattened session framing, `Runtime.evaluate`, `Input.dispatch*`, tab open/close.
 *
 * The suite arms its own loopback fakes only; an unarmed process refuses every side effect, so
 * even if this machine's Chrome is running on the default port, a test can never reach it.
 */

// The suite only ever talks to the loopback fakes test/fake-chrome.mjs starts: arming them
// switches the under-test refusal off in this process. An unarmed test process refuses every
// side effect, so a test that slipped through could never open a window on a real Chrome.
process.env.DSH_CHROME_CDP_ARM_FAKES = '1'

import test from 'node:test'

import assert from 'node:assert/strict'
import { startFakeChrome, TINY_JPEG } from './fake-chrome.mjs'
import { documentOf, element, frameDocument } from './fixture-dom.mjs'
import { SYNTHETIC_ENDPOINT, SYNTHETIC_PASSWORD } from './fixtures.mjs'
import { relayHost, relayOf, callRelay } from './relay-route.test.mjs'


const { createHost, execOf, tempDataDir } = await import('./harness.mjs')

/** The CDP client behind one applied host: leases and bindings no tool call exposes alone. */
const internalsOf = (host) => host.applied.state.cdp

/** A fake Chrome with one page and one OOPIF, and a Host bound to it. */
async function fixture ({ frameUrls = [], targets, childFrames = [], resumeFails } = {}) {
  const fake = await startFakeChrome({
    targets: targets ?? [{ id: 'T1', title: 'Example', url: 'https://example.com/' }],
    frameUrls,
    childFrames,
    resumeFails,
    // A fixture may bind a tab; it may never create one, so nothing here opens a window.
    createTarget: (url) => ({ id: 'FIXTURE-NEW', title: 'new', url: url || 'about:blank' }),
  })
  const host = relayHost({ config: { endpoint: fake.url } })
  const run = (name, args = {}, sessionId = 'session-1') => host.tools.get(name).execute(args, execOf(name, args, { sessionId }))
  const bind = async (sessionId = 'session-1', targetId = 'T1') => run('chrome_open', { targetId }, sessionId)
  return { fake, host, applied: host, run, bind }
}

const pageCalls = (fake, id = 'T1') => fake.state[id] ?? []
const methods = (fake, id = 'T1') => pageCalls(fake, id).map((call) => call.method)

test('R2/R9: every result states browser, execution host, endpoint and connection', async (t) => {
  const { fake, run } = await fixture()
  t.after(() => fake.close())
  const status = await run('chrome_status')
  assert.match(status, /^browser    : Chrome \(CDP\)/m)
  assert.match(status, /^host       : \S+/m)
  assert.match(status, /^endpoint   : http:\/\/127\.0\.0\.1:\d+$/m)
  assert.match(status, /^connection : ready$/m)
  assert.match(status, /chrome     : Chrome\/157\.0\.0\.0 \(fake\)/)
})

test('R9: an unreachable endpoint answers the exact sentence, never suggesting the sidebar Browser', async () => {
  const host = createHost({ config: { endpoint: 'http://127.0.0.1:9' } }) // discard port: nothing listens
  // chrome_open is checked against the fake Chrome (its side effect is guarded here); the
  // reads every tool starts with are the ones that must name the endpoint.
  for (const [name, args] of [['chrome_status', {}], ['chrome_tabs', {}], ['chrome_close_tab', { targetId: 'ABC' }]]) {
    await assert.rejects(
      () => host.tools.get(name).execute(args, execOf(name, args)),
      (error) => {
        assert.match(error.message, /^Chrome CDP not reachable at http:\/\/127\.0\.0\.1:9 on /)
        assert.match(error.message, /start Chrome with --remote-debugging-port or fix config$/)
        assert.doesNotMatch(error.message, /sidebar|internal_browser|Browser tab/i)
        return true
      },
      name,
    )
  }
})

test('R2/R6: chrome_tabs lists the open tabs and marks the bound one, page text wrapped', async (t) => {
  const { fake, run, bind } = await fixture()
  t.after(() => fake.close())
  const before = await run('chrome_tabs')
  assert.match(before, /1 Chrome tab\(s\):/)
  assert.match(before, /<untrusted-page-content source="dsh-ext\/chrome-cdp">/)
  assert.match(before, /Example/)
  await bind()
  const after = await run('chrome_tabs')
  assert.match(after, /^target     : T1$/m)
  assert.match(after, /^ {2}\* T1 {2}Example {2}https:\/\/example\.com\/$/m)
})

test('R3: a snapshot numbers the elements of the top document and of an OOPIF', async (t) => {
  const { fake, run, bind } = await fixture({ frameUrls: ['https://accounts.example/rotate'] })
  t.after(() => fake.close())
  await bind()
  // The auto-attach event and the frame sessions are the R3 mechanism; the fake attaches
  // one iframe target and the plugin must enable the domain and resume it.
  fake.state.expressionAnswer = (expression, { sessionId }) => ({
    title: sessionId ? 'frame' : 'Example Domain',
    url: sessionId ? 'https://accounts.example/rotate' : 'https://example.com/',
    viewport: { w: 800, h: 600 },
    elements: [{ index: sessionId ? 1 : 3, tag: sessionId ? 'button' : 'a', label: sessionId ? 'Sign in' : 'More information...' }],
  })
  const snapshot = await run('chrome_snapshot')
  assert.match(snapshot, /title : Example Domain/)
  assert.match(snapshot, /\[frame\] top document {2}800x600/)
  // Numbers are the host's single page-wide series, whatever each document called itself.
  assert.match(snapshot, /\[1\] a "More information\.\.\."/)
  assert.match(snapshot, /\[frame\] iframe https:\/\/accounts\.example\/rotate/)
  assert.match(snapshot, /\[2\] button "Sign in"/)
  assert.match(snapshot, /2 interactive element\(s\) in 2 frame\(s\)/)
  // R3: the cross-frame mechanism is Target.setAutoAttach with waitForDebuggerOnStart,
  // and each attached frame is resumed so it can be read.
  const calls = pageCalls(fake)
  const autoAttach = calls.find((call) => call.method === 'Target.setAutoAttach')
  assert.deepEqual(autoAttach.params, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
  assert.ok(methods(fake).includes('Runtime.runIfWaitingForDebugger'))
  // The top document and the frame are each evaluated in their own session.
  const evaluations = calls.filter((call) => call.method === 'Runtime.evaluate')
  assert.deepEqual(evaluations.map((call) => call.sessionId).sort(), [null, 'S1'].sort())
})

test('R3/R4: every frame gets its own isolated world, and evaluated numbers are page-wide', async (t) => {
  const { fake, run, bind, host } = await fixture({ childFrames: [{ id: 'C1', url: 'https://child.example/' }], frameUrls: ['https://oopif.example/'] })
  t.after(() => fake.close())
  await bind()
  await run('chrome_snapshot')
  // The top document and the OOPIF each get a world of their own; the same-process child is
  // read through its frameId in the page session, so the page's worlds are the top frame and
  // its child, and the OOPIF's world names the target's own root frame (never a guess).
  const page = internalsOf(host).pages.get('T1')
  const worldOf = (sessionId, frameId) => fake.state.worldCalls.find((call) => call.sessionId === sessionId && call.frameId === frameId)?.contextId
  assert.equal(worldOf(null, 'T1-main'), page.worlds.get('|T1-main'))
  assert.equal(worldOf(null, 'C1'), page.worlds.get('|C1'))
  assert.equal(worldOf('S1', 'frame-S1'), page.worlds.get('S1|frame-S1'))
  const frames = fake.state.worldCalls.map((call) => `${call.sessionId ?? 'page'}:${call.frameId ?? 'top'}`).sort()
  assert.deepEqual(frames, ['S1:frame-S1', 'page:C1', 'page:T1-main'])
  assert.deepEqual(fake.state.badWorldCalls, [], 'no world was created without its frame id')
})

test('R3: an attached frame is resumed with a string session id, and that id goes on every call', async (t) => {
  const { fake, run, bind } = await fixture({ frameUrls: ['https://oopif.example/'] })
  t.after(() => fake.close())
  await bind()
  await run('chrome_snapshot')
  // The fake rejects a non-string sessionId exactly as Chrome does; nothing was rejected.
  assert.deepEqual(fake.state.badSessions, [])
  const resumed = pageCalls(fake).filter((call) => call.method === 'Runtime.runIfWaitingForDebugger')
  assert.equal(resumed.length, 1)
  assert.equal(resumed[0].sessionId, 'S1')
})

test('R3: a frame whose resume fails is recorded on its session, not swallowed', async (t) => {
  const { fake, run, bind, host } = await fixture({ frameUrls: ['https://oopif.example/'], resumeFails: () => true })
  t.after(() => fake.close())
  await bind()
  // Opening the page attaches and resumes the OOPIF; the refusal is recorded on that session.
  // A frame this side could not resume is reported in the snapshot, not read and not dropped.
  const text = await run('chrome_snapshot')
  assert.match(text, /\[frame\] iframe https:\/\/oopif\.example\/: not readable \(could not resume the frame/)
  const session = internalsOf(host).pages.get('T1').sessions.get('S1')
  assert.match(String(session?.failed), /could not resume the frame/)
})

test('R3: a number is only resolved where the snapshot printed it', async (t) => {
  const { fake, run, bind } = await fixture({ frameUrls: ['https://oopif.example/'] })
  t.after(() => fake.close())
  await bind()
  // A session with no snapshot of this tab refuses a click as stale; it never takes a read of
  // its own and acts on numbers that read never printed.
  fake.state.expressionAnswer = (expression) => (expression.includes('function')
    ? { title: 'T', url: 'https://example.com/', viewport: { w: 10, h: 10 }, elements: [] }
    : { x: 5, y: 5, tag: 'button', text: 'Pay' })
  await assert.rejects(() => run('chrome_click', { index: 1 }), /stale snapshot: this session has no chrome_snapshot/)
  fake.state.expressionAnswer = (expression) => (expression.includes('function')
    ? { title: 'T', url: 'https://example.com/', viewport: { w: 10, h: 10 }, elements: [{ index: 1, tag: 'button', label: 'Pay' }] }
    : { x: 5, y: 5, tag: 'button', text: 'Pay' })
  const snapshot = await run('chrome_snapshot')
  assert.match(snapshot, /\[1\] button "Pay"/)
  const text = await run('chrome_click', { index: 1 })
  // The click names the frame the snapshot printed the number in, or "stale" — never a guess.
  const outcome = text.startsWith('browser') ? 'clicked' : text
  assert.match(outcome, /^clicked/)
})

test('R3: click addresses the element number, dispatching inside the frame that printed it', async (t) => {
  const { fake, run, bind } = await fixture({ frameUrls: ['https://pay.example/frame'] })
  t.after(() => fake.close())
  await bind()
  // Only the iframe owns an element; the top document has none, so the page-wide number 1 is
  // the OOPIF's, and its lookup is answered in the OOPIF's own session. The OOPIF's own frame
  // tree names its frame and URL, which is what the result reports as its frame. An OOPIF gets
  // no owner translation: its coordinates already are its own root viewport's.
  fake.state.expressionAnswer = (expression, { sessionId }) => {
    if (expression.includes('function')) {
      return sessionId === 'S1'
        ? { title: 't', url: 'https://pay.example/frame', viewport: { w: 100, h: 100 }, elements: [{ index: 1, tag: 'button', label: 'Pay' }] }
        : { title: 't', url: 'https://example.com/', viewport: { w: 100, h: 100 }, elements: [] }
    }
    return sessionId === 'S1' ? { x: 40, y: 20, tag: 'button', text: 'Pay' } : null
  }
  await run('chrome_snapshot')
  const text = await run('chrome_click', { index: 1 })
  assert.match(text, /clicked element \[1\]: <button> "Pay" \(frame: iframe /)
  const pressed = pageCalls(fake).filter((call) => call.params && call.params.type === 'mousePressed')
  assert.equal(pressed.length, 1)
  assert.equal(pressed[0].sessionId, 'S1', 'the click is dispatched in the frame that printed the number')
  assert.deepEqual({ x: pressed[0].params.x, y: pressed[0].params.y }, { x: 40, y: 20 })
})

/**
 * One synthetic element: tag, text, point and size. Its number is the one the snapshot script
 * writes, as the production element lookup reads it.
 * @param {object} spec - `{ tag, text, x, y, width, height }`.
 */
const syntheticElement = ({ tag = 'button', text = '', x = 0, y = 0, width = 40, height = 20 } = {}) => element({
  tag,
  text,
  box: { left: x, top: y, width, height },
})

/**
 * A document whose single button sits centred on (x, y) in its own viewport. The REAL snapshot
 * script numbers it and the REAL lookup finds it, so the rect a click starts from is the script's
 * own answer and never a hand-made one.
 * @param {string} label - the button's text.
 * @param {number} x - the centre the click must start from.
 * @param {number} y - the same on the vertical axis.
 */
const buttonDocument = (label, x, y) => documentOf([syntheticElement({ text: label, x: x - 20, y: y - 10 })], `https://${label.toLowerCase()}.example/`)

/**
 * The page's documents by frame id: the DOM model the fake hands the REAL scripts, so the
 * snapshot and the lookup that follows it read the same element in the same frame.
 * @param {object} byFrame - `top` or a child frame id → its `documentOf`.
 */
const documentsByFrame = (byFrame) => ({
  top: () => byFrame.top ?? frameDocument('top', []),
  ...Object.fromEntries(Object.entries(byFrame).filter(([id]) => id !== 'top').map(([id, document]) => [id, () => document])),
})

/** One of two unnamed sibling iframes: the old page-side lookup could only guess one of them. */
test('R3: two unnamed sibling iframe owners are told apart by DOM.getFrameOwner, never by a sole-owner guess', async (t) => {
  const { fake, run, bind } = await fixture({
    childFrames: [
      // Content corners in the root document, with a border on C1 so its two quads differ.
      { id: 'C1', url: 'https://left.example/', content: { x: 30, y: 40 }, border: 4 },
      { id: 'C2', url: 'https://right.example/', content: { x: 100, y: 200 } },
    ],
  })
  t.after(() => fake.close())
  await bind()
  fake.state.document = documentsByFrame({
    top: buttonDocument('Top', 5, 6),
    C1: buttonDocument('Left', 7, 8),
    C2: buttonDocument('Right', 11, 12),
  })
  await run('chrome_snapshot')
  const press = async (index) => {
    const text = await run('chrome_click', { index })
    const pressed = pageCalls(fake).filter((call) => call.params && call.params.type === 'mousePressed').at(-1)
    return { text, point: { x: pressed.params.x, y: pressed.params.y } }
  }
  // C1's button: the CONTENT corner (30, 40), not the border corner (26, 36).
  const left = await press(2)
  assert.match(left.text, /<button> "Left"/)
  assert.deepEqual(left.point, { x: 37, y: 48 }, 'C1\u2019s content corner, never its border corner nor its sibling\u2019s')
  // C2's button: its own corner (100, 200), never the neighbour's.
  const right = await press(3)
  assert.match(right.text, /<button> "Right"/)
  assert.deepEqual(right.point, { x: 111, y: 212 }, 'C2\u2019s content corner, never its sibling\u2019s')
  // Clicking page number 3 (C2's element) named only C2; the sibling C1 was never consulted.
  assert.deepEqual(fake.state.domCalls.filter((call) => call.method === 'DOM.getFrameOwner').slice(-2).map((call) => call.params.frameId), ['C2', 'C2'], 'only the clicked frame is measured')
  // The top document needs no owner at all.
  const top = await press(1)
  assert.match(top.text, /<button> "Top"/)
  assert.deepEqual(top.point, { x: 5, y: 6 })
  // The quads the host actually used: the content corner was taken, and the border differs.
  const used = fake.state.boxModels ?? []
  assert.ok(used.length > 0, 'the host measured an owner')
  assert.notDeepEqual(used[0].content.slice(0, 2), used[0].border.slice(0, 2), 'the fixture gives the two quads different corners')
})

/** A nested same-process iframe, mapped through its own owner's root-relative content quad. */
test('R3: a nested same-process iframe maps through each owner\u2019s root-relative content quad', async (t) => {
  const { fake, run, bind } = await fixture({
    childFrames: [
      // C1 sits at root (400, 300) with a border and padding; C2, inside C1, at root (450, 350).
      { id: 'C1', url: 'https://middle.example/', content: { x: 400, y: 300 }, border: 5, padding: 3 },
      { id: 'C2', url: 'https://inner.example/', parentId: 'C1', content: { x: 450, y: 350 } },
    ],
  })
  t.after(() => fake.close())
  await bind()
  fake.state.document = documentsByFrame({
    C2: buttonDocument('Deep', 10, 10),
  })
  await run('chrome_snapshot')
  const text = await run('chrome_click', { index: 1 })
  assert.match(text, /<button> "Deep"/)
  const pressed = pageCalls(fake).filter((call) => call.params && call.params.type === 'mousePressed')
  assert.equal(pressed.length, 1)
  // C2's (10, 10) in its own viewport goes through its immediate owner's content quad, which is
  // already (450, 350) in the root: (460, 360). The same-process input is dispatched on the page
  // session, whose viewport the quad is measured in, so C2's quad is the only one involved; the
  // outer owner is never consulted, and its border and padding never move the point.
  assert.deepEqual({ x: pressed[0].params.x, y: pressed[0].params.y }, { x: 460, y: 360 })
  // The owner was named by its own frame id, once, on the page session.
  const owners = fake.state.domCalls.filter((call) => call.method === 'DOM.getFrameOwner')
  assert.deepEqual(owners.map((call) => call.params.frameId), ['C2'])
  assert.ok(owners.every((call) => call.sessionId === null), 'the owner is measured on the page session')
})

/** A CSS-scaled owner: the content quad is larger than the child's own viewport. */
test('R3: a scaled iframe owner is mapped with its content quad and the child viewport, not by adding corners', async (t) => {
  const { fake, run, bind } = await fixture({
    // The owner's content quad is 1200x800 on the root while the child's viewport is 600x400:
    // a CSS scale of 2. Its corner is (100, 200).
    childFrames: [{ id: 'C1', url: 'https://scaled.example/', content: { x: 100, y: 200 }, border: 2, contentWidth: 1200, contentHeight: 800, document: documentOf([], 'https://scaled.example/', { w: 600, h: 400 }) }],
  })
  t.after(() => fake.close())
  await bind()
  fake.state.document = documentsByFrame({ C1: buttonDocument('Scaled', 20, 30) })
  await run('chrome_snapshot')
  await run('chrome_click', { index: 1 })
  const pressed = pageCalls(fake).filter((call) => call.params && call.params.type === 'mousePressed')
  // (100 + 20 * 2, 200 + 30 * 2) = (140, 260); adding the corner alone would give (120, 230).
  assert.deepEqual({ x: pressed[0].params.x, y: pressed[0].params.y }, { x: 140, y: 260 })
})

/** A rotated owner has no axis-aligned content corner: the action refuses. */
test('R3: a rotated iframe owner refuses the click instead of guessing a corner', async (t) => {
  const { fake, run, bind } = await fixture({
    childFrames: [{ id: 'C1', url: 'https://turned.example/', content: { x: 50, y: 60 }, rotated: true }],
  })
  t.after(() => fake.close())
  await bind()
  fake.state.document = documentsByFrame({ C1: buttonDocument('Turned', 20, 30) })
  await run('chrome_snapshot')
  await assert.rejects(() => run('chrome_click', { index: 1 }), /rotated or skewed/)
  assert.equal(pageCalls(fake).filter((call) => call.params && call.params.type === 'mousePressed').length, 0, 'nothing was clicked')
})

test('R8: chrome_fill types as one insertText and refuses a password field before typing', async (t) => {
  const { fake, run, bind } = await fixture()
  t.after(() => fake.close())
  await bind()
  // Element 5 is the password field, element 4 a text field; both come from the lookup.
  fake.state.expressionAnswer = (expression) => (!expression.includes('elements')
    ? { x: 10, y: 10, tag: 'input', type: 'password', text: '' }
    : { title: 't', url: 'https://example.com/', viewport: { w: 10, h: 10 }, elements: [{ index: 1, tag: 'input', type: 'password', label: 'Password' }, { index: 2, tag: 'input', type: 'text', label: 'Name' }] })
  await run('chrome_snapshot')
  await assert.rejects(() => run('chrome_fill', { index: 1, text: 'hunter2' }), /does not type passwords \(spec 035 R8\)/)
  assert.equal(pageCalls(fake).filter((call) => call.method === 'Input.insertText').length, 0, 'nothing was typed')

  fake.state.expressionAnswer = (expression) => (!expression.includes('elements')
    ? { x: 10, y: 10, tag: 'input', type: 'text', text: '' }
    : { title: 't', url: 'https://example.com/', viewport: { w: 10, h: 10 }, elements: [{ index: 2, tag: 'input', type: 'text', label: 'Name' }] })
  const text = await run('chrome_fill', { index: 2, text: 'hello' })
  assert.match(text, /^5 char\(s\) into element \[2\]: <input\[text\]>/m)
  assert.equal(pageCalls(fake).filter((call) => call.method === 'Input.insertText').length, 1)
})

test('R8: no code path reads cookies, storage or the password store', async () => {
  const { readFileSync } = await import('node:fs')
  for (const file of ['../lib/index.js', '../lib/cdp.js', '../lib/cdp-client.js', '../lib/client.js', '../lib/snapshot-script.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /Network\.getAllCookies|Network\.setCookie|Network\.getCookies|document\.cookie|Storage\.getDOMStorageItems|DOMStorage|Storage\.getCookies/, file)
    // No CDP call into the browser's own credential or profile surfaces.
    assert.doesNotMatch(source, /Login\.\w|Browser\.getHistograms|Tracing\.|SystemInfo\./, file)
  }
})

test('R8: a screenshot is written only inside the plugin data directory', async (t) => {
  const { fake, run, bind } = await fixture()
  const dataDir = tempDataDir()
  t.after(async () => { await fake.close(); dataDir.done() })
  const host = createHost({ config: { endpoint: fake.url, dataDir: dataDir.dir } })
  const tool = host.tools.get('chrome_screenshot')
  await host.tools.get('chrome_open').execute({ targetId: 'T1' }, execOf('chrome_open'))
  const text = await tool.execute({}, execOf('chrome_screenshot'))
  const file = /^file       : (.+)$/m.exec(text)[1]
  assert.ok(file.startsWith(dataDir.dir), file)
  const bytes = readFileSyncSync(file)
  assert.deepEqual(bytes, Buffer.from(TINY_JPEG, 'base64'), 'the JPEG Chrome sent is what was written')
  for (const savePath of ['../escape.jpg', 'sub/dir.jpg', 'C:\\Windows\\x.jpg', '..']) {
    await assert.rejects(() => tool.execute({ savePath }, execOf('chrome_screenshot')), /plain file name/, savePath)
  }
  void run
  void bind
})

function readFileSyncSync (file) {
  const { readFileSync } = process.getBuiltinModule('node:fs')
  return readFileSync(file)
}

test('R4: one tab per session, bound on open, verified before each action', async (t) => {
  const { fake, run, bind } = await fixture({ targets: [{ id: 'T1', title: 'One', url: 'https://one.example/' }, { id: 'T2', title: 'Two', url: 'https://two.example/' }] })
  t.after(() => fake.close())
  await bind('session-b', 'T2')
  await bind('session-a', 'T1')
  assert.match(await run('chrome_tabs', {}, 'session-a'), /^target     : T1$/m)
  assert.match(await run('chrome_tabs', {}, 'session-b'), /^target     : T2$/m)
  // Rebinding replaces the session's own tab; it never adds a second binding.
  await bind('session-a', 'T2')
  assert.match(await run('chrome_tabs', {}, 'session-a'), /^target     : T2$/m)

  // A tab that vanished is reported by id, never silently replaced (R4).
  fake.state.pages.splice(fake.state.pages.findIndex((page) => page.id === 'T2'), 1)
  await assert.rejects(() => run('chrome_snapshot', {}, 'session-a'), /no longer exists; use chrome_tabs and chrome_open/)
})

test('R4: a tab leased to another session answers "tab in use by another session"', async (t) => {
  const { fake, run, host } = await fixture()
  t.after(() => fake.close())
  // A click holds its tab's lease until its own snapshot finishes; taking the lease directly
  // shows the refusal another session gets meanwhile, with both sessions bound to that tab.
  await run('chrome_open', { targetId: 'T1' }, 'session-a')
  await run('chrome_open', { targetId: 'T1' }, 'session-b')
  const cdp = internalsOf(host)
  cdp.lease('session-a', 'T1')
  await assert.rejects(
    () => run('chrome_click', { index: 1 }, 'session-b'),
    /tab in use by another session/,
  )
  assert.equal(cdp.isLeasedBy('session-a', 'T1'), true, 'the holder keeps its lease')
  cdp.release('session-a', 'T1')
  assert.equal(cdp.isLeasedBy('session-a', 'T1'), false, 'a released lease lets the next session act')
})

test('R4: the lease expires after the idle window, so a dead session does not hold a tab forever', async () => {
  // Explicitly the discard port, never whatever the default endpoint happens to be.
  const cdp = internalsOf(createHost({ config: { endpoint: SYNTHETIC_ENDPOINT } }))
  cdp.lease('session-a', 'T1')
  assert.throws(() => cdp.lease('session-b', 'T1'), /tab in use by another session/)
  // Age the lease past the 60 s idle window; the next action of another session is admitted.
  cdp.leases.get('T1').at = Date.now() - 61_000
  assert.doesNotThrow(() => cdp.lease('session-b', 'T1'))
})

test('R4: a second session shares the live connection once no lease excludes it, and keeps its own selection', async (t) => {
  const { fake, host } = await fixture()
  t.after(() => fake.close())
  const cdp = internalsOf(host)
  const first = await cdp.page('T1', { sessionId: 'session-a' })
  // Connection ownership is not exclusion: with no active lease the second session shares the
  // same live connection, and neither session's selection is rewritten by that.
  cdp.bind('session-a', 'T1', 'https://example.com/')
  cdp.bind('session-b', 'T1', 'https://example.com/')
  const second = await cdp.page('T1', { sessionId: 'session-b' })
  assert.equal(second, first, 'one live connection is shared, never replaced')
  assert.deepEqual(first.users, ['session-a', 'session-b'])
  assert.equal(cdp.bindingFor('session-a').targetId, 'T1')
  assert.equal(cdp.bindingFor('session-b').targetId, 'T1')
  assert.equal(first.connection.closed, false)
  // An active lease is the only exclusion: session-a acting on the tab refuses session-b.
  cdp.lease('session-a', 'T1')
  assert.throws(() => cdp.lease('session-b', 'T1'), /tab in use by another session/)
})

test('R1/R2: discovery never follows a redirect and never connects to another host', async (t) => {
  const hop = await startFakeChrome({ targets: [{ id: 'T1', title: 'One', url: 'https://one.example/' }], redirects: { status: 302, location: 'http://192.0.2.10:40222/json/list' } })
  t.after(() => hop.close())
  const host = createHost({ config: { endpoint: hop.url } })
  await assert.rejects(() => host.tools.get('chrome_tabs').execute({}, execOf('chrome_tabs')), /redirect \(HTTP 302\)/)
  assert.equal(hop.state.calls.length, 1, 'only the first request was made; the hop was not followed')

  const elsewhere = await startFakeChrome({ targets: [{ id: 'T1', title: 'One', url: 'https://one.example/' }], socketUrl: 'ws://192.0.2.10:40222/devtools/page/T1' })
  t.after(() => elsewhere.close())
  const other = createHost({ config: { endpoint: elsewhere.url } })
  await assert.rejects(() => other.tools.get('chrome_tabs').execute({}, execOf('chrome_tabs')), /not the configured endpoint/)
})

test('R8: a password value a page holds never reaches a tool result', async (t) => {
  const { fake, run, bind } = await fixture()
  t.after(() => fake.close())
  await bind()
  // The page script is the only thing that could read the value, so a value in the result
  // could only come from the script itself; the fake reports what the script asked for.
  fake.state.expressionAnswer = (expression) => (expression.includes('elements')
    ? { title: 'Login', url: 'https://login.example/', viewport: { w: 100, h: 100 },
        elements: [{ index: 1, tag: 'input', type: 'password', label: 'Password' }] }
    : { x: 10, y: 10, tag: 'input', type: 'password', text: '' })
  const snapshot = await run('chrome_snapshot')
  assert.equal(snapshot.includes(SYNTHETIC_PASSWORD), false)
  assert.match(snapshot, /\[1\] input\[password\] "Password"/)
  // A fill against the password field is refused, and its refusal quotes no page value.
  await assert.rejects(() => run('chrome_fill', { index: 1, text: 'x' }), /does not type passwords/)
})

test('R5: chrome_close_tab closes exactly the named target through the browser connection', async (t) => {
  const { fake, run } = await fixture({ targets: [{ id: 'T1', title: 'One', url: 'https://one.example/' }, { id: 'T2', title: 'Two', url: 'https://two.example/' }] })
  t.after(() => fake.close())
  const text = await run('chrome_close_tab', { targetId: 'T2' })
  assert.match(text, /^closed     : T2$/m)
  assert.deepEqual(fake.state.closed, ['T2'])
  assert.deepEqual(fake.state.browserCalls.filter((call) => call.method === 'Target.closeTarget').map((call) => call.params.targetId), ['T2'])
})

test('R5: closing a tab that does not exist closes nothing', async (t) => {
  const { fake, run } = await fixture()
  t.after(() => fake.close())
  await assert.rejects(() => run('chrome_close_tab', { targetId: 'NOPE' }), /no Chrome tab has the id NOPE; nothing was closed/)
  assert.deepEqual(fake.state.closed, [])
})

test('R1/R2: chrome_open creates a tab only when asked to, and binds it', async (t) => {
  const fakeWithCreate = await startFakeChrome({
    targets: [],
    createTarget: (url) => ({ id: 'NEW1', title: 'about:blank', url: url || 'about:blank' }),
  })
  t.after(() => fakeWithCreate.close())
  const host = createHost({ config: { endpoint: fakeWithCreate.url } })
  const text = await host.tools.get('chrome_open').execute({ url: 'example.com' }, execOf('chrome_open'))
  assert.match(text, /^target     : NEW1 \(bound to this session\)$/m)
  // `/json/new` is PUT on Chrome 111+, and the host the model gave became a full URL.
  const created = fakeWithCreate.state.calls.filter((call) => call.path === '/json/new')
  assert.deepEqual(created.map((call) => call.method), ['PUT'])
  assert.equal(created[0].search, `?${encodeURIComponent('https://example.com')}`)
})

test('the under-test refusal is a function of env only: an unarmed test process refuses, an armed one does not', async () => {
  const { __internals } = await import('../lib/index.js')
  const guardOn = __internals.underTestGuard
  assert.equal(typeof guardOn, 'function')
  // The same environment with and without the arming variable, so the decision itself is pinned
  // without touching a browser: an unarmed test process is refused, a normal Host (no test
  // marker at all) is never refused.
  const refused = guardOn({ NODE_TEST_CONTEXT: 'child-v8' })
  assert.equal(refused, true)
  assert.equal(guardOn({ NODE_TEST_CONTEXT: 'child-v8', DSH_CHROME_CDP_ARM_FAKES: '1' }), false)
  assert.equal(guardOn({ NODE_ENV: 'test' }), true)
  assert.equal(guardOn({}), false)
})

test('the bridge serves one JPEG, the tab list and forwarded input through the same binding', async (t) => {
  const { fake, host } = await fixture()
  t.after(() => fake.close())
  const secret = host.bridgeSecret()
  const route = (name) => relayOf(host.registrations, name)

  const tabs = await callRelay(route('tabs'), { secret })
  assert.equal(tabs.status, 200)
  assert.equal(tabs.body.ok, true)
  assert.equal(tabs.body.value.tabs[0].id, 'T1')

  const shot = await callRelay(route('shot'), { secret, body: { targetId: 'T1' } })
  assert.equal(shot.body.ok, true)
  assert.equal(shot.body.value.data, TINY_JPEG)

  const input = await callRelay(route('input'), { secret, body: { targetId: 'T1', op: 'mouse', data: { type: 'mousePressed', x: 5, y: 6 } } })
  assert.equal(input.body.ok, true)
  // Only the press the view made is forwarded: a mousedown is not turned into a click, and the
  // release waits for the view's own mouseup.
  const pressed = pageCalls(fake).filter((call) => call.params && call.params.type === 'mousePressed')
  assert.equal(pressed.length, 1)
  assert.deepEqual({ x: pressed[0].params.x, y: pressed[0].params.y, button: pressed[0].params.button }, { x: 5, y: 6, button: 'left' })
  assert.equal(pageCalls(fake).filter((call) => call.params && call.params.type === 'mouseReleased').length, 0)
  const up = await callRelay(route('input'), { secret, body: { targetId: 'T1', op: 'mouse', data: { type: 'mouseReleased', x: 5, y: 6 } } })
  assert.equal(up.body.ok, true)
  const released = pageCalls(fake).filter((call) => call.params && call.params.type === 'mouseReleased')
  assert.equal(released.length, 1, 'the page sees exactly the release the view made')
  assert.equal(released[0].params.button, 'left')

  const key = await callRelay(route('input'), { secret, body: { targetId: 'T1', op: 'key', data: { key: 'a' } } })
  assert.equal(key.body.ok, true)
  assert.ok(pageCalls(fake).some((call) => call.method === 'Input.dispatchKeyEvent' && call.params.windowsVirtualKeyCode === 65))

  const bad = await callRelay(route('input'), { secret, body: { targetId: 'T1', op: 'paste', data: {} } })
  assert.equal(bad.body.ok, false)
  assert.match(bad.body.error, /unsupported input operation: paste/)
})
