// Spec 033 (constitution amendment A1.2, as revised 2026-11-16): a non-image file picked in a
// composer that shows a session on ANOTHER Host must reach that Host as BYTES, not as a
// controller-local `@"C:\…"` mention.
//
// The first mechanism (wrapping `globalThis.__DSH_HOST_PATHS__.pathFor`) could never work: the
// preload exposes that object through `contextBridge.exposeInMainWorld`, which hands the page a
// FROZEN copy — measured live on the owner's remote client 2026-11-16 (the picked zip still
// became `@"C:\…zip"`, nothing uploaded, the wrap reported `bridge-frozen`). The mechanism now
// wraps nothing at all: in the CAPTURE phase of the picker's `change` — before DSH's own
// `onPickFiles` reads `e.target.files`, its first statement — a pick proven to belong to a
// remote composer is replaced by path-free `File` copies, and DSH's own composer then takes its
// byte path (`apply.ts` `path === ''` → `POST /api/session/uploadFileBinary`, which
// lib/upload-route.mjs routes to the owning Host).
//
// What these tests hold:
//  - the chunk's REGISTRATION ENVELOPE (`window.__ModuleLoader__.load({id, chunk, factory})`,
//    measured in the installed terminal chunk) and the adapter reading the same text;
//  - the mechanism against the REAL domain, on a page shaped like the installed composer with
//    real `File` objects and a replaceable picker list: DSH's own handler, reading the list in
//    BUBBLE order after the capture phase, sees the copies;
//  - the decision table: remote + a non-image file → every pick re-materialized; local,
//    unproven, image-only → untouched; DSH's own outcome per row;
//  - the visible refusals: no `DataTransfer`/`File`, and an installed DSH whose sources no
//    longer read the file list the way the mechanism needs (`dsh-incompatible`);
//  - R6: attribution is read from the picker's own composer, in the composer region;
//  - the seam re-measured against the INSTALLED DSH's own shipped sources (`InputBar.tsx`,
//    `apply.ts`, `preload-app.cjs`, the file-upload client, the chunk loader), so an upgrade
//    that moves it fails here instead of silently turning remote picks back into mentions.
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
import {
  PICKED_ORIGIN, createFakeComposerDocument, createLivePage,
  createWebPage, dispatchIntake, installFileListStub, livePick, picked, pickFiles, settleMicrotasks,
} from './helpers.mjs'

// Node has `File` and `Blob` but no `FileList`; a browser's `input.files = dt.files` needs one.
installFileListStub()

/**
 * One realm per test — what each DSH renderer gets (its own page): the module keeps ONE
 * instance per global in a WeakMap, which is right for a page and wrong for a test file that
 * runs many "pages" through one realm. Each call reloads the adapter.
 */
