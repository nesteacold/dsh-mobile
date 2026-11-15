// Remote file attach (spec 033, constitution amendment A1.2, owner 2026-11-15).
//
// A RE-EXPORT, not a second implementation. Every function lives in
// `lib/client.remote-file-attach.js` — the package-local client chunk the renderer loads
// (`require.async('./client.remote-file-attach.js')` from `lib/client.js`). This file
// exists only because the chunk is a BROWSER script in DSH's registration envelope, while
// the Host-side tests want named exports.
//
// The envelope is what DSH actually runs. The chunk text starts with
//
//   window.__ModuleLoader__.load({id, chunk, factory: (require) => { …; return module.exports }})
//
// exactly like the installed `dsh-client-ui-sidebar-terminal/lib/client.terminal.js`, and
// DSH's loader keys the registration by `<owner id>/<chunk>` and fails a request whose
// bundle did not register (`@deepseek-ai/dsh-client-modules/lib/client.js` `importChunk`).
// So this file evaluates that same text against a fake `window.__ModuleLoader__`, and
// takes the factory's return value — the object the loader would hand back. There is no
// second copy of the logic to drift: the Host tests exercise the renderer's own code.
//
// The registration is checked against DSH's own rules before it is trusted: the chunk is
// named after its URL segment (a mismatch would make the request unresolvable), the id is
// `<folder>/client`, and the loader pattern and the served URL are the ones measured in
// `@deepseek-ai/dsh-client-modules` (`^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$`,
// `/plugins/<id>/<chunk>?rev=<rev>`).
//
// What it fixes: in a session that lives on ANOTHER Host, a non-image file picked with the
// composer's `+` never reached that Host. DSH's composer asks
// `globalThis.__DSH_HOST_PATHS__.pathFor(file)` for a local path and turns a non-empty
// answer into an `@"C:\…\file.zip"` MENTION — a path on this machine, which the remote
// Host cannot read — while an empty answer sends the bytes through
// `POST /api/session/uploadFileBinary`, which `lib/upload-route.mjs` already routes to
// the owning Host.
//
// The full rationale — A1.1/A1.2 conditions, the per-row decision table read from the
// installed `apply.ts` `addFiles`, and R6's attribution rule — is the header of
// `lib/client.remote-file-attach.js`, where the code that implements it lives.

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
/** The one source: the packed client chunk the renderer materializes. */
export const CHUNK_FILE = path.join(here, 'client.remote-file-attach.js')
/**
 * The package id the chunk registers under: the owner of `require.async`, which for this
 * package is its manifest `name` — not the folder name, because DSH names the route by
 * the package (`/plugins/<name>/client.<name>.js`, measured in
 * `@deepseek-ai/dsh-client-modules`). Read from the manifest, never copied.
 */
export const CHUNK_OWNER = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).name
/** The chunk segment DSH's loader and Host route both accept verbatim. */
export const CHUNK_NAME = path.basename(CHUNK_FILE)
export const CHUNK_PATTERN = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
/** The URL DSH's loader derives for it (`chunkUrl(row, fileName, rev)`); `rev` is any value. */
export const CHUNK_URL = `/plugins/${CHUNK_OWNER}/${CHUNK_NAME}`

/**
 * Materialize the chunk exactly as the renderer's loader does: evaluate the script with a
 * `window` whose `__ModuleLoader__.load` records the registration, check that registration
 * against DSH's own rules, then take the factory's return value — the object
 * `require.async('./client.remote-file-attach.js')` resolves to in a page. One definition,
 * read once, memoized here.
 *
 * `runInThisContext` (not a fresh `vm.createContext`): the objects the functions hand back
 * must belong to THIS realm, or a `deepStrictEqual` against a plain object fails on
 * prototype identity even though nothing differs. The renderer gets the same deal — chunk
 * factories materialize in the page's own realm.
 */
function loadChunk() {
  const source = fs.readFileSync(CHUNK_FILE, 'utf8')
  const registrations = []
  const loader = {
    load(registration) {
      if (typeof registration !== 'object' || registration === null) throw new Error('module loader: a registration must be an object')
      if (typeof registration.id !== 'string' || registration.id === '') throw new Error('module loader: a registration needs an id')
      if (typeof registration.factory !== 'function') throw new Error('module loader: a registration needs a factory')
      registrations.push(registration)
    },
  }
  vm.runInThisContext(`(function (window) {${source}\n})`, { filename: CHUNK_NAME })({ __ModuleLoader__: loader })
  if (registrations.length !== 1) throw new Error(`${CHUNK_NAME} must register exactly one factory (registered ${registrations.length})`)
  const [registration] = registrations
  if (registration.id !== CHUNK_OWNER) throw new Error(`${CHUNK_NAME} registers as ${registration.id}; its route serves ${CHUNK_OWNER}`)
  if (registration.chunk !== CHUNK_NAME) throw new Error(`${CHUNK_NAME} registers chunk ${String(registration.chunk)}; it is served as ${CHUNK_NAME}`)
  if (!CHUNK_PATTERN.test(registration.chunk)) throw new Error(`${CHUNK_NAME} is not a name DSH's loader accepts`)
  const noRequire = () => { throw new Error('the remote file attach chunk must stay a leaf module') }
  const exports = registration.factory(noRequire)
  if (typeof exports !== 'object' || exports === null) throw new Error(`${CHUNK_NAME} factory must return its exports`)
  return exports
}

const chunk = loadChunk()

export const {
  HOST_PATHS_GLOBAL, HOST_PATHS_MEMBER, HOST_TAG, SESSION_VIEW_SELECTOR, COMPOSER_INPUT_SELECTOR,
  COMPOSER_SEAT_SELECTOR, FILE_INPUT_SELECTOR, PICK_EVENT, hostPathsSelfTest, splitTaggedSessionId,
  isUploadableFile, composerSites, composerContainerOf, attributionOfPicker, ATTRIBUTION_STATES,
  RemoteFileIntake, remoteFileIntakeFor, installRemoteFileIntake, adoptPickerFrom, HOST_PATHS_ORIGINAL,
  HOST_PATHS_INSTANCES, hostPathsRootOriginal,
} = chunk
