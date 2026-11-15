// Spec 033 (constitution amendment A1.2, owner 2026-11-15): a non-image file picked in a
// composer that shows a session on ANOTHER Host must reach that Host as BYTES, not as a
// controller-local `@"C:\…"` mention. lib/client.remote-file-attach.js wraps
// `globalThis.__DSH_HOST_PATHS__.pathFor` — the bridge DSH's preload exposes — and answers
// `''` for such a pick: the one answer DSH's own composer reads as "upload these bytes"
// (installed `apply.ts` → lib/upload-route.mjs → the remote Host).
//
// What these tests hold:
//  - the chunk's REGISTRATION ENVELOPE (`window.__ModuleLoader__.load({id, chunk, factory})`,
//    measured in the installed terminal chunk) and the adapter reading the same text;
//  - the spec's acceptance rows, against a FAKE bridge and a composer document shaped like
//    the installed one (the picker is a SIBLING of `[data-composer-input]`, and DSH drains
//    and resets it BEFORE intakeFiles — test/helpers.mjs `createFakeComposerDocument`);
//  - R6 at pick time: the attribution is claimed from the capture phase of `change` and
//    held for the whole pick batch; anything unproven keeps DSH's own answer AND is
//    reported;
//  - A1.2: the strict structural self-test (null, accessor, hidden key, symbol, shape),
//    no wrap on any mismatch, exact restore of the bridge member, another instance's
//    overwrite left alone, and — the reviewer finding of 2026-11-16 — a member that cannot
//    be replaced in place is `bridge-frozen`: the global binding is NEVER re-pointed at a
//    delegating object (installed `apply.ts:504` captures the bridge once per composer
//    inject, so a re-point reaches no composer that was already rendered);
//  - the seam re-measured against the INSTALLED DSH's own shipped sources (`apply.ts`, the
//    built `client.js`, the preload, the chunk loader), so an upgrade that moves it fails
//    here instead of silently turning remote picks back into mentions.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as shared from '../lib/remote-file-attach.mjs'
import { PINNED_DSH_VERSION } from '../lib/host-router.mjs'
import { splitTaggedSessionId as carrierSplit } from '../lib/upload-route.mjs'
import { createFakeComposerDocument, dispatchIntake, pickFiles, settleMicrotasks } from './helpers.mjs'

/**
 * One realm per test — what each DSH renderer gets (its own page): the module keeps ONE
 * instance per global in a WeakMap, which is right for a page and wrong for a test file
 * that runs many "pages" through one realm (a later page's document would answer an earlier
 * page's pick). Each call reloads the adapter and binds it to the pages that test creates.
 */
