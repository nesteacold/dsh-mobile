# 021 — web passkey unlock: coder progress notes

Working notes for the implementation of `spec.md`. Updated as work proceeds so an
interrupted run can resume without re-reading everything.

## Start state (2026-11-12, coder)

- Repo: canonical `dsh-mobile`. Working tree has a large STAGED set (the migration) and 4
  unstaged modifications (`.gitignore`, `CLAUDE.md`, `plugins/devices/test/store.test.mjs`,
  `plugins/mobile-gateway/lib/secure-file.mjs` — the last one is a comment-only name swap).
  Nothing is committed by this task; those edits are preserved.
- `plugins/mobile-gateway/lib/web-unlock.mjs` is the spec-020 DeepSeek-account attestation
  (313 lines, last written 12:36 today). No coder-visible edits happened during this session
  before the rewrite began; the rewrite below supersedes it entirely as the task says.
- Where spec 020 lives today:
  - protocol `packages/mobile-protocol/src/index.mjs` lines ~724-740 (`ACCOUNT_ATTESTATION_TYPE`,
    `WEB_UNLOCK_SCOPE`, `WEB_UNLOCK_EXEMPT_TYPES`), `SCOPE_BY_TYPE` entry, `ERROR_CODES['auth/locked']`,
    `CLOSE_CODES.locked = 4412`.
  - gateway `lib/index.mjs`: imports (168-175, 186), `handleQuery` attestation branch (2168-2199),
    service wiring (3374-3393), close sweep 13 (3412-3440), send gate (5319-5360), locked refusal
    helper (5386-5398), request gate (5751-5766) and dispatch flags (5687-5690, 5824-5825, 5958-5971),
    probe + account events (6781-6791, 7151-7153).
  - gateway `lib/allowlist.mjs` 268-297 (`WEB_UNLOCK_TYPE`, `WEB_UNLOCK_SCOPE`,
    `WEB_LOCK_EXEMPT_TYPES`), family list 437-439.
  - gateway `lib/devices.js` 191-197 (`webAccountPin` load) + 406-427 (`getWebAccountPin`,
    `pinWebAccount`).
  - gateway tests: `test/session-authoring-adversarial.test.mjs` items (15) ADV-15a…p (lines
    1259-1755) drive the whole account-attestation surface; the `fakeHost` fixture has
    `account/getState`/`getProfile` hooks (111-123). `allowlist.test.mjs` does not know the
    web-unlock names (the known pre-existing question-answer failure there is NOT ours).
  - app: `src/platform/web-unlock.ts`, `account-attestation.ts`, `account-pin*.ts`,
    `account-attestor-registration*.ts`, `biometrics.web.ts`, `secure-store.web.ts` (pin +
    IndexedDB), `app-state.ts` (imports 88-89, pairing hook ~1011-1014, attestor registration
    ~1942), `app/_layout.tsx` gate, `i18n/index.ts` unlock keys (13-26, 336-349, 641-654).
    App tests: `test/web-unlock.test.ts`, `test/web-unlock-e2e.test.ts` (+ the i18n key check).

## Design decisions (contract revision 14, additive)

- Scopes unchanged: `web:unlock` keeps gating the new frames; `account-attestation` is REMOVED
  from `SCOPE_BY_TYPE` (its op is gone).
- New protocol exports: `PASSKEY_CLIENT_TYPES`, `PASSKEY_REGISTER_OPTIONS_TYPE`,
  `PASSKEY_REGISTER_TYPE`, `PASSKEY_ASSERT_OPTIONS_TYPE`, `PASSKEY_ASSERT_TYPE`,
  `PASSKEY_ERROR_CODES`, `WEB_LOCK_STATES`, `PASSKEY_CHALLENGE_TTL_MS`,
  `PASSKEY_RATE_LIMITS`, `WEB_UNLOCK_IDLE_MS`.
- `WEB_UNLOCK_EXEMPT_TYPES` = the four passkey frames only (hello/ping are channel-neutral and
  always allowed; `device-forget` is scope-exempt). Lock gate refuses everything else
  `auth/locked`.
- `auth/locked` error `reason`: `locked` | `unregistered` | `rate-limited` (spec 020 reasons
  dropped).
- Re-registration approval reuses `POST /mgw/pending/:id/{approve,reject}` with a pending
  record of kind `passkey` (`pendingSockets` is not consulted for it). Pending records get an
  8-character `verificationCode` shown on the Devices page; the client learns the code only
  when it approves.
- WebAuthn rules: attestation fmt `none`, clientData type `webauthn.create`, origin === socket
  origin AND ∈ allowedOrigins, challenge exact, rpIdHash, UP+UV flags, attStmt empty,
  credential public key ES256 or RS256 only; assertion type `webauthn.get`, same origin/challenge
  rules, rpIdHash, UP+UV, signCount monotonic when both non-zero, signature over
  authData||SHA-256(clientDataJSON). AT presence mandatory.
