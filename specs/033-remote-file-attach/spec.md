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
- R4. Mechanism: **no DSH object is wrapped.** In the capture phase of the composer picker's
  `change` event, a pick proven to belong to a remote session's composer has its `input.files`
  replaced with page-built `File` copies. A page-built `File` has no backing path, so
  `webUtils.getPathForFile` answers `''` and DSH takes its own byte-upload path.
  - Why not wrap `__DSH_HOST_PATHS__.pathFor` (the original A1.2 idea): the preload hands the page a
    `contextBridge` copy whose members are frozen, so no wrap is possible in Electron. Measured live
    on 2026-11-16 ("the local file-path bridge cannot be replaced").
  - The replacement must be verified on the spot (bridge answers `''` for a page-built `File`, the
    replaced list reads back path-free); a pick that cannot be verified is left to DSH.
- R5. Conditions: the structural check reads DSH's own contract at runtime and is bounded to the
  composer's DOM (region, session view, picker ancestry); it must never become a prerequisite for
  activation — an unreadable source means "no change for this pick", not "feature disabled".
  Nothing of DSH is mutated, so dispose only removes the capture listener. A failure to replace is
  reported with its own reason, never as "this is a local pick". README lists the mechanism;
  reviewer pass.
- R6. Session attribution must be the composer's session, not a guess. If the wrap cannot know the
  session for a pick with certainty, it must fail safe: keep DSH's behaviour for that pick AND warn
  (never upload a local-session file to a remote Host, never send a remote session a controller path
  silently — show the reason).

## Acceptance

- Unit tests with a fake bridge: remote session + zip → page-built copies with no path; local
  session → original `File` objects untouched; image → original behaviour; directory → original; a
  bridge that names even a page-built `File` → no change + `path-unavailable`; an unreadable DSH
  contract → no change for that pick (never "feature off"); a proven remote pick whose list
  replacement fails → `replace-failed` shown; dispose removes the capture listener only.
- Live (owner, remote client DNLP25-IT09): the same zip in a Sigma-Remote session reaches the Host
  (gateway log shows the upload; Host store gains an 11 917-byte object; the Host turn shows an
  attachment, not `@"C:\Users\remote\…"`). A local session still mentions the path as before.
- Self-test result (active / not active + reason) is visible on the Devices page, so a page whose
  preload names a page-built `File` is diagnosable without a debugger.
