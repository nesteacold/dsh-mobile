# 044 — Web/PWA attachment upload from the real picked File

Status: **proposed — reviewer pass required** (file/network surface).

Affects `apps/mobile-companion` web target only. No wire/contract change; spec 041 FR-2 stays the
authority for the remote-upload frames.

## Problem

Owner: upload image fails with “Add attachment: The upload failed. Try again.”

Measured from source (2026-11-18):

- `app/session/[id].tsx:465-469` calls `DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true })`.
- `app/session/[id].tsx:483-490` then does `new File(asset.uri)` from `expo-file-system`, `info()` and
  `arrayBuffer()`.
- On web, `expo-file-system/build/ExpoFileSystem.web.js:1-13` defines `FileSystemFile` as a stub whose
  constructor only warns; it has no `info()` or `arrayBuffer()`. The call throws inside the picker
  branch and is caught at `[id].tsx:515-518`, which maps every non-`file-too-large` error to the single
  generic copy. No `remote-upload-*` frame is ever sent.
- `expo-document-picker/build/ExpoDocumentPicker.web.js:56-67` already returns the browser's real
  `File` as `asset.file` (and `URL.createObjectURL(asset.uri)` when `base64:false`). This is the bytes
  source the web branch must use.

This is a platform-selection bug in the app, not a gateway refusal: the device has `attachments:write`
and no upload frame appears for this path.

## Goal

On PWA, picking an image/file must read the exact picked bytes and pass them to the existing
`controller.uploadAttachment()` contract flow. Native behaviour stays unchanged.

## Design

1. Add a narrow web byte reader, e.g. `src/platform/picked-file.web.ts`, exporting
   `readPickedFile(asset): Promise<{ bytes: Uint8Array; name: string; mediaType?: string }>`:
   - admission happens BEFORE allocation: check a valid `asset.size` when present AND the DOM
     `File.size` before calling `arrayBuffer()`. A missing size is allowed only when the DOM `File`
     itself supplies a finite size; never read an unbounded buffer just to discover it is too large;
   - use `asset.file.arrayBuffer()` when the DOM `File` is present (preferred);
   - otherwise accept `asset.base64` ONLY as a `data:…;base64,…` URL. Strip the header, validate the
     base64 payload, decode to bytes with `atob` + `charCodeAt` (NOT `TextEncoder`), and re-check
     encoded/decoded length against the ceiling before allocating the byte array. Malformed data or a
     non-data URL fails closed. Do not fetch `asset.uri`.
   - do **not** import or call `expo-file-system` on web;
   - name/mediaType are untrusted metadata from the DOM File/asset: prefer the DOM `File` values,
     never infer MIME from an extension or data-URL header to bypass the `image/*` gate, and leave
     content validation to the existing gateway. Refuse empty bytes with a typed error path.
2. Add a native no-op module with the same signature that keeps the current
   `new File(asset.uri) → info() → arrayBuffer()` path. Metro/web resolution must choose the web file.
3. In `pickAndUpload`, branch on `Platform.OS === 'web'` and call the seam only AFTER the existing
   pre-read admission and `image/*` metadata gate, then pass the bytes to `controller.uploadAttachment`.
   Keep pre-read size admission (`asset.size`, DOM `File.size`, actual byte length), single-transfer
   ownership/cancel generation, progress/receipt/cancel UI, and the scope gate `attachments:write`.
   The picker MUST NOT be called with `base64:true` by default: that makes Expo read the whole file
   before the app can admit it.
4. Expo's web picker creates an object URL with `URL.createObjectURL()` in BOTH the `file` and
   `base64` branches. The app owns cleanup: revoke the picker-created `asset.uri` exactly once on
   success, read error, picker cancel, session switch/unmount or stale completion. Never revoke an
   arbitrary URI and never create a second object URL.
5. Split failure copy by stage so the next report is actionable:
   - picker returned no file,
   - read failed,
   - upload/Host failed.
   Keep `session.attachFailed` for the upload stage; add distinct vi/en copy for read failure.
   Never stringify or display an exception, file path, object URL, data URL, file bytes or a Host
   internal message.
6. Reads are bounded: use a finite deadline for the web seam (start with 15 s); a late result must be
   ignored by the ownership generation. Cancel/session switch during a read sends no upload frame,
   opens no stale sheet, and releases the single transfer slot under the correct owner.

## Non-goals

- No gateway, contract, scope or MIME change.
- No storing the picked file; bytes are in memory only for the transfer.
- No retry loop or silent alternate destination.

## Acceptance

- Behavioural tests:
  1. Web branch uses the DOM `File` from the picker and produces exactly its bytes; no
     `expo-file-system` call on web. `File.size` is admitted before `arrayBuffer()`.
  2. Base64 fallback decodes the same bytes when `asset.file` is absent, including byte `0x00–0xFF`,
     1/2-byte padding, malformed/non-data URL and over-ceiling cases.
  3. Empty/oversized bytes are refused before any `remote-upload-*` frame. The picker is not called
     with `base64:true` by default.
  4. The picker-created object URL is revoked exactly once on success, error, cancel and stale
     completion; no arbitrary URI is revoked.
  5. Native branch keeps `File/info/arrayBuffer` behaviour; web module resolution is asserted.
  6. Read failure shows a distinct copy; upload failure keeps `session.attachFailed`; no exception,
     URI/path, data URL, bytes or Host message leaks into copy/log.
  7. Cancel/session switch during a read is bounded (15 s deadline), sends no frame, opens no stale
     sheet and releases only the owning slot. Existing progress/receipt tests still pass.
- Reviewer **APPROVE** required.
- Live PWA: pick an image, upload succeeds, receipt appears, and the next prompt can name the file.
