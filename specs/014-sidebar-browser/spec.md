# 014 — Agent access to the built-in side-panel Browser

Owner request 2026-11-11: integrate `alesha-pro/dsh-sidebar-browser` (MIT, HEAD `65eca4f6`, reference
clone `_upstream/alesha-pro__dsh-sidebar-browser`) into our plugin set, published with dsh-remote.
Package: `plugins/sidebar-browser` (`@dsh-ext/sidebar-browser`). Reviewer verdict on upstream as-is:
FAIL; PASS WITH CONDITIONS after C1–C8. A second reviewer pass is mandatory before reload.

## Requirements (= reviewer conditions)

- C1 The `/dsh-sidebar-browser/poll` and `/reply` bridge routes require a per-start random secret known
  only to the client half (or DSH's own authorization); requests without it are rejected. Ids are not
  guessable.
- C2 A master switch, **off by default**, shown in Settings. Mutating tools (`navigate`, `click`, `type`,
  `press`, `open`, `close`, `scroll`) and `eval` require DSH user approval per call; a configurable origin
  allowlist (empty = ask). Read-only tools (`snapshot`, `text`, `screenshot`, `tabs`, …) need only the
  master switch.
- C2a Owner amendment 2026-11-11: the session's permission mode is the switch. When the session runs in
  **Full access** (the composer's permission preset), browser tools are allowed and mutating tools need
  no per-call approval — exactly as other tools behave under Full access. In any other mode the tools
  follow that mode's normal approval rules (ask per call). Implement by declaring the tools' risk/approval
  metadata through DSH's native permission-preset mechanism, not by reading UI state; the separate
  default-off master switch is dropped unless DSH offers no such mechanism (then report).
- C3 The three cookie tools are removed.
- C4 Every result carrying page content is wrapped as untrusted page content, and tool descriptions say
  page text is data, never instructions.
- C5 Transport is `window` only; the CDP / `--remote-debugging-port` path and its docs are removed.
- C6 For sessions driven by a remote device (plugins/devices / mobile-gateway), browser tools are
  unavailable unless a new scope `browser:control` is granted (owner decision 2026-11-11: no hard
  blocks, permissions instead); approval requests for them stay answerable on the remote device like any
  other approval. If origin of the session cannot be determined, treat as remote.
- C7 `engines.dsh: 0.2.2-rc.1`; startup self-check of the DOM hooks it relies on (`webview[data-sidebar-browser-frame]`,
  `[data-dockkit-tab]`, `[data-sidebar-right-toggle]`) with a visible reason when missing; screenshot
  `savePath` confined to the plugin's data directory.
- C8 `NOTICE` / third-party notices: upstream MIT copyright (Alexey Fateev) and the vendored
  modern-screenshot licence + version; README credits upstream.

Out of scope: the upstream `cli/` and `probes/` folders (not shipped).