- Lock state per socket (`webLock` on the connection), cleared by: no successful assertion for
  `WEB_UNLOCK_IDLE_MS` (15 min), close, PWA `passkey-lock`, device revoke, re-register.
- Rate limits per device 5 / 10 min and global 30 / hour over failed assertions and failed
  registrations. Revocation deletes the record and closes sockets 4401.
- Account paths removed: `readAccountAttestation`, `fingerprintAccountId`, the HMAC secret file,
  `webAccountPin`, the `deepseek-account/*` events and the probe. `api.account` is no longer
  reached by any gateway code path.

Status: **BLOCKED — step 2 (gateway WebAuthn verification) does not pass its unit tests; steps 3
and 4 are not started.** Reported to the lead, see "Blocker" below.

## Done

1. Protocol (revision 14): `packages/mobile-protocol/src/index.mjs` — `passkey-*` frame constants,
   `PASSKEY_CLIENT_TYPES`, `WEB_UNLOCK_SCOPE` (kept, now the four passkey frames in
   `SCOPE_BY_TYPE`, `account-attestation` removed), `WEB_UNLOCK_EXEMPT_TYPES`, `WEB_LOCK_ERROR`,
   `WEB_LOCK_STATES`, `PASSKEY_CHALLENGE_TTL_MS` (60 s), `PASSKEY_RATE_LIMITS` (5/10 min per device,
   30/h global), `WEB_UNLOCK_IDLE_MS` (15 min), `PASSKEY_ERROR_CODES`, `PASSKEY_APPROVAL_KIND`,
   `PASSKEY_APPROVAL_ACTIONS`; `ERROR_CODES` + five `passkey/…` codes; `CLOSE_CODES.locked` comment.
   `index.d.ts` mirrors it (`HelloFrame.webLock?`). README updated. Contract doc
   `specs/001-gateway-hardening/contracts/mobile-protocol-v1.md`: §3.5 webLock sentence, §3 close
   code note, §6 five passkey rows + `auth/locked` row, revision 12 scope row, new `## Revision 14`
   (§14.1 frames/verification, §14.2 lock, §14.3 approval, §14.4 codes, §14.5 rate limits,
   §14.6 revocation). `test/contract.test.mjs` spec-020 assertions replaced + four revision-14
   tests. `npm test` in the package: 52 pass / 0 fail. Vendored copy synced; `check:protocol` OK.

2. Gateway, WRITTEN BUT NOT VERIFIED (new files, nothing wired into `index.mjs` yet):
   - `plugins/mobile-gateway/lib/webauthn.mjs` — base64url, CBOR, COSE→KeyObject (ES256/RS256),
     `verifyRegistration`, `verifyAssertion`. Imports cleanly.
   - `plugins/mobile-gateway/lib/cbor.mjs` — iterative CBOR subset decoder used by `webauthn.mjs`.
   - `plugins/mobile-gateway/lib/passkey.mjs` — store, lock layer, challenges, approvals, rate
     limits. Imports cleanly.
   - `plugins/mobile-gateway/test/passkey.test.mjs` — unit suite (P1–P13, S1–S11).

## Step 2 progress (coder, 2026-11-12 ~17:40)

**Step 1 (CBOR) DONE — `test/passkey.test.mjs` 25/25 green.**

- Root cause of the `{1: 2}` refusal: the iterative decoder in `lib/cbor.mjs` and its duplicate in
  `lib/webauthn.mjs` disagreed about what `readItem` returns. Replaced BOTH with one small
  **recursive** decoder in `lib/cbor.mjs` (`decodeCbor`, `CborMap`, `CborDecodeError`): depth cap
  `MAX_CBOR_DEPTH = 16`, string ≤ 1 MiB, container counts bounded by the bytes left, indefinite
  lengths / tags / null / floats / duplicate keys / trailing bytes refused, invalid UTF-8 refused.
  `webauthn.mjs` now imports it and maps `CborDecodeError` → `PasskeyVerificationError`; no copy
  of the decoder is left in `webauthn.mjs`.
- Three further real bugs the green suite exposed, all fixed in `lib/webauthn.mjs` /
  `lib/passkey.mjs`:
  - `uintBytes` (COSE RSA modulus/exponent) rejected `Buffer` values — the only form a 2048-bit
    modulus can arrive in (RS256 registration always failed). It now accepts a buffer or a safe
    integer.
  - `passkey.mjs` stored approvals under `key` but looked them up under `stateKey`, so an
    approved socket never got its re-registration grant. Now a decision leaves a per-socket grant
    (`grants` map, `{deviceId, expiresAt}`) that `register` looks up by `stateKey` and spends.
  - rate limits were only checked inside `register`/`assert`; `assertionOptions`/`registrationOptions`
    now refuse `passkey/rate-limited` before issuing anything (S7 expects the refusal at options
    time).
- Test file changes (2 assertions, behaviour of the SERVICE not of the test): S5 unchanged apart
  from restoring an `advance()` line I mis-edited; S6 used to answer options requested *while
  limited* after the window passed — it now checks the limited refusal, and the post-window
  assertion re-requests options (the only API-correct route).


