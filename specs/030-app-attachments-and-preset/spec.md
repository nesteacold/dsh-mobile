# 030 — Attachments in the app, agent preset at session create, capability flags

Packages: `packages/mobile-protocol` (minor revision), `plugins/mobile-gateway`, `apps/mobile-companion`.
Roadmap P1-8 (remaining) + the spec 029 contract gap.

## A. Capability flags (protocol minor)
- Add `OPTIONAL_CAPABILITIES` entries `attachments` and `passkey` (and `session-preset` for C).
- Gateway advertises each only when the feature is available on this Host/device scope.
- App hides/disables each feature with a short reason when the flag is absent (spec 029 banner lists it).

## B. Attachments (images first)
- App: attach from photo library / camera (native) and file picker (web); show thumbnails before send;
  max size from gateway `hello` (default 10 MB), images only in v1.
- Upload uses the existing gateway upload route; requires device scope `attachments:write`
  (spec 025). Missing scope → button disabled with "Ask the computer owner to grant attachments".
- No attachment bytes in logs, notifications or push payloads. EXIF GPS stripped client-side
  before upload when the platform allows.

## C. Agent preset at session create
- New-session sheet shows the Host's preset list (read-only names/descriptions, already exposed
  for view) and lets the user pick one; default = Host default.
- Gateway validates the preset id against the Host list and the device's scope; unknown id →
  `op/invalid`. No preset editing from the phone.

## Tests / review
Contract tests for new flags and frames; gateway tests for scope refusal and size cap; app unit
tests for gating and EXIF stripping; fake gateway updated and P1-9 parity kept at zero divergences.
Reviewer mandatory (upload = network/data surface).