const ADAPTER_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'remote-file-attach.mjs')).href
let realmCount = 0
async function newRealm() {
  realmCount += 1
  const realm = await import(`${ADAPTER_URL}?realm=${realmCount}`)
  return {
    /** A fake page bound to THIS realm, knowing the bridge its composer reads. */
    page(holder, options) {
      const fake = createFakeComposerDocument(options)
      fake.document.holder = holder
      return fake
    },
    route(holder, doc) { return realm.remoteFileIntakeFor({ global: holder, doc, log: () => {} }) },
    install(holder) { return realm.installRemoteFileIntake({ global: holder, doc: null, log: () => {} }) },
    ...realm,
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const h = require('../../mobile-gateway/node_modules/react').createElement
const TestRenderer = require('../../mobile-gateway/node_modules/react-test-renderer')
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const HOST_ID = '2f1d1a52-6d7c-4d3e-9a58-1f0f1a2b3c4d'
const TAGGED = `h:${HOST_ID}:s-1`
const LOCAL = 's-local'
const HOST_PATHS = shared.HOST_PATHS_GLOBAL
/** The installed DSH (`resources/app`), when this machine has one. */
const APP = `${String(process.env.LOCALAPPDATA ?? '').replace(/\\/g, '/')}/Programs/DeepSeek Harness/resources/app`
const PRELOAD = `${APP}/lib/preload-app.cjs`
const PACKAGE = `${APP}/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation`
const BUILT = `${PACKAGE}/lib/client.js`
const APPLY = `${PACKAGE}/src/client/apply.ts`
const INTAKE = `${PACKAGE}/src/client/skeleton/InputBar.tsx`
const MODULES = `${APP}/dsh/node_modules/@deepseek-ai/dsh-client-modules`
const TERMINAL_CHUNK = `${APP}/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-terminal/lib/client.terminal.js`
const installed = () => fs.existsSync(PRELOAD) && fs.existsSync(BUILT) && fs.existsSync(APPLY) && fs.existsSync(INTAKE)

const zip = () => ({ name: 'bundle.zip', type: 'application/zip', size: 11917 })
const image = () => ({ name: 'shot.png', type: 'image/png', size: 1200 })
const folder = () => ({ name: 'folder', type: 'inode/directory', size: 0 })
const DOWNLOADS = 'C:\\Users\\owner\\Downloads'

/**
 * DSH's bridge as the preload exposes it: one own key, an ARROW `pathFor` that ignores
 * `this` (`preload-app.cjs` @119676, `pathFor: (file) => electron.webUtils.getPathForFile(file)`).
 */
function bridgeGlobal({ frozen = false, dir = DOWNLOADS } = {}) {
  const bridge = { pathFor: (file) => `${dir}\\${file.name}` }
  if (frozen) Object.freeze(bridge)
  const holder = {}
  Object.defineProperty(holder, HOST_PATHS, { value: bridge, writable: !frozen, configurable: !frozen, enumerable: false })
  return { holder, bridge, dir }
}

/** DSH's preload for a non-file: `getPathForFile` answers `""` (`preload-app.cjs` @119676). */
const fileBridge = (dir = DOWNLOADS) => ({ pathFor: (file) => (file === null || file === undefined ? '' : `${dir}\\${file.name}`) })

/**
 * A bridge whose own `pathFor` cannot be replaced while the global binding still can:
 * the shape that used to reach the delegating install. Written out rather than passed as
 * `frozen`, because that switch freezes BOTH, and the reviewer finding is about the
 * member alone.
 */
function immutableMember({ dir = DOWNLOADS } = {}) {
  const bridge = {}
  Object.defineProperty(bridge, 'pathFor', { value: (file) => `${dir}\\${file.name}`, writable: false, configurable: false, enumerable: true })
  const holder = {}
  Object.defineProperty(holder, HOST_PATHS, { value: bridge, writable: true, configurable: true, enumerable: false })
  return { holder, bridge, dir }
}

/**
 * DSH's own per-file outcome, transcribed from `addFiles` in the installed `apply.ts` —
 * the parts a pick can take: the bytes (upload), the mention of a path, or DSH's own
 * refusal.
 */
function dshPick(pathFor, file) {
  const directory = file.type === 'inode/directory'
  const answer = pathFor(file)
  const filePath = answer ?? ''
  if (directory && filePath === '') return { kind: 'refused', reason: 'attachment.pathUnavailable' }
  if (filePath === '' || (!directory && /^image\//.test(file.type))) return { kind: 'upload' }
  return { kind: 'mention', ref: `@"${filePath}"` }
}

/**
 * One pick exactly as DSH runs it: the capture listener claims the batch (what
 * `lib/client.js` installs), DSH's own handler drains and resets the picker, and `pathFor`
 * answers every file — through whichever bridge is passed in. That is DSH's own shape, not
 * a test convenience: `apply.ts` reads `hostPathBridge()` ONCE per composer inject
 * (`:504`) and calls `bridge?.pathFor(file)` (`:520`), so a composer rendered before any
 * later install keeps the object it captured.
 * @param {object} bridge what one composer holds
 * @returns {Array<{kind: string, ref?: string, reason?: string}>} DSH's own outcome per file
 */
/**
 * One pick exactly as DSH runs it: the capture listener claims the batch (what
 * `lib/client.js` installs), DSH's own handler drains and resets the picker, then DSH's own
 * loop — announced first, `dispatchIntake`, as the installed `apply.ts` `addFiles` does it —
 * asks the bridge for every file. That is DSH's own shape, not a test convenience: `apply.ts`
 * reads `hostPathBridge()` ONCE per composer inject (`:504`) and calls `bridge?.pathFor(file)`
 * (`:520`), so a composer rendered before any later install keeps the object it captured.
 * @param {object} bridge what one composer holds
 * @returns {Array<{kind: string, ref?: string, reason?: string}>} DSH's own outcome per file
 */
function pick(realm, route, document, picker, files = [zip()], bridge = document.holder[HOST_PATHS]) {
  const listener = (event) => { realm.adoptPickerFrom(route, event) }
  document.addEventListener(realm.PICK_EVENT, listener, true)
  try {
    return pickFiles(document, picker, files, (file) => dshPick((picked) => bridge.pathFor(picked), file),
      (handed) => dispatchIntake(document, handed))
  } finally {
    document.removeEventListener(realm.PICK_EVENT, listener, true)
  }
}

/**
 * One capture with the files STILL in the picker and no answer yet: the state a queued
 * microtask can observe before DSH's own loop asks its bridge (`pickFiles` drains the picker
 * before it answers, so it cannot express this turn).
 */
function fileInputFiles(picker, files) {
  picker.files = Object.assign([...files], { item: (index) => files[index] ?? null })
  picker.value = 'picked'
}

/** A hidden file input of another document (browser chrome): it is not in this page. */
function makeForeignPicker() {
  const other = createFakeComposerDocument({ sessions: [LOCAL] }).composers[0].fileInput
  let at = other
  while (at !== null && at !== undefined) { at.ownerDocument = { contains: () => false }; at = at.parent }
  return other
}

// --------------------------------------------------------------- the envelope

test('the chunk ships in DSH\'s own registration envelope and the adapter reads it back', () => {
  const source = fs.readFileSync(shared.CHUNK_FILE, 'utf8')
  assert.match(source, /^\/\/.*\n/, 'the header is comments, so the envelope can be found')
  assert.match(source, /\nwindow\.__ModuleLoader__\.load\(\{\n {2}id: '@dsh-ext\/devices',\n {2}chunk: 'client\.remote-file-attach\.js',\n {2}factory: \(require\) => \{/,
    'the exact registration shape DSH\'s chunks use: id, chunk, factory')
  assert.ok(source.trimEnd().endsWith('});'), 'the registration closes after the factory (`});`)')
  assert.ok(source.includes('return {\n      HOST_PATHS_GLOBAL'), 'the factory returns its exports, which is what require.async resolves to')
  assert.doesNotMatch(source, /^\s*module\.exports\s*=/m, 'a bare module.exports registers nothing: DSH serves the file verbatim')
  assert.equal(shared.CHUNK_OWNER, '@dsh-ext/devices', 'the owner is the package the loader keys the chunk by')
  assert.equal(shared.CHUNK_NAME, 'client.remote-file-attach.js', 'the file name IS the chunk segment DSH serves')
  assert.ok(shared.CHUNK_PATTERN.test(shared.CHUNK_NAME), 'DSH\'s loader pattern accepts the name')
  assert.equal(shared.CHUNK_URL, '/plugins/@dsh-ext/devices/client.remote-file-attach.js', 'the Host route serves it there')
  // What the README (and any doc) may spell about the chunk id must survive GFM's HTML
  // sanitiser: `__` inside a word is stripped as an underscore emphasis, so a doc that
  // wrote the module id naturally would show `ModuleLoader.load(...)` and cite nothing.
  assert.equal(shared.CHUNK_OWNER.includes('__'), false, 'the chunk id has no `__` that a doc would lose')
  assert.doesNotMatch(shared.CHUNK_NAME, /__/)
  // The adapter evaluated that same text through a fake __ModuleLoader__ (lib/remote-file-attach.mjs
  // `loadChunk` throws on a wrong count, id, chunk or factory), so these exports ARE the
  // factory's return value.
  assert.equal(typeof shared.remoteFileIntakeFor, 'function')
  assert.equal(typeof shared.HOST_PATHS_ORIGINAL, 'symbol')
})

// ------------------------------------------------------------- the acceptance

test('remote session + zip: bytes, never the controller path (R1)', async () => {
  const realm = await newRealm()
  const { holder } = bridgeGlobal()
  const { document, composers } = realm.page(holder, { sessions: [TAGGED] })
  const route = realm.route(holder, document)
  assert.deepEqual(route.install(),
    { surface: HOST_PATHS, wrapped: true, reason: null, shape: 'in-place', calls: 0 })
  // `''` is the answer whose bytes then travel the route lib/upload-route.mjs wraps; the
  // tagged id in that request's query is what turns it into `remote-upload-*` frames.
  assert.deepEqual(pick(realm, route, document, composers[0].fileInput), [{ kind: 'upload' }])
  assert.equal(composers[0].intake.picked.length, 1, 'DSH\'s own intake still received the file')
  const query = new URLSearchParams({ sessionId: TAGGED })
  assert.deepEqual(carrierSplit(query.get('sessionId')), { hostId: HOST_ID, sessionId: 's-1' })
  assert.equal(route.status().calls, 1, 'the page can see the wrap being used')
  assert.equal(route.lastPick, null, 'a remote pick uploads, so there is no refusal to report')
})

test('local session: the pick keeps DSH\'s own answer (R2)', async () => {
  const realm = await newRealm()
  const { holder } = bridgeGlobal()
  const { document, composers } = realm.page(holder, { sessions: [LOCAL] })
  const route = realm.route(holder, document)
  route.install()
  assert.deepEqual(pick(realm, route, document, composers[0].fileInput), [{ kind: 'mention', ref: `@"${DOWNLOADS}\\bundle.zip"` }])
  assert.equal(route.lastPick, 'certain', 'attribution was certain; this pick is simply local')
  assert.equal(route.takeNotice().sessionId, LOCAL, 'the page can say it was not uploaded')
})

test('image: unchanged, because DSH uploads an image whatever the path says (R2)', async () => {
  const realm = await newRealm()
  const { holder } = bridgeGlobal()
  const { document, composers } = realm.page(holder, { sessions: [TAGGED] })
  const route = realm.route(holder, document)
  route.install()
  const [answer] = pick(realm, route, document, composers[0].fileInput, [image()])
  assert.equal(answer.kind, 'upload', 'apply.ts: an image uploads with a path too')
  assert.equal(answer.ref, undefined)
  assert.equal(route.status().calls, 1)
  assert.equal(route.lastPick, 'certain')
})

test('directory: DSH\'s own pathUnavailable, never a mention the Host cannot read (R3)', async () => {
  const realm = await newRealm()
  const { holder } = bridgeGlobal()
  const { document, composers } = realm.page(holder, { sessions: [TAGGED] })
  const route = realm.route(holder, document)
  route.install()
  const [answer] = pick(realm, route, document, composers[0].fileInput, [folder()])
  // `''` is the only answer that reaches `attachment.pathUnavailable`; a path would become a
  // folder chip for a Host that cannot read it, and a relative path would be `@folder/`.
  assert.deepEqual(answer, { kind: 'refused', reason: 'attachment.pathUnavailable' })
  assert.equal(shared.isUploadableFile(folder()), false)
  assert.equal(route.takeNotice().sessionId, TAGGED)
})

test('a frozen bridge: no wrap, and the reason is visible before any pick (R5)', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal({ frozen: true })
  const { document } = realm.page(holder, { sessions: [TAGGED] })
  const route = realm.route(holder, document)
  assert.deepEqual(route.install(), { surface: HOST_PATHS, wrapped: false, reason: 'bridge-frozen', shape: null, calls: 0 })
  assert.equal(bridge.pathFor(zip()), `${DOWNLOADS}\\bundle.zip`, 'DSH keeps its own behaviour')
  assert.equal(route.status().reason, 'bridge-frozen', 'measured every time it is asked')
})

// ----------------------------------------------------------------- attribution

test('the picker is a SIBLING of the composer input, and DSH empties it BEFORE pathFor runs', async () => {
  const realm = await newRealm()
  const { document, composers } = createFakeComposerDocument({ sessions: [LOCAL, TAGGED] })
  const { card, row, input, tools, fileInput } = composers[1]
  assert.equal(input.querySelectorAll(realm.FILE_INPUT_SELECTOR).length, 0, 'the picker is not inside [data-composer-input]')
  assert.equal(fileInput.closest(realm.COMPOSER_INPUT_SELECTOR), null, 'and the composer input is not an ancestor of the picker')
  assert.equal(fileInput.parent, tools, 'it sits in the input bar\'s tools row')
  assert.equal(tools.parent, row, 'the tools row is inside the composer\'s row')
  assert.equal(row.parent, card, '…and that row shares the composer card with the input')
  assert.equal(realm.composerContainerOf(fileInput), card, 'the container is the deepest element holding both')
  assert.deepEqual(realm.attributionOfPicker(fileInput), { state: 'certain', sessionId: TAGGED, sites: 2, view: composers[1].root, container: card })
  // The order that breaks any `.files`-based attribution: DSH's own listener (registered per
  // picker by the fake) runs in the bubble phase and resets the picker before
  // `intakeFiles(picked)` hands the files to `addFiles`, where `pathFor` is called.
  let seen = null
  document.addEventListener('change', (event) => {
    if (event.currentTarget === document) seen = event.target.files?.length
  }, true)
  pickFiles(document, fileInput, [zip()], () => {
    assert.equal(fileInput.files, null, 'by the time pathFor runs, DSH has reset the picker')
    assert.equal(fileInput.value, '')
    return ''
  })
  assert.equal(seen, 1, 'only the capture phase still sees the files')
  assert.equal(composers[1].intake.picked.length, 1, 'and DSH itself still, correctly, got the file')
})

test('R6: a claim from the capture phase attributes each pick to its composer, across the reset', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal()
  const { document, composers } = realm.page(holder, { sessions: [LOCAL, TAGGED] })
  const route = realm.route(holder, document)
  route.install()
  const listener = (event) => { realm.adoptPickerFrom(route, event) }
  document.addEventListener(realm.PICK_EVENT, listener, true)
  try {
    // Remote composer: the claim survives DSH's drain-and-reset, so the answer is `''`.
    assert.deepEqual(pickFiles(document, composers[1].fileInput, [zip()], (file) => bridge.pathFor(file)), [''])
    // Local composer: the same mechanism answers DSH's own path.
    assert.deepEqual(pickFiles(document, composers[0].fileInput, [zip()], (file) => bridge.pathFor(file)), [`${DOWNLOADS}\\bundle.zip`])
  } finally {
    document.removeEventListener(realm.PICK_EVENT, listener, true)
  }
  assert.equal(route.status().calls, 2, 'each pick reached this wrap exactly once')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(route.pendingPick, null, 'and each one-file batch ended on its own answer')
})

test('R6: a multi-file batch keeps its attribution for every file', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal()
  const { document, composers } = realm.page(holder, { sessions: [LOCAL, TAGGED] })
  const route = realm.route(holder, document)
  route.install()
  const listener = (event) => { realm.adoptPickerFrom(route, event) }
  document.addEventListener(realm.PICK_EVENT, listener, true)
  try {
    // DSH's `onPickFiles` drains the FileList into an array, resets `value`, then
    // `addFiles` loops the array synchronously: one claim, several pathFor calls.
    const answers = pickFiles(document, composers[1].fileInput, [zip(), { name: 'notes.txt', type: 'text/plain', size: 3 }, image()],
      (file) => bridge.pathFor(file))
    assert.deepEqual(answers, ['', '', `${DOWNLOADS}\\shot.png`], 'every non-image file of the batch uploads; the image keeps its path')
  } finally {
    document.removeEventListener(realm.PICK_EVENT, listener, true)
  }
})

test('R6: one pick and then a call with no pick of its own — never pick A\'s session', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal()
  const { document, composers } = realm.page(holder, { sessions: [TAGGED] })
  const route = realm.route(holder, document)
  route.install()
  const listener = (event) => { realm.adoptPickerFrom(route, event) }
  document.addEventListener(realm.PICK_EVENT, listener, true)
  try {
    // Pick A is claimed, then answered — and its one-file batch ends with that answer.
    assert.deepEqual(pickFiles(document, composers[0].fileInput, [zip()], (file) => bridge.pathFor(file)), [''])
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(route.pendingPick, null, 'one answer ended the one-file batch')
    // A later call with no pick behind it (a drop, a paste, an unclaimed file) keeps DSH's
    // own answer and says so; it never inherits pick A's remote session.
    assert.equal(bridge.pathFor(zip()), `${DOWNLOADS}\\bundle.zip`, 'DSH\'s own answer')
    assert.equal(route.takeNotice().reason, 'no-document', 'and the page says which state it was')
    // A picker outside the document: the event saw a file input it cannot place.
    const elsewhere = makeForeignPicker()
    assert.equal(realm.adoptPickerFrom(route, { type: 'change', target: elsewhere, timeStamp: 2001 }).state, 'picker-document')
    assert.equal(bridge.pathFor(zip()), `${DOWNLOADS}\\bundle.zip`)
    assert.equal(route.lastPick, 'picker-document')
  } finally {
    document.removeEventListener(realm.PICK_EVENT, listener, true)
  }
})

test('R6: a picker outside every composer is not a composer pick', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal()
  const { document, loosePicker } = realm.page(holder, { sessions: [TAGGED], picker: true })
  const route = realm.route(holder, document)
  route.install()
  let claimed = null
  const listener = (event) => { claimed = realm.adoptPickerFrom(route, event) }
  document.addEventListener(realm.PICK_EVENT, listener, true)
  try {
    assert.deepEqual(pickFiles(document, loosePicker, [zip()], (file) => bridge.pathFor(file)), [`${DOWNLOADS}\\bundle.zip`])
  } finally {
    document.removeEventListener(realm.PICK_EVENT, listener, true)
  }
  assert.equal(claimed.state, 'picker-elsewhere', 'the capture phase saw a pick from no composer')
  assert.equal(route.lastPick, 'picker-elsewhere', 'and the page says so')
})

test('R6: a batch DSH refuses BEFORE pathFor answers once never claims a later call', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal()
  const { document, composers } = realm.page(holder, { sessions: [LOCAL, TAGGED] })
  const route = realm.route(holder, document)
  route.install()
  let claimed = null
  const listener = (event) => { claimed = realm.adoptPickerFrom(route, event) }
  document.addEventListener(realm.PICK_EVENT, listener, true)
  try {
    // Locked, busy, denied, the image limit, an emptied picker: the `change` fires — DSH's own
    // bubble handler runs, because the fake picker always dispatches — and DSH never asks its bridge.
    assert.equal(claimed, null)
    assert.deepEqual(pickFiles(document, composers[1].fileInput, [], (file) => bridge.pathFor(file)), [])
    assert.equal(claimed.state, 'certain', 'the picker was claimed for the REMOTE composer')
    assert.equal(route.pendingPick.pending, false, 'and no pathFor answered it')
    await settleMicrotasks()
    // A later turn, an unattributed call keeps DSH\'s own answer: never the refused pick\'s session.
    assert.equal(bridge.pathFor(zip()), `${DOWNLOADS}\\bundle.zip`)
    assert.equal(route.lastPick, 'no-document')
    assert.equal(route.takeNotice().reason, 'no-document')
  } finally {
    document.removeEventListener(realm.PICK_EVENT, listener, true)
  }
})

test('R6 (reviewer round 4): the claim is bound to the picked FILES — an unrelated file before expiry keeps DSH\'s path', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal()
  const { document, composers } = realm.page(holder, { sessions: [TAGGED, LOCAL] })
  const route = realm.route(holder, document)
  route.install()
  const listener = (event) => { realm.adoptPickerFrom(route, event) }
  document.addEventListener(realm.PICK_EVENT, listener, true)
  try {
    const picked = zip()
    // The capture phase binds the claim to the exact File objects still in the picker.
    fileInputFiles(composers[0].fileInput, [picked])
    document.dispatch({ type: 'change', target: composers[0].fileInput, timeStamp: 4000 })
    assert.equal(route.pendingPick.files, 1, 'one file was captured with the claim')
    // A queued microtask answers an UNRELATED file before DSH's own loop asks about the pick:
    // it is not this pick, so it keeps DSH's native answer.
    let unrelated = null
    queueMicrotask(() => { unrelated = bridge.pathFor({ name: 'other.txt', type: 'text/plain', size: 5 }) })
    // Inside the turn the claim holds: DSH's own loop then asks about the file that WAS picked,
    // and that one uploads — the unrelated call did not spend the pick.
    const pickedAnswer = bridge.pathFor(picked)
    await settleMicrotasks()
    assert.equal(unrelated, `${DOWNLOADS}\\other.txt`, 'the unrelated file keeps DSH\'s own path')
    assert.equal(pickedAnswer, '', 'the picked file uploads, even after an unrelated call in its turn')
    // The turn is over: nothing of the pick answers a later call, the picked file's own repeat
    // included.
    assert.equal(bridge.pathFor(picked), `${DOWNLOADS}\\bundle.zip`, 'the batch is over: DSH\'s own answer')
    assert.equal(bridge.pathFor(image()), `${DOWNLOADS}\\shot.png`)
    await settleMicrotasks()
    assert.equal(route.pendingPick, null, 'and the pick is over with its turn')
  } finally {
    document.removeEventListener(realm.PICK_EVENT, listener, true)
  }
})