const ADAPTER_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'remote-file-attach.mjs')).href
let realmCount = 0
async function newRealm() {
  realmCount += 1
  const realm = await import(`${ADAPTER_URL}?realm=${realmCount}`)
  return {
    /** A real-file page (spec 033's live mechanism) bound to THIS realm. */
    live(box, deps = {}) {
      // `picker`/`hero` are part of the page's box (a page-level input, a session-less composer).
      const shape = { ...box }
      delete shape.web
      const made = box.web === true ? createWebPage(shape) : createLivePage(shape)
      // The attachment module only needs the installed-DSH self-test where a path can exist.
      const readFile = box.web === true ? undefined : (relative) => CONTRACT_SOURCES[relative] ?? null
      const attach = realm.remoteFileIntakeFor({ global: made.holder, doc: made.document, log: () => {}, ...(readFile === undefined ? {} : { readFile }), ...deps })
      made.document.addEventListener(realm.PICK_EVENT, (event) => {
        if (event.currentTarget === made.document) realm.adoptPickerFrom(attach, event)
      }, true)
      return { ...made, attach }
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
const UPLOAD_CLIENT = `${APP}/dsh/node_modules/@deepseek-ai/dsh-client-file-upload/lib/client.js`
const MODULES = `${APP}/dsh/node_modules/@deepseek-ai/dsh-client-modules`
const TERMINAL_CHUNK = `${APP}/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-terminal/lib/client.terminal.js`
const installed = () => fs.existsSync(PRELOAD) && fs.existsSync(BUILT) && fs.existsSync(APPLY) && fs.existsSync(INTAKE)

/** DSH's own sources, as the in-page self-test reads them (`lib/client.js servedSourceReader`). */
const CONTRACT_SOURCES = Object.freeze({
  'dsh-client-ui-conversation/src/client/skeleton/InputBar.tsx': fs.readFileSync(INTAKE, 'utf8'),
  'dsh-client-ui-conversation/src/client/apply.ts': fs.readFileSync(APPLY, 'utf8'),
  'dsh-client-file-upload/lib/client.js': fs.readFileSync(UPLOAD_CLIENT, 'utf8'),
})

const zipFile = () => new File([new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4])], 'bundle.zip', { type: 'application/zip', lastModified: 1700000000000 })
const imageFile = () => new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
const folderFile = () => new File([], 'folder', { type: 'inode/directory' })
const DOWNLOADS = 'C:\\Users\\owner\\Downloads'

/** The preload's answer for a file, and `''` for a `File` this page built (no backing path). */
const bridgePathFor = (holder, file) => (file instanceof File ? holder.__DSH_HOST_PATHS__.pathFor(file) : `not-a-file:${String(file)}`)

/** A bridge whose answer is DSH's own, for a realm whose consents this file writes itself. */
function fileBridge(dir = DOWNLOADS) {
  return { pathFor: (file) => (file?.origin === PICKED_ORIGIN ? `${dir}\\${file.name}` : '') }
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
  assert.equal(typeof shared.canRematerialize, 'function')
})

test('the chunk wraps nothing: no bridge member is written, and a frozen contextBridge bridge is left alone', async () => {
  const realm = await newRealm()
  const { holder, attach } = realm.live({ sessions: [TAGGED] })
  const bridge = holder[HOST_PATHS]
  const before = Object.getOwnPropertyDescriptor(bridge, 'pathFor')
  assert.equal(attach.install().state, 'active')
  // The old mechanism had a wrapper with an `ORIGINAL` symbol and a status `shape` of
  // `in-place`/`frozen`; both are gone with it, and the preload's object is untouched.
  assert.equal(shared.HOST_PATHS_ORIGINAL, undefined, 'no wrapper marker is exported any more')
  assert.equal(shared.hostPathsSelfTest, undefined, 'no bridge self-test: nothing is wrapped')
  assert.equal(shared.hostPathsRootOriginal, undefined)
  assert.equal(Object.getOwnPropertyDescriptor(bridge, 'pathFor').value, before.value, 'the bridge\'s own function')
  for (const key of ['writable', 'enumerable', 'configurable']) assert.equal(Object.getOwnPropertyDescriptor(bridge, 'pathFor')[key], before[key], key)
  assert.equal(Object.isFrozen(bridge), true, 'the fixture is the frozen contextBridge copy')
})

// ------------------------------------------------------------- the acceptance

test('remote session + zip: DSH\'s own handler receives a path-free File, so the pick uploads (R1)', async () => {
  const realm = await newRealm()
  const { holder, document, composers, attach } = realm.live({ sessions: [LOCAL, TAGGED] })
  assert.deepEqual(attach.install(), { surface: HOST_PATHS, shape: 'measured', picks: 0, uploaded: 0, state: 'active', reason: null })
  const zip = picked(zipFile())
  let handed = []
  // DSH's own outcome for what its handler reads: a path-free File takes the byte upload, the
  // picked File keeps its path (`bridgePathFor` answers what the preload would). Without the
  // capture-phase replacement (`pathFor: () => ''`) the live page shows `mention` instead —
  // that fixture's own control below.
  const answers = livePick(document, composers[1].fileInput, [zip], (file) => bridgePathFor(holder, file), (pickedFiles) => { handed = pickedFiles })
  assert.deepEqual(answers.map((answer) => answer.kind), ['upload'])
  assert.equal(handed.length, 1)
  const copy = handed[0]
  assert.notEqual(copy, zip, 'DSH got a copy, not the picked File the bridge could name')
  assert.ok(copy instanceof File)
  assert.equal(copy.name, 'bundle.zip')
  assert.equal(copy.type, 'application/zip')
  assert.equal(copy.size, zip.size, 'the same bytes')
  assert.equal(copy.lastModified, 1700000000000, 'the same timestamp')
  assert.equal(holder[HOST_PATHS].pathFor(copy), '', 'and the preload has no path for it: "" is DSH\'s upload answer')
  // The tagged id is what the upload route turns into `remote-upload-*` frames for that Host.
  assert.deepEqual(carrierSplit(TAGGED), { hostId: HOST_ID, sessionId: 's-1' })
  assert.deepEqual(attach.status(), { surface: HOST_PATHS, shape: 'measured', picks: 1, uploaded: 1, state: 'active', reason: null })
  assert.equal(attach.lastPick, null, 'a remote pick uploads, so there is no refusal to report')
})

