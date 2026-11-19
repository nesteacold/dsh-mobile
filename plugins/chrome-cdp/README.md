# @dsh-ext/chrome-cdp

Shared Chrome control over the DevTools protocol (CDP) on loopback, plus a Chrome tab in the
right sidebar. Spec `specs/035-chrome-cdp/`. Owner approval 2026-11-15.

Chrome is a browser the owner already runs on this machine with `--remote-debugging-port`.
This plugin never launches Chrome, never creates a profile, never kills a process and never
changes a port (R1). It finds that Chrome at one loopback endpoint and drives it with the
`chrome_*` tools and with the sidebar tab.

## Install

```yaml
- insert:
    - id: chrome-cdp
      name: '@dsh-ext/chrome-cdp'
      config:
        endpoint: 'http://127.0.0.1:40222'   # loopback literal only (127.0.0.1, ::1, localhost)
        launchPolicy: never                  # the only value v1 accepts
        dataDir: ''                          # '', or an absolute path for screenshots
```

`engines.dsh: >=0.2.2-rc.3 <0.3.0-0`. Install it like any Host plugin
(`dsh plugin --profile <name> add @dsh-ext/chrome-cdp`); it writes under a data directory
`<DSH_HOME>/chrome-cdp` unless `dataDir` says otherwise (R8).

## Tools (R2)

| Tool | What it does | Asks |
|---|---|---|
| `chrome_status` | endpoint, connection state, Chrome's own version | never |
| `chrome_tabs` | the open tabs, the bound one marked | never |
| `chrome_snapshot` | title, URL and numbered interactive elements, including OOPIF frames | never |
| `chrome_screenshot` | JPEG of the bound tab into the plugin data directory | never |
| `chrome_open` | open a tab, or bind an existing one by `targetId` | unless Full access |
| `chrome_click` | click element `[n]` inside the frame that printed that number | unless Full access |
| `chrome_fill` | type into element `[n]`; a password field is refused | unless Full access |
| `chrome_key` | Enter, Tab, Escape, arrows, Home/End, PageUp/PageDown, Space | unless Full access |
| `chrome_close_tab` | close exactly the `targetId` you name | unless Full access |

Every result states browser, execution host, endpoint and connection state. The R9 sentence for
an endpoint nothing answers is `Chrome CDP not reachable at <endpoint> on <host>; start Chrome
with --remote-debugging-port or fix config`, and it never suggests the sidebar Browser.

## Permissions (R7)

The session's permission preset is the switch, exactly as in `plugins/sidebar-browser` (C2a).
The plugin registers a `tools/pre-execute` listener and returns DSH's own `{ kind: 'ask' }`
for a mutating call outside Full access; the tools pipeline raises the approval and the
session's approval policy decides. Under Full access nothing asks. The mode is read from
`ctx.permissionPresets.current`, with `ctx.sandboxPolicy.resolve` as the fallback, never from
UI state. Read-only tools carry no declaration.

## Tab binding and leases (R4, R5)

Each DSH session keeps its own `targetId`. Before an action the plugin verifies the target
still exists and reports its URL; a tab that vanished is reported by id instead of being
silently replaced. A session that acts on a tab holds it for 60 s of idling; while it acts,
another session gets `tab in use by another session`. `chrome_close_tab` closes only the id
it is given: nothing closes implicitly, so a stalled session cannot make a named tab
impossible to close.

## Page content (R6) and credentials (R8)

Every result that carries page text (tab titles, URLs, element labels, snapshot listings) is
wrapped as untrusted page content, the sidebar-browser C4 pattern. The plugin never reads a
cookie, a storage value or the password store, and `chrome_fill` refuses an element whose
type is `password` before typing anything. Screenshots are written only inside the plugin
data directory.

## The sidebar tab (R10 to R14)