`node --test test/passkey.test.mjs` → **9 pass / 16 fail**. Root cause found and NOT yet explained:
`decodeCbor(Buffer.from([0xa1, 0x01, 0x02]))` — the CBOR map `{1: 2}`, by far the simplest input —
returns `undefined` (refused) from `lib/cbor.mjs`, while:

- an inline replica of the same algorithm (same statements, written to a scratch file with
  `Set-Content`) decodes it correctly (`CborMap(1) { 1 => 2 }`);
- the same module's empty-map path (`a0`) works, and text-keyed maps work;
- instrumenting the loop shows it reading the map header, the key `1`, the value `2`, and then
  the `stack.length === 0` check fires after the map is still open.

I burned roughly 45 minutes of trial-and-error on this (adjacent-token statement joining, a
`Map`-subclass constructor quirk, ASI after `if (...)` lines — all fixed for real, and the fixes
matter — but none of them is the cause). Per the escalation rule I stopped rather than keep
guessing. Next step for whoever picks this up: reproduce with a minimal harness that imports
`lib/cbor.mjs` directly from a file in the repo root, and dump the loop state with
`console.log` injected by rewriting the module to a scratch file (this worked to show
`ITEM {"kind":"map"}` → `ITEM undefined` at offset 3 with the stack still holding the open frame).