test('local session: DSH\'s own File object, DSH\'s own path (R2)', async () => {
  const realm = await newRealm()
  const { holder, document, composers, attach } = realm.live({ sessions: [LOCAL] })
  attach.install()
  const zip = picked(zipFile())
  let handed = []
  const answers = livePick(document, composers[0].fileInput, [zip], (file) => bridgePathFor(holder, file), (pickedFiles) => { handed = pickedFiles })
  assert.deepEqual(answers.map((answer) => answer.kind), ['mention'])
  assert.equal(handed[0], zip, 'the very object the user picked')
  assert.equal(attach.lastPick, 'certain', 'the attribution was certain; this pick is simply local')
  assert.equal(attach.takeNotice().sessionId, LOCAL, 'and the page can say it was not uploaded')
})

test('images only, in a remote session: untouched (DSH uploads an image whatever the path says) (R2)', async () => {
  const realm = await newRealm()
  const { holder, document, composers, attach } = realm.live({ sessions: [TAGGED] })
  attach.install()
  const image = picked(imageFile())
  let handed = []
  livePick(document, composers[0].fileInput, [image], (file) => bridgePathFor(holder, file), (pickedFiles) => { handed = pickedFiles })
  assert.equal(handed[0], image, 'the image keeps its own object: nothing about its outcome changes')
  assert.equal(attach.lastPick, 'certain')
  assert.equal(attach.status().uploaded, 0)
})

test('a batch is re-materialized WHOLE: an image beside a zip loses its path too, so DSH creates every draft', async () => {
  const realm = await newRealm()
  const { holder, document, composers, attach } = realm.live({ sessions: [TAGGED] })
  attach.install()
  const image = picked(imageFile())
  const zip = picked(zipFile())
  let handed = []
  // `apply.ts` returns from the loop on the FIRST file whose path cannot be used and only then
  // creates the upload drafts — so a batch DSH accepts as bytes must have no path at all, and
  // the image, whose own outcome never depended on a path, is a copy too.
  const answers = livePick(document, composers[0].fileInput, [image, zip], (file) => bridgePathFor(holder, file), (pickedFiles) => { handed = pickedFiles })
  assert.deepEqual(answers.map((answer) => answer.kind), ['upload', 'upload'])
  assert.equal(handed[0] === image || handed[1] === image, false, 'the image is a copy as well')
  assert.equal(handed[1] === zip || handed[0] === zip, false)
  assert.deepEqual(handed.map((file) => file.name), ['shot.png', 'bundle.zip'], 'picker order is kept')
})

test('a directory keeps its own object: DSH\'s directory rule is not this mechanism\'s business (R3)', async () => {
  const realm = await newRealm()
  const { holder, document, composers, attach } = realm.live({ sessions: [TAGGED] })
  attach.install()
  const folder = picked(folderFile())
  const zip = picked(zipFile())
  let handed = []
  livePick(document, composers[0].fileInput, [folder], (file) => bridgePathFor(holder, file), (pickedFiles) => { handed = pickedFiles })
  assert.equal(handed[0], folder, 'a copy would carry no filesystem entry at all')
  livePick(document, composers[0].fileInput, [folder, zip], (file) => bridgePathFor(holder, file), (pickedFiles) => { handed = pickedFiles })
  assert.equal(handed[0], folder, 'the directory still')
  assert.notEqual(handed[1], zip, 'the file beside it uploads like any other remote file')
})