`lib/client.js` registers a `chrome` tab type through the public two-stage sidebar API
(`ctx.sidebarRightTabs.register` plus the keyed `sidebar.right.pane.tab` and
`sidebar.right.pane.tab.title` seats) with a guide entry "Chrome". The body shows one Chrome
tab in a canvas fed by the Host (`Page.captureScreenshot` relayed over the bridge), with a tab
picker, an address bar and back / forward / reload; mouse, wheel and keyboard are forwarded as
`Input.dispatch*`. No external site is embedded in an iframe. The UI uses `--dsw-alias-*`
tokens only, and the client half imports React from the module table, never a DSH package.

The Host relays through four JSON POST routes under `/api/dsh-chrome-cdp/` (`tabs`, `shot`,
`input`, `nav`) on DSH's owner-authenticated `connection.fetch` registry. DSH's `/api` fence
owns the owner principal and Host/Origin trust; the plugin repeats the owner check, requires
`application/json` and the per-start secret, and answers with `cache-control: no-store`. Exact
`webServer` routes are deliberately not used: DSH Desktop does not reliably mount them after
Host `ready` (R12). The secret is minted with `crypto.randomBytes(32)` and injected for the
owner's page only through `webserver/index-inject` (a render for any other principal gets no
row). See the R1 and R9 sections for what the remote and unreachable cases show.

DSH Desktop caches the injection table at Host `ready`, so an already-open window gets no
global when this plugin is installed or reloaded afterwards. The Host therefore also registers
one narrow owner-authenticated route, `GET /api/dsh-chrome-cdp/bridge-secret`, on
`ctx.connection.fetch.register` (DSH admits fetch routes only for owner principals, and the
handler repeats that check). The client uses the injected global first and asks this route
once, in memory, only when the global is missing; same-origin credentials, `no-store`, the
usual request deadline, and validation of `{secret, dsh}` keep it narrow. A failed attempt
leaves the view closed — it is never retried on every bridge post, and no secret is made
global. The four relay routes live on that same owner-authenticated `/api` registry and use the same secret header.

The sidebar view is for the local app window only (R14): a window that is not served from
loopback gets an explanatory notice instead of a view, because CDP never leaves loopback.

## Where the plugin reaches into DSH (read from 0.2.2-rc.3)

| Surface | Use |
|---|---|
| `ctx.tools.register` | the nine tools |
| `ctx.on('tools/pre-execute')` | the R7 risk declaration |
| `ctx.on('webserver/index-inject')` | the owner-only bridge secret row |
| `ctx.connection.fetch.register` | four `POST /api/dsh-chrome-cdp/*` relays plus `GET /api/dsh-chrome-cdp/bridge-secret`, all owner-only |
| `ctx.sidebarRightTabs.register`, `ctx.slots.inject` / `register` | the tab type and its two seats |
| `ctx.locale.bind` | the `chromeCdp` copy namespace |

The tool gate depends on files the shell owns (the sidebar seat props through `useTabInfo`
and `t`, the `webserver/index-inject` event, the owner principal). None of it is version
pinned: a missing hook surfaces as a visible reason in the result, never a silent workaround.

## CDP mechanics

Discovery is `/json/version` and `/json/list`; tab management goes through the browser
WebSocket (`Target.closeTarget`) and `/json/new` (PUT, Chrome 111 and later). A page gets its
own WebSocket with `Target.setAutoAttach` (`waitForDebuggerOnStart`, flattened), so an OOPIF
is resumed and read in its own session before its first script runs, and a visibility-hidden
element never takes a number. The numbering pass writes `data-chrome-cdp-index` into the frame,
and the click and fill resolve that number to a viewport coordinate inside the same frame, so
scrolling and window position can never move a click (R3). A number written in the last two
minutes is kept, so the numbers a snapshot printed remain valid for the click that follows.
Node's global `WebSocket` is the transport: no dependency is added.

The `chrome` tab body polls one JPEG every 350 ms through the bridge (`Page.captureScreenshot`
in JPEG). The CDP screencast relay is deferred to v2; the spec allows either.

