# 048 — PWA session UX: overlap, multi-attach, duplicate bubble, progress

Status: **proposed — reviewer required for multi-attachment/file upload**.

Affects `apps/mobile-companion` only. No wire/contract change expected.

Owner screenshot + report 2026-11-19.

## 1. Header title overlaps scrolled transcript

`app/session/[id].tsx:862-880` draws the header absolutely over the transcript with
`backgroundColor: translucent(colors.bg)`. On iPhone the translucency is too weak: message text
scrolls behind and shows through the title/status area (“Benchmark so sánh…” over other text).

Fix: give the header an opaque/same-scheme resolved background (or a much stronger glass token) on
web, while retaining the floating look via shadow/border. Keep `headerMeasured` layout and back/more
buttons. Test: header background token is opaque, title renders above transcript, native unchanged.

## 2. Attach multiple images at once

`pickAndUpload` currently calls `DocumentPicker.getDocumentAsync({ multiple: false })` and stores a
single `attachReceipt`; `sendPrompt` already accepts `files: [{receiptId}]`, so no wire change.

Fix (PWA image picks ONLY; native and the generic file picker keep `multiple:false`):
- for web image picks use `multiple: true`; validate the WHOLE batch before any read: max 6 images,
  total declared size <= 64 MiB (same client ceiling), each size finite/non-negative, `base64:false`,
  scope `attachments:write`. Server `maxBytes` still applies per upload.
- read one image at a time through `readPickedFile` and upload it before reading the next; keep only
  the current image's bytes in memory. Apply spec 044 size/MIME/object-URL rules to every asset.
- upload sequentially through the existing contract with per-file progress, name, size and errors.
  On any failure or cancel, STOP the batch (no further upload) and show the fixed failure reason.
  Receipts already uploaded successfully are KEPT in the same session so the owner can retry/send
  the remaining files; cancel does not delete them. Switching session drops every receipt from the
  composer. A session switch/cancel revokes EVERY picker object URL, including assets never read and
  late picker results, and never releases a newer batch's slot.
- collect successful receipts into `attachReceipts`; `send()` passes all receiptIds to `sendPrompt`.
  Snapshot the exact receiptId set + sessionId of that send. A successful ack clears only those
  receipts when both identities still match; refusal/timeout keeps them for retry. A receipt from a
  different session is never carried over or cleared by another send.
- native path unchanged; web admission and object-URL cleanup from spec 044 still apply.

Reviewer **APPROVE** required (file upload surface).

## 3. Duplicate identical user bubble

Root cause (source): `HistoryStore.addPendingPrompt` stores an optimistic row with `id=clientMsgId`
and `seq=null` (`history.ts:443-455`). A live `user/message` event is coerced to a row with a host id
or `seq-N` (`history.ts:306-316`) and appended; `confirmAllPending` (`history.ts:424-433`) only clears
`pending`, so the optimistic row and the host row both render. Switching sessions reloads history and
the duplicate disappears.

Fix: when an incoming live user message matches the oldest still-pending prompt of the open session
(exact trimmed text, or a `clientMsgId` field when the Host echoes one), replace that optimistic row
with the authoritative row (same id/seq/pending=false) before append, instead of appending a second
bubble. Preserve streaming/chunk events and non-pending history; dedupe by id/seq remains.

## 4. Reasoning / processing visibility on PWA

`HistoryMessage.reasoning` already exists and `session/[id].tsx:1856-1858` renders a collapsed
`ProcessReasoning` block, but the owner cannot tell whether a sent prompt reached the Host and is
being processed: there is no prominent in-flight indicator while the outbox is sending / the session
state is running / reasoning is streaming.

Fix (no new wire): show a fixed, localized “Đang gửi…” / “Đang xử lý…” indicator using existing
`snapshot.outgoing`/`session.state === 'running'` and the existing reasoning row; do not invent a
new frame. Keep it non-blocking and remove it on ack/failure/turn end or when history is reloaded.
Do not show model-private reasoning inline; use the existing disclosure.

## Acceptance

- Header: title/subline readable over scrolled content; no text bleed-through.
- Multi-attach: web-only 2+ image picks, all uploaded sequentially, one prompt sends all receiptIds,
  one prompt bubble; ack clears only the snapshotted receipt set for that session; refusal keeps it.
  Batch cap, pre-read admission, stop-on-failure/cancel, revoke-all assets, late picker and stale
  slot ownership are covered by behavioural tests; native single-file path unchanged.
- Duplicate: send one prompt, live user event + ack yields exactly one bubble; switching sessions is
  no longer required.
- Progress: after send the PWA visibly shows sent/processing state until the answer/turn completes;
  reasoning disclosure unchanged.
- Gates: app typecheck/check:core/focused/full/e2e; reviewer auth pass for multi-attach; deploy and
  live verify on PWA.