test('a mixed drop with no remote file at all (local session) is untouched', async () => {
  const realm = await newRealm()
  const { document, composers, attach } = realm.live({ sessions: [LOCAL] })
  attach.install()
  const image = picked(imageFile())
  const zip = picked(zipFile())
  let handed = []
  livePick(document, composers[0].fileInput, [image, zip], (file) => (file.origin === 'picked' ? `${DOWNLOADS}\\${file.name}` : ''), (pickedFiles) => { handed = pickedFiles })
  assert.deepEqual(handed, [image, zip])
})

// ------------------------------------------------------- the visible refusals

test('no DataTransfer or no File: nothing is changed, and the page says why (browser-unavailable)', async () => {
  const cases = [
    ['DataTransfer', (holder) => { holder.DataTransfer = undefined }],
    ['File', (holder) => { holder.File = undefined }],
    ['a DataTransfer that drops what it is given', (holder) => {
      holder.DataTransfer = class { constructor() { this.items = { add() {} } } get files() { return Object.assign([], { item: () => null }) } }
    }],
  ]
  for (const [name, breakRealm] of cases) {
    const realm = await newRealm()
    const { holder, document, composers, attach } = realm.live({ sessions: [TAGGED] })
    breakRealm(holder)
    assert.deepEqual(attach.install(), { surface: HOST_PATHS, shape: null, picks: 0, uploaded: 0, state: 'unavailable', reason: 'browser-unavailable' }, name)
    const zip = picked(zipFile())
    let handed = []
    const answers = livePick(document, composers[0].fileInput, [zip], (file) => bridgePathFor(holder, file), (pickedFiles) => { handed = pickedFiles })
    assert.equal(handed[0], zip, `${name}: DSH's own pick stands`)
    assert.deepEqual(answers.map((answer) => answer.kind), ['mention'], name)
    assert.equal(attach.lastPick, 'browser-unavailable', `${name}: and the pick says why nothing was uploaded`)
    assert.deepEqual(attach.takeNotice(), { reason: 'browser-unavailable', sessionId: TAGGED, sites: 1, intake: null })
  }
})

test('the installed DSH contract is asserted from disk, and a changed contract is reported as not composed', async () => {
  const realm = await newRealm()
  // Activation is the install: the page never fetches DSH sources (they are not served), so an
  // unreadable tree cannot disable the feature. The contract is still asserted — in the tests —
  // from the installed sources on disk (see CONTRACT_SOURCES), and `dshContract` reports each
  // pattern it could not find instead of throwing.
  const { attach } = realm.live({ sessions: [TAGGED] })
  assert.deepEqual(attach.install(), { surface: HOST_PATHS, shape: 'measured', picks: 0, uploaded: 0, state: 'active', reason: null },
    'installing never waits on a source read')
  // A contract whose sources no longer say what the mechanism rests on is reported, pattern by
  // pattern, rather than silently assumed:
  const changed = (relative, text) => (other) => (other === relative ? text : CONTRACT_SOURCES[other])
  const cases = [
    ['InputBar.tsx no longer reads e.target.files first', 'composer', changed('dsh-client-ui-conversation/src/client/skeleton/InputBar.tsx', 'const picked = e.target.files ?? [];')],
    ['apply.ts no longer uploads a path-less file', 'composed', changed('dsh-client-ui-conversation/src/client/apply.ts', 'if (path === null) { uploads.push(file); continue }')],
    ['the upload client stopped posting the file', 'upload', changed('dsh-client-file-upload/lib/client.js', 'return send(data)')],
  ]
  for (const [name, field, readFile] of cases) {
    const contract = shared.dshContract(readFile)
    assert.equal(contract[field], false, `${name}: a changed contract is never composed`)
  }
  // The chunk runs in this realm (`runInThisContext`), so one plain object either side:
  assert.deepEqual({ ...shared.dshContract((relative) => CONTRACT_SOURCES[relative]) }, { composed: true, composer: true, upload: true, read: true })
  // Nothing readable: `read: false` is the fact (nothing claimed), and nothing is composed.
  assert.deepEqual({ ...shared.dshContract(() => null) }, { composed: true, composer: true, upload: true, read: false },
    'nothing readable: not measured, so no claim either way')
})

