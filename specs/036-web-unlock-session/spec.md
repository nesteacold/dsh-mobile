# 036 — Web unlock session (24h passkey grant)

Status: **historical implementation; PWA lock policy superseded by owner-directed spec 045**.

> Release precedence (2026-11-19): spec 045 removes the browser/PWA second passkey gate. The locked/unlocked requirements below document the earlier design and legacy/non-browser compatibility only; they do not re-enable browser locking. Native platform biometrics and pinned pairing are unchanged.

This amends spec `021-web-passkey-unlock` §2 and §4. Packages affected: `packages/mobile-protocol`
(additive capability/constants), `plugins/mobile-gateway` (authoritative grant), `apps/mobile-companion`
(web target consumes existing `hello.webLock`). Reviewer is **mandatory** (auth/token/session code).

## Problem

Measured 2026-11-17 on the owner's iPhone PWA: pair, passkey registration and unlock succeed, but
switching to another tab and back makes the PWA ask for the passkey again. Source inspection
confirms this is by design in spec 021: every socket starts locked; only a successful
`passkey-assert` on that socket unlocks it; socket close/background and tab reload require a new
assertion. The recent pairing/background fix only defers socket close while a pairing is pending;
it did not introduce this behaviour.

Owner request: "session 1 ngày mới lock 1 lần" — one passkey unlock per 24 hours.

## Goal

After one successful passkey assertion, the same paired web device in the same browser origin may
reconnect and read its own data for **up to 24 hours of rolling activity** without repeating the
WebAuthn ceremony. The Host remains the authority; the browser never stores a new "already unlocked"
secret. Owner decision 2026-11-17: the 24h window is **sliding on activity**, not absolute; a Lock
offline that never reaches the Host is accepted as not confirmed; capability opt-in is accepted so
older clients keep spec 021 behaviour.

## Security model and tradeoff

This creates a Host-issued, time-limited unlock grant. It is equivalent to a rolling 24-hour bearer
authorization for that browser profile/origin/device. That is a real increase in exposure if the
device profile is compromised; web storage is already weaker than native Keychain
(`secure-store.web.ts` documents this). The rolling window means continued use keeps the grant alive;
it is deliberately chosen by the owner. There is NO absolute hard cap in this revision; traffic on an idle-but-connected socket (including keep-alive/backpressure) can keep the window open.

The grant is bound to the paired credential, device, presented Origin and the Host's current
authorization generation. It does **not** prove a unique browser profile: a process holding the
device credential could present the same Origin. A sealed client token in IndexedDB would not fix
that and would add another bearer artifact and replay surface; the Host-side grant is therefore the
smaller design.

Non-goals:
- Never store "unlocked=true", the grant, or any token in `localStorage`/`sessionStorage`.
- Never let the client decide it is unlocked. `hello.webLock` and every outbound data gate remain
  Host-authoritative.
- Native devices (`kind: desktop`, no `web:unlock`) are unaffected.
- No passkey sharing between devices; no account recovery; re-pair is still the recovery path.

## Design

### Host-authoritative grant

Add a grant to the existing passkey record for the device (owner-only state file, already where the
passkey public key lives). Shape:

```js
unlockGrant: { origin: string, grantedAt: number, expiresAt: number } | null
```

Rules:
1. On a successful `passkey-assert` for a web device, set `unlockGrant` to the exact `Origin` that
   socket presented, `grantedAt = now()`, `expiresAt = now() + 24h`. Persist atomically with the
   record. Do not log the origin if logging origins is disallowed; log a code only.
2. Define ONE predicate `effectiveGrant(device, socket, now)` used at socket creation AND before
   every inbound dispatch and outbound data send (including broadcasts and responses to requests
   that started earlier). It must check, at minimum: kind may hold `web:unlock`; scope still present;
   passkey record still exists; socket `Origin` exactly matches the grant origin and is still
   accepted by that socket's ingress; `now() < expiresAt`; device not rate-limited; credential /
   passkey / authorization generation unchanged; ingress/origin policy unchanged. A rate limit
   suspends use of the grant for the window (it does not silently clear it unless authorization
   changed); expiry and every authorization mutation below clear it permanently.
3. The 15-minute idle re-lock (`WEB_UNLOCK_IDLE_MS`, spec 021 §4) does **not** apply while
   `effectiveGrant` is valid. When it stops being valid, the next `touch`/state/outbound check locks
   the socket. Owner chose a **sliding** window: an authorized inbound frame or outbound data send
   on a socket with a valid grant refreshes `expiresAt = max(expiresAt, now + 24h)`. Refresh is only
   allowed after `effectiveGrant` has passed all checks; a locked/rate-limited/invalid socket can
   never extend the grant. Persist refreshes at most once per 60s (debounced), but evaluate expiry
   from the in-memory value first so a crash cannot extend a grant past its last authorized use.
    Invalidation cancels that device's pending refresh; a flush callback must re-check the current
    epoch and record identity and serialize ONLY the current state, never a captured grant. Clearing
    a grant on invalidation is persisted immediately, never debounced.
