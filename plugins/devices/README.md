# @dsh-ext/devices

A **Devices** page inside DSH Settings (Qoder-style), spec `specs/008-devices-page`. Private package, `engines.dsh: 0.2.2-rc.3`.

- **Allow connections to this device** — switch the local `mobile-gateway` on/off (LAN), generate a `desktop` pairing code (copy + expiry countdown), see this device's addresses, list authorized devices, remove access, edit permissions. The switch position is remembered in the gateway state file, so it survives a plugin reload or a DSH restart; the off position is remembered too, and that is the kill switch. If the write fails the page says so and the position applies only until the session ends.
- **Connect to other devices** — paste an address + pairing string from another Host; this Host dials it (pinned WSS), then lists its sessions, shows history, sends prompts and decides approvals.

It needs `@dsh-ext/mobile-gateway` loaded in the same profile (the page drives its `/mgw/*` admin routes). It does not edit the gateway, DSH core, or the protocol package.

## Install (local folder)

Not published. Add the folder to a profile with the plugin manager (`dsh plugin add` accepts a local path):

```
dsh plugin --profile <name> add C:\path\to\dsh-ext\plugins\devices
```

or add it from the plugin manager UI ("install from folder"). This appends the package to `dsh.profile.bundles`, applies `cordis.patch.yml` (one `devices` row, consumes `webServer`) and bundles `lib/client.js` (`dsh.client`, web). Restart the web profile; **Settings → Devices** appears.

`ws` is not yet a dependency of this folder (no network install in this workspace). `lib/remote-client.mjs` resolves `ws` normally and otherwise falls back to `../../mobile-gateway/node_modules/ws`. For a standalone install add `"ws": "^8.18.0"` to `dependencies` and run `npm install`.

Config (`cordis.patch.yml`): `dataDir` (default `~/.dsh/devices-page`), `allowPublicRemotes` (default `false`), `remoteSessions` (default `true`, the multi-host gateway wrapper), `sessionCacheMaxBytes` (default 2 MiB per transcript file) and `sessionCacheRotations` (default 2) for the offline copy below. The link supervisor is configured by `autoReconnect` (default `true`), `reconnectDelaysMs` (default `[1000, 2000, 5000, 10000, 30000]`, each entry clamped to an integer in `[100, 300000]` ms before the ±20% jitter; an empty or invalid list falls back to the default) and `reconnectStableMs` (default `10000`, clamped to the same range): every stored remote is dialled once at start-up and again, with that bounded ±20% backoff, whenever the Host drops the link on its own, so a remote Host's workspace group returns after either side restarts without a human pressing Reconnect. The backoff sequence starts over only once the link has stayed online for `reconnectStableMs` — a host that greets and immediately drops keeps climbing instead of being redialled at the first step forever. A close this side asked for (including one that arrives during the TLS handshake: the pending socket is destroyed before the credential-bearing upgrade), a `4401` revocation (the token is wiped), a missing credential and a `pin-mismatch` (the host now presents another certificate; nothing was sent, the row says so and only pairing again clears it) are never retried automatically, and `autoReconnect: false` restores the explicit-only behaviour. `test/auto-reconnect.test.mjs` and `test/reconnect-hardening.test.mjs` cover it.

## Usage