test('the Web GUI (no bridge): no contract to read, and every remote pick still re-materializes', async () => {
  const realm = await newRealm()
  const { holder, document, composers, attach } = realm.live({ sessions: [TAGGED], web: true })
  assert.equal(HOST_PATHS in holder, false)
  assert.deepEqual(attach.install(), { surface: HOST_PATHS, shape: 'no-bridge', picks: 0, uploaded: 0, state: 'active', reason: null })
  const zip = zipFile()
  let handed = []
  const answers = livePick(document, composers[0].fileInput, [zip], () => '', (pickedFiles) => { handed = pickedFiles })
  assert.notEqual(handed[0], zip)
  assert.deepEqual(answers.map((answer) => answer.kind), ['upload'])
})

// ----------------------------------------------------------------- attribution

test('the picker is a SIBLING of the composer input, and DSH reads the list BEFORE pathFor ever runs', async () => {
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
  // The order the capture phase relies on: DSH's own handler drains `.files` and resets the
  // picker before it hands the files to `addFiles`, so the capture phase is the last moment a
  // replacement could still be seen.
  let seen = null
  document.addEventListener('change', (event) => {
    if (event.currentTarget === document) seen = event.target.files?.length
  }, true)
  pickFiles(document, fileInput, [{ name: 'bundle.zip', type: 'application/zip', size: 11917 }], () => {
    assert.equal(fileInput.files, null, 'by the time pathFor runs, DSH has reset the picker')
    assert.equal(fileInput.value, '')
    return ''
  })
  assert.equal(seen, 1, 'only the capture phase still sees the files')
  assert.equal(composers[1].intake.picked.length, 1, 'and DSH itself still, correctly, got the file')
})

test('R6: the pick is attributed to ITS composer — the second composer\'s pick never takes the first\'s session', async () => {
  const realm = await newRealm()
  const { holder, document, composers, attach } = realm.live({ sessions: [LOCAL, TAGGED] })
  attach.install()
  let handed = []
  const zipLocal = picked(zipFile())
  livePick(document, composers[0].fileInput, [zipLocal], (file) => bridgePathFor(holder, file), (pickedFiles) => { handed = pickedFiles })
  assert.equal(handed[0], zipLocal, 'the local composer keeps its own File')
  const zipRemote = picked(zipFile())
  livePick(document, composers[1].fileInput, [zipRemote], (file) => bridgePathFor(holder, file), (pickedFiles) => { handed = pickedFiles })
  assert.notEqual(handed[0], zipRemote, 'the remote composer\'s pick is a copy')
  assert.equal(attach.claimedPicks, 2)
  assert.equal(attach.endedPicks, 1)
})

test('R6: a picker outside every composer, and a hero with no session, are no claim', async () => {
  const realm = await newRealm()
  {
    const { holder, document, loosePicker, attach } = realm.live({ sessions: [TAGGED], picker: true })
    attach.install()
    const zip = picked(zipFile())
    let handed = []
    livePick(document, loosePicker, [zip], (file) => bridgePathFor(holder, file), (pickedFiles) => { handed = pickedFiles })
    assert.equal(handed[0], zip, 'DSH\'s own pick')
    assert.equal(attach.lastPick, 'picker-elsewhere')
  }
  {
    const page = realm.live({ sessions: [], hero: true })
    page.attach.install()
    assert.equal(realm.attributionOfPicker(page.composers[0].fileInput).state, 'no-session')
    const zip = picked(zipFile())
    let handed = []
    livePick(page.document, page.composers[0].fileInput, [zip], (file) => bridgePathFor(page.holder, file), (pickedFiles) => { handed = pickedFiles })
    assert.equal(handed[0], zip)
    assert.equal(page.attach.lastPick, 'no-session')
  }
})

test('R6: focus and "the only composer present" are not proof', async () => {
  const realm = await newRealm()
  const { holder, document, composers, attach } = realm.live({ sessions: [TAGGED] })
  attach.install()
  document.activeElement = composers[0].input
  const zip = picked(zipFile())
  let handed = []
  livePick(document, composers[0].fileInput, [zip], (file) => bridgePathFor(holder, file), (pickedFiles) => { handed = pickedFiles })
  assert.notEqual(handed[0], zip, 'the composer\'s own session view is what decides, and it is remote')
})

