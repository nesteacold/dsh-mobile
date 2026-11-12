# 013 — Attachments in remote sessions

Owner decision 2026-11-11: attaching images/files from the client desktop to a session on a remote
Host must work. This removes "attachment" from the hard-block list of spec 012 and replaces it with a
grantable scope the owner can untick on the Permission page. Constitution v1.3.0 (A1.1 amendment).

Packages: `packages/mobile-protocol`, `plugins/mobile-gateway`, `plugins/devices`.

## Requirements

- R1 New scope `attachments:write`. Grantable to desktop devices; in the desktop default set (spec 012:
  everything grantable is on by default, owner unticks). Never granted to a device silently on
  migration: existing devices get it only through the Devices page.
- R2 Bytes travel over the existing pinned link as chunked frames
  (`remote-upload-open|chunk|finish|cancel`), reusing the gateway's `createFileUploadManager`
  (`lib/file-upload.mjs`). No new listener, no new port.
- R3 Gateway checks, all mandatory, each with a named test: scope; session is visible to the device;
  monotonic offset; canonical base64; sha256 of the whole file; total size <= `fileUploadMaxBytes`;
  chunk <= min(256 KiB, `maxPayloadBytes`); cap on concurrent transfers per device; idle timeout that
  frees the partial file; image media type against the Host's own `imageLimits`. The Host's own
  upload validation still runs. The generic RPC `fileUploads/upload` stays denied.
- R4 `plugins/devices` intercepts only `POST /api/session/uploadFileBinary` with a host-tagged
  `sessionId` and turns it into the frames of R2; the returned receipt is the remote Host's, passed
  through opaque. Untagged requests are untouched. The local Host stores nothing.
- R5 Failures are visible in the composer (forbidden, too large, link down), never silent.
- R6 Contract documented in `specs/001-gateway-hardening/contracts/mobile-protocol-v1.md` (revision 8).
- R7 Reviewer pass is mandatory before the plugins are reloaded on the owner's Host.

## Out of scope

Downloading attachments from the remote Host beyond what session rendering already does; phone uploads.