test('R6 (reviewer round 4): a batch DSH refuses before pathFor, then an unrelated microtask call — native path', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal()
  const { document, composers } = realm.page(holder, { sessions: [LOCAL, TAGGED] })
  const route = realm.route(holder, document)
  route.install()
  const listener = (event) => { realm.adoptPickerFrom(route, event) }
  document.addEventListener(realm.PICK_EVENT, listener, true)
  try {
    // The user picks for the REMOTE composer, and DSH refuses the batch before asking at all
    // (a locked composer, the image limit, an emptied picker).
    const refused = zip()
    fileInputFiles(composers[1].fileInput, [refused])
    document.dispatch({ type: 'change', target: composers[1].fileInput, timeStamp: 4100 })
    assert.equal(route.pendingPick.sessionId, TAGGED, 'the pick WAS claimed for the remote composer')
    // A queued microtask then calls pathFor for something else entirely — before the claim's
    // macrotask ends it. It used to spend the claim and answer '' for a local file.
    let unrelated = null
    queueMicrotask(() => { unrelated = bridge.pathFor({ name: 'notes.txt', type: 'text/plain', size: 3 }) })
    // DSH's own loop never asks about the pick: nothing consumes it, and its owned turn (the
    // microtasks the capture queued) is over.
    await Promise.resolve()
    assert.equal(unrelated, `${DOWNLOADS}\\notes.txt`, 'DSH\'s own path, never "upload these bytes"')
    // Nothing is ended early for it: the pick is still the claim's, no answer consumed it.
    assert.equal(route.pendingPick.files, 1, 'the refused pick is not spent on that call')
    await settleMicrotasks()
    assert.equal(route.pendingPick, null, 'the refused batch ends with its turn and task, as before')
    assert.equal(bridge.pathFor({ name: 'later.txt', type: 'text/plain', size: 1 }), `${DOWNLOADS}\\later.txt`)
    assert.equal(route.lastPick, 'no-document', 'and a later call has no claim at all')
  } finally {
    document.removeEventListener(realm.PICK_EVENT, listener, true)
  }
})

