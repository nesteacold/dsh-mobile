# Spec 041 — Restore the three missing session controls

**Package**: `apps/mobile-companion` (UI + narrow app-side upload client) · **Status**: owner-approved 2026-11-18 · **Owner directive**:

> "App mobile thiếu nút: 1. Thiếu nút chọn Permission 2. Thiếu nút + đính kèm file 3. Thiếu vòng tròn thể hiện context. Bạn có thể tham khảo code của https://clarklevis1995.github.io/dsh-mobile/ để làm cho nhanh."

## Source of truth and limits

- Upstream reference: `Clarklevis1995/dsh-mobile` @ `3ec49d6` (MIT, "Whaleness"), local read-only clone
  `_upstream/Clarklevis1995__dsh-mobile`. The three upstream controls are:
  permission menu (`DeepSeekHarnessMobile/Views/ConversationView.swift:2088-2197`,
  `androidApp/.../ConversationScreen.kt:2370-2400,3727-3771`), composer attach menu
  (`ConversationView.swift:1240-1278,1876-1915`; `ConversationScreen.kt:1755-1770`), and context ring
  (`ConversationView.swift:3411-3427,1482-1491`; `ConversationScreen.kt:2665-2700`). They are native
  SwiftUI/Compose; this spec ports behaviour and layout to RN, not those source files.
- Attribution already lives in `apps/mobile-companion/UPSTREAM-UI.md`; no upstream binary icon files
  are copied. Any new icons come from the already-approved `lucide-react-native` (ISC).
- **Hard blocklist is unchanged.** `specs/012-remote-parity-blocklist/spec.md:12-16,29-36` permanently
  denies `permissions/*`, `permissionPresets/*`, `commands/*`, `session/attachment`, `settings/*`,
  etc. to a device token. Therefore the Permission button here is the **hardened lower-only**
  permission surface from spec 019 (`src/core/permission-lower.ts`), not upstream's arbitrary
  `permission` setter. Do not add or unblock legacy/upload endpoints.

## Functional requirements

### FR-1 — Permission selector button (visible, honest, no gateway change)
- Render a dedicated Permission button in the session header beside the existing
  `PermissionChip`/`session-more` area (`app/session/[id].tsx:595-623`) and/or in the composer model
  row (`:973-979`). It must be present even when `permission-lower` capability is absent, because the
  owner reported it missing; use `Shield`/`ShieldCheck` from lucide and a stable
  `testID="session-permission-picker"` with localized `accessibilityLabel`.
- On press, open the existing permission sheet (`permission-sheet`, options
  `permission-option-<preset>`, `permission-close`, `permission-receipt`) using
  `AppController.readPermissionOptions(sessionId)` (`src/app-state.ts:3770-3779`) and
  `lowerPermission` (`:3790-3797`). The current value and options come from
  `src/core/permission-lower.ts:67-73,117-130,214-245`.
- If capability is absent, the sheet must render a truthful unavailable state (no send, no dead
  buttons): "Permission changes are not enabled for this device" (en) / "Thiết bị này không được
  phép đổi quyền" (vi). Reuse the existing unavailable pattern; do not fake options.
- Keep the existing lower-only rule: only strictly stricter presets may be offered. Never send the
  upstream `permission` message or touch `permissions/*` endpoints. Preserve all current permission
  testIDs/labels (`test/permission-lower-screen.test.ts:42,76-78`; `test/ui-test-hooks.test.ts`).

### FR-2 — Composer `+` attach button with real remote-upload path
- Render a `+` button in the composer (`app/session/[id].tsx:893-1032`, next to
  `MicHintButton`/Send), lucide `Plus`, `testID="session-attach"`, localized
  `accessibilityLabel` ("Attach a file" / "Đính kèm tệp"), min 44 pt touch target.
- On press, open a small action sheet with two choices: **Image / Photo** and **File**.
  - Use `expo-document-picker` (approved dep) for both; for images set the document type to images
    where the platform supports it, otherwise allow all and validate MIME prefix `image/`.
  - Use `expo-file-system` (approved dep) to establish a finite, nonnegative file size and read the
    picked file as bytes/base64. The contract's authoritative `maxBytes` is returned only by
    `remote-upload-open` (`packages/mobile-protocol/src/index.mjs:429-432`), so before reading the app
    enforces a fail-closed **client ceiling** (`CLIENT_UPLOAD_MAX_BYTES`, 64 MiB) and rejects an
    absent/invalid/oversized size with a localized message. After `open`, the server `maxBytes`
    remains authoritative; if it is smaller, cancel the acquired upload and report it. This is the
    accepted interpretation of the earlier "reject over maxBytes before open" wording — the gateway
    limit cannot be known before `open`, so the pre-open guard is necessarily a local ceiling.
- Implement the narrow app-side upload client in `src/core/` (new module, pure core) using the
  contract frames (`packages/mobile-protocol/src/index.mjs:423-463`):
  `remote-upload-open {type,requestId,sessionId,kind:'file'|'image',name?,mediaType?,size,sha256}`
  → read `uploadId`, `chunkBytes`, `maxBytes`; then `remote-upload-chunk
  {type,requestId,uploadId,offset,data}` with canonical base64 and decoded-byte offsets; then
  `remote-upload-finish {type,requestId,uploadId}`. Support `remote-upload-cancel` and handle
  `remote-upload-result`. Use `client.request(..., {allowNonOpType:true})`
  (`src/core/client.ts:830-850`). Canonical base64 + sha256 must be computed from the same bytes;
  offsets are decoded bytes, not base64 characters.
