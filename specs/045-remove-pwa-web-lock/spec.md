# 045 — Remove the PWA web-lock screen

Status: **proposed — owner-directed security change; reviewer pass required**.

Supersedes the PWA part of specs `021` and `036`. Native platform lock is unchanged.

## Owner decision

Owner 2026-11-18: “Gỡ luôn phần lock màn hình của PWA, quá rắc rối, dù đã thực hiện passkey unlock
thành công nhưng vẫn quay về màn hình khoá, đưa tab về background cũng bị khoá dù đã unlock.”

The PWA will no longer use a Host-enforced passkey lock or show any lock/registration screen. Pairing
still requires the Host-approved one-time code and the device credential; the per-device credential
and scopes remain authoritative. This knowingly removes the browser-side second gate. Native phone
lock (OS biometrics / device passcode) is untouched.

## Root cause (source evidence)

- `app/_layout.tsx:259-286` calls `controller.lock()` on every `background` transition; web is only
  exempt while a pairing is pending (`background-lock.ts:17-19`). This closes the socket that had just
  been asserted.
- `plugins/mobile-gateway/lib/index.mjs:3940-3955` arms `ws.passkeySlot` and `webLockState` for any
  device holding `web:unlock`; `:4005-4022` drops all non-passthrough frames while locked.
- Gateway socket close locks the slot (`index.mjs:4889-4891`), and the next `client-hello` is locked
  unless a valid Host grant exists. Grant invalidation on origin/epoch change reopens the gate
  (`passkey.mjs:467-487`).
- `_layout.tsx:438-452` renders `WebLockGate` whenever `snapshot.webLock.state !== 'unlocked'`;
  `WebBootstrap` (`:401-410`) asks for passkey register/assert before any socket exists.

Removing only the UI would leave the PWA paired but unable to read data: the gateway would still
answer `auth/locked` and drop session frames. Both layers must change together.

## Design

1. **Gateway: no web lock for browser clients**
   - In `plugins/mobile-gateway/lib/index.mjs`, stop arming `passkeySlot`, `webLockState`,
     `ws.sendGate` and `refuseIfWebLocked` for a socket whose client is a browser/PWA. Detect this
     from the browser `Origin` on the WebSocket upgrade (the same signal passkey site checks use);
     native clients send no browser Origin.
   - Keep the passkey service itself available for the contract frames so an older bundle does not
     crash, but never let it gate a browser socket. Do not add any new log field or line.
   - No socket close lock, no `hello.webLock`, no `auth/locked` for browser clients. Explicit lock
     broadcasts must also skip browser sockets (e.g. the `passkey-lock` approval path around
     `index.mjs:1555-1556`) so a later event cannot re-arm the gate on an already-open PWA.
   - Browser `Origin` is a transport signal, not proof that a client is a PWA: a non-browser client
     could spoof it to skip the browser passkey gate. That is the accepted consequence of the owner's
     decision; the existing Origin check for ceremonies, device credential, scopes and revocation are
     unchanged. Native/mobile-app lock behaviour is unchanged for non-browser sockets.

2. **App: remove the web lock UI, controller gate and background lock**
   - `_layout.tsx`: on web, initialise/treat the platform gate as `unlocked`; do not render
     `WebBootstrap`, `WebLockGate`, passkey register/assert buttons or the lock screen. A paired web
     app goes straight to the navigator.
   - On web, the controller must also start and remain logically unlocked: do not let a stored
     `web-unlock-session.v1` grant (`loadWebUnlockGrant`), a legacy `hello.webLock:locked`, or a
     `paired.device.scopes` containing `web:unlock` re-arm `webLocked`, block resync or disconnect the
     socket. Reconnect and Host change keep the web controller unlocked. Existing stored passkey data
     may remain untouched; it is simply not required by the PWA.
   - On web, do not call `controller.lock()` on `AppState background`; do not call
     `startWebLockSession()`. Keep the existing foreground/background tracking only if needed for
     other features.
   - Remove the web-only “Lock now” action from `settings.tsx`.
   - Keep `app-state.ts`/`passkey.web.ts` functions for wire compatibility and native builds, but
     the web UI must not call them. No stored passkey is required to use the PWA.

3. **Contract / docs**
   - In `packages/mobile-protocol`, mark the web-unlock-session capability and passkey lock frames
     as legacy/deprecated for browser clients; do not remove wire names, so an old bundle can still
     connect and simply is not gated. Sync the vendored gateway copy.
   - Update spec `001` / `021` / `036` references with a one-line “superseded for PWA by 045” note.

4. **Rollout / version skew**
   - The gateway must be updated with this change. A cached OLD PWA bundle can still stop at the
     bootstrap waiting for a passkey; deploy must invalidate the service-worker shell so the new
     bundle is fetched (same pattern as spec 043: rebuild, toggle web ingress, verify served common
     chunk, then hard reload/remove re-add PWA on iOS).
   - If a NEW app bundle meets an OLD gateway that still returns `hello.webLock:locked` or refuses
     ordinary frames with `auth/locked`, show a clear non-lock-screen message that the computer must
     be updated; do not mount the navigator over a gated socket and do not pretend to be connected.
   - Test upgrade with a stored 24h grant, a device holding `web:unlock`, reload and offline-cache
     recovery.

5. **Privacy**
   - No new token, log field or persistent marker. Do not log passkey assertions or pairing codes.

## Acceptance

- Gateway behavioural tests: a browser-origin socket with `web:unlock` receives no `webLock` in
  `hello`, is not gated, and can run ordinary ops immediately; close/reconnect stays usable; explicit
  `passkey-lock`/approval broadcasts do not re-arm browser sockets; a non-browser socket with
  `web:unlock` keeps the existing lock path.
- App behavioural tests: web branch never renders `WebLockGate`/`WebBootstrap`, never calls
  `lock()`/`startWebLockSession()` on background, ignores stored grant/legacy hello webLock, and
  pairs directly to the navigator; native branch is unchanged.
- Rollup tests: old bundle needs the new shell, new app + old gateway shows the update notice, and a
  stored 24h grant does not re-lock after reload/offline recovery.
- Existing pairing, token, approval and scope tests still pass.
- Reviewer **APPROVE** required (auth/pairing/security).
- Live PWA: unlock/passkey gate is gone; reload works; background/foreground does not lock; session
  list and attachments still work.