test('R6: focus and "the only composer present" are not proof', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal()
  const { document, composers } = realm.page(holder, { sessions: [TAGGED] })
  const route = realm.route(holder, document)
  route.install()
  // Nothing claimed (a drop, a paste, a direct call) — even with one composer and focus in it.
  document.activeElement = composers[0].input
  assert.equal(bridge.pathFor(zip()), `${DOWNLOADS}\\bundle.zip`)
  assert.equal(route.lastPick, 'no-document', 'no claim: DSH\'s own behaviour, and the page says so')
  assert.equal(route.takeNotice().reason, 'no-document')
})

test('R6: a composer with no session view (hero) keeps DSH\'s behaviour, and says so', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal()
  const { document, composers } = realm.page(holder, { sessions: [], hero: true })
  const route = realm.route(holder, document)
  route.install()
  assert.equal(realm.attributionOfPicker(composers[0].fileInput).state, 'no-session')
  const listener = (event) => { realm.adoptPickerFrom(route, event) }
  document.addEventListener(realm.PICK_EVENT, listener, true)
  try {
    assert.deepEqual(pickFiles(document, composers[0].fileInput, [zip()], (file) => bridge.pathFor(file)), [`${DOWNLOADS}\\bundle.zip`])
  } finally {
    document.removeEventListener(realm.PICK_EVENT, listener, true)
  }
  assert.equal(route.lastPick, 'no-session', 'the hero has no session, and R6 never uploads for a guess')
})

test('R6: a claim whose composer unmounted before pathFor is a stale batch, not a session', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal()
  const { document, composers } = realm.page(holder, { sessions: [TAGGED] })
  const route = realm.route(holder, document)
  route.install()
  const listener = (event) => { realm.adoptPickerFrom(route, event) }
  document.addEventListener(realm.PICK_EVENT, listener, true)
  try {
    // The claim is made, then the composer leaves the document before pathFor runs.
    document.dispatch({ type: 'change', target: composers[0].fileInput, timeStamp: 3000 })
    document.remove(composers[0].root)
    assert.equal(bridge.pathFor(zip()), `${DOWNLOADS}\\bundle.zip`)
    assert.equal(route.lastPick, 'stale-batch')
    assert.equal(route.takeNotice().reason, 'stale-batch')
  } finally {
    document.removeEventListener(realm.PICK_EVENT, listener, true)
  }
})

test('attributionOfPicker and composerSites read DSH\'s anchors and name every refusal', async () => {
  const realm = await newRealm()
  const { document, composers } = createFakeComposerDocument({ sessions: [LOCAL, TAGGED] })
  assert.deepEqual(realm.composerSites(document).map((site) => site.sessionId), [LOCAL, TAGGED])
  assert.equal(realm.SESSION_VIEW_SELECTOR, '[data-conversation-session]')
  assert.equal(realm.COMPOSER_INPUT_SELECTOR, '[data-composer-input]')
  assert.equal(realm.COMPOSER_SEAT_SELECTOR, '[data-conversation-region="composer"]')
  assert.equal(realm.FILE_INPUT_SELECTOR, '[hidden] input[type="file"]')
  assert.equal(realm.PICK_EVENT, 'change')
  for (const state of realm.ATTRIBUTION_STATES) assert.ok(typeof state === 'string' && state !== '')
  for (const state of ['certain', 'picker-document', 'no-composer', 'picker-elsewhere', 'composer-uncertain', 'no-session', 'stale-batch'])
    assert.ok(realm.ATTRIBUTION_STATES.includes(state), state)
  // A page-level picker (not DSH's) and a composer card that lost its input.
  const loose = createFakeComposerDocument({ sessions: [TAGGED], picker: true })
  assert.equal(realm.attributionOfPicker(loose.loosePicker).state, 'picker-elsewhere')
  const hidden = createFakeComposerDocument({ sessions: [TAGGED], hidInputs: true })
  assert.equal(realm.attributionOfPicker(hidden.composers[0].fileInput).state, 'no-composer',
    'an input without [data-composer-input] is not a composer this module can name')
  void composers
})

