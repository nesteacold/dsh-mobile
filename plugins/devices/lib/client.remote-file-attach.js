// Remote file attach (spec 033, constitution amendment A1.2 as revised 2026-11-16).
//
// WHAT THIS FILE IS. This is the ONE implementation, and it ships in the format DSH's own
// package-local client chunks use — measured in the installed 0.2.2-rc.3
// `dsh-client-ui-sidebar-terminal/lib/client.terminal.js`:
//
//   window.__ModuleLoader__.load({id:`<package>`,chunk:`client.<name>.js`,factory:require=>{…;return module.exports}});
//
// The envelope is not decoration. DSH serves a package file byte for byte and relies on
// the returned source to register itself: the terminal chunk above is requested with
// `await require.async('./client.terminal.js')` (built `client.js` of that package) and
// the loader then fails the request with `bundle <url> loaded without registering
// "<id>/client.<name>.js" via __ModuleLoader__.load` unless the script called
// `window.__ModuleLoader__.load` (installed `@deepseek-ai/dsh-client-modules/lib/client.js`
// `importChunk` → `register`, which keys a chunk registration by `<owner id>/<chunk>`). A
// bare `module.exports = …` at the top of a served script is therefore not a module at
// all. `lib/remote-file-attach.mjs` loads this same text through a fake
// `__ModuleLoader__` and takes the factory's return value, so the Host-side tests run
// the very code the renderer materializes. There is no second copy to drift.
//
// WHAT IT FIXES. In a session that lives on ANOTHER Host, a non-image file picked with the
// composer's `+` became the mention `@"C:\…\file.zip"` — a path on THIS machine, packed
// from the `File` the picker handed over. DSH computes it in its composer's
// `addFiles` (installed `apply.ts:520` `const path = bridge?.pathFor(file) ?? ''`,
// bridge = the preload's `globalThis.__DSH_HOST_PATHS__`): a non-empty answer becomes an
// `@"path"` reference, an empty one sends the BYTES through
// `POST /api/session/uploadFileBinary` — which `lib/upload-route.mjs` already routes to
// the owning Host. Images upload whatever the answer says (`:522`).
//
// THE FIRST MECHANISM FAILED, MEASURED LIVE (2026-11-16). A1.2 in its original text let
// this plugin wrap `__DSH_HOST_PATHS__.pathFor` in place. It never can: the preload exposes
// the object through `contextBridge.exposeInMainWorld` (installed `lib/preload-app.cjs`),
// and contextBridge hands the page a FROZEN copy — every member non-writable and
// non-configurable — so an in-place wrap is refused (`bridge-frozen`) and no re-pointing of
// the global binding could help either (DSH captures the bridge once per composer inject,
// `apply.ts:504` `const bridge = hostPathBridge()`). The owner's remote client (commit
// 7edd03f, DSH fully restarted) still turned the picked zip into `@"C:\…zip"`: nothing was
// uploaded.
//
// THE MECHANISM NOW (no DSH object is wrapped, nothing is monkey-patched). The picker's own
// `input[type=file]` is the one element in that flow the page owns end to end, and the
// `File` objects it hands DSH are ours to decide. So:
//
//  1. `lib/client.js` keeps a CAPTURE-phase `change` listener on `document` and the same
//     composer-region/session attribution (R6, below). Capture is necessary:
//     DSH's own `onPickFiles` (installed `InputBar.tsx:280`, built
//     `const onPickFiles=e=>{const picked=e.target.files===null?[]:[...e.target.files];…}`)
//     reads `e.target.files` as its very FIRST statement, so the capture phase is the last
//     moment that list can still be replaced.
//  2. When a pick is proven to belong to a composer that shows a REMOTE session
//     (`h:<hostId>:…`), and the picked set holds a non-image file, every picked file is
//     RE-MATERIALIZED: `new File([original], original.name, {type, lastModified})`, added
//     through a fresh `DataTransfer`, and `input.files` is replaced with it. A `File`
//     built in page script has no backing filesystem path, so
//     `webUtils.getPathForFile` answers `''` and DSH's OWN composer takes its byte path —
//     no mention, no wrap, nothing else touched. Images are re-materialized in place like
//     the rest (same type, so DSH still uploads them at `apply.ts:522`; their bytes,
//     name and type are unchanged, and an image never consults a path for its outcome).
//  3. A mixed batch is re-materialized as a WHOLE. DSH asks `pathFor` for the reference
//     files of the batch first and creates the upload drafts only when the whole loop
//     passed (`apply.ts:517-540`: a `return` inside the loop refuses the batch before ANY
//     draft is created), so leaving an image's path intact would drag the re-materialized
//     non-image files out of a batch DSH then refuses for the image — the pick would land
//     nowhere at all.
//  4. Every other pick — a local session, an unproven session, a file input outside the
//     composer, a directory-only pick, browser chrome — is NOT touched: DSH's own
//     behaviour, exactly as before.
//  5. When `DataTransfer` or `File` cannot be constructed, nothing is changed and
//     `status()` reports `browser-unavailable` with a sentence the Devices page shows.
//  6. A re-materialized pick is verified on the spot, twice: the page-built `File` must
//     answer `''` from the preload (`answersNoPath`) BEFORE the list is replaced, and the
//     list must read back path-free AFTER it. A page where either check fails touches
//     nothing and reports `path-unavailable`/`unverified` rather than an upload that never
//     happened.
//  7. ACTIVATION IS THE INSTALL, NOT A FETCH. An earlier revision made the module wait for
//     DSH's own package sources, fetched from guessed same-origin URLs (`/__dsh/app/<pkg>/…`,
//     then `/`), before it would touch a pick: the first picks of a page stayed DSH's own
//     while those reads were in flight, and a page whose reads never landed (an installed
//     Electron shell does not serve a package `src` tree at all) never switched on. The
//     fetch is gone (reviewer finding, 2026-11-16): the module activates on install, and
//     every per-pick proof above stays. The DSH contract the mechanism rests on is still
//     checked — against the INSTALLED sources, from disk, in the tests
//     (`test/remote-file-attach.test.mjs`, `test/client.test.mjs`), so an upgrade that moves
//     the seam fails there instead of quietly turning remote picks back into mentions.
//  8. If the picker refuses the replacement (`assign-failed`: a `files` setter that throws;
//     `not-taken`: the list it kept is not the one that was handed over), the pick is a
//     PROVEN remote non-image pick that could not be handed to DSH as bytes, and the page
//     says exactly that (`replace-failed`) — never `certain`, which reads as a local pick.
//
// Session attribution (R6) — certain or nothing. The capture phase asks WHICH composer
// this pick was made in, from the DOM, and answers it once at pick time:
//
//  - `[data-conversation-session]` is the per-session view root (`ConversationRoot`);
//  - `[data-composer-input]` is each composer's own input element
//    (`ComposerContentEditable`) — a SIBLING of the hidden `input[type=file]`: both live in
//    the composer card, the picker inside the input bar's tools row (`InputBar`);
//  - the composer container is the deepest element holding that input and the picker's form
//    control (in the installed layout the card; a card that does not nest them answers its
//    seat, the nearest ancestor carrying `[data-conversation-region="composer"]`);
//  - the search never ascends past the composer region: a file input rendered elsewhere in
//    the same session view (a panel, a dialog) is no claim, however many composer inputs
//    sit above it;
//  - focus, "only one composer in the document" and the picker's `.files` are NOT proof
//    (the `.files` part changed under the old wrap: a pick is now attributed ONCE, in the
//    capture phase, so there is no later call to bind a claim to).
//
// No authorization is touched and no request is made from here: this module decides
// whether a picked list keeps DSH's own `File` objects or gets byte-only copies. The
// bytes travel through `lib/upload-route.mjs`, and the remote gateway stays the sole
// authority (`attachments:write`, size, session visibility).
//
// The decision, each row read from the installed sources and re-asserted by the
// `composer` self-test:
//
//  - **Remote session, a non-image file among the picks → every pick re-materialized.**
//    All of them have no path, so all of them upload; the non-image files carry the bytes.
//  - **Remote session, images only → untouched.** DSH already uploaded images; nothing of
//    their outcome would change, and a picker the page does not need to touch is not touched.
//  - **A directory's `File`** (`inode/directory`) keeps its own object: a re-materialized
//    copy carries no filesystem entry, and DSH's directory handling is not what this fixes.
//  - **Local session, no session, unknown session → untouched**, and the page says why.
//  - **The page cannot vouch for the pick** (path-unavailable, unverified, replace-failed,
//    browser-unavailable) → untouched, and the page says which one.
//
// One body, two deliveries: this file holds every function in its factory, and
// `lib/remote-file-attach.mjs` re-exports these names from it.

