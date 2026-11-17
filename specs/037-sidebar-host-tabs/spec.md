# 037 — Sidebar host tabs (This Computer / Remote Workspace)

Package: `plugins/devices`. Owner decision 2026-11-16: split the merged sidebar into two icon tabs, keep **New Session** exactly where it ships.

## Why

The devices plugin merges local and remote workspaces/sessions into one `workspace/follow` stream. The native new-chat page validates a chosen workspace against that stream; filtering the stream itself made a workspace from the other tab bounce back to “Choose workspace” and locked the composer. Filtering must therefore be display-only.

## Behaviour

- A compact icon strip is inserted by DOM placement as the **previous sibling** of `[data-sidebar-workspace-header]` — after the native New Session row, before the Workspaces title/list. It is never inserted inside `[data-sidebar-list-area]` (the sidebar's `100cqh` scroll contract) and never wraps/changes New Session.
- The strip has two icon buttons (`🖥` monitor + check, `☁` cloud + link dot) — 28×24, icon-only. Names/shortcuts live in `title`/`aria-label`: `This Computer (Ctrl+Alt+1)` and `Remote Workspace (Ctrl+Alt+2)` (vi: `Máy này`, `Workspace từ xa`). The active icon is DSH accent blue on a pale accent chip; inactive is muted gray.
- One `<style data-plugin="dsh-ext.devices.host-tabs">` is swapped (never stacked) and filters only DOM rows by `data-row-key`: local tab hides `workspace:h:*`, `session:h:*`, `overflow:h:*`; remote tab hides rows without that host prefix. The empty state is never hidden.
- Streams `workspace/follow` and `session/list` stay complete regardless of the visible tab. Choice is persisted in `localStorage['dsh-ext.devices.sidebar-tab']` (default `local`). Ctrl+Alt+1/2 switch tabs; keys are installed only once the strip is placed.
- Degrade, never half-install: if `shell.overlay` is missing (`no-seat`), `react-dom/client` is unavailable (`no-renderer`), or no `[data-sidebar-workspace-header]` appears (`no-header`, one `console.warn`), the Devices page says why and no filter is installed. `dispose()` removes the node, style, observer, React root, and shortcuts.

## Constraints

- A1.1 still covers only `dispatchRpc`/`openWireStream`; this feature changes DOM/sidebar display only and does not wrap a new DSH method.
- Do not take over `sidebar.workspaces` (single slot owned by native workspace browser); test `client-p2b` keeps the stock occupant winner.
- Source evidence: shipped DSH declares `sidebar.session.action` as hoc and `shell.overlay` as root `list`; `WorkspaceBrowser` renders `data-sidebar-workspace-header` then `data-sidebar-list-area`; `Rows` emits `data-row-key=workspace:<group.key>` / `session:<id>` / `overflow:<group.key>`.

## Tests

`client-host-tabs` (placement order, idempotent observer, icon-only labels, exact filter text, persistence, keys, degrade reasons, dispose, no HTTP), `client-p2b` (native `sidebar.workspaces` winner unchanged), `client` (real `client.js` loads). Test gates are plain scripts except p2b (`node --test --test-isolation=none`).