test('R6: an unrelated file input in the same session view, outside the composer region, is no claim', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal()
  // The session view holds exactly ONE composer input — the shape the forbidden "only composer"
  // heuristic accepted — and an unrelated file input beside its seat, in the transcript.
  const { document, composers } = realm.page(holder, { sessions: [TAGGED], elsewhere: true })
  const { root, elsewhere } = composers[0]
  assert.equal(root.querySelectorAll(realm.COMPOSER_INPUT_SELECTOR).length, 1, 'one composer input in this session view')
  assert.equal(elsewhere.parent, root, 'the unrelated picker is in the same session view')
  assert.equal(elsewhere.closest(realm.COMPOSER_SEAT_SELECTOR), null, '…but outside the composer region')
  // The walk never reached the session view (or the page) to find that one composer input.
  assert.equal(realm.composerContainerOf(elsewhere), null, 'no suite holds this picker inside a composer region')
  assert.deepEqual(realm.attributionOfPicker(elsewhere),
    { state: 'picker-elsewhere', sessionId: null, sites: 1, view: null, container: null })
  const route = realm.route(holder, document)
  route.install()
  const listener = (event) => { realm.adoptPickerFrom(route, event) }
  document.addEventListener(realm.PICK_EVENT, listener, true)
  try {
    assert.deepEqual(pickFiles(document, elsewhere, [zip()], (file) => bridge.pathFor(file)),
      [`${DOWNLOADS}\\bundle.zip`], 'DSH\'s own answer: the pick is not attributed to the session around it')
  } finally {
    document.removeEventListener(realm.PICK_EVENT, listener, true)
  }
  assert.equal(route.lastPick, 'picker-elsewhere', 'and the page says which state it was')
  // The composer's own picker in that same view is still certain: the bound is the region, not the count.
  assert.deepEqual(realm.attributionOfPicker(composers[0].fileInput),
    { state: 'certain', sessionId: TAGGED, sites: 1, view: root, container: composers[0].card })
})

test('R6: a picker outside the composer card, in a page container that also holds a composer input, is no claim', async () => {
  const realm = await newRealm()
  // The same card markup mounted with its own composer input but NO composer region above it
  // (a dialog or a start-page bar), beside the session view that holds the real composer: the
  // ladder sees the session and the page each holding composer inputs, so nothing above the card
  // is "the one that holds exactly one", and the count is exactly what must not decide.
  const { holder } = bridgeGlobal()
  const { document, composers } = realm.page(holder, { sessions: [TAGGED], hidSeat: true, dialog: true })
  assert.equal(document.querySelectorAll(realm.COMPOSER_INPUT_SELECTOR).length, 2, 'two composer inputs in the page')
  assert.equal(composers[0].root.querySelectorAll(realm.COMPOSER_INPUT_SELECTOR).length, 1, 'one under the session view')
  assert.equal(realm.composerContainerOf(composers[0].fileInput), null,
    'no composer region above this picker: the count of inputs above it decides nothing')
  assert.equal(realm.attributionOfPicker(composers[0].fileInput).state, 'picker-elsewhere')
})


// ------------------------------------------- A1.2 self-test and the whole decision

test('the self-test is strict: only an absent global passes; null, accessors, keys and shapes name why', async () => {
  const realm = await newRealm()
  assert.equal(realm.hostPathsSelfTest(undefined), null, 'the Web GUI has no bridge — and needs none')
  assert.equal(realm.hostPathsSelfTest(null), 'bridge-shape', 'a null global is a shape mismatch, not an absence')
  assert.equal(realm.hostPathsSelfTest({ pathFor: () => '' }), null)
  assert.equal(realm.hostPathsSelfTest('bridge'), 'bridge-shape')
  assert.equal(realm.hostPathsSelfTest([]), 'bridge-shape')
  assert.equal(realm.hostPathsSelfTest(() => ''), 'bridge-shape')
  assert.equal(realm.hostPathsSelfTest({}), 'bridge-keys')
  assert.equal(realm.hostPathsSelfTest({ pathFor: () => '', extra: 1 }), 'bridge-keys')
  assert.equal(realm.hostPathsSelfTest({ pathFor: () => '', [Symbol('marker')]: 1 }), 'bridge-keys', 'a symbol key is an own key')
  assert.equal(realm.hostPathsSelfTest({ pathFor: 'not a function' }), 'bridge-pathFor')
  // A non-enumerable foreign key is still a foreign key: removing what is not `pathFor` and
  // calling the rest "the same object" is how a wrapper replaces somebody else's bridge.
  const hiddenKey = { pathFor: () => '' }
  Object.defineProperty(hiddenKey, 'hidden', { value: 1, enumerable: false })
  assert.equal(realm.hostPathsSelfTest(hiddenKey), 'bridge-keys')
  // An accessor `pathFor` is not DSH's preload object, even when it reads as a function.
  const accessor = {}
  Object.defineProperty(accessor, 'pathFor', { get: () => () => '', enumerable: true, configurable: true })
  assert.equal(realm.hostPathsSelfTest(accessor), 'bridge-pathFor')
})

test('a mismatch means no wrap, a visible reason, and never a throw', async () => {
  const realm = await newRealm()
  const cases = [
    // A null global IS a shape mismatch (R5 lists it beside a frozen bridge), not an
    // absence: a preload that exposed nothing and a preload that exposed null differ.
    ['keys', (holder) => { holder[HOST_PATHS] = { pathFor: () => '/x', [Symbol.for('m')]: 1 } }, 'bridge-keys', false],
    // A getter on the global is a property this module cannot measure, so it refuses it
    // rather than read it (the read may throw) — and it touches nothing.
    ['accessor', (holder) => Object.defineProperty(holder, HOST_PATHS, { get: () => ({ pathFor: () => '/x' }), configurable: true }), 'bridge-shape', false],
    ['null', (holder) => { holder[HOST_PATHS] = null }, 'bridge-shape', false],
    ['shape', (holder) => { holder[HOST_PATHS] = 'bridge' }, 'bridge-shape', false],
    ['absent', (holder) => { void holder }, 'no-bridge', true],
  ]
  for (const [name, build, reason, wrapped] of cases) {
    const holder = {}
    build(holder)
    const before = Object.getOwnPropertyDescriptor(holder, HOST_PATHS)
    let status
    assert.doesNotThrow(() => { status = realm.install(holder) }, name)
    assert.equal(status.wrapped, wrapped, `${name}: wrapped`)
    assert.equal(status.reason, reason, name)
    sameDescriptor(Object.getOwnPropertyDescriptor(holder, HOST_PATHS), before)
    if (before === undefined) assert.equal(HOST_PATHS in holder, false, `${name}: nothing was added`)
    else assert.equal(Object.getOwnPropertyDescriptor(holder, HOST_PATHS).value, before.value, `${name}: the binding holds what it held`)
  }
})

