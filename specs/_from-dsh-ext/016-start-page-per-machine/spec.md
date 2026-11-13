# 016 — Start page per machine, and host-driven client browser

Owner idea 2026-11-11: split the right-panel Start page so a remote host has the same items as this
machine, labelled "remote". Research: slot-auditor report 2026-11-11 (read from DSH 0.2.2-rc.1 source).
Package: `plugins/devices`.

Facts: the Start page is a chain-slot body (`sidebar.right.tab.guide`) over a flat, `order`-sorted list
of guide entries contributed by tab types; there is no group/section concept. A tab's title comes only
from its tab type, so per-machine labels need our own tab types.

## Phase 1 — per-machine doorways (no takeover) — implemented 2026-11-11

As shipped (`plugins/devices/lib/client.js`, `HostDoorTab` + `syncHostDoors`):
- **One tab type per doorway**, not one tab type per host with items inside. Correction to the text
  below, measured while implementing: a guide entry can only call `openTab(entry.kind, {replaceTab})`
  with no parameters, so every entry belonging to one tab type opens the same tab. A doorway therefore
  needs its own tab type with a single-entry guide, keyed by the type id in `sidebar.right.pane.tab`.
- Doorways contributed per **online** host: **"Remote machine · <host>"** (that host's sessions,
  history, approvals, prompt box — the existing `RemoteDetail`) and **"Devices · <host>"** (the Devices
  page, labelled per host). Offline/revoked hosts get none and regain them on reconnect.
- Order: shipped entries sit at 10/15/20/30/60; a host block starts at 1000, 100 slots per host
  (`1000 + 100 × hostIndex`, `+0` host, `+1` devices), host ids sorted so the order is stable.
  Refreshed by the existing 4 s `refresh()`; no new timer; teardown removes every doorway and body.
- **Not implemented, and why:** the original items *Workspace files, Code review, New terminal on that
  host* cannot be expressed as guide entries in rc.1 — they would have to hand a remote session to a
  native tab, and a guide entry receives no parameters. They need phase 2 (chain takeover) or a core
  change. Owner decision required if they are wanted before phase 2.
- Prerequisite (done separately): host-router routes `workspaceFileScopeId`.
- Changed-files (deliverables) is HTTP and not routable; out of scope unless decided later.

## Phase 2 — grouped Start page (owner's literal ask)
- Take over `sidebar.right.tab.guide` via a chain entry that is active only while a remote host is
  connected (falls back to the shipped guide otherwise), rendering "This machine" and "<host> (remote)"
  groups with the native capsule look (copied tokens, not hashed classes).

## Phase 3 — owner decision 2026-11-11: DO IT, option 2

Owner: "Làm bước 3". Lead chose the recommended option 2 (owner did not pick; no constitution
exception): the plugin's OWN "Browser (agent)" tab type on the client with its own storage partition,
not the native Browser tab and not `globalThis.dshDesktop.browser`. Reviewer pass mandatory (new
host→client command surface).

### Phase 3 design (beastcore 2026-11-11, read from source)
- Rendering: rc.1 attaches `<webview>` only with a main-process lease (`main.js:18663`, `:20650`), so a
  plugin has no public scriptable guest. The "Browser (agent)" tab is a screencast of a headless
  Chromium spawned by the devices plugin's Host half ON THE CLIENT, `--remote-debugging-pipe` (no TCP
  port), own `--user-data-dir` under plugin data. Installed Chrome/Edge only; never auto-download.
  Banner "agent is driving", Stop (kill switch), "let me drive".
- Contract revision 10 (revision 9 was already taken by companion parity work): `browser-command {commandId, sessionId, op, args, deadlineMs}` host→client,
  `browser-result {commandId, ok, result|error}`, `browser-cancel {commandId}` both ways; hello
  capability `browser-agent:1`; one command in flight per device; frame ≤ 1 MiB; deadline default 30 s
  max 120 s; screenshot JPEG ≤ 768 KiB; text/html cut at 256 KiB with `truncated`.
- Target: tool param `target` = `auto` (last device that sent a prompt to this session, if connected
  and capable, else host) | `host` | `<device>`. Gateway records last prompt device per session and
  exposes a `remoteBrowser` service plus `remoteSessionScope.describe(session)` (spec 014 C6 signal).
- Two keys: host scope `browser:control` (to send) AND client setting "allow the paired host to drive a
  browser on this machine" (off by default, per host). Results always wrapped untrusted on the host.

## Phase 3 — agent drives the client's Browser (needs owner decision + reviewer)
- Our own browser tab type on the client, a host→client command channel on the existing pinned link,
  client-side consent (scope `browser:control`, off until enabled on the client), "agent is driving"
  indicator, kill switch, dedicated storage partition. Must not depend on the undocumented
  `globalThis.dshDesktop.browser` carrier without a new explicit constitution exception.
