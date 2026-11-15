# 033 — Remote file attach (non-image files reach the remote Host)

Status: approved design direction (owner 2026-11-15, amendment A1.2 in `CLAUDE.md`). Package:
`plugins/devices` only.

## Problem (measured 2026-11-15 15:51)

On a remote client (DSH desktop + `plugins/devices`), a 11 917-byte zip picked with the composer
`+` in a Sigma-Remote session never reached the Host. The Host's turn received only the text
`@"C:\Users\remote\Downloads\…zip" test zip` — a path on the controller machine. No upload request
reached the gateway and no 11 917-byte object appeared in the Host attachment store.

Cause (read from installed DSH 0.2.2-rc.3, `%TEMP%\hostpaths-findings.md`):
- Electron preload exposes `globalThis.__DSH_HOST_PATHS__ = { pathFor(file) }`
  (`lib/preload-app.cjs` ~char 119676, `contextBridge`). The composer reads it once per
  `conversation.composer.bar` inject (`client.js` ~669846, ~681742) and calls
  `bridge?.pathFor(file) ?? ''` per picked file (~682308).
- A non-empty path turns a non-image file into an `@"path"` mention (no bytes sent). An empty path
  sends the file down DSH's byte upload (`POST /api/session/uploadFileBinary`, ~124964, ~126899),
  which `plugins/devices/lib/upload-route.mjs` already routes to the owning remote Host.
- Images always upload, so images worked and other files silently did not.

## Requirement

- R1. In a session owned by a remote Host (tagged id `h:<hostId>:…`), a non-image FILE picked or
  dropped in the composer is uploaded as bytes to that Host and appears to the Host's agent as a real
  attachment (not a controller-local path).
- R2. Local sessions, images, and every other DSH behaviour are unchanged.
- R3. A directory picked for a remote session is refused visibly (DSH's existing
  `attachment.pathUnavailable` path), never sent as a controller path.
- R4. Mechanism preference:
  1. a DSH-provided hook if one is reachable by the plugin (e.g. the composer slot's
     `registerFileIntake`), checked first;
  2. otherwise the A1.2 wrap of `__DSH_HOST_PATHS__.pathFor`: on the live object if writable,
     else by replacing the global binding with a delegating object if configurable.
- R5. A1.2 conditions: structural self-test (global present, exactly `{pathFor}` function,
  writability/configurability measured at runtime); on mismatch no wrap and a visible reason in the
  Devices page; exact restore on dispose (only if the current value is ours); never wrap what it
  did not install; README lists the wrapped surface; reviewer pass.
- R6. Session attribution must be the composer's session, not a guess. If the wrap cannot know the
  session for a pick with certainty, it must fail safe: keep DSH's behaviour for that pick AND warn
  (never upload a local-session file to a remote Host, never send a remote session a controller path
  silently — show the reason).

## Acceptance

- Unit tests with a fake bridge: remote session + zip → `''`; local session → original path; image
  → original behaviour; directory → original; frozen bridge → no wrap + reason; dispose restores the
  exact original reference/descriptor; foreign value at dispose → left alone.
- Live (owner, remote client DNLP25-IT09): the same zip in a Sigma-Remote session reaches the Host
  (gateway log shows the upload; Host store gains an 11 917-byte object; the Host turn shows an
  attachment, not `@"C:\Users\remote\…"`). A local session still mentions the path as before.
- Self-test result (wrapped / not wrapped + reason) is visible on the Devices page, so a frozen
  bridge is diagnosable without a debugger.