## Tests

```sh
npm test
```

107 tests over the endpoint validation, the R2 tool surface, the R7 risk declaration, the R4
binding and lease rules, the R5 close rules, the R6 untrusted wrapping, the R8 refusals and
screenshot confinement, the R12 route authorization and owner-only secret row, the R3
snapshot script (a fixture DOM in a VM, including both frame sessions of an OOPIF), and the
CDP client against a fake Chrome that speaks real WebSocket framing.

Two independent guards keep the suite off a real browser:

1. The fake Chrome answers only at its own ephemeral loopback port, and `/json/new` refuses
   unless a test opted in.
2. In a process that runs under `node --test`, the plugin refuses every side effect unless
   `DSH_CHROME_CDP_ARM_FAKES=1` is set. The five spec files set it at the top, before their
   imports, so they may drive the fakes; nothing else in a test process can open, close or
   type into a window. The rule itself is a pure predicate (`underTestGuard`) and is pinned by
   a test.

Measured on this machine with the owner's Chrome running on the default endpoint: a full
`npm test` added no tab and closed none (the tab list was identical before and after).

## Not verified here

The suite was not run against a live Chrome with the tools unattended: the live check in
`specs/035-chrome-cdp/spec.md` (`chrome_status`, `chrome_tabs`, a snapshot of example.com, and
no new Chrome process) is the owner's step. The sidebar tab is exercised as a registered
component and against the fake Chrome bridge; the canvas paint in a real carrier (through
`createImageBitmap`) is not. The reviewer pass on network exposure and input forwarding that
the spec asks for has not happened yet: the first attempt was a Codex subagent that failed
without output.

One known page-side limit: the reuse window keeps element numbers fresh by reading a stamp the
pass writes on the frame. A page whose own script tampers with that stamp or forges it can
make the next call renumber (safe: numbers only ever move to fresh ones) or try to keep stale
ones. Kept numbers are only ever adopted together with the pass that wrote them, and the worst
outcome of a forged pass is a click that lands on an element the page itself described, which
is no more than what any page can do to what it shows. Pages that stall their webfonts (a 750 ms
timer) get an inventory without numbers rather than a number that changed mid-call.


## Reviewer fixes (2026-11-16)

The ten findings of the first reviewer pass are handled in this package:

- Finding 1: a password value is never read or returned (lib/snapshot-script.js, lib/cdp.js); a synthetic value in a test proves it.
- Finding 2: discovery refuses an HTTP redirect and validates every `webSocketDebuggerUrl` (scheme, host, port) against the configured endpoint before a socket opens (lib/cdp-client.js).
- Finding 3: element numbers are the host's, one series for the page, each mapped to its exact frame, session, isolated context and element; same-process child frames are read through `Page.getFrameTree`; a number printed from an ambiguous tree is refused (lib/cdp-client.js, lib/snapshot-script.js).
- Finding 4: `Runtime.runIfWaitingForDebugger` carries a string session id and a failed resume is reported on that frame (lib/cdp-client.js); the fake validates the id type.
- Finding 5: a page connection belongs to the DSH session that opened it, never shared with or replaced by another session; the 60 s idle lease is the conflict rule, operations are serialized per target, and the sidebar view is its own session (lib/cdp-client.js, lib/index.js).
- Finding 6: every page-derived word in a click or fill summary stays inside the untrusted block (lib/index.js, lib/cdp.js).
- Finding 7: a WebSocket connect timeout, a pre-open close is a failed open, the font wait always resolves in the page's own realm, and every client fetch has a deadline (lib/cdp-client.js, lib/snapshot-script.js, lib/client.js).
- Finding 8: sidebar input is serialized per target, coalesces pointer moves, keeps modifier and button state, and sends balanced press/release pairs including on a double click and on a leave (lib/client.js, lib/index.js).
- Finding 9: the client registers `en` and `vi` dictionaries with `ctx.locale.register('chromeCdp', ...)` and carries `type.label`, `guide.title` and `guide.description` (lib/client.js, locale/).
- Finding 10: no `? null : null` expression and no stray token comments remain in the input path or `lib/cdp.js`.