test('the Web GUI (no bridge) is not a failure, and nothing is installed', async () => {
  const realm = await newRealm()
  const holder = {}
  const status = realm.install(holder)
  assert.deepEqual(status, { surface: HOST_PATHS, wrapped: true, reason: 'no-bridge', shape: null, calls: 0 })
  assert.equal(Object.getOwnPropertyDescriptor(holder, HOST_PATHS), undefined)
})

// -------------------------------------------------------------------- dispose

/** The descriptor's own fields, compared one by one: `deepEqual` on descriptors never holds. */
function sameDescriptor(actual, expected) {
  if (expected === undefined) {
    assert.equal(actual, undefined, 'still no binding')
    return
  }
  assert.notEqual(actual, undefined, 'the binding exists')
  for (const key of ['value', 'get', 'set', 'writable', 'enumerable', 'configurable']) {
    if (key in expected || key in actual) assert.deepEqual(actual[key], expected[key], key)
  }
}

test('dispose puts back the exact method and descriptor of the bridge member (in place)', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal()
  const { document } = realm.page(holder, { sessions: [TAGGED] })
  const original = Object.getOwnPropertyDescriptor(bridge, 'pathFor')
  const route = realm.route(holder, document)
  route.install()
  assert.notEqual(bridge.pathFor, original.value)
  route.uninstall()
  const restored = Object.getOwnPropertyDescriptor(bridge, 'pathFor')
  assert.equal(restored.value, original.value, 'the same function object, not an equivalent one')
  for (const key of ['writable', 'enumerable', 'configurable']) assert.equal(restored[key], original[key], key)
  assert.equal(holder[HOST_PATHS], bridge)
  assert.equal(route.status().wrapped, false)
})

test('dispose puts back the bridge member\'s OWN descriptor, not the global binding\'s flags (in place)', async () => {
  const realm = await newRealm()
  // A sealed bridge (no new field, `pathFor` still a writable configurable field): the in-place
  // shape, where the member's own flags are the only flags in play. `enumerable: true` on the
  // member against a non-enumerable binding, and the binding is never re-pointed here. Restoring
  // the binding's descriptor instead would carry `enumerable: false` onto the member.
  const original = (file) => `${DOWNLOADS}\\${file.name}`
  const bridge = {}
  Object.defineProperty(bridge, 'pathFor', { value: original, writable: true, enumerable: true, configurable: true })
  Object.seal(bridge)
  const holder = {}
  Object.defineProperty(holder, HOST_PATHS, { value: bridge, writable: true, configurable: true, enumerable: false })
  const beforeMember = Object.getOwnPropertyDescriptor(bridge, 'pathFor')
  const beforeBinding = Object.getOwnPropertyDescriptor(holder, HOST_PATHS)
  const { document } = realm.page(holder, { sessions: [TAGGED] })
  const route = realm.route(holder, document)
  assert.equal(route.install().shape, 'in-place')
  assert.notEqual(bridge.pathFor, original, 'wrapped in place')
  route.uninstall()
  const restored = Object.getOwnPropertyDescriptor(bridge, 'pathFor')
  assert.equal(restored.value, original, 'the same function object')
  for (const key of ['writable', 'enumerable', 'configurable']) assert.equal(restored[key], beforeMember[key], `member ${key}`)
  sameDescriptor(Object.getOwnPropertyDescriptor(holder, HOST_PATHS), beforeBinding)
  assert.equal(holder[HOST_PATHS], bridge)
  assert.equal(route.status().wrapped, false, 'and the wrap is gone again')
})

test('immutable member: NO wrap (bridge-frozen), and a composer that kept the original stays DSH\'s own [reviewer 2026-11-16]', async () => {
  const realm = await newRealm()
  const { holder, bridge } = immutableMember()
  const beforeMember = Object.getOwnPropertyDescriptor(bridge, 'pathFor')
  const beforeBinding = Object.getOwnPropertyDescriptor(holder, HOST_PATHS)
  const { document, composers } = realm.page(holder, { sessions: [TAGGED] })
  const route = realm.route(holder, document)
  // DSH's composer inject captured the bridge BEFORE the chunk arrived (`apply.ts:504`):
  // this reference is what that composer calls (`:520`) for as long as it is mounted.
  const retained = holder[HOST_PATHS]
  assert.deepEqual(route.install(), { surface: HOST_PATHS, wrapped: false, reason: 'bridge-frozen', shape: null, calls: 0 },
    'install refuses instead of reporting a wrap the composers would not see')
  // The install touched NOTHING: not the member, not the binding (the old delegating mode
  // re-pointed the binding, which this composer was not reading, and called that success).
  sameDescriptor(Object.getOwnPropertyDescriptor(bridge, 'pathFor'), beforeMember)
  sameDescriptor(Object.getOwnPropertyDescriptor(holder, HOST_PATHS), beforeBinding)
  assert.equal(holder[HOST_PATHS], bridge, 'the same bridge object, never a delegating replacement')
  assert.equal(retained, bridge)
  // The pick through the retained reference: either it is intercepted (in-place case) or
  // install reported refused (this case). Here: refused, and visibly so.
  assert.deepEqual(pick(realm, route, document, composers[0].fileInput, [zip()], retained),
    [{ kind: 'mention', ref: `@"${DOWNLOADS}\\bundle.zip"` }],
    'the composer keeps DSH\'s own answer — and the page says why it is not uploaded')
  assert.equal(route.status().wrapped, false)
  assert.equal(route.status().reason, 'bridge-frozen', 'the reason survives the pick, so it is what the page shows')
  assert.equal(route.status().calls, 0, 'the wrap never ran: nothing was wrapped')
})

test('in-place: a composer that kept the bridge before install() is intercepted through that reference', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal()
  const { document, composers } = realm.page(holder, { sessions: [TAGGED] })
  const route = realm.route(holder, document)
  const retained = holder[HOST_PATHS]
  assert.equal(retained, bridge)
  assert.equal(route.install().shape, 'in-place')
  // Not `holder[HOST_PATHS]`: the object the composer captured, exactly as `apply.ts:520`
  // calls it. The wrap must reach it, or the remote pick becomes a controller path again.
  assert.deepEqual(pick(realm, route, document, composers[0].fileInput, [zip()], retained), [{ kind: 'upload' }])
  assert.equal(route.status().calls, 1, 'the wrap ran through the captured object')
  route.uninstall()
  assert.equal(bridge.pathFor(zip()), `${DOWNLOADS}\\bundle.zip`, 'and dispose put DSH\'s own method back')
})

test('dispose leaves another instance\'s overwrite alone (in place)', async () => {  const realm = await newRealm()
  // In place: someone rewrote the bridge's own pathFor after us.
  const first = bridgeGlobal()
  const firstRoute = realm.route(first.holder, realm.page(first.holder, { sessions: [TAGGED] }).document)
  firstRoute.install()
  const theirs = () => '/theirs'
  first.bridge.pathFor = theirs
  assert.equal(firstRoute.status().reason, 'bridge-replaced')
  firstRoute.uninstall()
  assert.equal(first.bridge.pathFor, theirs, 'not ours any more: left in place')
  // In place: someone re-defined it as an accessor after us.
  const second = bridgeGlobal()
  const secondRoute = realm.route(second.holder, realm.page(second.holder, { sessions: [TAGGED] }).document)
  secondRoute.install()
  const accessor = { get: () => () => '/accessor', configurable: true }
  Object.defineProperty(second.bridge, 'pathFor', accessor)
  secondRoute.uninstall()
  assert.equal(Object.getOwnPropertyDescriptor(second.bridge, 'pathFor').get, accessor.get, 'an accessor another writer installed stays')
  // The global binding was never ours to re-point, so a later writer's binding is untouched
  // by an immutable-member instance too: it measured its refusal and stopped there.
  const third = immutableMember()
  const thirdRoute = realm.route(third.holder, realm.page(third.holder, { sessions: [TAGGED] }).document)
  assert.equal(thirdRoute.install().reason, 'bridge-frozen')
  const foreign = { pathFor: () => '/someone/else' }
  third.holder[HOST_PATHS] = foreign
  thirdRoute.uninstall()
  assert.equal(third.holder[HOST_PATHS], foreign, 'a later writer is never clobbered')
})

