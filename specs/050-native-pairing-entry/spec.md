# Spec 050 — Native-phone QR versus PWA OTP

Owner report 2026-11-19: selecting Phone/PWA in Settings → Devices generates a QR the released native iOS app refuses as otpLinkNative; typing its eight-digit code fails as otpNative. This is a product integration defect, not user error.

## Root cause (read from source)
`plugins/devices/lib/client.js` generateOtp posts `/mgw/pair` with `mode:'otp'` for the combined Phone/PWA choice. Its QR is a PWA `/pair#a=...&c=...` link. Native pairing requires the existing v3 payload including `certSha256`; gateway string mode already generates it. The existing Devices long-string path hardcodes desktop. Native mobile must exclude `web:unlock` because its native adapter cannot perform the PWA passkey ceremony.

## Requirements
1. Expose three explicit targets: Native iPhone/Android, Web/PWA (passkey), Desktop Remote. Native is default. Add en/vi labels and accurate explanatory copy.
2. Native generation uses the existing `/mgw/pair` string/v3 path with kind mobile and kind-valid scopes excluding `web:unlock`. Render the returned QR SVG, copyable full string and expiry. Never log payloads/codes.
3. PWA retains OTP link/passkey flow and web:unlock. Desktop retains existing behavior/kind filtering. Expiry, Host approval, replay protection and revocation remain unchanged.
4. Verify effective Host approval grants cannot re-add web:unlock to native offers. If gateway metadata needs an explicit distinction, report the minimal design to lead before changing contract/shared types. Do not globally strip PWA scopes.
5. Native parser/transport remains unchanged: bare OTP links refused, certificate pin mandatory, wrong pin sends no credentials. Fix the generated offer, not the client's trust checks.
6. Clear stale offers on target switch and display generation errors honestly.

## Tests / gates
Exercise all three generated request shapes and UI branches. Decode a controlled native QR with the released native parser to assert v3/pin presence; test effective native grant excludes web:unlock while PWA retains it. Do not print actual payloads. Preserve existing PWA/desktop tests. Run affected Devices tests, gateway/protocol gates if changed, repository verify-publish and scan-pii; report literal tails/exit codes and pre-existing failures separately.

## Process / scope
Lead owns spec; coder owns code. Preserve dirty worktree hunks; no reset/clean/stash. Expected writes: Devices client/tests/README; gateway pairing/scope logic only if necessary. No new dependencies or DSH core changes. Independent reviewer mandatory before live activation because pairing/auth is touched. No commit/push/store upload without explicit authorization. Do not revoke trusted devices, regenerate production TLS certificates or change credentials.

Cordis Inspect discovery was called before plugin coding; this fix reuses plugin-owned routes, not guessed DSH Service methods. Identify live plugin packageDir/version before runtime activation. Rebuild affected plugin artifacts for the existing runtime; do not start a replacement DSH server.

## Acceptance
The native offer is accepted by the released app's QR parser and completes controlled pinned pairing without web:unlock lockout. PWA OTP/passkey and Desktop Remote regressions remain green. QR rendering alone is not end-to-end acceptance. Existing store app should work without a new binary if only Host offers change. Screenshots must redact/live-exclude QR secrets. Update README with the three target flows.

Status: specified; implementation and reviewer pending.
No native OTP bypass, no contract-breaking format change, no unrelated store/Xcode work.
No blanket authorization for production/profile changes is inferred from this local repair request.