4. Explicit owner action "Lock" (`passkey-lock`) is **device-wide**, not just the current socket:
   clear the grant, lock every socket of that device, and cancel every in-flight unlock
   challenge/approval for it. Every assertion result must check the current epoch/generation before
   committing; a ceremony that started before Lock/revoke/re-pair may never recreate a grant.
   A background/tab switch is not an explicit lock: it may close the socket, but the grant remains
   until expiry or invalidation.

### Invalidation (clear grant and bump epoch immediately)

- device revoke or `device-forget` (existing revoke path),
- passkey replacement/removal (registration changes the public key),
- any device scope change, kind change, credential rotation or re-pair that changes generation,
  even if `web:unlock` is later added back,
- `auth/revoked`, `reauth-required`, `gateway-disabled`, `update-required`,
- gateway detects a passkey change (`onPasskeyChanged`) for that device,
- accepted-ingress / allowed-origin policy change for that socket's ingress,
- grant expiry,
- explicit Lock action.

On any invalidation, all sockets of that device fall back to the normal spec 021 locked state; they
must NOT keep an older per-socket `unlocked` slot as a secondary source of truth. The client may
clear its cached view on these events, but the Host record and epoch are the authority.
Any invalidation also cancels the device's pending refresh and persists the cleared grant
immediately; a delayed flush may only serialize the current epoch/record state, never a captured
older grant.

### Offline Lock limitation

The app currently treats a failed `passkey-lock` send as best-effort. With a 24h Host grant that is
no longer safe: if the Lock frame cannot reach the Host, the grant is still live and a later
reconnect/reload may be unlocked. Therefore the app must require a Host-confirmed Lock receipt before
showing "locked"; on timeout/offline it must say the Host has not confirmed the lock. Persistence of
a pending offline lock is OUT OF SCOPE; the owner must accept that without it, an offline Lock cannot
survive a browser restart before the Host receives the request.

### Wire and contract

No new frame shape is required; add:
- `WEB_UNLOCK_SESSION_TTL_MS = 24 * 60 * 60 * 1000`.
- A capability opt-in, e.g. `web-unlock-session.v1`, sent in `client-hello`. The gateway applies the
  grant ONLY to sockets that advertised it. Clients without the capability keep exact spec 021
  behaviour (every new socket locked), so this stays additive and no major version bump is forced.
- Clarify `WEB_LOCK_STATES[2] = 'unlocked'`: for opted-in sockets it may mean "this socket asserted
  OR a valid Host-side grant was applied". For non-opted-in sockets it keeps the old meaning.

Contract work is NOT optional: update §14 and revision history in
`specs/001-gateway-hardening/contracts/mobile-protocol-v1.md`, the constants/declarations/README in
`packages/mobile-protocol`, and sync the vendored gateway copy with
`scripts/sync-mobile-protocol.mjs`. Contract tests that only pin text/constant are not behavioural
evidence; the gateway/app tests below are.

### App behaviour

- Advertise the capability only when the build implements this spec.
- `hello.webLock === 'unlocked'`: skip the passkey UI, set the controller's unlocked state through the
  existing Host-confirmed path, and let normal `resync()` load sessions/history.
- Background/tab switch may still visually close the gate and tear down the socket; on return the app
  reconnects with its existing stored device token. If the grant is valid it reaches `unlocked`
  without a passkey prompt.
- Reload within 24h behaves the same (new socket, valid grant). Reload after expiry prompts again.
- Never add a client-side timer that opens the gate by itself.
- Lock action success requires Host receipt; offline failure is reported, not silently swallowed.

## Acceptance

- Contract: capability/constant and `hello.webLock` semantics pinned in the canonical contract and
  vendored copy in sync; non-capable clients still get spec 021 locked behaviour.
- Gateway behavioural tests:
  - grant survives reconnect, Host restart and browser restart while unexpired;
  - authorized activity extends the sliding window; locked/rate-limited/invalid activity does not;
  - TTL boundary and debounced persistence: an unpersisted refresh never extends a grant after a
    crash beyond the last authorized use;
  - expiry on an old socket with no inbound but receiving a broadcast closes the data gate;
  - two sockets of one device: Lock/replacement/expiry on A stops data on B;
  - stale assertion/challenge completed after Lock/revoke/re-pair cannot create a grant;
  - scope remove→re-add, credential generation change, origin-policy remove→restore all invalidate;
  - rate limit suspends the grant during the window and does not clear other authorization state;
  - explicit Lock clears grant device-wide; locked socket cannot read sessions/history;
  - no grant/origin/challenge/signature is logged as a secret.
   - scheduled refresh → Lock/revoke/replacement → flush timer → persisted state still has no grant;
- App behavioural tests:
  - `unlocked` hello → no passkey prompt and history loads (behavioural, not source regex);
  - background → reconnect → no prompt while grant valid; expired/invalid grant → prompt;
  - Lock request timeout/offline says Host has not confirmed the lock;
  - explicit Lock → prompt.
- Live owner check on the iPhone PWA: passkey once, switch tab away and back, conversation opens with
  messages and no passkey prompt.
- Reviewer APPROVE required before implementation is considered done.

## Open item for owner

Owner decided 2026-11-17: (a) accept the rolling 24h browser-profile exposure, (b) accept the
offline-Lock limitation, (c) accept capability opt-in for compatibility. No open decision remains.
Implementation must not silently choose a different TTL, window type or compatibility policy.