test('freeze after install, then dispose: the wrapper stays a callable passthrough, and the page says bridge-frozen [reviewer round 4]', async () => {
  const realm = await newRealm()
  // DSH's own preload answers `""` for a non-file, the fixture the last assertion needs.
  const bridge = fileBridge()
  const holder = {}
  Object.defineProperty(holder, HOST_PATHS, { value: bridge, writable: true, configurable: true, enumerable: false })
  const original = Object.getOwnPropertyDescriptor(bridge, 'pathFor').value
  const { document, composers } = realm.page(holder, { sessions: [TAGGED] })
  const route = realm.route(holder, document)
  assert.equal(route.install().shape, 'in-place')
  const wrapper = bridge.pathFor
  assert.notEqual(wrapper, original, 'the member is our wrapper')
  // The slot is frozen AFTER install: neither the wrapper nor the original can be written
  // back now. `Reflect.defineProperty` answers `false`, it does not throw.
  Object.freeze(bridge)
  assert.equal(Reflect.defineProperty(bridge, 'pathFor', { value: original }), false, 'the refusal is a boolean')
  route.uninstall()
  assert.equal(bridge.pathFor, wrapper, 'the wrapper is still the member DSH\'s composers read')
  assert.deepEqual(route.status(), { surface: HOST_PATHS, wrapped: false, reason: 'bridge-frozen', shape: 'frozen', calls: 0 },
    'and the page is told the bridge is frozen, not that it was restored')
  // It is never gutted: DSH's own answer for every call, no upload, no attribution — a
  // composer pick included, and a drop's `pathFor(null)` stays DSH's own `undefined`.
  assert.equal(bridge.pathFor(zip()), `${DOWNLOADS}\\bundle.zip`, 'the native answer, not undefined')
  assert.equal(bridge.pathFor(null), '', 'DSH\'s own answer for a non-file (preload getPathForFile) stays what it was')
  const listener = (event) => { realm.adoptPickerFrom(route, event) }
  document.addEventListener(realm.PICK_EVENT, listener, true)
  try {
    assert.deepEqual(pick(realm, route, document, composers[0].fileInput, [zip()]),
      [{ kind: 'mention', ref: `@"${DOWNLOADS}\\bundle.zip"` }],
      'a pick after the freeze keeps DSH\'s own behaviour, visibly: nothing is claimed or uploaded')
  } finally {
    document.removeEventListener(realm.PICK_EVENT, listener, true)
  }
  assert.equal(route.pendingPick, null, 'a frozen wrapper claims nothing')  // A second dispose is a no-op for the bridge and keeps saying why.
  route.uninstall()
  assert.equal(bridge.pathFor, wrapper)
  assert.equal(route.status().reason, 'bridge-frozen')
  // The pass-through really is the original: the bridge it is called on is passed through as
  // `this`, exactly as DSH calls the member.
  assert.equal(original.call(bridge, zip()), bridge.pathFor(zip()))
})

test('non-configurable but still writable after install, then dispose: the original goes back, never a non-callable stand-in [reviewer finding 2026-11-16]', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal()
  const original = Object.getOwnPropertyDescriptor(bridge, 'pathFor').value
  const { document, composers } = realm.page(holder, { sessions: [TAGGED] })
  const route = realm.route(holder, document)
  assert.equal(route.install().shape, 'in-place')
  const wrapper = bridge.pathFor
  assert.notEqual(wrapper, original, 'the member is our wrapper')
  // `defineProperty` with the original flags is refused by this slot (it asks for
  // `configurable: true`), yet plain assignment still takes: the shape a restore used to
  // fill with a stand-in OBJECT, which made every composer throw
  // `bridge.pathFor is not a function`.
  Object.defineProperty(bridge, 'pathFor', { configurable: false })
  assert.equal(Reflect.defineProperty(bridge, 'pathFor',
    { value: original, writable: true, configurable: true, enumerable: true }), false,
  'the exact restore is refused by this slot (a boolean): `configurable` cannot be raised again')
  route.uninstall()
  assert.equal(typeof bridge.pathFor, 'function', 'DSH\'s member is always callable after a dispose')
  assert.equal(bridge.pathFor(zip()), `${DOWNLOADS}\\bundle.zip`, 'the bridge\'s own answer, not a stand-in')
  assert.equal(bridge.pathFor, original, 'the exact original is back: assignment was tried before any fallback')
  assert.deepEqual(route.status(), { surface: HOST_PATHS, wrapped: false, reason: 'bridge-frozen', shape: 'frozen', calls: 0 },
    'the restore was not the exact one, so the page still says bridge-frozen')
  // The pick a composer makes now is DSH's own, through the reference DSH holds.
  assert.deepEqual(pick(realm, route, document, composers[0].fileInput, [zip()]),
    [{ kind: 'mention', ref: `@"${DOWNLOADS}\\bundle.zip"` }])
})

// ------------------------------------------------------------- one instance

test('one instance per global: a second install never wraps the first wrapper', async () => {
  const realm = await newRealm()
  const { holder, bridge } = bridgeGlobal()
  const first = realm.route(holder, realm.page(holder, { sessions: [TAGGED] }).document)
  first.install()
  const wrapped = bridge.pathFor
  assert.equal(realm.remoteFileIntakeFor({ global: holder, log: () => {} }), first)
  first.install()
  assert.equal(bridge.pathFor, wrapped)
})

test('splitTaggedSessionId agrees with the carrier on every shape', () => {
  const samples = [TAGGED, `h:${HOST_ID}:s-1:sub`, LOCAL, '', 'h::x', `h:${HOST_ID}:`, 'h:h:x',
    'H:abc:x', `h:${HOST_ID}:${'x'.repeat(300)}`, 42, null, undefined]
  for (const value of samples) {
    assert.deepEqual(shared.splitTaggedSessionId(value), carrierSplit(value), `carrier and renderer agree on ${String(value)}`)
  }
})

test('the decision table: every session × file row, against DSH\'s own outcome', async () => {
  const rows = [
    [TAGGED, zip(), 'upload'],
    [TAGGED, image(), 'upload'],
    [TAGGED, folder(), 'refused'],
    [LOCAL, zip(), 'mention'],
    [LOCAL, image(), 'upload'],
    [LOCAL, folder(), 'mention'],
  ]
  for (const [session, file, outcome] of rows) {
    const realm = await newRealm()
    const { holder } = bridgeGlobal()
    const { document, composers } = realm.page(holder, { sessions: [session] })
    const route = realm.route(holder, document)
    route.install()
    const [answer] = pick(realm, route, document, composers[0].fileInput, [file])
    assert.equal(answer.kind, outcome, `${session} + ${file.type}`)
  }
})

// ----------------------- measured against the installed DSH (skipped without one)

