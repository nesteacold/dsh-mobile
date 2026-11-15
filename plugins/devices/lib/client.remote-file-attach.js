// Remote file attach (spec 033, constitution amendment A1.2, owner 2026-11-15).
//
// WHAT THIS FILE IS. This is the ONE implementation of the wrap, and it ships in the
// format DSH's own package-local client chunks use — measured in the installed
// 0.2.2-rc.3 `dsh-client-ui-sidebar-terminal/lib/client.terminal.js`:
//
//   window.__ModuleLoader__.load({id:`<package>`,chunk:`client.<name>.js`,factory:require=>{…;return module.exports}});
//
// The envelope is not decoration. DSH serves a package file byte for byte and relies on
// the returned source to register itself: the terminal chunk above is requested with
// `await require.async('./client.terminal.js')` (built `client.js` of that package) and
// the loader then fails the request with `bundle <url> loaded without registering
// "<id>/client.<name>.js" via __ModuleLoader__.load` unless the script called
// `window.__ModuleLoader__.load` (installed `@deepseek-ai/dsh-client-modules/lib/client.js`
// `importChunk` → `register`, which keys a chunk registration by
// `<owner id>/<chunk>`). A bare `module.exports = …` at the top of a served script is
// therefore not a module at all: nothing registers, every request fails, and the wrap
// never arrived. `lib/remote-file-attach.mjs` loads this same text through a fake
// `__ModuleLoader__` and takes the factory's return value, so the Host-side tests run
// the very code the renderer materializes. There is no second copy to drift.
//
// Why a chunk at all: the renderer's module table resolves a request only against the
// platform seed, memoized records, boot-graph rows and registered factories
// (`dsh-client-modules` built `makeRequire`), so a sibling source file cannot be
// requested. A `client.<name>.js` file next to `client.js` is the one supported second
// file, and the loader owns that name pattern (`^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$`).
//
// What it fixes: in a session that lives on ANOTHER Host, a non-image file picked with
// the composer's `+` never reached that Host. DSH's composer asks
// `globalThis.__DSH_HOST_PATHS__.pathFor(file)` for a local path and turns a non-empty
// answer into an `@"C:\…\file.zip"` MENTION — a path on this machine, which the remote
// Host cannot read — while an empty answer sends the bytes through
// `POST /api/session/uploadFileBinary`, which `lib/upload-route.mjs` already routes to
// the owning Host. So the upload route was already right; nothing ever gave it tagged
// bytes for a FILE pick (the reported zip's 11 917 bytes never appeared on the Host).
//
// Mechanism (spec R4): the wrap of `__DSH_HOST_PATHS__.pathFor`, not the composer's
// `registerFileIntake`. The hook is reachable — it is a member of the composer bar's
// `inject` value (installed `dsh-client-ui-conversation/src/client/apply.ts`,
// `return { registerFileIntake: fileIntake, … }`) — but it cannot answer the per-file
// question: its `add` receives only the picked files. A remote session would then reach
// DSH's `addFiles` with no path and be refused by `attachment.pathUnavailable` (the
// "folders cannot be uploaded" rule) — R3's refusal applied to EVERY file, the opposite
// of R1. It would also move drops and pastes off DSH's own intake. R4's order was
// checked; the hook is real and unusable here.
//
// A1.2 conditions, all of them:
//  - structural self-test, never a version equality: the global must be exactly DSH's
//    `{pathFor}` — no other own key, enumerable, hidden or symbol — and whether it can be
//    wrapped is MEASURED at runtime (`install`), never assumed;
//  - a mismatch means NO wrap and `status().reason` for the Devices page; so does a
//    `pathFor` that cannot be replaced in place (`bridge-frozen`): the global binding is
//    never re-pointed, because composers already injected hold the original object
//    (installed `apply.ts:504`,`:520`);
//  - dispose puts back the exact `pathFor` descriptor it replaced, and only while the
//    bridge's own member is still strictly the wrapper this instance installed;
//  - never two wrappers: one instance per global, and the `ORIGINAL` marker carries the
//    true method, so a reload finds it instead of wrapping a wrapper;
//  - no authorization is touched: the wrapper answers a PATH STRING, never a request. The
//    bytes travel through `lib/upload-route.mjs`, and the remote gateway stays the sole
//    authority (`attachments:write`, size, session visibility);
//  - session attribution (spec R6) is certainty or nothing — see the attribution block.
//
// The decision, each row read from the installed `apply.ts` `addFiles`, not assumed:
//
//  - **Non-image file, tagged session → `''`** — DSH's own "upload these bytes" answer.
//    A relative path would not work either: `relativizeToCwd` only strips a workspace
//    prefix, so a relative path becomes the mention `@bundle.zip`, which is the bug.
//  - **Image → the original answer.** DSH uploads an image whatever the path says
//    (`path === '' || (!directory && isImageMediaType(file.type))`).
//  - **Directory, tagged session → `''`.** That is R3's own refusal,
//    `attachment.pathUnavailable`, which DSH raises before any upload (`directory &&
//    path === ''`). A path would render a folder chip for a Host that cannot read it.
//  - **Local session, no bridge, unknown session → DSH's own answer**, from the method
//    underneath the wrapper, whose `pathFor(file) ?? ''` decides: exactly today's answer.
//    That is R6's fail-safe, and the page says why.
//
// Session attribution (R6). A `pathFor` wrapper cannot be told which session it answers
// for: the composer reads `bridge?.pathFor(file)` with ONE argument and captures the
// bridge once per slot inject, so nothing in the call names a composer. The picker can,
// if it is observed at the right moment — which is why `lib/client.js` listens for the
// file input's `change` event in the CAPTURE phase on `document`: DSH's own handler runs
// in the bubble phase and, in the installed `onPickFiles`, drains `e.target.files` into
// an array and then sets `e.target.value=''` BEFORE `intakeFiles(picked)`, so `.files` is
// already empty by the time the first `pathFor` runs. The capture listener therefore
// claims nothing about which file was picked; it asks which composer's pick this is:
//
//  - `[data-conversation-session]` is the per-session view root (`ConversationRoot`,
//    `sessionId` on the content element; the anchor DSH's own stop shortcut walks to);
//  - `[data-composer-input]` is each composer's own input element
//    (`ComposerContentEditable`) — a SIBLING of the hidden `input[type=file]`: both live in
//    the composer card, the picker inside the input bar's tools row (`InputBar`);
//  - the composer container is the deepest element holding that input and the picker's form
//    control (in the installed layout the card; a card that does not nest them answers its
//    seat, the nearest ancestor carrying `[data-conversation-region="composer"]`);
//  - that container and the session its view names are retained for the TURN the pick was made
//    in: the capture queues one task (`#arm`), so every microtask that turn queues runs first —
//    DSH's own loop over the batch (which awaits its first `readAttachmentPath` before it asks
//    about the second file) or, when DSH refuses the batch before asking (locked, busy,
//    denied, the image limit, an emptied picker), nothing at all. A later call never inherits
//    the pick's session;
//  - focus, "only one composer in the document" and the picker's `.files` are NOT proof. A
//    drop, a paste or a call with no live claim keeps DSH's behaviour, and the page states
//    the state (`no-document`, `picker-document`, `picker-elsewhere`, `no-session`,
//    `composer-uncertain`, `stale-batch`).
//
// The claim BINDS THE FILES, not just the turn (reviewer round 4, 2026-11-16). A session
// claim alone answers `''` for any file until it ends, which is wrong twice: an unrelated
// `pathFor` call made in the same turn (a queued microtask, a second picker) as well as DSH's
// own loop would be answered for somebody else's pick; and a batch DSH REFUSES before asking
// (locked composer, image limit, an emptied picker) leaves a claim that a microtask then
// spends on an unrelated file. So the capture phase — the last moment `.files` still holds
// what the user picked, before DSH drains and resets it — snapshots the exact `File` objects
// (identities, by hand: never `WeakSet#has`, whose TypeError on a non-object would turn a
// drop's `pathFor(null)` into an error DSH never raises), and only those objects are
// answered. Any other file in the turn gets DSH's own answer and a notice that says the
// session is not known for it (`file-unclaimed`), never a guess.
//
// A wrapper that cannot be restored stays a CALLABLE passthrough (reviewer round 4). The
// restore's answer is `Reflect.defineProperty`'s BOOLEAN, not an exception: a slot that
// refuses the original back did not throw, and the retained wrapper is the member DSH's
// composers read. So it is never gutted: the bridge's original `pathFor` stays with it for
// as long as it can be called (the wrapper carries it as `ORIGINAL`), it answers that
// original alone (no upload, no attribution), and the page reports `bridge-frozen`.
// A member made non-configurable but still writable is the one case a plain assignment
// reaches, and the restore tries exactly that first: DSH's own function goes back, and if
// it does not, the callable wrapper simply stays — nothing non-callable is ever written
// into `pathFor` (reviewer finding 2026-11-16: a stand-in object there made every composer
// throw `pathFor is not a function`). README's "Exact restore" says the same.
//
// One body, two deliveries: this file holds every function in its factory, and
// `lib/remote-file-attach.mjs` re-exports these names (`HOST_PATHS_GLOBAL`, …) from it.

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
    /**
     * Marks this module's wrapper with the method it replaced, so a reload that installs a
     * second wrap finds the TRUE native pathFor instead of wrapping a wrapper. Same
     * convention and symbol as lib/upload-route.mjs (which cannot be imported here without
     * dragging a Node module into the browser bundle).
     */
    const ORIGINAL = Symbol.for('@dsh-ext/devices.uploadRouteOriginal')
    /** `h:<hostId>:<rawId>`, the shape `lib/upload-route.mjs#splitTaggedSessionId` accepts. */
    const TAGGED_SESSION = /^h:([0-9a-zA-Z-]{1,64}):([^:]{1,256}(?::.*)?)$/
    /** The kind of a picked directory: it has no bytes, and no Host can read its path. */
    const DIRECTORY_TYPE = 'inode/directory'
    /** Two independent references to one factory return. */
    const ONE_REFERENCE = 1

    const isString = (value) => typeof value === 'string'
    const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

    /** A picked file, about to be asked about: anything DSH may pass (a `File`, or `null`). */
    const isPassed = (file) => file !== undefined && file !== null

    /** Are these one picked file? Identity, and no host call: `WeakSet#has` throws on a drop's `null`. */
    const isSameFile = (one, other) => one === other

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
     * An own property that can be replaced at all: measured, never assumed, and measured
     * NOW — a property that was a plain field at install may be an accessor afterwards
     * (then the setter decides), and one that was an accessor may be a frozen field (then
     * it cannot be replaced at all).
     */
    function canReplace(target, key) {
      if (target === null || typeof target !== 'object') return false
      const descriptor = Object.getOwnPropertyDescriptor(target, key)
      if (descriptor === undefined) return false
      if ('get' in descriptor || 'set' in descriptor) return typeof descriptor.set === 'function'
      return descriptor.writable === true || descriptor.configurable === true
    }

    /**
     * The structure of one own property, `"<kind> <value type>"`: `data function` for an
     * ordinary value, `accessor get+set` / `accessor get` for a property pair, and the
     * `undefined` type for an absent property.
     */
    function structureOf(descriptor) {
      if (descriptor === undefined) return 'absent undefined'
      if ('get' in descriptor || 'set' in descriptor) {
        const pair = `${descriptor.get === undefined ? '' : 'get'}${descriptor.set === undefined ? '' : '+set'}`
        return `accessor ${pair || 'neither'}`
      }
      return `data ${descriptor.value === null ? 'null' : typeof descriptor.value}`
    }

    /**
     * The self-test (R5), pure and strict: is `value` exactly the object DSH's preload
     * exposes — one own key, `pathFor`, whose value is a function?
     *
     * `undefined`/`null` is NOT a failure: the Web GUI has no bridge, and its composer
     * already uploads every file (its own `?? ''`), so that surface needs no wrap. Every
     * other shape is a reason the Devices page shows, and no wrap is installed:
     *  - `bridge-shape`: not a plain non-array object (a string, an array, a function);
     *  - `bridge-keys`: own keys other than a data `pathFor` — a hidden key, a symbol, or
     *    anything else (removing a marker and calling that "the same object" is how a
     *    wrapper ends up replacing a foreign bridge);
     *  - `bridge-pathFor`: `pathFor` is absent, an accessor, or not a function.
     * @param {unknown} value `globalThis[__DSH_HOST_PATHS__]`
     * @returns {null|'bridge-shape'|'bridge-keys'|'bridge-pathFor'} null when it matches
     */
    function hostPathsSelfTest(value) {
      if (value === undefined) return null
      if (!isRecord(value)) return 'bridge-shape'
      const keys = Reflect.ownKeys(value)
      if (keys.length !== 1 || keys[0] !== HOST_PATHS_MEMBER) return 'bridge-keys'
      const descriptor = Reflect.getOwnPropertyDescriptor(value, HOST_PATHS_MEMBER)
      if (structureOf(descriptor) !== 'data function' || typeof value[HOST_PATHS_MEMBER] !== 'function') return 'bridge-pathFor'
      return null
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

    /** A picked file that can be sent as bytes; a directory has none to send. */
    const isUploadableFile = (file) => file !== null && typeof file === 'object' && file.type !== DIRECTORY_TYPE

    /** A picked image, which DSH uploads whatever pathFor answers. */
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
      return composerCardAbove(picker, chain)
    }

    /** The nearest ancestor-or-self marked `[data-conversation-region="composer"]`. */
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
    function composerCardAbove(picker, chain) {
      const view = nearestMarked(picker, SESSION_VIEW_ATTR)
      if (view === null || !isElement(view)) return null
      const card = chain.find((node) => isElement(node) && node !== view && DSH_BRIDGE.isMarked(node, COMPOSER_CARD_ATTR))
        ?? chain.find((node) => node !== view && holdsComposerInput(node))
      if (card === undefined || !containsNode(view, card)) return null
      const suite = chain.find((node) => node !== view && node !== card && containsNode(node, card))
      if (suite === undefined || !containsNode(view, suite)) return null
      if (!inSessionRegion(view, suite)) return null
      // A suite that also holds the seat would straddle a region boundary: ambiguous, not a claim.
      const seat = nearestComposerSeat(chain)
      if (seat !== null && containsNode(suite, seat)) return null
      return suite
    }

    /**
     * Is `node` inside the region `view` breaks — from the view or its content down to the
     * composer seat, and no further (a container of the view, a list of views or a rail, is not)?
     */
    function inSessionRegion(view, node) {
      let held = false
      for (let at = node; held === false && at !== null && at !== undefined; at = at.parentElement ?? null) {
        if (at === view || DSH_BRIDGE.isMarked(at, CONTENT_ATTR)) held = true
      }
      if (!held) return false
      // Past the content: every ancestor up to the first that also holds another session view
      // must be no composer seat.
      for (let at = node; at !== null && at !== undefined; at = at.parentElement ?? null) {
        if (at !== view && DSH_BRIDGE.isMarked(at, SESSION_VIEW_ATTR)) return false
        if (at.getAttribute(COMPOSER_REGION_ATTR) === COMPOSER_REGION) return true
      }
      return false
    }

    /** Does `outer` contain `inner`? A node that cannot answer is not trusted to contain. */
    function containsNode(outer, inner) {
      if (outer === inner) return true
      if (typeof outer?.contains === 'function') {
        try { return outer.contains(inner) === true } catch { return false }
      }
      return lineageOf(inner).includes(outer)
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
     * they exist (`onPickFiles` drains and resets the picker before DSH asks its bridge). The
     * objects are kept by identity; a picker that cannot answer, or has nothing in it, is empty.
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

    /** The states this module reports; the Devices page has a sentence for each. */
    const ATTRIBUTION_STATES = Object.freeze([
      'certain', 'no-document', 'picker-document', 'no-composer', 'picker-elsewhere', 'composer-uncertain',
      'no-session', 'browser-chrome', 'ambiguous', 'stale-batch', 'bridge-passthrough',
      'bridge-frozen', 'file-unclaimed',
    ])

    /**
     * The remote file-intake bridge for one renderer instance.
     *
     * `deps.global` is the object that holds the bridge (`window` in DSH; a plain object in a
     * test); `deps.doc` is the document its composer renders into (defaults to the global's
     * own `document`); `deps.log` records what happened, never what was picked;
     * `deps.onNotice(kind, notice)` receives the pick report the page shows.
     */
    class RemoteFileIntake {
      #global
      #doc
      #log
      #noticeSink
      /** The bridge we wrapped in place, its global binding, and its own `pathFor` descriptor. */
      #found = null
      #descriptor = null
      #member = null
      /** The method underneath us: the bridge's own original `pathFor`. */
      #root = null
      /** The exact wrapper this instance installed in the bridge's own `pathFor` — the value dispose compares against. */
      #wrapper = null
      /**
       * The wrapper was frozen into the slot by a restore that could not write the original
       * back: it is DSH's member now and may answer for as long as the page lives.
       */
      #frozen = false
      /** What we installed: the bridge itself, in place (`in-place`). */
      #ours = null
      #shape = null
      #installed = false
      #attempted = false
      /**
       * Why nothing is wrapped: a reason the bridge names (`bridge-shape`, `bridge-frozen`, …),
       * `refused` when replacing its `pathFor` was attempted and refused, or the last pick's
       * attribution state once the wrap is gone. Cleared by a successful install.
       */
      #refusal = null
      /** The state of the last pick this wrap did not upload (null once a remote pick is uploaded). */
      #last = null
      /** The pick report waiting to be read once (`takeNotice`). */
      #notice = null
      /** pathFor calls the wrap has seen, so the page can tell "wrapped" from "wrapped and used". */
      #calls = 0
      /** The picker claim for the batch in flight, if any (see `claimPicker`/`#release`). */
      #claim = null
      /** Claimed picks and how many ended with the turn that made them or an explicit answer. */
      #claims = 0
      #ended = 0
      /**
       * Picked files a claim is bound to, from the CAPTURE phase (`#picks`): the exact `File`
       * objects, by identity — never a `WeakSet#has`, whose TypeError on a drop's `null` would
       * turn DSH's own call into an error it never raises. Each is answered by the one call that
       * carries it; any other file in the same turn is its own row (`file-unclaimed`).
       */
      #picks = []
      /** Where the claim's answers continue (a file asked for twice is answered twice). */
      #at = 0
      /** The task that ends the claim's turn (every microtask the capture's turn queues goes first). */
      #turn = null

      constructor(deps = {}) {
        this.#global = deps.global ?? globalThis
        this.#doc = deps.doc ?? (isRecord(deps.global) && 'document' in deps.global ? deps.global.document : null)
        this.#log = typeof deps.log === 'function' ? deps.log : () => {}
        this.#noticeSink = typeof deps.onNotice === 'function' ? deps.onNotice : null
      }

      /** The bridge and the descriptor the global holds right now. */
      #live() {
        if (!isRecord(this.#global) && typeof this.#global !== 'function') return { value: undefined, descriptor: undefined }
        const descriptor = Object.getOwnPropertyDescriptor(this.#global, HOST_PATHS_GLOBAL)
        if (descriptor === undefined) return { value: undefined, descriptor }
        if (!Object.hasOwn(descriptor, 'value')) return { value: null, descriptor }
        return { value: descriptor.value, descriptor }
      }

      /**
       * Wrap the live pathFor IN PLACE, or not at all. On any self-test mismatch nothing is
       * patched and `status()` carries the reason (A1.2). An absent bridge is not a mismatch:
       * the Web GUI needs no wrap and reports `wrapped: true, reason: 'no-bridge'`.
       *
       * A member that cannot be replaced is `bridge-frozen` and nothing else is touched (R6):
       * re-pointing the global binding at a delegating object reads as wrapped while the
       * composers already rendered hold the ORIGINAL object — `apply.ts` does
       * `const bridge = hostPathBridge()` once per composer inject (line 504) — so their
       * picks would still become controller-local paths and the page would say otherwise.
       * @returns {{surface: string, wrapped: boolean, reason: string|null, shape: string|null, calls: number}}
       */
      install() {
        if (this.#installed) return this.status()
        this.#attempted = true
        this.#calls = 0
        const { value, descriptor } = this.#live()
        const shape = hostPathsSelfTest(value)
        if (shape !== null) return this.#refuse(shape)
        if (value === undefined) {
          // No bridge, so no local path and every pick is uploaded already. Nothing to restore either.
          this.#refusal = null
          return { ...this.status(), wrapped: true, reason: 'no-bridge' }
        }
        // Measured NOW, not at the self-test: a property that was a plain writable field
        // there may be frozen here. A bridge whose own `pathFor` cannot be replaced is
        // refused — the global binding is never re-pointed (see the method note).
        if (!canReplace(value, HOST_PATHS_MEMBER)) return this.#refuse('bridge-frozen')
        const root = rootOriginal(value[HOST_PATHS_MEMBER])
        // The original is kept by the WRAPPER too (`ORIGINAL`), not only by this instance: a
        // dispose can fail to restore it, and the wrapper then answers it for the life of the
        // page (reviewer round 4). The capture listener may call the wrapper as a bare
        // function, so it must not depend on `this` for anything it answers.
        const intake = this
        const wrapped = function (file) {
          return intake.#frozen || intake.#root === null ? intake.#underneath(wrapped, file) : intake.#pathFor(this, file)
        }
        Object.defineProperty(wrapped, ORIGINAL, { value: root })
        const before = Object.getOwnPropertyDescriptor(value, HOST_PATHS_MEMBER)
        this.#found = value
        this.#descriptor = descriptor
        this.#member = before
        this.#root = root
        this.#wrapper = wrapped
        // An accessor `pathFor` (a bridge that reads something else) is DSH's object to keep:
        // the self-test refused it already, so this is only reachable when the property
        // changed between the test and here — a no-op assignment would report a successful
        // wrap that never happened.
        const accessor = before !== undefined && ('get' in before || 'set' in before)
        try {
          if (accessor) throw new ThrowRecorded('an accessor pathFor is not replaceable')
          value[HOST_PATHS_MEMBER] = wrapped
          if (value[HOST_PATHS_MEMBER] !== wrapped) throw new ThrowRecorded('the in-place wrap did not take')
          this.#ours = value
          this.#shape = 'in-place'
          this.#installed = true
          this.#refusal = null
          this.#frozen = false
          this.#log('remote file attach: the Host path bridge is wrapped in place')
          return this.status()
        } catch (error) {
          this.#log(`remote file attach: the in-place wrap was refused (${error?.name ?? 'error'})`)
          // The original stands if it refuses; nothing was installed, and that is reported.
          try { Reflect.defineProperty(value, HOST_PATHS_MEMBER, before) } catch { /* the original stands if it refuses */ }
        }
        this.#found = null
        this.#descriptor = null
        this.#member = null
        this.#root = null
        this.#wrapper = null
        return this.#refuse('refused')
      }

      #refuse(reason) {
        this.#refusal = reason
        this.#installed = false
        this.#log(`remote file attach off: ${reason}`)
        return this.status()
      }

      /**
       * What the Devices page shows, measured NOW (A1.2: the failure mode is visible).
       * `wrapped` means "the bridge DSH reads right now is ours, or needs no wrap"; a frozen
       * bridge reports `wrapped: false` with `bridge-frozen` before any pick is tried.
       * `reason` is the bridge's state, or the last pick's state while it is not `certain`.
       */
      status() {
        const base = { surface: HOST_PATHS_GLOBAL, shape: this.#shape, calls: this.#calls }
        // A frozen wrapper still sits in DSH's slot (see `uninstall`): the bridge is disabled,
        // not wrapped and not gone, whatever the global does now.
        if (this.#frozen) return { ...base, wrapped: false, reason: 'bridge-frozen' }
        const { value } = this.#live()
        if (value === undefined) {
          if (this.#attempted && this.#refusal !== null) return { ...base, wrapped: false, reason: this.#refusal }
          return { ...base, wrapped: true, reason: 'no-bridge' }
        }
        const shape = hostPathsSelfTest(value)
        if (shape !== null) return { ...base, wrapped: false, reason: shape }
        if (!this.#installed) return { ...base, wrapped: false, reason: this.#attempted ? (this.#refusal ?? 'not-installed') : 'not-installed' }
        if (value !== this.#found || value[HOST_PATHS_MEMBER] !== this.#wrapper) return { ...base, wrapped: false, reason: 'bridge-replaced' }
        return { ...base, wrapped: true, reason: this.#last }
      }

      /** The last pick's attribution state: `certain` when it was attributed, null before any pick. */
      get lastPick() { return this.#last }

      /** The pick report waiting to be read, once. */
      takeNotice() {
        const notice = this.#notice
        this.#notice = null
        return notice
      }
      /**
       * Attribute the batch of picks DSH is about to hand to `pathFor` (R6). `lib/client.js`
       * calls this from a capture-phase `change` listener, i.e. before DSH's own bubble
       * handler drains `.files` and resets the picker. It records which composer the picker
       * belongs to, and — because the claim is only for what was actually picked — the exact
       * `File` objects still in that picker, by identity (the one moment they exist;
       * `pickedFilesOf`). It answers the attribution (`state` + `sessionId`) and the picks.
       *
       * The claim ends when the TURN it was made in is over — one task, queued here so it runs
       * after every microtask that turn queues (DSH's own loop over the batch, a refused
       * batch's nothing) — or as soon as every picked file has its answer (`#settle`).
       * @param {Element} picker DSH's own hidden file input (the event target)
       * @param {{mark?: number}} [options] the order mark of the event
       */
      claimPicker(picker, options = {}) {
        // A frozen wrap claims nothing: its wrapper is DSH's own method and never reads a claim.
        if (this.#frozen) return null
        const attribution = attributionOfPicker(picker)
        const picks = pickedFilesOf(picker)
        this.#claims += 1
        this.#at = 0
        const claim = {
          state: attribution.state, sessionId: attribution.sessionId, view: attribution.view,
          container: attribution.container, sites: attribution.sites, mark: Number.isFinite(options.mark) ? options.mark : null,
          pending: false,
        }
        this.#claim = claim
        this.#picks = picks
        this.#arm(claim)
        const canEnqueue = typeof queueMicrotask === 'function'
        return { state: attribution.state, sessionId: attribution.sessionId, sites: attribution.sites,
          agreed: picks.length === 0 ? 'none' : (canEnqueue ? 'pending' : 'unattributable'),
          files: picks.length }
      }

      /**
       * End the claim when the turn it was made in is over: one task from now, queued behind
       * every microtask that turn queues (a queued microtask that answers an unrelated file,
       * DSH's own loop over the batch, or nothing when DSH refuses the batch before asking).
       * A task, not a microtask: DSH's loop awaits its first `readAttachmentPath` before it
       * asks about the second file, and a claim ended by a microtask would miss it. Counted as
       * `unattributable` by `claimPicker` only when the realm queues none (`queueMicrotask`
       * lives in the same realm as `setTimeout`), and the claim then ends with every answer.
       */
      #arm(claim) {
        const later = typeof setTimeout === 'function' ? setTimeout : null
        if (later === null) return
        this.#turn = later(() => {
          this.#turn = null
          if (this.#claim === claim) this.#disown(claim)
        }, 0)
      }

      /** The claim in flight, for the page and the tests; never a DOM node. */
      get pendingPick() {
        const claim = this.#claim
        if (claim === null) return null
        return { state: claim.state, sessionId: claim.sessionId, sites: claim.sites, pending: claim.pending,
          files: this.#picks.length, answers: this.#at }
      }

      /** Picks claimed since install: the page can tell "no capture reached us" from "no pick ran". */
      get claimedPicks() { return this.#claims }

      /** Claimed picks that ended with their turn or an explicit answer (a claim never lingers). */
      get endedPicks() { return this.#ended }

      /**
       * Put back exactly the bridge's own `pathFor` descriptor — and only while that member is
       * still the wrapper this instance installed. A property that refuses the original back
       * (made non-configurable after install) reports `bridge-frozen` and why a restore was
       * refused. When the member cannot take the original back the wrapper stays DSH's member
       * and answers that original alone (`#underneath`); a member that is still writable gets
       * the original assigned back first. The refusal is the BOOLEAN `Reflect.defineProperty`
       * answers — not an exception — so a restore is only "done" when
       * the slot was read back holding the original. Any other value in the slot is a later
       * writer (another plugin, a DSH reload) and is never clobbered.
       */
      uninstall() {
        const ours = this.#ours
        const wrapper = this.#wrapper
        const found = this.#found
        const member = this.#member
        const root = this.#root
        // A wrapper a previous dispose froze is already plain DSH behaviour: this one only
        // forgets its own record of the wrap (a later instance can still re-wrap it).
        if (this.#frozen) {
          this.#ours = null
          this.#shape = null
          this.#wrapper = null
          this.#found = null
          this.#descriptor = null
          this.#member = null
          this.#root = null
          if (this.#claim !== null) this.#disown(this.#claim)
          return
        }
        this.#ours = null
        this.#shape = null
        this.#wrapper = null
        this.#found = null
        this.#descriptor = null
        this.#member = null
        this.#root = null
        this.#installed = false
        this.#notice = null
        this.#last = null
        const claim = this.#claim
        if (claim !== null) this.#disown(claim)
        if (ours === null || wrapper === null) {
          // A refused install left nothing to put back; the reason still stands until the
          // next install (a reload that finds a frozen bridge must say so, not fall silent).
          this.#refusal = this.#refusal ?? this.#last
          return
        }
        this.#refusal = null
        const live = Object.getOwnPropertyDescriptor(ours, HOST_PATHS_MEMBER)
        // Ours means the same slot still HOLDS the wrapper this instance installed; a
        // property that became an accessor after install no longer does, whatever it reads.
        const holdsOurs = live !== undefined && 'value' in live && live.value === wrapper
        if (!holdsOurs) {
          this.#log('the Host path bridge is no longer ours; left in place')
          return
        }
        // The MEMBER's own descriptor (`found` is the bridge this instance wrapped,
        // `member` its own `pathFor`): the global binding's descriptor says nothing about
        // this field, and using it here would put the member back with foreign flags.
        const target = found ?? ours
        const restored = member !== undefined && 'value' in member && typeof member.value === 'function'
          ? member
          : { value: root, writable: true, configurable: true, enumerable: true }
        if (!this.#restore(target, restored, root)) this.#refusal = 'bridge-frozen'
      }

      /** Did the slot read back holding the restored function? The answer, not a throw. */
      #restore(target, restored, root) {
        let written = false
        try { written = Reflect.defineProperty(target, HOST_PATHS_MEMBER, restored) === true } catch { written = false }
        const after = Object.getOwnPropertyDescriptor(target, HOST_PATHS_MEMBER)
        const readback = after !== undefined && 'value' in after ? after.value : undefined
        if (written && readback === restored.value) return true
        // Refused. The wrapper IS the member there, so it stays callable as DSH's own method —
        // a pure passthrough to the original, no upload and no attribution (`#underneath`).
        this.#frozen = true
        this.#shape = 'frozen'
        // A member made non-configurable but still WRITABLE (`writable: true,
        // configurable: false`) refuses `defineProperty` when it asks for different flags, yet
        // plain assignment of the original answer still takes. Try that before settling for the
        // wrapper: DSH's own method is better than any stand-in.
        const live = Object.getOwnPropertyDescriptor(target, HOST_PATHS_MEMBER)
        if (live !== undefined && 'value' in live && live.writable === true) {
          try { target[HOST_PATHS_MEMBER] = restored.value } catch { /* the wrapper stands */ }
          const assigned = Object.getOwnPropertyDescriptor(target, HOST_PATHS_MEMBER)
          if (assigned !== undefined && 'value' in assigned && typeof assigned.value === 'function'
            && rootOriginal(assigned.value) === root) {
            // A function is back — but a frozen instance compares identity, and the assigned
            // value is the bridge's own original, so it answers DSH's method from here on. The
            // page is still told `bridge-frozen`: this restore was not the exact one.
            this.#log('the Host path bridge could not be restored exactly (bridge-frozen); its own pathFor was assigned back')
            return false
          }
        }
        // A NON-CALLABLE is never left in DSH's slot — every composer would then throw
        // `pathFor is not a function` — so nothing is written here: the callable wrapper stays.
        this.#log('the Host path bridge cannot be restored (bridge-frozen); its wrapper answers DSH\'s own pathFor alone')
        return false
      }

      /**
       * Who this call belongs to: the claim's session when the claim still fits the live
       * document, `bridge-passthrough` when it does not, `null` when there is no claim.
       */
      #attribute() {
        const claim = this.#claim
        if (claim === null) return null
        const doc = this.#doc
        // A composer that left the document after the pick is a stale batch: the session a
        // later pick shows says nothing about the one this file was picked for §R6).
        if (claim.view !== null && !inDocument(doc, claim.view)) return { state: 'stale-batch', sessionId: null, sites: claim.sites }
        if (claim.container !== null && !inDocument(doc, claim.container)) return { state: 'stale-batch', sessionId: null, sites: claim.sites }
        // The composer may have re-rendered between the pick and the call: the session it
        // names now must still be the one the pick was claimed for.
        if (claim.state === 'certain' && sessionIdOf(claim.view) !== claim.sessionId) {
          return { state: 'composer-uncertain', sessionId: null, sites: claim.sites }
        }
        return { state: claim.state, sessionId: claim.sessionId, sites: claim.sites }
      }

      /**
       * The wrapped pathFor: DSH's own call shape (one argument) and DSH's own answer shape
       * (a string; `''` = "upload these bytes"; `undefined` = DSH's own `?? ''`).
       *
       * Every call gets DSH's own answer FIRST, from the original underneath (`#passthrough`),
       * so nothing here can change what DSH asked for — only what it hears for a file this
       * pick actually carries.
       */
      #pathFor(bridge, file) {
        // A frozen wrapper (see `uninstall`) is DSH's own method again: no upload, no notice.
        if (this.#frozen) return this.#underneath(bridge, file)
        const path = this.#passthrough(bridge, file)
        this.#calls += 1
        const claim = this.#claim
        if (claim === null) {
          // No pick event reached us (a drop, a paste, a direct call): DSH's own answer.
          this.#remember({ state: 'no-document', sessionId: null, sites: 0 }, null, path)
          return path
        }
        claim.pending = true
        try {
          return this.#decide(file, path)
        } finally {
          this.#settle(claim)
        }
      }

      /** DSH's own answer: the original method, called exactly as DSH calls it. */
      #passthrough(bridge, file) {
        const root = this.#root
        if (typeof root !== 'function') return undefined
        // DSH's own bridge does not read `this`: the preload exposes
        // `pathFor: (file) => electron.webUtils.getPathForFile(file)` (an arrow), so `this`
        // is the bridge and the answer is the same. A throwing native call stays DSH's
        // failure, not ours.
        try { return Reflect.apply(root, bridge, [file]) } catch (error) {
          this.#log(`remote file attach: the Host path bridge threw (${error?.name ?? 'error'}); DSH's own result stands`)
          throw error
        }
      }

      /**
       * DSH's own answer from the wrapper's own `ORIGINAL`, for a wrapper whose instance has
       * let go of the original (a frozen wrap, or a duplicate module instance in the same
       * realm): DSH's member then, and it answers what DSH's method answers. A thrown native
       * error stands here too — it is the native call's, not ours.
       */
      #underneath(wrapper, file) {
        const root = rootOriginal(wrapper)
        return typeof root === 'function' ? Reflect.apply(root, this.#found, [file]) : undefined
      }

      /**
       * The place in this pick that answers for `file`: the next picked file when the call is
       * not a `File` DSH can compare (a drop's `null`), and the exact pick when it is one.
       * `null` is the `file-unclaimed` row: the claim is only for the files captured with it.
       * @returns {{file: object, owns: boolean}|null}
       */
      #finding(file) {
        if (!isPassed(file)) {
          const next = this.#picks[this.#at]
          return next === undefined ? null : { file: next, owns: false }
        }
        for (let at = 0; at < this.#picks.length; at += 1) {
          if (isSameFile(this.#picks[at], file)) return { file, owns: true }
        }
        return null
      }

      /** One row of the decision table, with the attribution this claim gives it. */
      #decide(file, path) {
        const attribution = this.#attribute()
        if (attribution === null) {
          // No pick event reached us (a drop, a paste, a direct call): DSH's own answer.
          this.#remember({ state: 'no-document', sessionId: null, sites: 0 }, null, path)
          return path
        }
        if (attribution.state !== 'certain') {
          // R6: DSH's own pick, DSH's own behaviour; the page says why.
          this.#remember(attribution, null, path)
          return path
        }
        const tag = splitTaggedSessionId(attribution.sessionId)
        if (tag === null) {
          this.#remember(attribution, null, path)
          return path
        }
        const found = this.#finding(file)
        if (found === null) {
          // The claim is only for the files captured with it: a call for any other file in the
          // same turn is not this pick, so DSH's own answer stands and the page says the
          // session is not known FOR THIS FILE (reviewer round 4).
          this.#remember({ state: 'file-unclaimed', sessionId: attribution.sessionId, sites: attribution.sites }, null, path)
          return path
        }
        return this.#answer(attribution, tag, file, path, found)
      }

      /**
       * The upload rows, for a file the claim covers: a directory answers `''` (R3: DSH's own
       * `attachment.pathUnavailable`), an image and anything DSH cannot upload keep the path
       * DSH gave, and a non-image file of a remote session answers `''` — its bytes.
       * @param {{file: object, owns: boolean}} found the pick this answer stands for
       */
      #answer(attribution, tag, file, path, found) {
        let answer
        if (!isUploadableFile(file)) {
          // R3: a directory reaches DSH's own `attachment.pathUnavailable` only through `''`.
          answer = ''
          this.#remember(attribution, null, path)
        } else if (isImageFile(file) || !isUploadableFile(found.file)) {
          // A non-file entry in DSH's loop (an image is uploaded whatever the path says; a
          // pick that is not a file uploads nothing). DSH's own answer, and the page says why.
          answer = path
          this.#remember(attribution, null, path)
        } else if (tag !== null) {
          answer = ''
          this.#last = null
          this.#notice = null
          this.#report('upload', { sessionId: attribution.sessionId, hostId: tag.hostId, name: file?.name })
        } else {
          answer = path
          this.#remember(attribution, null, path)
        }
        // A call for a file the capture did not see closes the rest of the loop: every entry
        // still open was asked about before it, so it is answered once more, by entry order.
        if (!found.owns) this.#at = Math.min(this.#at + 1, this.#picks.length)
        return answer
      }

      /**
       * End the claim as soon as every pick it captured has its answer; otherwise the turn's
       * own task ends it (`#arm`), so a pick DSH never asks about is never answered twice and a
       * claim never outlives the turn it was made in.
       */
      #settle(claim) {
        if (this.#claim !== claim) return
        if (this.#picks.length === 0 || this.#at >= this.#picks.length) this.#disown(claim)
      }

      /** The claim is over: nothing of it may answer a later call. */
      #disown(claim) {
        if (claim !== null && this.#claim !== claim) return
        this.#claim = null
        this.#picks = []
        this.#at = 0
        this.#ended += 1
      }

      #remember(attribution, hostId, path) {
        this.#last = attribution.state
        this.#notice = { reason: attribution.state, sessionId: attribution.sessionId, sites: attribution.sites, intake: null }
        this.#report('refused', { reason: attribution.state, sessionId: attribution.sessionId, hostId, path })
      }
      #report(kind, notice) {
        if (this.#noticeSink === null) return
        try { this.#noticeSink(kind, notice) } catch { /* a report must never break a pick */ }
      }
    }

    // THIS FILE NO LONGER RE-POINTS THE GLOBAL BINDING. DSH reads the bridge once per composer
    // inject (installed `apply.ts:504` `const bridge = hostPathBridge()`, then `:520`
    // `bridge?.pathFor(file)`), so a composer rendered before such a re-point held the ORIGINAL
    // object and still answered a controller-local path while the page said wrapped (R6: a wrap
    // that cannot cover DSH's composers is a wrong answer, not a partial one). A bridge whose
    // own `pathFor` cannot be replaced is `bridge-frozen`: no wrap, nothing touched, the page
    // says so. Every remaining install is that same bridge's own member, so an uninstall leaves
    // nothing behind that a later instance could misread as DSH's bridge.

    /** A recorded install failure: the message is the log line, nothing is thrown outward. */
    class ThrowRecorded extends Error {}

    /** The native method underneath any number of our wrappers. */
    function rootOriginal(fn) {
      let current = fn
      for (let depth = 0; depth < 8; depth += 1) {
        const next = current?.[ORIGINAL]
        if (typeof next !== 'function') return current
        current = next
      }
      return current
    }

    /**
     * The one live instance per global, so a DSH reload in the same window re-uses it instead
     * of wrapping its own wrapper. Weak: a global that goes away takes it along.
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

    /** Install the wrap for one global and report what happened; `uninstall` is the caller's disposer. */
    function installRemoteFileIntake(deps = {}) {
      return remoteFileIntakeFor(deps).install()
    }

    /**
     * The delegated capture-phase listener body `lib/client.js` installs for `change` on
     * `document`: the event's own target is the picker (never `currentTarget`, which is the
     * document). Returns the attribution it claimed — with the files it bound it to — or null
     * when the event was not a pick.
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
      COMPOSER_SEAT_SELECTOR, FILE_INPUT_SELECTOR, PICK_EVENT, hostPathsSelfTest, splitTaggedSessionId,
      isUploadableFile, composerSites, composerContainerOf, attributionOfPicker, ATTRIBUTION_STATES,
      RemoteFileIntake, remoteFileIntakeFor, installRemoteFileIntake, adoptPickerFrom,
      HOST_PATHS_ORIGINAL: ORIGINAL, HOST_PATHS_INSTANCES: INSTANCES, hostPathsRootOriginal: rootOriginal,
    }
  },
});