- Gate on device scope `attachments:write` (contract `ATTACHMENTS_WRITE_SCOPE`,
  `packages/mobile-protocol/src/index.mjs:214,463`; gateway permits a phone holding it,
  `plugins/mobile-gateway/lib/index.mjs:4302-4303`). Add a small generic scope-read helper in
  `AppController` (do not widen `hasReadScope`'s semantic name for non-read scopes). If scope is
  absent, the button remains visible but tapping shows a truthful unavailable sheet — never send a
  forbidden frame.
- Upload UI: per-transfer progress/cancel/error, one transfer at a time; disable Send while a
  transfer is in flight; on finish, show the Host receipt (`receiptId` + file/image name) in the
  composer as a pending attachment chip. Do not attempt to insert the bytes into the text prompt.
- Keep the existing contract/gateway untouched. Legacy `file-upload-*`, `session/attachment` and
  `/api/session/upload` stay blocked.

### FR-3 — Context usage ring
- Render a circular ring (`react-native-svg` `Circle`, already installed) in the session header near
  `session-more` (upstream places it in header/composer), `testID="session-context-ring"`,
  `accessibilityLabel` from a localized "Context usage" string. Size ~18–22 dp, stroke ~3 dp,
  track `colors.text` @0.22, foreground `colors.accent`, rotate -90°, round caps.
- Source the value from the **existing** `AppController.readSessionStats(sessionId)`
  (`src/app-state.ts:3836-3841` → `src/core/stats.ts:158-174`), using
  `contextPressure.pressureTokens / contextPressure.contextWindow` clamped 0…1
  (`src/ui/read-only-views.ts:63-73`). Do **not** add a new `context-usage` client type: app-side
  `context-usage` has no decoder (`stats.ts:31,140-142`) and the hard blocklist is unchanged.
- Load lazily on first render/tap when `stats:read` is present; show a neutral empty ring and an
  unavailable sheet with localized reason when it is absent. Tap opens the existing stats sheet
  (`session-stats`, `testID="stats-context"`) so the ring is not a dead indicator.
- Respect reduced motion if any animation is added; no animation is required for V1.

## Non-negotiables
- Native render only; no WebView; no DSH core/plugin changes; no auth/pairing/TLS/push changes.
- No new gateway message types, no scope expansion, no blocklist relaxation.
- Preserve every existing `testID`, `accessibilityLabel` and screen structure pinned by
  `test/ui-test-hooks.test.ts`, `test/sessions-screen.test.ts`,
  `test/session-screen-shell.test.ts`, `test/permission-lower-screen.test.ts`,
  `test/stats-read.test.ts` and `e2e/check-flows.mjs`. Dynamic new hooks must be added to the
  source-based allowlist in `test/ui-test-hooks.test.ts` by coder, with tests updated accordingly.
- All new user-facing strings in `i18n/index.ts` for both en and vi.
- Reviewer pass before any store upload: this change adds a file-upload network surface and a
  permission UI.
- New dependencies (lead decision, measured 2026-11-18 with `npm view`):
  `expo-document-picker@58.0.5` (MIT, peer `expo`) and `expo-file-system@58.0.14` (MIT, peers
  `expo`, `react-native`), both SDK-58 patch lines. No other dependency is approved.

## Gates
From `apps/mobile-companion`: `npm run typecheck`; `npm run check:core`; `node e2e/check-flows.mjs`;
`node --import tsx --import ./test/support/resolve.ts --import ./test/support/stub-platform.ts --test "test/*.test.ts"`.
Repo root: `node tools/verify-publish.mjs`; `node tools/scan-pii.mjs`.
Add source-based tests in the style of the existing suite (no renderer needed) for the three new
hooks, the upload frame sequence and scope gating, and the ring's clamp.

## Acceptance evidence
- Source tests + literal gate tails green (except any separately documented pre-existing baseline).
- Simulator screenshots (iPhone 17 Pro `9DBA11F5-D54A-4FE4-BE0E-60129682F770`, 1206×2622) of:
  permission sheet, attach sheet, context ring + stats sheet, placed in
  `apps/mobile-companion/artifacts/session-controls/` (git-ignored).
- Exact upload behaviour with paired demo Host in screenshot mode: a file of a few KB is attached,
  a receipt appears, and Send is not blocked by a stale transfer. If the demo Host lacks
  `attachments:write`, show the unavailable sheet and report that; do not fake success.
- Status set by lead after acceptance.

## Status
2026-11-18: implemented; reviewer-041 final verdict APPROVE WITH CONDITIONS after four review rounds.
Gates are green on the integrated worktree (coder literal tails). Remaining acceptance: native
simulator screenshots + paired-Host upload/cancel/session-switch/receipt checks, and staging only
these hunks for commit after explicit owner approval. No store upload before those conditions.