window.__ModuleLoader__.load({
  id: '@dsh-ext/devices',
  chunk: 'client.remote-file-attach.js',
  factory: (require) => {
    'use strict'
    // The chunk is a leaf: the factory must not drag a Host module into the browser.
    void require

    const HOST_PATHS_GLOBAL = '__DSH_HOST_PATHS__'
    const HOST_PATHS_MEMBER = 'pathFor'
    const HOST_TAG = 'h:'
    /** The per-session view root: its `data-conversation-session` names the session. */
    const SESSION_VIEW_ATTR = 'data-conversation-session'
    const SESSION_VIEW_SELECTOR = `[${SESSION_VIEW_ATTR}]`
    /** The view's content element: the same node as the root above, named separately where it is read. */
    const CONTENT_ATTR = 'data-conversation-content'
    /** One composer's own input; it holds no file input (the picker is its sibling). */
    const COMPOSER_INPUT_ATTR = 'data-composer-input'
    const COMPOSER_INPUT_SELECTOR = `[${COMPOSER_INPUT_ATTR}]`
    /** The composer seat (ConversationRoot) and the card (InputBar), the two cuts above a picker. */
    const COMPOSER_REGION_ATTR = 'data-conversation-region'
    const COMPOSER_REGION = 'composer'
    const COMPOSER_SEAT_SELECTOR = `[${COMPOSER_REGION_ATTR}="${COMPOSER_REGION}"]`
    /** The composer card's own mark (installed `InputBar`; this page's remote card falls back to its input). */
    const COMPOSER_CARD_ATTR = 'data-composer-card'
    /** DSH's hidden picker: `input[type=file][hidden]`, its form control `input[type=file]`. */
    const FILE_CONTROL_ATTR = 'type'
    const FILE_CONTROL = 'input[type="file"]'
    const FILE_INPUT_SELECTOR = `[hidden] ${FILE_CONTROL}`
    /** `change` is what DSH's own `onPickFiles` listens to. */
    const PICK_EVENT = 'change'
    /** `h:<hostId>:<rawId>`, the shape `lib/upload-route.mjs#splitTaggedSessionId` accepts. */
    const TAGGED_SESSION = /^h:([0-9a-zA-Z-]{1,64}):([^:]{1,256}(?::.*)?)$/
    /** The kind of a picked directory: it has no bytes, and DSH's directory rule is DSH's own. */
    const DIRECTORY_TYPE = 'inode/directory'
    /** Two independent references to one factory return. */
    const ONE_REFERENCE = 1

    const isString = (value) => typeof value === 'string'
    const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

    /** A picked file, about to be asked about: anything DSH may pass (a `File`, or `null`). */
    const isPassed = (file) => file !== undefined && file !== null

    /** A DOM-ish node: it answers its attributes and it has ancestors. */
    function isElement(value) {
      return isRecord(value) && typeof value.getAttribute === 'function' && typeof value.hasAttribute === 'function'
    }

    /** Every DOM fact this module reads goes through one seam, so a test can count them. */
    const DSH_BRIDGE = {
      isElement,
      isMarked: (node, attribute) => isElement(node) && node.hasAttribute(attribute) === true,
    }

    /**
     * `h:<hostId>:<sessionId>` → `{hostId, sessionId}`, or null for anything else (a local
     * session id, an empty or malformed tag). A local copy of the carrier's rule: the
     * renderer must not import a Host-side module, and a test pins both to one answer.
     */
    function splitTaggedSessionId(value) {
      if (!isString(value)) return null
      const match = TAGGED_SESSION.exec(value)
      if (match === null) return null
      return { hostId: match[1], sessionId: match[2] }
    }

    /** A picked file DSH can upload as bytes; a directory is DSH's own case, not ours. */
    const isUploadableFile = (file) => isRecord(file) && file.type !== DIRECTORY_TYPE

    /** A picked image, which DSH uploads whatever the path would say. */
    const isImageFile = (file) => isString(file?.type) && file.type.startsWith('image/')

    /** The node itself and its ancestors, starting at `node` (a detached node answers just itself). */
    function lineageOf(node) {
      const chain = []
      for (let at = node; at !== null && at !== undefined; at = at.parentElement ?? null) {
        chain.push(at)
        if (chain.length > 64) break
      }
      return chain
    }

    /** Is `node` still in `doc`? A document that cannot answer the question is trusted. */
    function inDocument(doc, node) {
      if (doc === null || doc === undefined || typeof doc.contains !== 'function') return true
      try { return doc.contains(node) !== false } catch { return true }
    }

    /** The nearest ancestor-or-self DSH marked with `attribute`. */
    const nearestMarked = (node, attribute) => lineageOf(node).find((at) => DSH_BRIDGE.isMarked(at, attribute)) ?? null
    /** The attribute a view names its session by, or null when it names none. */
    const sessionIdOf = (view) => {
      const raw = isElement(view) ? view.getAttribute(SESSION_VIEW_ATTR) : null
      return isString(raw) && raw !== '' ? raw : null
    }

    /** The picker's form control: the `input[type=file]` the event's target belongs to. */
    const formControlOf = (picker) => lineageOf(picker).find((at) => isElement(at) && at.getAttribute(FILE_CONTROL_ATTR) === 'file') ?? null

    /**
     * Every composer DSH rendered, with the session each one shows, read off the document.
     * @returns {Array<{input: Element, view: Element|null, sessionId: string|null}>} DOM order
     */
    function composerSites(doc) {
      if (!doc || typeof doc.querySelectorAll !== 'function') return []
      let inputs
      try { inputs = [...doc.querySelectorAll(COMPOSER_INPUT_SELECTOR)] } catch { return [] }
      return inputs.map((input) => {
        const view = nearestMarked(input, SESSION_VIEW_ATTR)
        return { input, view, sessionId: sessionIdOf(view) }
      })
    }

    /**
     * The composer container a picker belongs to, searched OUTWARD only inside the composer
     * region and never past it. The installed `ConversationRoot` renders
     * `[data-conversation-content][data-conversation-session][data-conversation-region="chat"]`
     * and, among its children, the seat `[data-composer-seat][data-conversation-region="composer"]`.
     * The composer bar DSH renders inside that seat (`lib/client.js`, `composerBar`) holds a
     * `DraftEditor` and an `input[type=file][hidden]` in the `row`/`tools` of one card, so the
     * deepest element that holds both the picker's form control and a `[data-composer-input]`
     * is the card — always inside the seat.
     *
     * Outside every seat a picker has no composer region and answers null: ascending to the
     * session view (or the page) and accepting an ancestor because it holds exactly one composer
     * input is the "there is only one composer here" guess R6 forbids — an unrelated file input
     * rendered anywhere in that session would then be attributed to its session.
     *
     * The other two anchors are tolerated only INSIDE such a region: a card marked
     * `[data-composer-card]` (the installed InputBar's own mark), and this page's remote card,
     * which carries a `[data-composer-input]` of its own and no card mark. In both the suite is
     * the card's own ancestor BELOW the session view (the bar), and it must not also hold the
     * seat — a bar beside the seat would hold two regions, and which one a pick belongs to
     * would be a guess.
     * @returns {Element|null}
     */
    function composerContainerOf(picker) {
      const control = formControlOf(picker)
      if (control === null) return null
      // The `[hidden]` attribute may sit on the form control itself or on a wrapper around
      // it (a visually hidden label): either way the ancestry above it is the composer's.
      const chain = mergeLineages(lineageOf(control), lineageOf(control.parentElement ?? null))
      const seat = nearestComposerSeat(chain)
      if (seat !== null) {
        // The picker's own composer: the deepest element between it and its seat holding a
        // composer input (the card). The seat itself is not a suite a pick belongs to.
        const inside = chain.slice(0, chain.indexOf(seat))
        const card = inside.find((node) => holdsComposerInput(node))
        if (card !== undefined) return card
        if (holdsComposerInput(seat)) return seat
      }
      return composerCardAbove(picker, lineageOf(picker))
    }

    /** The nearest ancestor-or-self marked `[data-conversation-region="composer"]`, between two nodes. */
    function nearestComposerSeat(chain) {
      return chain.find((node) => isElement(node) && node.getAttribute(COMPOSER_REGION_ATTR) === COMPOSER_REGION) ?? null
    }

    /** Does `node` hold exactly one composer input (`[data-composer-input]`)? */
    function holdsComposerInput(node) {
      if (!isElement(node) || typeof node.querySelectorAll !== 'function') return false
      try { return node.querySelectorAll(COMPOSER_INPUT_SELECTOR).length === ONE_REFERENCE } catch { return false }
    }

    /**
     * A pick from a card this module only half knows (a new card mark, or this page's own card
     * with a composer input): the card AND the suite it renders into must both lie inside the
     * nearest session view, and the suite must be in the region that view breaks
     * (`inSessionRegion`) — its content or its composer seat, or the view root itself — never a
     * container of the view or of a neighbouring one. A page-level count of composer inputs
     * never decides.
     */
    function composerCardAbove(picker, line) {
      const view = nearestMarked(picker, SESSION_VIEW_ATTR)
      if (view === null || !isElement(view)) return null
      // `line` is the picker's OWN ancestry (only a picker's ancestry can be its composer), and
      // `isView` is a VIEW test, not a node test: the chain of a `[hidden]` file input holds a
      // sibling `undefined` slot (the fake document's root); unrelated nodes fall away.
      const isView = (node) => node === view || (isElement(node) && DSH_BRIDGE.isMarked(node, SESSION_VIEW_ATTR))
      // Every NODE of the picker's ancestry — the `undefined` root slot of the fake document's
      // chain included: supplied through `slice()`, `Array.prototype.find` hands its callback
      // only the element (never the index), so a predicate that reads a second parameter cannot
      // compare the element against its own position.
      const nodes = Array.prototype.slice.call(line.filter((node) => !isView(node)))
      const card = nodes.find((node) => DSH_BRIDGE.isMarked(node, COMPOSER_CARD_ATTR))
        ?? nodes.find((node) => holdsComposerInput(node))
      if (card === undefined || !containsNode(view, card)) return null
      // The composer seat that belongs to this card — the nearest one it does NOT contain (a
      // seat between the card and its picker belongs to another composer: then there is none).
      const seat = nodes.find((node) => isElement(node) && node.hasAttribute(COMPOSER_REGION_ATTR)
        && node.getAttribute(COMPOSER_REGION_ATTR) === COMPOSER_REGION && !containsNode(node, card)) ?? null
      // The suite the card renders into: its nearest ancestor below the view. A seat ABOVE that
      // suite is the composer region `inSessionRegion` proves; a seat BELOW it (between the card
      // and its input bar) is inside the suite and straddles the boundary: ambiguous. The seat
      // is then passed to `inSessionRegion` as a hint, which confirms and never decides.
      // Measured, not assumed: `Array.prototype.find` hands its callback `(node, index, array)`
      // for EVERY node, and `[][0]` is `undefined` — in every lineage — so a callback that
      // reads a second parameter would be comparing the node's INDEX against `undefined` and
      // matching every position. The callback below takes the node alone.
      const holdsCard = (node) => node !== null && node !== undefined && containsNode(node, card)
      const suite = nodes.find(holdsCard)
      if (suite === undefined || !containsNode(view, suite)) return null
      if (seat !== null && containsNode(suite, seat)) return null
      return sessionRegionOf(view, suite, seat) === 'inside' ? suite : null
    }

    /**
     * Is `node` inside the region `view` breaks — from the view or its content down to the
     * composer seat, and no further (a container of the view, a list of views or a rail, is not)?
     * Answers `'inside'`, `'ambiguous'` (a seat that could be the suite's is not above it), or
     * `null` (outside). The ambiguity is a refusal, never a claim (R6).
     * @param {Element} view the session view
     * @param {Element} node the node to place
     * @param {Element|null} [seat] the composer seat found beside `node`, if any
     * @returns {'inside'|'ambiguous'|null}
     */
    function sessionRegionOf(view, node, seat = null) {
      // `isKnown` guards every attribute read: an ancestry can end in a non-element slot.
      const isKnown = (at) => at !== null && at !== undefined
      let held = false
      for (let at = node; held === false && isKnown(at); at = at.parentElement ?? null) {
        if (at === view || DSH_BRIDGE.isMarked(at, CONTENT_ATTR)) held = true
      }
      if (!held) return null
      if (seat !== null) {
        // A known seat, when it sits above the suite, is the composer region this proves. When
        // it does NOT, the suite is beside a composer seat rather than inside one.
        let above = false
        for (let at = node; isKnown(at) && above === false; at = at.parentElement ?? null) {
          if (at !== view && isElement(at) && DSH_BRIDGE.isMarked(at, SESSION_VIEW_ATTR)) return null
          if (at === seat) above = true
        }
        if (above) return 'inside'
      }
      // Past the content: walking up may leave the suite's element (the region `view` breaks is
      // itself allowed here — only another session VIEW in between is not), and a suite that
      // sits directly in the view with no seat above it is ambiguous, not outside.
      let at = node
      while (isKnown(at)) {
        if (isElement(at) && at !== view && at !== node && DSH_BRIDGE.isMarked(at, SESSION_VIEW_ATTR)) return 'ambiguous'
        if (isElement(at) && at.getAttribute(COMPOSER_REGION_ATTR) === COMPOSER_REGION) return 'inside'
        at = at.parentElement ?? null
      }
      // No seat above it at all, and a seat beside it: the region is not this pick's to claim.
      return seat === null ? null : 'ambiguous'
    }

    /** The boolean form of {@link sessionRegionOf}: only `'inside'` is a region this module uses. */
    const inSessionRegion = (view, node, seat = null) => sessionRegionOf(view, node, seat) === 'inside'

    /** Does `outer` contain `inner`? Only an ELEMENT of the page, or the document, can contain. */
    function containsNode(outer, inner) {
      if (outer === inner) return true
      if (outer === null || outer === undefined) return false
      const answersContains = typeof outer.contains === 'function'
      const lineage = isElement(inner) ? lineageOf(inner) : []
      if (isElement(outer)) return answersContains ? safeContains(outer, inner) : lineage.includes(outer)
      // Anything else (the document, or a chain's `undefined` slot) only counts by a real
      // `contains` answer: `undefined` IS in every lineage and would contain everything.
      return answersContains && isPassed(inner) ? safeContains(outer, inner) : false
    }

    const safeContains = (outer, inner) => {
      try { return outer.contains(inner) === true } catch { return false }
    }

    /** Both chains in nearest-first order, each element once. */
    function mergeLineages(first, second) {
      const seen = new Set()
      const out = []
      for (const node of [...first, ...second]) {
        if (seen.has(node)) continue
        seen.add(node)
        out.push(node)
      }
      return out
    }

    /**
     * Which composer a pick belongs to and which session it shows — read from the picker
     * itself, at the moment the pick happened and never later (R6: exactness, because a
     * guess either sends a local file to a remote Host or hands a remote session a path it
     * cannot read).
     *
     *  - `picker-document`: the picker is not in this document (browser chrome), so no
     *    session can be named;
     *  - `no-composer`: no composer input for it to belong to;
     *  - `picker-elsewhere`: no composer container holds both the picker and an input
     *    (two elements sharing a page ancestor is not evidence);
     *  - `no-session`: the container is real but its view names no session (hero);
     *  - `certain`: the container, the input it holds and the view root above both.
     * @param {Element|null} picker DSH's own file input, captured at the `change`
     * @returns {{state: string, sessionId: string|null, sites: number, view: Element|null, container: Element|null}}
     */
    function attributionOfPicker(picker) {
      const none = (state) => ({ state, sessionId: null, sites: 0, view: null, container: null })
      if (!isElement(picker)) return none('no-document')
      const doc = picker.ownerDocument ?? null
      if (!inDocument(doc, picker)) return none('picker-document')
      const container = composerContainerOf(picker)
      const sites = composerSites(doc)
      if (sites.length === 0) return none('no-composer')
      if (container === null) return { ...none('picker-elsewhere'), sites: sites.length }
      const ownInput = container.querySelectorAll?.(COMPOSER_INPUT_SELECTOR) ?? null
      if (ownInput === null || ownInput.length !== ONE_REFERENCE) {
        return { ...none('composer-uncertain'), sites: sites.length, container }
      }
      const view = lineageOf(container).find((node) => DSH_BRIDGE.isMarked(node, SESSION_VIEW_ATTR)) ?? null
      const sessionId = sessionIdOf(view)
      if (sessionId === null) return { ...none('no-session'), sites: sites.length, view, container }
      return { state: 'certain', sessionId, sites: sites.length, view, container }
    }

    /**
     * The picks still in a picker's `input.files` — read in the CAPTURE phase, the only moment
     * they exist (`onPickFiles` drains the picker in its first statement). The objects are kept
     * as they are; a picker that cannot answer, or has nothing in it, is empty.
     * @returns {Array<object>} the picked files, in picker order
     */
    function pickedFilesOf(picker) {
      if (!isRecord(picker)) return []
      let files
      try { files = picker.files } catch { return [] }
      const isFileList = files !== null && typeof files === 'object' && typeof files.length === 'number'
      if (!isFileList) return []
      const picked = []
      for (let at = 0; at < files.length; at += 1) {
        if (isPassed(files[at])) picked.push(files[at])
      }
      return picked
    }

    /**
     * The states this module reports; the Devices page has a sentence for each.
     * `active` rows are what the capture did (or deliberately did not do) with one pick;
     * `not-active` rows are why nothing can be changed at all. `unmeasured` and
     * `dsh-incompatible` are gone with the source-fetch gate: activation is the install, and
     * the installed-DSH contract is asserted in the tests, from disk.
     */
    const ATTRIBUTION_STATES = Object.freeze([
      'certain', 'no-document', 'picker-document', 'no-composer', 'picker-elsewhere', 'composer-uncertain',
      'no-session', 'browser-chrome', 'ambiguous', 'stale-batch', 'file-unclaimed',
      'path-unavailable', 'unverified', 'replace-failed', 'browser-unavailable', 'not-installed',
    ])

    /** Realms whose `DataTransfer` accepted a file list AND a constructed `File`: measured once. */
    const REMATERIALIZABLE = new WeakSet()

    /**
     * Can this realm build a fresh `File` and put it in a `DataTransfer`? Measured, never
     * assumed, and measured with an actual round trip: a realm that answers both constructors
     * and still drops the item is no realm to change a picker in. The result is cached per
     * global (a page measures once; a test realm that swaps the constructor re-measures by
     * using a fresh global).
     * @param {object} holder the global the constructors live on (`window`, or a test realm)
     */
    function canRematerialize(holder) {
      if (isRecord(holder) && REMATERIALIZABLE.has(holder)) return true
      const transfer = isRecord(holder) ? holder.DataTransfer : undefined
      const FileCtor = isRecord(holder) ? holder.File : undefined
      if (typeof transfer !== 'function' || typeof FileCtor !== 'function') return false
      try {
        const probe = new FileCtor([new Uint8Array([1, 2, 3])], 'probe.bin', { type: 'application/octet-stream' })
        const list = new transfer()
        list.items.add(probe)
        if (list.files?.length !== ONE_REFERENCE) return false
        if (isRecord(holder)) REMATERIALIZABLE.add(holder)
        return true
      } catch {
        return false
      }
    }

    /**
     * A copy of one picked file that carries no filesystem path: same bytes, name, type and
     * timestamp, built by page script. `webUtils.getPathForFile` answers `''` for such a
     * `File`, which is exactly DSH's own answer for "upload these bytes".
     */
    function rerawFile(holder, file) {
      const FileCtor = holder.File
      const options = { type: isString(file?.type) ? file.type : '' }
      if (Number.isFinite(file?.lastModified)) options.lastModified = file.lastModified
      const name = isString(file?.name) ? file.name : ''
      return new FileCtor([file], name, options)
    }

    /**
     * Put the given files into a picker's `input.files`, as ONE list: the whole batch, by
     * picker order, or nothing. Answers null on success, or the reason it did not take
     * (`list-build-failed`, `assign-failed`, `not-taken`) — the caller reports it as
     * `replace-failed`, so a picker that refused the copies is never read as a local pick.
     * @param {object} holder the global whose `DataTransfer` builds the list
     * @param {object} picker DSH's own file input
     * @param {Array<object>} files the copies to hand DSH, in pick order
     */
    function replacePickedFiles(holder, picker, files) {
      let list
      try {
        list = new holder.DataTransfer()
        for (const file of files) list.items.add(file)
      } catch {
        return 'list-build-failed'
      }
      try {
        picker.files = list.files
      } catch {
        return 'assign-failed'
      }
      // Taken, not merely assigned: the picker must now hold a list of the same length in
      // which every entry is the copy this page built. A browser's `input.files = dt.files`
      // is exactly that — the list keeps the objects it was given — so a setter that throws,
      // stores something else or keeps the previous list is the failure this catches.
      let kept
      try {
        kept = picker.files
      } catch {
        return 'not-taken'
      }
      if (kept === null || typeof kept !== 'object' || kept.length !== files.length) return 'not-taken'
      for (let at = 0; at < files.length; at += 1) {
        if (kept[at] !== files[at]) return 'not-taken'
      }
      return null
    }

    /**
     * The DSH contract this mechanism rests on, as a set of source patterns. IT NO LONGER
     * GATES ACTIVATION: an installed Electron shell does not serve DSH's package `src` tree,
     * so a page-side read could never be the thing that switches the mechanism on.
     *
     *  - `InputBar.tsx` `onPickFiles` reads `e.target.files` as its first statement — the
     *    capture phase's replacement is what DSH then sees (built form:
     *    `const onPickFiles=e=>{const picked=e.target.files===null?[]:[...e.target.files];`);
     *  - `apply.ts` `addFiles` maps an empty path to the byte upload (`path === ''` →
     *    `uploads.push`), so a path-less `File` of a remote session uploads;
     *  - `dsh-client-file-upload` posts `attachment.file` with no Blob/FormData/`size`
     *    conversion, so a `File` built in page script uploads like a picked one.
     *
     * Patterns, not a version equality (standing rule 2026-11-13). The tests read the
     * INSTALLED sources from disk and assert these very patterns, so a DSH upgrade that moves
     * the seam fails the suite instead of silently turning remote picks back into mentions.
     * @param {(path: string) => string|null} readFile a reader over DSH's own sources
     * @returns {{composed: boolean, composer: boolean, upload: boolean, read: boolean}}
     */
    function dshContract(readFile) {
      const read = (relative) => {
        // A reader may answer with a promise of text: a promise is not text, and treating it
        // as one would measure the wrong thing.
        if (typeof readFile !== 'function') return null
        try {
          const text = readFile(relative)
          return typeof text === 'string' ? text : null
        } catch { return null }
      }
      const intake = read('dsh-client-ui-conversation/src/client/skeleton/InputBar.tsx')
      const apply = read('dsh-client-ui-conversation/src/client/apply.ts')
      const upload = read('dsh-client-file-upload/lib/client.js')
      const against = (source, pattern) => (source === null ? null : pattern.test(source))
      const composer = against(intake, /const picked = e\.target\.files === null \? \[\] : \[\.\.\.e\.target\.files\]/)
      const bytes = against(apply, /if \(path === '' \|\| \(!directory && isImageMediaType\(file\.type\)\)\)/)
      const posts = against(upload, /return this\.ctx\.remote\.fileUploads\.upload\(/)
      return {
        composed: composer !== false && bytes !== false,
        composer: composer !== false && bytes !== false && posts !== false,
        upload: posts !== false,
        read: intake !== null && apply !== null && upload !== null,
      }
    }

    /**
     * Does the preload answer a path for THIS pick? Measured on the pick the user made, because
     * it is the only fact the mechanism rests on that is not a source pattern: `pathFor` of a
     * `File` this page built answers `''` (`webUtils.getPathForFile` has no entry for it). A
     * page where even a constructed `File` gets an answer is a page where re-materializing
     * would change nothing — it would still be a mention — so that pick is left to DSH and
     * the state says so instead of claiming an upload.
     * @param {object} holder the renderer's global (its `__DSH_HOST_PATHS__`)
     * @param {object} file a path-free `File` built by this page
     * @returns {boolean} true when the bridge declined to name it (the byte path)
     */
    function answersNoPath(holder, file) {
      const bridge = isRecord(holder) ? holder[HOST_PATHS_GLOBAL] : undefined
      const pathFor = isRecord(bridge) ? bridge[HOST_PATHS_MEMBER] : undefined
      if (typeof pathFor !== 'function') return true
      try { return (pathFor.call(bridge, file) ?? '') === '' } catch { return false }
    }

    /** A notice kind per outcome, so the page can say what happened without a log. */
    const NOTICE_KINDS = Object.freeze({
      upload: 'upload', untouched: 'untouched', refused: 'refused', passthrough: 'passthrough',
    })

    /**
     * The remote file-intake for one renderer instance.
     *
     * `deps.global` is the object that holds the constructors and the bridge (`window` in DSH;
     * a test realm otherwise); `deps.doc` is the document its composers render into (defaults
     * to the global's own `document`); `deps.log` records what happened, never what was picked;
     * `deps.onNotice(kind, notice)` receives the pick report the page shows. Nothing about
     * DSH's sources is a dependency of this class: it activates on `install()`.
     */
    class RemoteFileIntake {
      #global
      #doc
      #log
      #noticeSink
      #shape = null
      #installed = false
      #attempted = false
      /** Why nothing can be changed: a `browser-…` reason, or null while active. */
      #refusal = null
      /** The state of the last pick this module did not upload (null once a remote pick is uploaded). */
      #last = null
      /** The pick report waiting to be read once (`takeNotice`). */
      #notice = null
      /** Picks seen in the capture phase, and how many were re-materialized for their Host. */
      #claims = 0
      #ended = 0

      constructor(deps = {}) {
        this.#global = deps.global ?? globalThis
        this.#doc = deps.doc ?? (isRecord(deps.global) && 'document' in deps.global ? deps.global.document : null)
        this.#log = typeof deps.log === 'function' ? deps.log : () => {}
        this.#noticeSink = typeof deps.onNotice === 'function' ? deps.onNotice : null
      }

      /** The bridge the preload exposed, or undefined (the Web GUI, where every file already uploads). */
      #bridge() {
        const holder = this.#global
        if (!isRecord(holder) && typeof holder !== 'function') return undefined
        try { return holder[HOST_PATHS_GLOBAL] } catch { return undefined }
      }

      /**
       * Switch on for this renderer. ACTIVATION IS THE INSTALL: nothing is fetched, no source
       * of DSH's is read from the page (an installed shell serves no package `src` tree, so a
       * page-side read could only ever be a gap — and a gap that kept the first picks of
       * every page DSH's own). What the mechanism rests on is proven per pick, at the pick:
       * the composer region and session attribute (`attributionOfPicker`), the `File`/
       * `DataTransfer` round trip measured here, `answersNoPath` for the page-built copy, and
       * the readback of the replaced list.
       *
       * Outcomes:
       *  - `browser-unavailable`: no `File`/`DataTransfer` to build copies with, or a
       *    `DataTransfer` that drops what it is given. Nothing is changed, ever.
       *  - `active` (`no-bridge`): the Web GUI, where a picked `File` has no path to pack and
       *    every file already uploads.
       *  - `active` (`measured`): an installed shell. The path-free proof is made per pick.
       * @returns {{surface: string, state: 'active'|'unavailable', reason: string|null, shape: string|null, picks: number, uploaded: number}}
       */
      install() {
        this.#attempted = true
        if (!canRematerialize(this.#global)) return this.#refuse('browser-unavailable')
        this.#installed = true
        this.#refusal = null
        // `no-bridge` when the preload exposed nothing (the Web GUI): there is no path to pack,
        // so the answer a page-built `File` gets is DSH's byte upload by construction.
        this.#shape = this.#bridge() === undefined ? 'no-bridge' : 'measured'
        return this.status()
      }

      #refuse(reason) {
        this.#refusal = reason
        this.#installed = false
        this.#log(`remote file attach off: ${reason}`)
        return this.status()
      }

      /**
       * What the Devices page shows, measured NOW (A1.2: the failure mode is visible).
       * `state: 'active'` means "a pick in a remote composer is handed to DSH as byte-only
       * files"; `unavailable` always carries the reason. `reason` with an active state is the
       * last pick's state while it was not uploaded (`certain` means "remote, images only";
       * `replace-failed` means "remote, and the picker refused the copies").
       */
      status() {
        const base = { surface: HOST_PATHS_GLOBAL, shape: this.#shape, picks: this.#claims, uploaded: this.#ended }
        if (!this.#installed) return { ...base, state: 'unavailable', reason: this.#attempted ? (this.#refusal ?? 'not-installed') : 'not-installed' }
        return { ...base, state: 'active', reason: this.#last }
      }

      /** The last pick's attribution state: null before any pick. */
      get lastPick() { return this.#last }

      /** The pick report waiting to be read, once. */
      takeNotice() {
        const notice = this.#notice
        this.#notice = null
        return notice
      }

      /** Picks seen in the capture phase. */
      get claimedPicks() { return this.#claims }

      /** Picks re-materialized for their remote Host. */
      get endedPicks() { return this.#ended }

      /** Nothing was ever installed in DSH's realm, so there is nothing to put back but this record. */
      uninstall() {
        this.#installed = false
        this.#shape = null
        this.#notice = null
        this.#last = null
        this.#refusal = this.#refusal ?? null
      }

      /**
       * The capture-phase body `lib/client.js` calls for one `change` on DSH's picker (R6).
       * Answers the attribution it claimed, with what it did, or null when the event was not a
       * pick. Runs BEFORE DSH's own handler reads `e.target.files`, which is the whole point.
       * @param {Element} picker DSH's own hidden file input (the event target)
       * @param {{mark?: number}} [options] the order mark of the event
       */
      claimPicker(picker, options = {}) {
        const attribution = attributionOfPicker(picker)
        const picks = pickedFilesOf(picker)
        const claim = {
          state: attribution.state, sessionId: attribution.sessionId, sites: attribution.sites,
          mark: Number.isFinite(options.mark) ? options.mark : null, files: picks.length, action: 'none',
        }
        this.#claims += 1
        if (attribution.state !== 'certain') {
          // R6: DSH's own pick. A local composer shows a local id; anything unproven is reported.
          this.#remember(attribution, null)
          return claim
        }
        const tag = splitTaggedSessionId(attribution.sessionId)
        if (tag === null) {
          this.#remember(attribution, null)
          return claim
        }
        // R2: images upload whatever the path says, so an image-only pick changes nothing.
        if (!picks.some((file) => isUploadableFile(file) && !isImageFile(file))) {
          this.#remember(attribution, null)
          return { ...claim, action: 'kept' }
        }
        if (!this.#installed) {
          // A refused mechanism (no `File`/`DataTransfer`) never changes a pick: DSH's own,
          // and the page says which refusal. Nothing here waits for a measurement.
          this.#remember({ state: this.#refusal ?? 'not-installed', sessionId: attribution.sessionId, sites: attribution.sites }, null)
          return { ...claim, action: 'refused' }
        }
        // The pick itself is the last proof, and the one that is not a source pattern: a
        // `File` this page builds has no path, and the preload must say so. When it names one
        // anyway, a re-materialized pick would still be a mention — DSH's own pick stands and
        // the page shows the measured state instead of an upload that did not happen.
        const proof = rerawFile(this.#global, picks.find((file) => isUploadableFile(file) && !isImageFile(file)))
        if (!answersNoPath(this.#global, proof)) {
          this.#log('remote file attach: the preload names a path even for a page-built File; DSH\'s own pick stands')
          this.#remember({ state: 'path-unavailable', sessionId: attribution.sessionId, sites: attribution.sites }, null)
          return { ...claim, action: 'refused' }
        }
        const copies = []
        for (const file of picks) {
          // A directory keeps its own object (its entry is what DSH reads); everything else gets
          // a path-free copy, so the WHOLE batch takes DSH's byte path and none of it is refused
          // because a sibling kept a path (`apply.ts`: one `return` refuses the batch).
          copies.push(isUploadableFile(file) ? rerawFile(this.#global, file) : file)
        }
        const failure = replacePickedFiles(this.#global, picker, copies)
        if (failure !== null) {
          // THE PICK WAS PROVEN REMOTE AND A NON-IMAGE, AND THE PICKER WOULD NOT TAKE THE COPIES.
          // That is its own state, never `certain`: `certain` is a proven pick that needed
          // nothing changed (a local id, images only), and recording it here would show the
          // owner a local-session pick while DSH is about to mention a controller path to the
          // remote Host. DSH's own objects stand (`replacePickedFiles` changes nothing it did
          // not verify), and the page says `replace-failed` with the setter's own reason.
          this.#log(`remote file attach: the picker refused the copies (${failure}); DSH's own pick stands`)
          this.#remember({ state: 'replace-failed', sessionId: attribution.sessionId, sites: attribution.sites }, null)
          return { ...claim, action: 'refused' }
        }
        // Confirmed a second time on the list DSH will actually read: the review the capture
        // phase exists for is that the pick it sees carries no path (`state: 'unverified'`).
        const replaced = pickedFilesOf(picker)
        const firstUploadable = replaced.find((file) => isUploadableFile(file) && !isImageFile(file))
        if (replaced.length !== copies.length || (firstUploadable !== undefined && !answersNoPath(this.#global, firstUploadable))) {
          this.#log('remote file attach: the replaced list did not read back path-free; DSH\'s own pick stands')
          this.#remember({ state: 'unverified', sessionId: attribution.sessionId, sites: attribution.sites }, null)
          // Best effort: DSH's own objects go back where the replacement could not be trusted.
          replacePickedFiles(this.#global, picker, picks)
          return { ...claim, action: 'kept' }
        }
        this.#last = null
        this.#notice = null
        this.#ended += 1
        this.#report(NOTICE_KINDS.upload, { sessionId: attribution.sessionId, hostId: tag.hostId, files: picks.length })
        return { ...claim, action: 'rematerialized' }
      }

      /** The pick report shape the page reads; `intake` mirrors what the last router kept. */
      #remember(attribution, hostId) {
        this.#last = attribution.state
        this.#notice = { reason: attribution.state, sessionId: attribution.sessionId, sites: attribution.sites, intake: null }
        this.#report(NOTICE_KINDS.untouched, { reason: attribution.state, sessionId: attribution.sessionId, hostId })
      }

      #report(kind, notice) {
        if (this.#noticeSink === null) return
        try { this.#noticeSink(kind, notice) } catch { /* a report must never break a pick */ }
      }
    }

    /**
     * The one live instance per global, so a DSH reload in the same window re-uses it.
     * Weak: a global that goes away takes it along.
     */
    const INSTANCES = new WeakMap()

    /** @param {object} deps see {@link RemoteFileIntake} */
    function remoteFileIntakeFor(deps = {}) {
      const holder = deps.global ?? globalThis
      if (!isRecord(holder) && typeof holder !== 'function') return new RemoteFileIntake(deps)
      let instance = INSTANCES.get(holder)
      if (instance === undefined) {
        instance = new RemoteFileIntake({ ...deps, global: holder })
        INSTANCES.set(holder, instance)
      }
      return instance
    }

    /** Install for one global and report what happened; `uninstall` is the caller's disposer. */
    function installRemoteFileIntake(deps = {}) {
      return remoteFileIntakeFor(deps).install()
    }

    /**
     * The delegated capture-phase listener body `lib/client.js` installs for `change` on
     * `document`: the event's own target is the picker (never `currentTarget`, which is the
     * document). Returns the attribution it claimed, or null when the event was not a pick.
     */
    function adoptPickerFrom(attach, event) {
      const target = event !== null && typeof event === 'object' && isElement(event.target) ? event.target : null
      if (attach === null || attach === undefined || typeof attach.claimPicker !== 'function' || target === null) return null
      const picker = formControlOf(target)
      if (picker === null) return null
      return attach.claimPicker(picker, { mark: event.timeStamp })
    }

    return {
      HOST_PATHS_GLOBAL, HOST_PATHS_MEMBER, HOST_TAG, SESSION_VIEW_SELECTOR, COMPOSER_INPUT_SELECTOR,
      COMPOSER_SEAT_SELECTOR, FILE_INPUT_SELECTOR, PICK_EVENT, splitTaggedSessionId,
      isUploadableFile, isImageFile, composerSites, composerContainerOf, attributionOfPicker,
      pickedFilesOf, canRematerialize, replacePickedFiles, dshContract, answersNoPath,
      ATTRIBUTION_STATES, NOTICE_KINDS,
      RemoteFileIntake, remoteFileIntakeFor, installRemoteFileIntake, adoptPickerFrom,
    }
  },
});
