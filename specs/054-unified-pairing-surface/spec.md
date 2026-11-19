# 054 — Unified pairing surface (native, PWA, Devices desktop)

Status: **proposed — reviewer mandatory (pairing/auth)**.

Owner request: native iOS/Android lacks the 8-digit OTP entry the web and desktop have; all three
surfaces should use one common design, and on desktop it must be inline on the same Devices screen,
not another popup.

## Security decision

- Native OTP MUST NOT become bare TOFU. The gateway already returns `certSha256` with an OTP offer.
  The Host Devices page puts it in the native pairing link fragment as `p=<64 lowercase hex>`:
  `https://<pwa-origin>/pair#a=<address>&c=<otp>&p=<pin>`.
- Native parses `a`, `c`, `p`, validates all three before any socket, and passes `certSha256: p` to
  `controller.pair()`. The pinned transport still verifies the leaf before the proof; the proof is
  still keyed to that pin. An OTP link without `p` stays refused.
- Web keeps its own-origin route and NEVER adopts `a` or `p` from a link: the browser cannot pin a
  leaf, so the pin field is irrelevant there and must not become an address override.
- Desktop OTP keeps the existing real `certSha256`; only the rendering moves inline and the link
  gains `p` for native. No code, pin or proof may be logged.

## Common information design (all three)

One panel, in this order: target selector (Native / Web-PWA / Desktop on Host; native app shows phone),
two tabs **QR or code** and **8-digit code**, then the active form. Generated offers render inline in
that same panel/card: code grouped `dddd dddd`, countdown, copy code, QR when available, address,
and for native the certificate fingerprint. No modal for the generated pairing offer on the Devices
screen. Native app pair screen and PWA pair screen use the same tab order, labels and test IDs where
the platform has the control.

## Changes

1. Contract unchanged. No new scope; native OTP offer uses `kind:'mobile'` with the existing native
   scope set (no `web:unlock`).
2. `plugins/devices`: `pairQrPayload` accepts optional `pin` and emits `p=`; `/devices/pair-qr`
   carries it from the offer; `OtpDialog` becomes an inline `PairOffer` card in `AllowTab`, with no
   `Dialog`/backdrop; native target generates OTP (not string-only) but native re-pair/edit still uses
   the long string. Add en/vi copy for the certificate pin and inline card. Tests: QR payload with/without
   pin, inline no-dialog source, native OTP request shape, no secret logging.
3. `apps/mobile-companion`: `PairLink` gains optional `pin`; `parsePairHash` accepts `p` only as 64
   lowercase hex; native `applyPairLink` prefills address + code + pin; native OTP submit builds
   `wss://<address>/ws/mobile` and passes the pin into `pair()`. Native OTP link without pin stays
   refused. Web ignores `a`/`p`. UI adds a pin field on native only and uses the common order/labels.
   Tests cover link parse, native submit with pin, blocked bare link, web ignoring link address/pin,
   and unchanged QR/paste flows.
4. Desktop Devices screen keeps approval, scope filtering, revocation and pending-request UI unchanged.
   AddDeviceDialog for OUTBOUND remote hosts is a separate flow and may remain a dialog; this spec is
   about the pairing-offer card on the Allow/Devices screen.

## Acceptance

- Host Devices: choose Native → generate → one inline card shows 8-digit code, address and pin/QR;
  no popup. Choose Web-PWA or Desktop → same inline card shape, no pin field shown for web.
- Native iOS/Android: scan the native pairing QR or paste that link → fields prefilled → tap Pair →
  pinned TLS verified → proof emitted → Host approval shown → paired. Typing only an 8-digit code
  still fails with honest “address + certificate required” copy.
- PWA: existing same-origin OTP flow unchanged; a native link with `p` cannot redirect it.
- Reviewer APPROVE before live activation; gates for devices plugin, app, protocol if touched;
  repository scan-pii/verify-publish; no commit/push/store upload.