test('R6: a page-level composer card nested in a session view, with no composer seat, is never that session\'s composer', async () => {
  // The R6 case this attribution exists for: a page container (a dialog, a start-page bar)
  // holds a composer input, and the session view around it holds exactly ONE composer input —
  // 2026-11-16 measurement: the old "only composer under an ancestor" reading passed this, so
  // the pick would have been uploaded to the remote Host from an unrelated composer. Without a
  // composer seat above the card's input bar there is nothing that says the card composes
  // THAT session, so the answer is a refusal, never a claim.
  const realm = await newRealm()
  const made = createLivePage({ sessions: [TAGGED], hidSeat: true, dialog: true })
  assert.equal(made.document.querySelectorAll(realm.COMPOSER_INPUT_SELECTOR).length, 2, 'two composer inputs in the page')
  assert.equal(made.document.querySelectorAll(realm.SESSION_VIEW_SELECTOR).length, 1, 'one session view')
  assert.deepEqual(realm.attributionOfPicker(made.composers[0].fileInput),
    { state: 'picker-elsewhere', sessionId: null, sites: 2, view: null, container: null })
  const { holder, attach } = realm.live({ sessions: [TAGGED], hidSeat: true, dialog: true })
  attach.install()
  const zip = picked(zipFile())
  let handed = []
  livePick(holder.document ?? made.document, made.composers[0].fileInput, [zip], (file) => bridgePathFor(holder, file), (pickedFiles) => { handed = pickedFiles })
  assert.equal(handed[0], zip, 'DSH\'s own pick: nothing was claimed')
  assert.equal(attach.lastPick, 'picker-elsewhere')
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
  // The session view holds exactly ONE composer input — the shape the forbidden "only composer"
  // heuristic accepted — and an unrelated file input beside its seat, in the transcript.
  const { document, composers } = createFakeComposerDocument({ sessions: [TAGGED], elsewhere: true })
  const { root, elsewhere } = composers[0]
  assert.equal(root.querySelectorAll(realm.COMPOSER_INPUT_SELECTOR).length, 1, 'one composer input in this session view')
  assert.equal(elsewhere.parent, root, 'the unrelated picker is in the same session view')
  assert.equal(elsewhere.closest(realm.COMPOSER_SEAT_SELECTOR), null, '…but outside the composer region')
  assert.equal(realm.composerContainerOf(elsewhere), null, 'no suite holds this picker inside a composer region')
  assert.deepEqual(realm.attributionOfPicker(elsewhere),
    { state: 'picker-elsewhere', sessionId: null, sites: 1, view: null, container: null })
  assert.deepEqual(realm.attributionOfPicker(composers[0].fileInput),
    { state: 'certain', sessionId: TAGGED, sites: 1, view: root, container: composers[0].card })
})

test('attributionOfPicker refuses a picker from another document', async () => {
  const realm = await newRealm()
  const other = createFakeComposerDocument({ sessions: [LOCAL] }).composers[0].fileInput
  let at = other
  while (at !== null && at !== undefined) { at.ownerDocument = { contains: () => false }; at = at.parent }
  assert.equal(realm.attributionOfPicker(other).state, 'picker-document')
  assert.equal(realm.attributionOfPicker(null).state, 'no-document')
})

// ------------------------------------------------------------- the module state

test('one instance per global: a second request never re-measures or re-installs', async () => {
  const realm = await newRealm()
  const { holder, document, attach } = realm.live({ sessions: [TAGGED] })
  attach.install()
  assert.equal(realm.remoteFileIntakeFor({ global: holder, log: () => {} }), attach)
  assert.equal(attach.install().state, 'active')
})

test('uninstall: every later pick is DSH\'s own again, and the page says the attach is off', async () => {
  const realm = await newRealm()
  const { holder, document, composers, attach } = realm.live({ sessions: [TAGGED] })
  attach.install()
  attach.uninstall()
  assert.deepEqual(attach.status(), { surface: HOST_PATHS, shape: null, picks: 0, uploaded: 0, state: 'unavailable', reason: 'not-installed' })
  const zip = picked(zipFile())
  let handed = []
  livePick(document, composers[0].fileInput, [zip], (file) => bridgePathFor(holder, file), (pickedFiles) => { handed = pickedFiles })
  assert.equal(handed[0], zip)
})