test('the installed composer still decides a pick this way', (t) => {
  if (!installed()) { t.skip('no installed DSH on this machine: the composer seam was not re-measured'); return }
  const apply = fs.readFileSync(APPLY, 'utf8')
  assert.match(apply, /const path = bridge\?\.pathFor\(file\) \?\? ''/,
    'the composer reads pathFor once per file, with one argument; an absent bridge is ""')
  assert.match(apply, /if \(directory && path === ''\) return t\('attachment\.pathUnavailable'\)/,
    'a directory with no path is DSH\'s own refusal (R3)')
  assert.match(apply, /if \(path === '' \|\| \(!directory && isImageMediaType\(file\.type\)\)\) \{/,
    'a file with no path — or any image — still goes to the byte upload (R1, R2)')
  assert.match(apply, /const relative = relativizeToCwd\(path, cwd\)/,
    'a returned path is relativized first, so a relative default would still be a mention')
  assert.match(apply, /registerFileIntake: fileIntake,/)
  const intake = fs.readFileSync(INTAKE, 'utf8')
  assert.match(intake, /return addFiles\(files, directories\)/,
    'the hook reaches addFiles with the SAME call as a path-less pick')
  assert.match(intake, /intakeFiles, uploadsPending, uploadsHeldText, showToast, canAcceptDrop/, 'the card gate is the same intake')
})

test('the installed renderer still lays out the picker the way the attribution expects', (t) => {
  if (!installed()) { t.skip('no installed DSH on this machine: the DOM anchors were not re-measured'); return }
  const built = fs.readFileSync(BUILT, 'utf8')
  assert.match(built, /"data-conversation-session":sessionId/, 'the session view root declares its session id')
  assert.match(built, /"data-composer-input":true/, 'the composer input is marked')
  assert.match(built, /ref:fileInputRef,type:`file`,multiple:true,disabled:!canAcceptDrop\|\|subagent!==null,hidden:true,onChange:onPickFiles/,
    'DSH\'s picker is hidden and handled by onPickFiles')
  const toolsAt = built.search(/className:InputBar_module_css_default\.tools/)
  const pickerAt = built.indexOf('ref:fileInputRef,type:`file`')
  const inputAt = built.indexOf('ComposerContentEditable')
  assert.ok(toolsAt > 0 && pickerAt > toolsAt, 'the picker is rendered inside the tools row')
  assert.ok(inputAt > 0 && inputAt < toolsAt, '…which comes AFTER the composer input, as its sibling')
  assert.match(built, /const onPickFiles=e=>\{const picked=e\.target\.files===null\?\[\]:\[\.\.\.e\.target\.files\];e\.target\.value=``;/,
    'onPickFiles drains .files and resets value BEFORE intakeFiles')
})

test('the installed preload still exposes exactly {pathFor}', (t) => {
  if (!installed()) { t.skip('no installed DSH on this machine: the preload was not re-measured'); return }
  const preload = fs.readFileSync(PRELOAD, 'utf8')
  assert.match(preload, /contextBridge\.exposeInMainWorld\("__DSH_HOST_PATHS__", \{ pathFor: \(file\) => electron\.webUtils\.getPathForFile\(file\) \}\)/)
  assert.equal(HOST_PATHS, '__DSH_HOST_PATHS__')
  assert.equal(PINNED_DSH_VERSION, '0.2.2-rc.3', 'the release this evidence was read from')
})

test('the installed chunks register in the envelope this chunk copies', (t) => {
  if (!fs.existsSync(TERMINAL_CHUNK)) { t.skip('no installed DSH on this machine: the chunk envelope was not re-measured'); return }
  // Only the head is read: the installed chunk is ~500 KB, and an assertion message that
  // echoed it would bury the run.
  // The installed chunk opens on a newline (the build's banner); the call itself is the rule.
  const head = fs.readFileSync(TERMINAL_CHUNK, 'utf8').slice(0, 1000).trimStart()
  const envelope = ['window.__ModuleLoader__.load({id:', '`@deepseek-ai/dsh-client-ui-sidebar-terminal`', ',chunk:',
    '`client.terminal.js`', ',factory:require=>{'].join('')
  assert.equal(head.startsWith(envelope), true, 'the exact envelope: id, chunk, factory')
  const server = fs.readFileSync(`${MODULES}/lib/index.js`, 'utf8')
  // The exact template `chunkUrl(id, fileName, rev)` of that file returns.
  const chunkRoute = '${PLUGIN_ROUTE}/${id}/${fileName}' + '${sourceMap ? ".map" : ""}' + '?rev=${rev}'
  assert.equal(server.includes(chunkRoute), true, 'the Host serves a chunk at /plugins/<id>/<chunk>?rev=…')
  const loader = fs.readFileSync(`${MODULES}/lib/client.js`, 'utf8')
  assert.match(loader, /loaded without registering/, 'and the loader fails a bundle that did not register')
  assert.match(loader, /const CLIENT_CHUNK=\/\^client\\\.\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\*\\\.js\$\//, 'the chunk name pattern')
})

test('the composer host renders one file input per session view', async () => {
  const Card = () => h('div', { 'data-composer-card': '' },
    h('div', { 'data-composer-input': '', role: 'textbox', 'aria-multiline': 'true' }),
    h('div', { 'data-composer-tools': '' }, h('input', { type: 'file', multiple: true, tabIndex: -1, hidden: true })))
  const Seat = () => h('div', { 'data-composer-seat': '', 'data-conversation-region': 'composer' }, h(Card))
  const View = (props) => h('div', { 'data-conversation-session': props.sessionId, 'data-conversation-region': 'chat' }, h(Seat))
  const renderer = TestRenderer.create(h('div', null, h(View, { sessionId: LOCAL }), h(View, { sessionId: TAGGED })))
  const views = renderer.toJSON().children
  assert.deepEqual(views.map((view) => view.props['data-conversation-session']), [LOCAL, TAGGED])
  assert.deepEqual(views.map((view) => JSON.stringify(view).split('"type":"file"').length - 1), [1, 1])
  renderer.unmount()
})

test('the staged bytes still reach the upload route as a file of this size (spec 013 seam)', async () => {
  // Not a re-test of test/upload-route.test.mjs: this only proves the two halves meet —
  // a tagged id and a `file` kind travel with the bytes, so a pick that the wrap clears
  // arrives at the remote Host as that size and that digest.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec033-'))
  const { createUploadRoute } = await import('../lib/upload-route.mjs')
  const frames = []
  const link = {
    requestTimeoutMs: 5000,
    async request(frame) {
      frames.push(frame)
      if (frame.type === 'remote-upload-open') return { kind: 'remote-upload-result', ok: true, value: { uploadId: 'u1', chunkBytes: 8 } }
      if (frame.type === 'remote-upload-finish') return { kind: 'remote-upload-result', ok: true, value: { receiptId: 'r1', file: { attachmentId: 'a1' } } }
      return { kind: 'remote-upload-result', ok: true, value: { nextOffset: frame.offset + Buffer.from(frame.data, 'base64').length } }
    },
  }
  const record = { methods: new Set(['POST']), requestBody: 'streaming', fetch: async () => new Response('{}') }
  const connection = { fetchRoutes: new Map([['/api/session/uploadFileBinary', record]]) }
  createUploadRoute({ connection, dshVersion: PINNED_DSH_VERSION, log: () => {}, tmpDir: root,
    connect: async () => ({ connection: link }) }).install()
  const payload = Buffer.from('PK\u0003\u0004zip-bytes-for-the-remote-host', 'utf8')
  const request = new Request(`http://127.0.0.1/api/session/uploadFileBinary?sessionId=${encodeURIComponent(TAGGED)}&name=bundle.zip`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, duplex: 'half',
    body: new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close() } }),
  })
  try {
    const answer = await record.fetch(request)
    assert.equal(answer.status, 200)
    assert.deepEqual({ type: frames[0]?.type, sessionId: frames[0]?.sessionId, kind: frames[0]?.kind, size: frames[0]?.size },
      { type: 'remote-upload-open', sessionId: 's-1', kind: 'file', size: payload.length },
      'the remote Host receives the untagged id, the file kind and the pick\'s size')
    assert.equal(frames[0]?.sha256, crypto.createHash('sha256').update(payload).digest('hex'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

void here