Steps still to do (all of step 2's wiring and all of steps 3–4):
- Wire `webauthn`/`passkey` into `lib/index.mjs`: `hello.webLock`, the four `passkey-*` handlers,
  the per-socket lock gate, the `passkey-lock` frame, `POST /mgw/pending/:id/{approve,reject}`
  for `kind: 'passkey'`, the 15-minute idle re-lock, and revoke → record delete + 4401.
- Delete the spec-020 account path: `readAccountAttestation`/`fingerprintAccountId` and the
  `web-unlock.mjs` secret, `devices.js` `webAccountPin`/`getWebAccountPin`/`pinWebAccount`, the
  `handleQuery` attestation branch (index.mjs 2168–2199), the probe and `deepseek-account/*`
  listeners (6781–6791, 7151–7153), `allowlist.mjs` `WEB_UNLOCK_TYPE`/`isWebUnlockType` and the
  `WEB_LOCK_EXEMPT_TYPES` list, and the spec-020 assertions in
  `test/session-authoring-adversarial.test.mjs` (items ADV-15a…p, lines 1259–1755) plus the
  `account/getState|getProfile` fixture hook (lines 111–123).
- `specs/001-gateway-hardening/contracts/mobile-protocol-v1.md`: mention `passkey-lock` in §14.2
  and the `passkey-approval` frame in §14.3 (the doc currently describes both but names neither
  frame type; the contract test does not require them).
- App (step 3): web lock screen + register after pairing + Lock button; vi+en i18n; unit tests.
- App (step 4): remove `src/platform/web-unlock.ts`, `account-attestation.ts`, `account-pin*.ts`,
  `account-attestor-registration*.ts`, the `biometrics.web.ts` attestation path, the pin in
  `secure-store.web.ts`, the `app-state.ts` hooks (imports 88–89, the pairing hook ~1011–1014,
  the attestor registration ~1942), the i18n keys `unlock.accountChanged|signedOut|
  unavailableWeb|needsAttestation|unlockUnavailable`, and rewrite `test/web-unlock.test.ts` and
  `test/web-unlock-e2e.test.ts`.
- Then run every gate in AGENTS.md.

## App (apps/mobile-companion) — DONE, all four gates green (2026-11-12, coder)

Scope was `apps/mobile-companion/**` only; `plugins/mobile-gateway/**` and `packages/**` were NOT
touched (read for the contract only).

### New files

- `src/core/base64url.ts` — unpadded base64url ↔ bytes. WebAuthn's dictionaries take `BufferSource`
  where the contract carries base64url STRINGS, so this is where the translation happens; pure, no
  `Buffer`/`atob`, so `check:core` holds.
- `src/core/web-lock.ts` — the client policy + frame codec: Host options → `navigator.credentials.*`
  requests (every binary member decoded, malformed answers refused, `timeout` clamped), credential →
  the contracted `attestation`/`assertion` objects (`id` cross-checked against `rawId`), the
  `LockReason` vocabulary (`passkey/*` codes, `auth/locked` reasons, local `not-supported`), the
  `LOCK_COPY` reason→i18n-key map, `lockAction()`, `unlockCopyKey()`, `PASSKEY_LOCK_TYPE`.
- `src/platform/passkey.web.ts` — the browser half: `navigator.credentials.create/get` with
  `residentKey: 'preferred'`, `userVerification: 'required'`, `attestation: 'none'`;
  `registerPasskey`, `assertPasskey`, `lockPasskeySocket`, `watchPasskeyApproval`, and the gate's
  `authenticate/unlockCapability`. A dismissed prompt (`NotAllowedError`/null) is
  `client/passkey-not-allowed`, never a success.
- `src/platform/passkey.ts` — native no-op pair (identical signatures; "web only" is decided by the
  bundler, as with the old account pair).
- `src/platform/web-grant.ts` / `web-grant.web.ts` — the pairing's `web:unlock` grant, remembered
  across reloads (`secure-store.web.ts`: `saveWebUnlockGrant`/`readWebUnlockGrant`, dropped in
  `forgetHost`). Needed because the gate never reads the credential, so a web install whose FIRST
  socket died before `hello` could not otherwise learn it must create a passkey.
- Tests: `test/web-unlock.test.ts` (rewritten: codec, frame building, fake-WebAuthn platform steps,
  reasons/copy), `test/web-unlock-e2e.test.ts` (rewritten: reason → key → the literal vi/en sentence
  a user reads, plus the assertion that the removed account copy is gone), and
  `test/web-passkey-lock.test.ts` (controller wiring: a locked socket requests NO session list;
  register→assert clears the lock; "Lock now" calls the lock step and closes the socket; a refused
  assertion keeps the lock and names the reason; a native pairing reports `webLock: null` and DOES
  resync).

### Removed (spec 020 account path)

`src/platform/web-unlock.ts`, `account-attestation.ts`, `account-pin.ts`, `account-pin.web.ts`,
`account-attestor-registration.ts`, `account-attestor-registration.web.ts`; the
`save/read/clearAccountFingerprint` store functions; the five i18n keys
(`unlock.signedOut|accountChanged|unavailableWeb|needsAttestation|unlockUnavailable`); the
`app-state.ts` imports and both pairing hooks. `grep` for `readAccountAttestation`,
`account-pin`, `registerWebUnlockAttestor`, `AccountFingerprint` over `src/ app/ i18n/ docs/` is clean.

### Changed

- `src/core/client.ts` — `hello.webLock` → `client.webLock` (absent = not locked; a value the app
  cannot read fails SHUT as `locked`); the `passkey-approval` push → a typed `passkeyApproval` event;
  `passkeyRequest(type, params)` as the narrow, typed opt-in for the four non-§4 frames;
  `_webLock` reset per connection; spec-020 comments retitled.
- `src/app-state.ts` — `webLock` on the snapshot (`{state, reason, approval, error}`, `null` for
  native); `registerWebPasskey`, `unlockWithPasskey`, `lockWebDevice` (sends `passkey-lock`, then
  closes the socket), `passkeyConnection` (the socket the gate may assert on); `applyWebLock` in
  `onReady` — a locked socket skips the resync entirely; the `paired` frame records the
  `web:unlock` grant SYNCHRONOUSLY and a locked pairing keeps its one-time socket for the passkey
  frames (an owner approval is granted to the asking socket only, §14.3); `passkey` injected through
  `ControllerOptions` (like `transport`) so Node needs no WebAuthn.
- `app/_layout.tsx` — the web lock screen (`WebLockGate`) rendered INSIDE the unlocked branch, above
  the navigator: the platform gate still mounts no route first (A020 unchanged), and a locked web
  socket shows the lock with no session list. `unlockFailureCopy` maps every reason to its copy.
- `app/settings.tsx` — a web-only "Lock now" row, drawn only when the snapshot reports a web lock.
- `src/platform/biometrics.ts` / `biometrics.web.ts` — one `unlockCapability/biometricLabel/
  authenticate(prompt, client?)` signature for both platforms; `UnlockResult.reason` now includes the
  passkey `LockReason`.
- `src/platform/unlock-copy*.ts` — the web key is `unlock.passkeyUnsupported` (the old
  "signed in to DeepSeek" instruction is gone); the native key is unchanged.
- `i18n/index.ts` — nine `unlock.passkey*` keys + `settings.lockNow`, both locales.
- Test support: `test/support/fake-gateway.ts` gained `webLock`, `passkeyAnswers` (the five frames)
  and `requestCount(type)`; `test/client.test.ts` + `test/app-controller.test.ts` title/snapshot
  updates (the snapshot really has a new `webLock` field); `docs/web-pwa.md` rewritten for the passkey
  model.

### Gates (literal, run in `apps/mobile-companion`)

- `npm run typecheck` → no output, `EXIT_TYPECHECK=0` (baseline before this work was RED:
  `account-attestation.ts(21,10): error TS2305 … no exported member 'ACCOUNT_ATTESTATION_TYPE'`).
- `npm run check:core` → `src/core import check: OK (no react-native, expo or node imports)`,
  `EXIT_CHECKCORE=0`.
- `node e2e/check-flows.mjs` → `PASS — 30 flows structurally valid …`, `EXIT_FLOWS=0`.
- `node --import tsx --import ./test/support/resolve.ts --import ./test/support/stub-platform.ts
  --test "test/*.test.ts"` → `ℹ tests 1131 / suites 240 / pass 1131 / fail 0`, `EXIT_TESTS=0`.

### Risk / open items for the reviewer (auth code)

1. `passkey-lock` is NOT a protocol constant: `packages/mobile-protocol` revision 14 exports
   `PASSKEY_*_TYPE` for the four frames and `PASSKEY_APPROVAL_KIND`, but not the PWA's re-lock frame,
   even though contract §14.2 names it. The app carries the literal in
   `src/core/web-lock.ts#PASSKEY_LOCK_TYPE` and the shared contract was NOT edited (out of scope).
   Recommend the protocol owner add it beside the others.
2. `app-state.ts` keeps the one-time PAIRING socket as the live client when a web pairing lands
   locked (so an owner's `passkey-approval` reaches the socket that asked). That socket is not the
   bearer socket, and `teardownConnection` drops it on lock/forget — verified by the controller test,
   but it is the one place this app reuses a pairing socket beyond pairing.
3. The web store still keeps the credential in IndexedDB behind a non-extractable AES-GCM key
   (unchanged, documented in `secure-store.web.ts`): the passkey gates the SOCKET, not that store.
   A browser-profile attacker can still read the token, as the existing threat model says.
4. `residentKey: 'preferred'` (contract §14.1) means an authenticator MAY create a non-discoverable
   credential; the app always sends `allowCredentials`, so that is fine, but it is worth a reviewer
   confirming the intended reading.
5. The `passkey-approval` push carries `verificationCode`; the app stores it in the snapshot and the
   lock screen does not yet display it as a code to compare. The owner-side comparison works from the
   approval email/copy; showing the code in the gate is a small UI follow-up if the lead wants it.

## Gateway (plugins/mobile-gateway) — step 2 DONE, all three gates green (2026-11-12 ~20:10, coder)

Resumed from a tree where two coders had died mid-edit. Start state: all `lib/*.mjs` parsed, but
`npm test` was 97 pass / 2 fail — both failures were one unfinished edit.

### What was broken and is now fixed

1. **`ReferenceError: WEB_UNLOCK_EXEMPT_TYPES is not defined`** at the locked-socket gate (the crash
   the two failures reported). The constant was never added to the `./vendor/mobile-protocol.mjs`
   import list, and `channelNeutral` was used at the gate but declared ~14 lines BELOW it (the
   dead coder's `const` was being hoisted as a TDZ error the moment the first case ran). Fixed by
   importing it and hoisting the single `channelNeutral` declaration above the gate; the duplicate
   declaration further down was removed, not duplicated.
2. **The whole spec-020 account path is gone from the gateway**: `lib/web-unlock.mjs` deleted (313
   lines), `lib/devices.js` lost `webAccountPin`/`getWebAccountPin`/`pinWebAccount`, and `lib/`
   has no remaining `readAccountAttestation`, `fingerprintAccountId`, `deepseek-account/*` or
   `account/*` reference. No gateway code path reaches `api.account` any more.
3. **14 spec-020 tests removed** from `test/session-authoring-adversarial.test.mjs` (ADV-15a…p,
   498 lines) together with their fixture hooks (`accountState`, `accountProfile`,
   `accountDelayMs`, `onAccountRead`, `webUnlockProbeMs`, `seedDirectory`) and the two comments
   that described the owner-side account probe. ADV-1…20 (spec 011/018/019/021) are untouched:
   the file is now 50/50 green. `callsSinceSet` is kept — it still filters owner-attributed calls,
   with a corrected comment.

### Step 2 (the three bugs the green suite exposed, already fixed by the previous coder)

`uintBytes` rejected `Buffer` RSA moduli (RS256 registration always failed); approvals were stored
under `key` but read under `stateKey` (an approved socket never got its grant); rate limits were only
enforced inside `register`/`assert`, not at options time.

### Wiring added/completed in `lib/index.mjs`

- `hello.webLock` for a `web:unlock` device (`unregistered` | `locked` | `unlocked`), absent for
  every other device; the per-socket `passkeySlot` created on connect.
- The per-frame lock gate, **before any handler**, refusing everything outside the exempt set with
  `auth/locked` + `reason`; the same gate on the outbound `sendGate` so a locked socket receives no
  session data at all (and error text is replaced with a fixed sentence).
- The four passkey handlers (`handlePasskeyFrame`) plus the `refuseIfWebLocked` guard on the three
  families dispatched before the generic scope gate (remote bridge, upload, browser).
- Re-lock on socket close (challenge dropped), on the 15-minute idle bound (lock layer), and on the
  PWA's lock frame. Revocation deletes the record and closes sockets `4401`.
- `POST /mgw/pending/:id/{approve,reject}` decides a `kind: 'passkey'` record and answers the asking
  socket with `passkey-approval` (granted to that socket, never the device); `GET /mgw/pending` lists
  them beside the pairing requests.
- Rate limits (5 failed ops / 10 min per device, 30 / hour global) are now part of the request-path
  lock too: an **unlocked** socket over its budget is refused `auth/locked` with
  `reason: 'rate-limited'` (§14.5's own wording for the request path), not silently served.

### Two contract gaps found while wiring (both fixed in the gateway)

1. **`device-forget` was refused on a locked socket.** Contract §14.2 lists `client-hello`, `ping`,
   `device-forget` and the passkey frames as the allowed set, and §5 FR2 makes `device-forget`
   scope-exempt so a leaked credential can always remove itself. The lock gate now allows it.
2. **`passkey-lock` was not implemented as a frame.** The gateway only accepted an invented
   `passkey-assert {lock:true}` form, while the app (`src/core/web-lock.ts#PASSKEY_LOCK_TYPE`) and
   contract §14.2 both send a top-level `passkey-lock` → `passkey-lock {locked:true}`. The gateway
   now spells the same literal (`PASSKEY_LOCK_TYPE` in `lib/allowlist.mjs`, since
   `packages/mobile-protocol` revision 14 exports no constant for it — same open item the app
   section already recorded), scopes it to `web:unlock`, accepts it in any lock state and answers
   the contracted frame. The invented `passkey-assert {lock:true}` form was removed.

### New file: `test/passkey-adversarial.test.mjs` (9 cases, wire level)

The unit suite's header promised this file and it did not exist — which is exactly why the broken
wiring above shipped with a green unit suite. It drives the assembled gateway over its **real TLS
listener** with real P-256 keys, real signatures and real CBOR: locked start + `hello.webLock` +
no Host call; register→close→re-assert→served; forged assertions (foreign key / wrong origin / wrong
rpId / UV=0 / UP=0) with no leaked field; replayed challenge; the bridge/upload/browser families
held by the lock; `passkey-lock` in any state; close-is-a-lock; revoke → record deleted + `4401`;
five failures → `passkey/rate-limited` and `reason: 'rate-limited'`. The fixture reserves a free port
before startup so the exact `Origin` can be listed in `allowedOrigins` (the passkey site is the exact
origin, and that list is read once at bind time).

### Gates (literal, run in `plugins/mobile-gateway`)

- `npm test` → `exit=0`, no `✖`/`not ok` lines; last suite `tests 58 / pass 57 / fail 0 / skipped 1`
  (the skip is pre-existing). `test/passkey.test.mjs` + `test/passkey-adversarial.test.mjs` were
  added to the `npm test` chain (they were not run by any gate before).
- `node --test test/passkey.test.mjs test/passkey-adversarial.test.mjs` → `tests 34 / pass 34 / fail 0`.
- `npm run check:protocol` → `OK — lib/vendor/mobile-protocol.mjs matches … (sha256 5b5a33ff…, 93 exports)`.
- `npm run test:package` → `tests 1 / pass 1 / fail 0`; `the packed tarball is self-contained`.
  This gate CAUGHT a real packaging bug: `lib/passkey.mjs` imported the bare
  `@dsh-ext/mobile-protocol`, which does not resolve in an installed tarball. Now uses
  `./vendor/mobile-protocol.mjs` like every other runtime consumer.
- `packages/mobile-protocol`: `npm test` → `tests 52 / pass 52 / fail 0`.

### Risk / open items for the reviewer (auth code)

1. `passkey-lock` still has no `packages/mobile-protocol` constant; the gateway and the app each
   carry the literal. Two places to change if the protocol owner adds one (unchanged open item).
2. The scope gate runs BEFORE the lock gate, so a frame whose scope the device lacks answers
   `auth/forbidden-scope`, not `auth/locked` (asserted deliberately in WL-5). That is the existing
   order for every family and leaks nothing the device did not already know.
3. `webLockReason()` is consulted on every outbound frame for a `web:unlock` socket, so the rate
   limiter prunes on each send. Bounded by construction (windows drop expired entries), but it is
   per-send work a reviewer may want to look at.
4. The gateway still sends a login-less `webauthn.request` frame when the TLS listener has an empty
   `allowedOrigins` (no passkey site can exist then). Not part of revision 14's frame list; kept as a
   pre-existing setup hint, and worth a reviewer opinion on whether it belongs in the contract.

## Gateway review fixes (2026-11-12 ~21:20, coder)

Scope: `plugins/mobile-gateway/**` only. The security reviewer REJECTED the passkey feature with five
gateway findings; each is fixed below with the test that now pins it. `packages/**` was NOT touched
(no `PASSKEY_LOCK_TYPE` export added, as instructed); the literal stays in
`lib/allowlist.mjs#PASSKEY_LOCK_TYPE`, unchanged.

### 1. `passkey-register` no longer unlocks the socket (index.mjs ~5485 → now 5511-5521)

The register handler called `passkeyLock.unlock(...)` on success, so storing a credential opened the
socket without a user authentication. Contract §14.2 says only a successful `passkey-assert` unlocks.
The handler now only answers `{kind:'passkey-register', ok:true}`; the socket's state moves
`unregistered` → `locked`, and the next non-passkey frame is still refused `auth/locked`.
Tests: `WL-2` (register then `sessions` → `auth/locked` + `reason:'locked'`, assertion is what opens
it), `WL-6`/`WL-9` were updated to assert first (they had relied on the old unlock), and `WL-10` pins
that a REPLACEMENT registration is not an unlock either.

### 2. Attested credential data is read at the standard layout (webauthn.mjs 236 → now 41-46, 240-251)

`parseAuthData` read `credentialIdLength` at byte 37, i.e. at the start of the 16-byte AAGUID, so every
real browser attestation was refused (and the gateway's own fixtures had been written to that wrong
shape). It now bounds-checks `AAGUID_BYTES + CREDENTIAL_ID_LENGTH_BYTES`, skips the AAGUID, then reads
the id and the COSE key. Fixtures fixed in `test/passkey.test.mjs` (~111, `AAGUID` constant + the
`attestationObject` builder) and in `test/passkey-adversarial.test.mjs` (`registration()`).
New test `P14` pins it: the genuine layout verifies, a legacy AAGUID-less authData is refused, and a
truncated AAGUID is a refusal rather than a crash.

### 4. `passkey-approval` carries the contracted fields (index.mjs ~4955 → now 4967-4990)

The push sent `{kind, approved, verificationCode}`. Contract §14.3 (lines 748-750) names
`{kind:'passkey-approval', approvalId, action:'approve'|'reject', verificationCode}`, and the app
(`src/core/client.ts` 1082-1087) drops a frame without `approvalId`/`action`. The frame is now built
once from the decision and sent to the asking socket; on `reject` the same loop re-locks that socket
(`passkeyLock.lock`) and drops its live challenge (`forgetSocket`), per §14.3's "the asking socket is
locked again". Test: `WL-10` asserts both actions' fields, the re-lock after a reject, that the old
passkey still works afterwards, and the approve→re-register→assert path of a replacement.

### 5. Pending routes require this machine's loopback authority (index.mjs 4937-4965)

`GET /mgw/pending` and `POST /mgw/pending/:id/{approve,reject}` only checked `isLoopback(req)` and
`isSameOrigin(req)` — and the latter compares two caller-supplied headers, which a DNS-rebinding page
satisfies while the peer really is loopback. Both routes now call `assertTrustedLocalAuthority(req)`
the same way `/mgw/listen` does (the function's doc comment was widened because it is no longer
listen-specific; its refusal text no longer says "listen address changes"). Test: `WL-11` calls both
routes with `Host`/`Origin` = `attacker.example` from the loopback peer and requires 403 on each, with
no verification code in the body and the approval still pending afterwards.

### 6. The idle re-lock is checked BEFORE the touch (passkey.mjs 562-577, index.mjs 5729)

`touch()` refreshed `lastFrameAt` unconditionally, so a frame arriving after 15 idle minutes re-armed
an unlock that had already expired (the expiry was only noticed if `state()` happened to run first).
`createPasskeyLock` now owns one `withinIdle()` predicate; `touch()` applies it first — an expired
unlock is cleared, never extended — and `state()` uses the same predicate. The gateway touches the
slot on every accepted incoming frame (right after the JSON/`type` validation, before any gate), which
is what "measured from its last frame" in §14.2 means.
Tests: `S10b` (unit: idle past the bound + `touch()` stays locked; within the bound the refresh
extends; a locked slot is never revived) and `WL-12` (wire: an instance started with the new test-only
`testWebUnlockIdleMs` keeps an unlocked socket alive across 2× the bound while traffic flows, then
three frames after a real idle are all `auth/locked`, and only a new assertion gets back in).

### Notes

- New test-only option `testWebUnlockIdleMs` (index.mjs 3385-3390), consumed like the existing
  `testPendingTtlMs` seam: the bundle never sets it, and without it the 15-minute rule cannot be
  observed on a live socket. Production behaviour is unchanged (`WEB_UNLOCK_IDLE_MS`).
- `test/passkey-adversarial.test.mjs`'s authenticator now keeps its own sign counter and advances it
  per signature (`signCounter`): the platform's counter is monotonic, and a fixture that reused one
  value made the second assertion of a socket fail — a test defect, not a gateway defect.
- WL-11 deliberately does not reuse the pairing `rawManagement` helper: it goes through the real
  listener with a forged `Host` header, which is exactly the attack the finding describes.

### Gates (literal, run in `plugins/mobile-gateway`)

- `npm test` → `EXIT=0`; 0 `✖` lines; 17 suites report `ℹ fail 0`; last suite `tests 58 / pass 57 /
  fail 0 / skipped 1` (the skip is pre-existing).
- `node --test test/passkey.test.mjs test/passkey-adversarial.test.mjs` → `tests 39 / pass 39 / fail 0`.
- `npm run check:protocol` → `OK — lib/vendor/mobile-protocol.mjs matches … (sha256 5b5a33ff…`,
  `EXIT_CHECK=0`.
- `npm run test:package` → `the packed tarball is self-contained …`, `tests 1 / pass 1 / fail 0`,
  `EXIT_PKG=0`.

### Still open for the reviewer

1. `test/pairing-approval.test.mjs` P9 now also passes through `assertTrustedLocalAuthority` for the
   pending routes (its own `Host: 127.0.0.1:<port>` header already satisfies it), so no expectation
   moved — worth a glance that the new 403s and the old ones stay distinguishable.
2. The pre-existing `test/allowlist.test.mjs` question-answer/question-cancel failure stays as
   AGENTS.md records it; it is untouched by this work and the suite is green.
3. `PASSKEY_LOCK_TYPE` is still a gateway/app literal, per the instruction not to touch `packages/`.

---

## 2026-11-12 — reviewer finding (Major): an approved pending socket carried the WRONG Origin

### The defect

A pending pairing socket is created by the **browser's** WebSocket upgrade but promoted by a
completely different request: the Host's `POST /mgw/pending/:id/approve` on the loopback management
route. `lib/index.mjs` read `origin: req.headers.origin` at that promotion point, where `req` is the
**management POST**, not the upgrade. The browser's Origin was never stored
(`pendingSockets.set(...)` kept only `transport`), so the promoted socket's passkey site was the
owner page's origin — which is not, and must never need to be, a member of `allowedOrigins` — and
every ceremony on the socket the owner had just approved was refused
`passkey/verification-failed`. A socket that upgraded without an Origin inherited the management
origin outright.

### The fix (`lib/index.mjs`)

- `acceptPendingSocket` → `admit()`: the pending record now stores the upgrade request's own
  `origin: req.headers.origin`, beside the `socket`/`transport` it already kept. That `req` really is
  the browser's upgrade.
- `POST /mgw/pending/:id/approve`: the promotion passes `origin: waiting.origin` instead of
  `req.headers.origin`.

Swept every other promotion/handshake site for the same mistake. `activateBusinessConnection` is
reached from exactly three places: the fixed promotion above, and the two inside
`wss.handleUpgrade`'s callback (`businessTransport` at the rtc attach, and the plain business
activation) — there `req` genuinely IS the browser upgrade, so both keep `req.headers.origin`. No
other management request feeds either the transport or `helloFrame`.

### The test

`test/passkey-adversarial.test.mjs` **WL-13**, at the end of the file. It pairs over the real TLS
listener with `web:unlock` via OTP, with `origin:` set to the TLS listener's origin
(`https://127.0.0.1:<lanPort>`) while the approval POST goes to `http://127.0.0.1:<mgmtPort>` — two
provably different origins, asserted distinct in the test. It then runs the full registration and
assertion ceremony with `browserOrigin` and asserts the socket unlocks and serves `sessions`.

Proven to catch the defect: with `origin: req.headers.origin` restored at the promotion point,
`node --test test/passkey-adversarial.test.mjs` → `tests 13 / pass 12 / fail 1`, the failing one being
WL-13. With the fix `tests 13 / pass 13 / fail 0`.

### Gates (literal, run in `plugins/mobile-gateway`)

- `node --test test/passkey.test.mjs test/passkey-adversarial.test.mjs` →
  `tests 40 / pass 40 / fail 0 / skipped 0`, `duration_ms 75986.4939`.
- `npm run check:protocol` → `[sync-mobile-protocol] OK — lib/vendor/mobile-protocol.mjs matches
  packages/mobile-protocol/src/index.mjs (sha256 5b5a33ff482a61f7b2fd7aa9c6c3edbeaea8253b302764d1fe68eb4837a8b404, 93 exports), 6 runtime consumers import the vendored copy`.
- `npm run test:package` → `✔ the packed tarball is self-contained: it installs and loads with no
  @dsh-ext/mobile-protocol (14680.0824ms)`, `tests 1 / pass 1 / fail 0`, `duration_ms 14783.4169`.
- `npm test` → `EXIT=0`, final suite `tests 58 / pass 57 / fail 0 / skipped 1 / cancelled 0`,
  `duration_ms 22333.7049`, `status: completed, exit code: 0`.
  First run had ONE failure, `test/webrtc/trickle.test.mjs:205` ("dual real peers bind before group
  commit while STUN is pending", `1 !== 2`); run alone it passed `4 / 4`, and the second full run was
  green, so it is a known ICE/STUN timing flake in that suite, not this change. Both runs recorded
  rather than only the green one.

### Still open for the reviewer

1. Confirm the Origin captured in the pending record is the one the browser will present at
   `passkey-*` time. A tab that pairs and then reloads starts a NEW socket (a new upgrade), so the
   stored value only ever serves the socket that is actually promoted — worth a read.
2. `waiting.origin` is `undefined` when the upgrade carried no Origin. That is the intended
   fail-closed behaviour (a socket with no Origin can never run a ceremony) and it matches the
   direct-claim path, but it is now reached through this new field rather than through whatever the
   management request happened to carry.
3. The `test/webrtc/trickle.test.mjs` flake is unrelated to spec 021 and is not fixed here; the
   `test/allowlist.test.mjs` question-answer/question-cancel issue noted above is likewise untouched.