1. On the host to be controlled: Settings → Devices → turn on **Allow connections** → **Generate pairing code** → Copy.
2. On the controlling host: **Connect to other devices** → address (`192.168.1.20:3081`, from the other host's address chips) + paste the string → **Pair and connect**.
3. Open the remote host → sessions → history → send a prompt; pending approvals show **Allow once / Reject**.
4. **Edit permissions** cannot change a paired device (the gateway has no scope-update route): it generates a new pairing code with the chosen scopes; the device must pair again, which closes its old sockets (4401, spec 005 T8).

## Security model

- **No new listener.** The plugin only registers `/devices` on the Host web server. Every request (GET included) must come from loopback **and** be same-origin, else 403. The browser never sees a remote token.
- **Outbound only, pinned.** The pairing string carries `certSha256`. The peer certificate is read off the TLS handshake; on a mismatch that handshake is all that was sent (no pairing code, no token). The WebSocket then runs on that same verified socket, so the pin is the whole trust decision and the Host's CA store is never consulted — the gateway's certificate is self-signed and Electron's TLS (BoringSSL) refuses it as a CA-store anchor, which is why chain building must not decide (spec 008). No `Origin` header is sent; credentials go only in `dsh-pair.<code>` (first pairing) and `Authorization: Bearer` — never in URLs.
- **Addresses.** The typed `ip:port` must match an endpoint in the pairing string; only loopback/private/Tailscale addresses are accepted unless `allowPublicRemotes: true`.
- **Address edit checks less than add.** `PATCH /devices/remotes/:id` (the owner's address change, e.g. after a Tailscale IP moved) requires a typed port, `wss`, no credentials/query/fragment, and a private address unless `allowPublicRemotes: true` — but, unlike the add path, it is **not** tied to an endpoint in the signed pairing payload. The certificate pin is the real gate: the bearer token is written only on a socket whose leaf certificate matches the stored pin (an edit can never change the pin), so a wrong or hostile address can only produce a `pin-mismatch` denial, never a token leak.
- **Tokens.** One file per remote, `tokens/<id>.token`, mode 0600 (dir 0700) on POSIX; on Windows ACL inheritance is removed and only the current user is granted (`icacls`). Never logged, returned or placed in `remotes.json`. On close `4401` the token is overwritten and deleted and the remote is marked `revoked` (no auto-reconnect). Removing a remote deletes its token.
- **Approvals.** Pending approvals are buffered per remote. A decision echoes the **server-buffered** `argsHash`, never one supplied by the page; a request without a hash is desktop-only; a decision is applied at most once (the gateway is authoritative). A remote approval/question card is also re-published into the native conversation `$events` stream with its ids in the `h:<hostId>:` namespace, so it appears in the native approval card; answering it routes back to that host only (an approval through the bridge's hash-bound `$events/result`, a question through the bridge's `userQuestions/answer` with the card's own tool-call id — never through the admin-only `question-answer` frame), and a disconnect withdraws it. An id that arrives from a remote is opaque: it is always wrapped in that host's namespace, and a payload that already carries a namespace tag is refused (`remote/id-leak`).
- **Offline copy.** Every `session/follow` frame of an opened remote session is appended to `sessions/<host-slug>-<sha256(hostId)>/<session-slug>-<sha256(sessionId)>.jsonl` (one JSON object per line, size-capped; rotations live in a `rot/` subdirectory). An id is never used as a file name — it is hashed — so a session id containing `:`, `..` or a rotation-shaped suffix cannot alias another file, and two ids differing only by case stay distinct. Only session frames are written, never a token or header. While that host is offline, `GET …/sessions/:sid/history` and the native session view replay the copy read-only; prompts are refused with `remote/host-offline`. **Remove local copy** deletes the files.
- **A disconnect keeps the sessions listed.** Losing the link is not forgetting the host: the merged `session/list` the native sidebar renders retains the last rows that host listed, under the **same** `h:<hostId>:<sid>` aliases, so nothing vanishes from the sidebar and an already-open session resumes under the identity the user had (`lib/host-router.mjs`, `#retainedRows`). Only two things end that retention: **Forget host** (`DELETE /devices/remotes/:id`) and a `4401` revocation, because there the grant is gone rather than the link. A refusal the Host itself answers (`auth/forbidden-scope`) also drops the rows — it is "nothing for you", not "away for a moment". `GET /devices/remotes` reports such a host in `routing.disconnected` (`{hostId, hostName, online:false, retainedSessions}`) so the row reads **Disconnected**, the composer popover says sessions stay listed and readable, and every write (prompt, approval) is still refused until the link returns. Retention is bounded to 32 hosts and is cleared on uninstall.
- Scopes are enforced by the remote gateway; a `desktop` pairing defaults to `sessions:read`, `prompt:send`, `approval:respond`.

## Wrapped DSH internals (constitution A1.1)

Rendering a remote Host's session in the **native** DSH UI needs one thing rc.1 has no
public API for: the controller's single `typertGateway` instance has to answer for more than one
Host. Under A1.1 (owner-approved 2026-11-09) this plugin wraps **exactly two methods of the live
service object it obtains from the Host** — never a prototype, module export or DSH file:

- `typertGateway.dispatchRpc` (listens for the wrapped method's rc.1 arity `4`)
- `typertGateway.openWireStream` (arity `7`)

Conditions, all implemented in `lib/host-router.mjs`:

- **Self-test against the pinned release.** `engines.dsh` is `0.2.2-rc.3`, and the running DSH
  version is resolved from the Host's own boot package (`lib/dsh-runtime-version.mjs`). The wrap
  happens only when that version equals the pin and both carrier methods have the expected shape.
- **Failure mode.** Any mismatch (unknown version, another version, a missing method, a changed
  `openWireStream` arity) means **no wrap at all**, the originals stay untouched, and the reason
  (`dsh-version-unknown`, `dsh-version-mismatch`, `dispatchRpc-missing`, `openWireStream-missing`,
  `openWireStream-signature`) is returned by `GET /devices/remotes` as `routing.reason` and shown
  on the Devices page ("Sidebar grouping: multi-host routing is off: …"). Remote mode is off; local
  DSH behaviour is unchanged.
- **Exact restore.** `dispose` puts the original methods back, and only if a method is still the one
  this plugin installed — a wrapper installed later by someone else is never clobbered or removed.
- **No authorization weakening.** The wrapper only routes; the remote gateway remains the sole
  authority for what a paired device may do, and every routed call still carries the device token
  and the device's scopes.
- **Review gate.** Every DSH version bump needs a reviewer pass over the wrapper before it is
  enabled — update `PINNED_DSH_VERSION` only together with `engines.dsh` and that review.

### The attachment upload route (A1.1 amendment v1.3.0, spec 013)

Attaching a file to a session that lives on **another** Host cannot go through `dispatchRpc`: the
native composer POSTs the bytes straight to `/api/session/uploadFileBinary`, an HTTP route registered
on the Host's connection service. Under the A1.1 amendment (owner-approved 2026-11-11) this plugin
wraps **exactly one registered Fetch-route record** — never a prototype, module export or DSH file:

- `connection.fetchRoutes.get('/api/session/uploadFileBinary').fetch`

That record is the one DSH's own file-upload plugin registers with `methods: ['POST']` and
`requestBody: 'streaming'`; the dispatcher re-reads `route.fetch` per request, which is what makes a
single object field the right seam. The whole implementation is `lib/upload-route.mjs`.

- **Only host-tagged requests leave the box.** `sessionId` `h:<host>:<id>` is forwarded as
  `remote-upload-open|chunk|finish|cancel` (contract revision 8) over the already-pinned link, with the
  untagged remote-local session id. Every other request — untagged `sessionId`, no `sessionId`, a
  malformed tag — reaches the native handler as the **same** `Request` object with its body untouched,
  so local uploads behave exactly as before. The local Host stores nothing.
- **Who decides.** The remote gateway alone decides (scope `attachments:write`, size, content type,
  session visibility, image media type). Its result comes back opaque as
  `{ ok: true, value: <the remote Host's own upload result> }`; `receiptId` and `attachmentId` are never
  read or rebuilt. A refusal is `{ ok: false, error }` with HTTP 200, mirroring the host code — the same
  envelope the native route uses, so the composer shows it (R5).
- **Open needs the size and digest first.** The streaming carrier hands the route a body with no
  length, while `remote-upload-open` must declare `size` and the whole-file `sha256`. So the body is
  staged in an owner-only (0600) temporary file — never in memory — hashing as it arrives, then read
  back in the `chunkBytes` the open answer reported; the file is deleted on success, refusal, cancel
  and error. The staging bound is `MAX_SPOOL_BYTES` (512 MiB, the gateway's default
  `fileUploadMaxBytes`), and a `content-length` over it is refused before anything is dialled.
- **Refusals before the transfer.** Contract 8.2 is exact that a *transfer* failure is
  `{ ok: false }` inside a `remote-upload-result`, and everything `handleRemoteUpload` answers is. The
  four frames still pass the gateway's own dispatcher gates first — live credential, socket web lock,
  `requestId`, and `attachments:write` — and those answer `kind: 'error'`, as every other op does. Both
  shapes are relayed with their own code; a dispatcher refusal also carries its `scope`, so an unticked
  `attachments:write` (the common one: it is in the desktop default *offer*, never on an existing
  record) reads as the missing grant instead of "unexpected frame".
- **Every failure carries a `details` record.** The native route always answers details (`{}` at worst)
  and the desktop composer's own parser throws `file upload transport returned an invalid failure` when
  `error.details` is not a record — so an omitted `details` is a failure it cannot even display, not a
  shorter one.
- **Cancel.** A request the client aborts (`request.signal`) stops between chunks and sends
  `remote-upload-cancel`, so the remote spool is freed; the composer sees `file-upload-cancelled`.
- **Self-test against the pinned release.** Same pin and the same resolved running version as the
  carrier wrapper (`0.2.2-rc.3`): the `connection` service must exist, `fetchRoutes` must be a `Map`,
  the record must exist with `POST` in `methods`, `requestBody === 'streaming'`, a callable `fetch`, and
  the version must equal the pin.
- **The install waits for the services, it does not read them at apply time.** On rc.3 the
  `connection` service is provided later than this plugin (its provider awaits `BrowserAuth.create`),
  so a one-shot read at apply time is always empty. The install runs in a child context that requires
  **both** `connection` and `fileUploads` (the service that registers the route): Cordis starts it once
  both are live, re-starts it when a provider is replaced, and unloads it — restoring exactly — when
  one withdraws. `not-installed` is the reason while that fiber has not started yet.
- **Failure mode.** Any mismatch means **no wrap at all**, the record is untouched, and the reason
  (`no-connection`, `not-installed`, `fetchRoutes-missing`, `route-missing`, `route-methods`,
  `route-request-body`, `route-fetch`, `dsh-version-unknown`, `dsh-version-mismatch`) is returned by
  `GET /devices/remotes` as `uploads.reason`. Tagged uploads then fall through to the native handler
  and are refused there (`session/not-found`) instead of reaching the remote.
- **Exact restore.** `dispose` puts the original `fetch` back, and only if the record still carries
  the one this plugin installed. A stacked wrapper finds the TRUE native handler through
  `Symbol.for('@dsh-ext/devices.uploadRouteOriginal')`, and `uploads.wrapped` is measured live on BOTH
  facts: the map entry at `fetchRoutes.get(<path>)` must still be the record we wrapped, and that
  record must still carry our wrapper. A reload of the file-upload plugin that replaced the entry
  reports `route-replaced`, one the provider deleted (`registerFetchRoute`'s cleanup) reports
  `route-missing`, and either way the stale wrapper hands requests to the native handler unread.
- **No new surface.** No listener, route or port is added; the wrap changes one field of a record that
  already existed and only for the duration of the plugin.

**Devices page field (not yet rendered).** `GET /devices/remotes` now answers
`uploads: { route, wrapped, reason, dshVersion, pinned }` next to `routing`. `lib/client.js` does not
read it yet (it is outside this change's scope), so the reason is currently visible only in this
response and in the plugin log line `remote attachments: active|off (…)`.

## Browser the host may drive (spec 016 Phase 3, contract revision 10)

A paired host's agent can ask **this** machine to open a headless browser. Two independent
keys are required: the host's `browser:control` grant on this device, **and** this machine's
own per-host setting (remote card → *Allow this host to drive a browser on this machine*, off
by default, stored with the remote record). The setting is the one that decides whether
`client-hello` advertises the optional `browser-agent:1` capability; with it off a command is
answered `browser/denied` and nothing is read or launched. Turning it on or off redials the
link, because the capability is only carried in `client-hello`.

- The browser is an **installed** Chrome or Edge (`lib/agent-browser.mjs`): standard locations
  per platform plus an optional `agentBrowserPath`. Nothing is ever downloaded. It runs with
  `--headless=new --remote-debugging-pipe --user-data-dir=<dataDir>/agent-browser-profile/<remoteId>
  --no-first-run --no-default-browser-check` plus, once the egress proxy has a port, the proxy and
  DNS flags listed under *Enforced on the socket* below — no debugging TCP port, no shared profile
  with the owner's browsers.
- Transport is the child's fd 3/fd 4 with NUL-delimited CDP JSON. Ops are exactly the
  contract's `navigate|click|type|press|scroll|open|close|snapshot|text|html|screenshot|tabs`.
- **Limits** (contract §10.3): one command in flight per device (a second is `browser/busy`),
  the command's own deadline (a late result is never sent), results cut to 1 MiB per frame,
  `text`/`html` cut at 256 KiB with `truncated: true`, screenshots shrunk to JPEG ≤ 768 KiB.
  A command the host cancels gets **no** result — and its slot stays taken until the work has
  actually stopped (every CDP send gives up on the abort), so the next command cannot interleave
  with it; a kill switch answers `browser/cancelled`.
- **Page policy**: http/https only, no credentials in the URL, and never this machine or this
  network: `localhost` and `*.localhost`, `127.0.0.0/8`, `0.0.0.0/8`, `10/8`, `172.16/12`,
  `192.168/16`, `169.254/16` (link-local, cloud metadata), `100.64/10` (CGNAT, Tailscale), IPv6
  `::`, `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible
  (`::7f00:1`) forms of those, and the DSH server's own origin (learned from the frame route's
  `Host`, plus `agentBrowserBlockedOrigins`) are refused.
- **Enforced on the socket, then again on the request.** The primary enforcement point is an
  **egress proxy** this plugin runs itself (`EgressProxy` in `lib/agent-browser.mjs`): one per
  browser launch, bound to `127.0.0.1:<ephemeral>`, passed as
  `--proxy-server=http://127.0.0.1:<port>` with `--proxy-bypass-list=<-loopback>` (so even a
  request to `127.0.0.1` reaches the proxy instead of leaving directly), `--disable-quic`,
  `--dns-prefetch-disable`, `--disable-features=DnsOverHttps`,
  `--disable-background-networking` and
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`. Plain HTTP (absolute-URI
  requests), `CONNECT` tunnels and WebSocket `Upgrade` handshakes all take
  the same verdict. A name is resolved **once**, with a 2 s bound, and the socket is opened to the
  literal address that was judged — never to a second answer — so a rebinding name has no window
  between check and connect. A refused request gets the proxy's own `403` (policy) or `407`
  (lookup failed or timed out) and **never** a body, so a page cannot mistake a refusal for content.
  A timeout or resolver error is never cached.
- **And again at request time, as defence in depth.** Every attached target — the tab and every
  auto-attached popup, out-of-process iframe and worker (`Target.setAutoAttach`, flattened, sent
  both at browser level and on each page session so children are attached too) — runs
  `Fetch.enable` on all requests at the Request stage; a paused request out of policy is failed
  (`BlockedByClient`), so a 302, a script `location` change or a `window.open` to a local address
  never loads. A target whose hook cannot be installed is **closed, not resumed**, and a browser
  that refuses auto-attach fails the launch rather than running a half-guarded tab. The page's own
  address is re-read after every command and a tab that ended up out of policy is moved to
  `about:blank` and the command is refused. After the tab the agent drives is closed it re-attaches
  to another page or a fresh `about:blank`.
- **Residual risks** (the proxy is a policy boundary, not a sandbox):
  - **Another local process can use the proxy too.** It is an unauthenticated listener on loopback,
    so any process on this machine that finds the port gets the same policy decisions — which is
    safer than that process dialling directly, but it means the port is not a secret and must not be
    treated as an authorization of the caller. Nothing else on this machine is *constrained* by it.
  - **Chromium's own resolver may differ from Node's.** The policy is only as good as the answer
    the proxy got. A split-horizon resolver, a different search domain, or a proxy-bypass path
    (a scheme or protocol the proxy is not used for) leaves Chromium resolving on its own, and then
    the `Fetch` hook's own pre-resolution is the only check left — with the timing gap that implies.
  - **Service workers are covered only via the proxy.** A service worker's own fetches are not a
    page request the `Fetch` hook necessarily pauses, so the proxy is what keeps them in policy; a
    request that never reaches the proxy (see the bypass case above) is not covered by the hook.
  - **A managed laptop's enterprise proxy policy overrides `--proxy-server`.** When the machine is
    enrolled in an MDM/enterprise policy that sets a proxy (`ProxySettings`, or the equivalent
    managed policy), Chromium uses that policy and ignores this plugin's `--proxy-server` switch. The
    egress proxy is then not in the path at all — only the `Fetch` hook's own pre-resolution is left,
    with the timing gap that implies. The same applies to other managed switches a profile can pin.
  - For a LAN that must be unreachable, use an OS firewall rule for the browser process as well:
    the proxy decides what this plugin will *forward*, not what the OS will route.

- The "Browser (agent)" tab is this plugin's **own** tab type (`openTab(kind)`; one per paired
  host, title `Browser (agent) · <host>`), a screencast polled from `GET
  /devices/browser/<id>/frame`, a banner that the agent is driving, and **Stop**
  (`POST /devices/browser/<id>/stop`), which cancels the command in flight and closes the
  process. An unused browser closes itself (`agentBrowserIdleMs`, default 120 s); a forgotten
  host or a plugin teardown closes it too.

## Start page per machine (spec 016 Phase 1)

The right column's Start page is a chain-slot body over a **flat, `order`-sorted list** of guide
entries contributed by tab types (`sidebarRightTabs.register({ id, kind, guide: [...] })`); it has no
group/section concept, and picking an entry calls `openTab(entry.kind)` — an entry carries no params
and cannot name another page. Phase 1 therefore works **only through that seam**, with no takeover of
`sidebar.right.tab.guide` (that chain is Phase 2's).

- **One doorway, one tab type.** Each doorway a paired machine contributes is registered as its own
  tab type (`id` = `kind` = `dsh-ext.devices.<hostId>.<entry>`, `priority: 'extension'`,
  `multiple: false`) with a single-entry `guide`, and its body is dispatched through
  `sidebar.right.pane.tab` keyed by that id (the key rc.1 uses). Two per paired machine:
  - `host` — **"Remote machine · <host>"**: the machine's own card (its sessions, their history,
    its approvals, the prompt box) — the same `RemoteDetail` the Devices page shows, mounted in
    the tab, without a Back button because there is no list behind it there.
  - `devices` — **"Devices · <host>"**: the Devices page, where that machine's grant, its browser
    consent and this machine's own pairing are managed.
- **Labels** are `<item> · <host>`, the same shape as `Browser (agent) · <host>`; the item word is
  localised (vi + en), the host name is verbatim. Each capsule carries this package's own glyph.
- **Order.** Every shipped capsule sits at 10–60 (workspace files 10, code review 15, terminal 20,
  browser 30, session inspector 60), so a block starts at **1000** — the first round number above all
  of them, which keeps every local doorway first — and each machine gets **100 slots**
  (`1000 + 100 × hostIndex`, `+0` for `host`, `+1` for `devices`). `hostIndex` comes from the host ids
  **sorted**, so the same paired set always yields the same numbers whatever order the Host listed
  them in, and one machine's block stays contiguous while a later phase can add doorways to it
  without renumbering the others.
- **Only connected machines get entries.** The spec says "per connected remote host", so a paired
  host that is offline (or revoked) is **omitted**, not shown disabled: a capsule that opens a card
  for a machine which cannot answer is a doorway onto nothing. It comes back on its own when the
  link returns. (Its **sessions** are a different question: those stay in the sidebar while it is
  merely disconnected — see *A disconnect keeps the sessions listed* above.)
- **Current, not polled.** The set is recomputed from the one `hostsStore` snapshot the other
  surfaces already read (`/devices/remotes`, the existing 4 s `refresh`), so adding, removing, losing
  or reconnecting a machine adds, removes or restores its entries on the next refresh. No new
  timer; teardown unregisters every type and body.

The Start page's own behaviour is unchanged in every other respect: a refused seat (a shell that does
not hand over `sidebarRightTabs`) simply leaves the entries out, and nothing else changes.
## Tests

`npm test` runs plain scripts (spawning `node --test` workers is EPERM in the sandbox): `guards` (loopback/same-origin), `pin` (pin mismatch sends no credential bytes), `store` (token file perms, 4401 wipe), `client` (slots, labels, flows, the spec 016 Phase 1 per-machine Start-page doorways: entries, order, removal, the offline rule, no new timer, and the spec 025 R5 in-place Permissions editor: kind-limited scope list, diff body, route refusal codes, the missing-upload hint, vi+en twins), `host-router` (multi-host routing/rename/merge), `upload-route` (spec 013: untagged passthrough, chunking + whole-file sha256, refusal mapping, abort → cancel, exact restore, self-test failure), `interactions` (remote approval/question cards in the native `$events` stream), `session-cache` (offline transcript copy: write, replay, refusal, delete, rotation), `agent-browser` (spec 016 Phase 3 against a FAKE CDP pipe: pipe-only launch args, ops, URL refusals, 768 KiB/256 KiB/1 MiB limits, consent off → `browser/denied`, one in flight, cancel, deadline, kill switch, idle shutdown, the consent/frame/stop routes), `e2e` (real `mobile-gateway` in-process: pair as `desktop` → sessions → history → prompt → approval → revoke), `e2e-otp` (OTP + Host approval through `POST /devices/pairings`), `disconnect-retention` (connection lifecycle: disconnect → sessions kept and marked disconnected → reconnect → same aliases resume, twice, in one process; forget and 4401 drop them) and `pairing-trust` (that route pairs against a listener whose certificate no CA store can chain to: the pin is the trust decision). Tests borrow `ws`, `selfsigned`, `react` and `react-test-renderer` from `../mobile-gateway/node_modules`.