Hermetic tests: the harness defaults every host to a discard port and arms the fakes itself, and a test process never contacts the owner's Chrome on 40222 (test/harness.mjs, lib/index.js, lib/cdp-client.js). `test/review-findings.test.mjs` pins each finding above.


## Reviewer round 2 (2026-11-16)

The second reviewer pass found runtime defects the fake had been masking; each is fixed and pinned in `test/round2.test.mjs`, whose `document` fixture runs the REAL page script inside a VM:

- Frame-local numbers: `page.index` keeps both the page-wide number and the frame-local `localIndex`; a click or fill looks up the frame-local number in that frame's isolated world (`lib/cdp-client.js`).
- OOPIF worlds: each attached target is asked for its own `Page.getFrameTree` and its real root frame id is passed to `Page.createIsolatedWorld`; a frame that cannot be read stays in the results as unreadable (`lib/cdp-client.js`). The fake now refuses a world call without its required `frameId`.
- Selections are keyed per session; the only exclusion is the active 60 s lease, after which any session (and the sidebar) shares the live connection and nobody's selection is deleted. The sidebar screenshot renews the view's own lease (`lib/cdp-client.js`, `lib/index.js`).
- Sidebar input forwards the owner's real gestures (down, move, up), releases only on up or a leave, runs each operation on the target's queue, and keeps one pending move slot fed by a single pointer chain (`lib/index.js`).
- The page-side frame bridge is gone: one script reads one document, and the Host walks the frames and merges (`lib/snapshot-script.js`, `lib/cdp-client.js`).
- No process-wide `fetch` override: the plugin wraps only the transport it hands its client (`installOwnerPortGuard`), and `ChromeCdp` takes an injected transport (`lib/index.js`, `lib/cdp-client.js`).


## Reviewer round 3 (2026-11-16)

The third pass found state and geometry defects; each is fixed and pinned (`test/round3.test.mjs`, `test/client-view.test.mjs`):

- The sidebar view's forwarding state lives in a `useRef` (one queue per mounted view, kept across renders); a cancel is enqueued behind every accepted gesture instead of sent beside it, and a tab change or unmount clears the timers, the single pending-move slot and the old tab's queue (`lib/client.js`).
- A same-process frame's rect is translated through its owner geometry before it is dispatched: `DOM.getFrameOwner` names the exact owner element of the frame id and `DOM.getBoxModel` measures its content quad on the page session, accumulated innermost first through nested frames, so a nested iframe click lands in the page viewport the input is sent on; an owner Chrome will not name or measure refuses instead of clicking blind (`lib/cdp-client.js`). The fake Chrome answers both DOM commands with real offsets, and the sibling and nested cases are pinned (`test/cdp-client.test.mjs`).
- Snapshots are per calling session with a generation: a click or fill resolves only against its own session's numbers, and a missing, superseded or navigated-away snapshot is refused with `stale snapshot ... take a new chrome_snapshot` — the old silent re-snapshot is gone (`lib/cdp-client.js`, `lib/index.js`).
- Pointer moves and wheel events carry the modifier keys the view reported (`lib/index.js`).


## Round 4 (2026-11-16)

Two reviewer findings after round 3, fixed in this package:

- `chrome_fill` carries the calling session: `fill` passes `task` to its element lookup and to the focus click, so a fill by session B on a connection session A opened resolves B's own snapshot instead of the connection owner's (`lib/cdp-client.js`).
- The iframe owner is read from CDP, never guessed from the DOM: the sole-iframe fallback and its `iframe[name=...]` lookup are gone (`lib/cdp.js`, `lib/cdp-client.js`).
