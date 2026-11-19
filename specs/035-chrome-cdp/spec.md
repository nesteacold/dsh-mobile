# 035 — Shared Chrome control (CDP) and a Chrome sidebar tab

Status: approved by owner 2026-11-15 ("Làm theo đề xuất của bạn đi"). Package: new
`plugins/chrome-cdp` (`@dsh-ext/chrome-cdp`). `plugins/sidebar-browser` and DSH core unchanged.

## Problem (measured 2026-11-15)

- Every session rediscovers Chrome by hand: one session probed `:9222` (wrong), launched a second
  Chrome with a temp profile, then found the owner's Chrome on `127.0.0.1:40222`
  (`--user-data-dir=C:\Users\<owner>\dsh-chrome-profile`). A new session did not know the port and
  confused `internal_browser_*` ("app window has not connected") with "no Chrome".
- Agents drove CDP through ad-hoc PowerShell WebSocket scripts and pixel coordinates.

## Requirements

### Host tools (R1–R8)

- R1. One configured endpoint per Host, plugin Config:
  `endpoint` (default `http://127.0.0.1:40222`), `launchPolicy` (only `never` in v1).
  The endpoint host MUST be a loopback literal (`127.0.0.1`, `::1`, `localhost`); anything else is
  refused at activation with a visible reason. The plugin never launches Chrome, never creates a
  profile, never kills processes, never changes ports.
- R2. Tools, names prefixed `chrome_` (distinct from `internal_browser_*`):
  `chrome_status`, `chrome_tabs`, `chrome_open`, `chrome_snapshot`, `chrome_click`,
  `chrome_fill`, `chrome_key`, `chrome_screenshot`, `chrome_close_tab`.
  Every result states browser, execution host (os hostname), endpoint, connection state.
- R3. Snapshot returns title, URL and numbered interactive elements (links, buttons, inputs,
  selects, textareas, `[role=button]`, contenteditable), **including same-process and OOPIF
  iframes** (CDP `Target.setAutoAttach` / `Page.getFrameTree` + per-frame `Runtime` isolated world).
  Click/fill address elements by those numbers, never by screen coordinates.
- R4. Per-session tab binding: each DSH session keeps its own selected `targetId`; tools verify the
  target still exists and report its URL before acting. A tab is leased to one session while it
  acts (lease expires after 60 s idle); another session acting on a leased tab gets
  "tab in use by another session" instead of silently interleaving.
- R5. `chrome_close_tab` closes only an explicitly named target id; nothing auto-closes.
- R6. Page-derived text is wrapped as untrusted data (same notice pattern as sidebar-browser C4).
- R7. Permissions: read-only tools (`status`, `tabs`, `snapshot`, `screenshot`) never ask;
  mutating tools ask through `tools/pre-execute` `{kind:'ask'}` unless the session preset is
  `danger-full-access` (identical rule to sidebar-browser C2a).
- R8. No credential access: the plugin never reads the password store, cookies or storage values,
  and `chrome_fill` refuses `type=password` fields unless the value comes from browser autofill
  (i.e. the tool does not type passwords). Screenshots are written only under the plugin data dir.
- R9. Clear errors: endpoint unreachable → "Chrome CDP not reachable at <endpoint> on <host>;
  start Chrome with --remote-debugging-port or fix config". Never suggest the sidebar Browser.

### Sidebar tab (R10–R14)

- R10. Register a right-sidebar tab type `kind: 'chrome'`, `priority: 'extension'`, with a guide
  entry "Chrome", via `ctx.sidebarRightTabs.register` + keyed `sidebar.right.pane.tab` body and
  `sidebar.right.pane.tab.title` (public two-stage API read from installed
  `dsh-client-ui-sidebar-right/src/client/index.ts` 22-26, 246-247 and
  `dsh-client-ui-sidebar-browser/src/client/index.ts` 74-104).
- R11. The body shows a live view of one Chrome tab (CDP `Page.startScreencast` relayed by the
  Host, or periodic `Page.captureScreenshot` fallback) with a tab picker, address bar and
  back/reload; mouse, wheel and keyboard on the view are forwarded via `Input.dispatch*`.
  No iframe embedding of external sites.
- R12. Host↔window relay routes are registered with `ctx.connection.fetch.register` under
  `/api/dsh-chrome-cdp/*` (`tabs`, `shot`, `input`, `nav`). DSH's `/api` fence admits only
  `principal.kind === 'owner'` peers and applies its Host/Origin trust rules (fail closed);
  every relay additionally requires a JSON POST and the per-start secret header, so the
  secret is still checked by this plugin. The client builds these URLs from `document.baseURI`
  with same-origin credentials. DSH Desktop does not reliably mount plugin exact webServer
  routes added after Host `ready`, so the old `/dsh-chrome-cdp/*` exact routes are not used.
  DSH Desktop also caches the `webserver/index-inject` table at Host `ready`; a plugin
  installed or reloaded afterwards gets no global secret in that window. The same owner-only
  `/api` registry therefore also serves one narrow `GET /api/dsh-chrome-cdp/bridge-secret`
  route. The client uses the injected value when present and fetches this route once, with
  same-origin credentials and `cache: 'no-store'`, only when the global is absent; a failed
  fetch keeps the view closed. The secret is never published globally by the fallback.
- R13. UI uses `--dsw-alias-*` tokens and locale namespace `chromeCdp` (vi, en); no DSH client
  package imported as a module.
- R14. The sidebar view is for the local app window only; remote viewers get an explanatory
  notice (CDP is never exposed beyond loopback).

## Out of scope
Launching Chrome, multiple endpoints, extension management, password autofill automation,
remote (non-loopback) CDP.

## Verification
- Unit tests (`node --test`): endpoint validation, untrusted wrapping, lease/binding, risk gate,
  route authorization, element-snapshot script against a fixture DOM, CDP client against a fake
  WebSocket server.
- Live (owner's Chrome :40222): `chrome_status` → ready; `chrome_tabs` lists open tabs; snapshot of
  example.com; no new Chrome process or profile appears (count `chrome.exe` main processes before/after).
- Reviewer pass (network exposure + input forwarding).
