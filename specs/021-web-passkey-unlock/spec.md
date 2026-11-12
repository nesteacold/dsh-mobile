# 021 — Web passkey unlock (replaces DeepSeek-account web unlock)

Owner decision 2026-11-12: the PWA (`https://<host>.ts.net:18443`) unlocks with a **passkey (WebAuthn)**
bound to the paired web device. The requirement "the Host must be signed in to DeepSeek" is **removed
entirely**. Packages: `packages/mobile-protocol` (contract, new revision), `plugins/mobile-gateway`,
`apps/mobile-companion` (web target only). Reviewer MANDATORY (auth code).

## Goal
A person who merely reaches the URL (inside the tailnet) sees no conversation, no session list, no
Host data until the browser proves possession of a passkey registered for that paired device.

## Requirements
1. **Registration.** Right after a web device pairs (it holds `web:unlock`), the PWA creates a passkey
   (`navigator.credentials.create`, `residentKey: preferred`, `userVerification: required`,
   RP id = the page's hostname, ES256 + RS256). Gateway stores per device only
   `{credentialId, publicKey (COSE), signCount, createdAt}` in its owner-only state file. At most one
   registration without desktop approval: adding/replacing a passkey for a device that already has one
   requires the owner to approve on the Host (same approval path as pairing).
2. **Unlock.** Each new WS connection from a `web:unlock` device starts **locked**. Gateway sends a
   fresh 32-byte random challenge (single use, 60 s TTL, bound to the socket). PWA calls
   `navigator.credentials.get`; gateway verifies: challenge, `type`, origin ∈ `allowedOrigins` (exact),
   rpIdHash = SHA-256(hostname of that origin), UP and UV flags set, signature over
   `authData || SHA-256(clientDataJSON)` with the stored key, signCount monotonic (when non-zero).
   Success → socket unlocked. Failure → stays locked; no detail beyond the code.
3. **While locked** the gateway answers only: hello, passkey frames, ping. Everything else is refused
   with `auth/locked` (close code 4412 semantics unchanged). No session titles, counts or ids leak.
4. **Re-lock.** Socket close, 15 min idle, or the PWA's "Lock" action → locked. A tab reload always
   requires a new assertion.
5. **Revocation.** Revoking the device on the Host deletes its passkey record and closes its sockets.
6. **Rate limit.** Per device: 5 failed assertions / 10 min → `rate-limited` for the rest of the window;
   global 30 / hour. Failures are logged as codes only.
7. **No DeepSeek dependency.** Remove the account-attestation path (`readAccountAttestation`,
   account pinning, `unlock-unavailable` for signed-out Host) from the web unlock decision. Native
   (iOS/Android) devices are unaffected: they never carry `web:unlock`.
8. **Secrets.** Never log credential ids, public keys, challenges, clientDataJSON or signatures.
   No new secret in git.

## Wire (new contract revision)
- `passkey-register-options` → `{challenge, rp:{id,name}, user:{id,name,displayName}, pubKeyCredParams, excludeCredentials}`
- `passkey-register` `{attestation: {id, rawId, clientDataJSON, attestationObject}}` → `{ok}` | error
- `passkey-assert-options` → `{challenge, allowCredentials, rpId, timeout}`
- `passkey-assert` `{assertion: {id, rawId, clientDataJSON, authenticatorData, signature, userHandle}}` → `{unlocked:true}` | error
- `hello` reply for a web device gains `webLock: 'unregistered' | 'locked' | 'unlocked'`.
- Error codes: `passkey/not-registered`, `passkey/already-registered` (needs Host approval),
  `passkey/challenge-expired`, `passkey/verification-failed`, `passkey/rate-limited`, `auth/locked`.
All binary fields base64url. Attestation format `none` accepted (no attestation trust needed: the
device is already paired with a per-device credential).

## Out of scope
Passkeys for native apps; sharing one passkey across several paired devices; account recovery
(re-pair instead).

## Acceptance
- Contract test covers the new frames/codes; vendored copy in sync.
- Gateway adversarial tests: replayed challenge, wrong origin, wrong rpId, UV=0, bad signature,
  signCount regression, other device's credential, locked socket asking for sessions/history,
  rate limit, revocation clears record.
- App: web lock screen with "Use passkey", registration after pairing, Lock button; unit tests.
- Old DeepSeek-account web unlock code paths removed or unreachable, with tests updated.