test('splitTaggedSessionId agrees with the carrier on every shape', () => {
  const samples = [TAGGED, `h:${HOST_ID}:s-1:sub`, LOCAL, '', 'h::x', `h:${HOST_ID}:`, 'h:h:x',
    'H:abc:x', `h:${HOST_ID}:${'x'.repeat(300)}`, 42, null, undefined]
  for (const value of samples) {
    assert.deepEqual(shared.splitTaggedSessionId(value), carrierSplit(value), `carrier and renderer agree on ${String(value)}`)
  }
})

// ----------------------- measured against the installed DSH (skipped without one)

test('the installed composer still reads the file list first, in BUBBLE order, and maps an empty path to bytes', (t) => {
  if (!installed()) { t.skip('no installed DSH on this machine: the composer seam was not re-measured'); return }
  const intake = fs.readFileSync(INTAKE, 'utf8')
  // The installed handler, in its own words: `e.target.files` is the FIRST thing it reads.
  assert.match(intake, /const onPickFiles = \(e: ChangeEvent<HTMLInputElement>\): void => \{\n {4}const picked = e\.target\.files === null \? \[\] : \[\.\.\.e\.target\.files\]/,
    'onPickFiles reads e.target.files before anything else')
  assert.match(intake, /e\.target\.value = ''/, '…then resets value so a re-pick re-fires')
  assert.match(intake, /onChange=\{onPickFiles\}/, 'the picker\'s change is React\'s onChange (a root delegate, bubble phase)')
  // The built bundle DSH actually runs.
  const built = fs.readFileSync(BUILT, 'utf8')
  assert.match(built, /const onPickFiles=e=>\{const picked=e\.target\.files===null\?\[\]:\[\.\.\.e\.target\.files\];e\.target\.value=``;/,
    'the built handler still drains the picker first')
  const apply = fs.readFileSync(APPLY, 'utf8')
  assert.match(apply, /const path = bridge\?\.pathFor\(file\) \?\? ''/, 'the composer reads pathFor once per file; an absent bridge is ""')
  assert.match(apply, /if \(path === '' \|\| \(!directory && isImageMediaType\(file\.type\)\)\) \{/, 'a file with no path — or any image — goes to the byte upload (R1, R2)')
  assert.match(apply, /if \(directory && path === ''\) return t\('attachment\.pathUnavailable'\)/, 'a directory with no path is DSH\'s own refusal (R3)')
  assert.match(apply, /const relative = relativizeToCwd\(path, cwd\)/, 'a returned path is relativized first, so a relative default would still be a mention')
  // Why the batch is re-materialized whole: the loop returns before any draft exists.
  assert.match(apply, /const uploads: File\[\] = \[\]/, 'reference files and uploads are collected in ONE loop')
  assert.match(apply, /const drafts = conversation\.createDrafts\(sessionId, uploads, ordinary\)/, 'the uploads are created only after the whole loop passed')
  const upload = fs.readFileSync(UPLOAD_CLIENT, 'utf8')
  assert.match(upload, /return this\.ctx\.remote\.fileUploads\.upload\(/, 'a File is posted as bytes, with no Blob/FormData/size conversion')
  assert.deepEqual({ ...shared.dshContract((relative) => CONTRACT_SOURCES[relative]) }, { composed: true, composer: true, upload: true, read: true })
})

test('the installed preload exposes the bridge through contextBridge (a frozen copy: that is why no wrap)', (t) => {
  if (!installed()) { t.skip('no installed DSH on this machine: the preload was not re-measured'); return }
  const preload = fs.readFileSync(PRELOAD, 'utf8')
  assert.match(preload, /electron\.contextBridge\.exposeInMainWorld\("__DSH_HOST_PATHS__", \{ pathFor: \(file\) => electron\.webUtils\.getPathForFile\(file\) \}\)/)
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
  // Not a re-test of test/upload-route.test.mjs: this only proves the two halves meet — a tagged
  // id and a `file` kind travel with the bytes, so a pick whose copies DSH uploads arrives at
  // the remote Host as that size and that digest.
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
void dispatchIntake
void fileBridge
void settleMicrotasks
