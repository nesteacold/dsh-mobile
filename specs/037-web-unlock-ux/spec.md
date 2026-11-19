# 037 — Web unlock UX: responsive, prefetched, fail-fast

Status: **historical implementation; PWA lock UI superseded by owner-directed spec 045**.

> Release precedence (2026-11-19): the PWA no longer renders the lock/registration UI described below. Spec 045 governs browser behavior; retained helpers exist for legacy compatibility, not as a requirement to lock the PWA. Native platform locking is unchanged.

Amends spec 021 §14.1/§14.3 and spec 036 App behaviour. Packages affected: `apps/mobile-companion`
only. No new wire frame, no contract revision bump: every frame below already exists.

## Problem

Measured from source and recent host logs 2026-11-18: pressing **Unlock** on the PWA can take many
seconds or never complete. Current path on web:

1. `onPress` calls `void controller.unlockWithPasskey()` with no busy state, no disabled button and no
   spinner (`app/_layout.tsx` `WebLockGate`).
2. `runPasskeyStep()` sets a private `passkeyInFlight` guard but does not expose it in the snapshot;
   a second tap returns silently (`src/app-state.ts:1187-1203`).
3. The app waits for a ready socket, then sends `passkey-assert-options` over WebSocket, and only then
   calls `navigator.credentials.get()` (`src/platform/passkey.web.ts:156-163`). On iOS this loses the
   user activation and can delay or suppress the passkey sheet.
4. WebAuthn itself has no app-side deadline; the only `timeout` is the Host challenge TTL (~60 s). If
   the platform promise never settles, `passkeyInFlight` stays true forever and every later tap is
   swallowed.
5. Socket timeout (20 s handshake), request timeout (15 s), user cancel, transport failure and
   `not-registered` all collapse into one generic `locked` copy.

This is a UX/auth defect, not a new security model. The Host stays authoritative.

## Goal

Pressing **Unlock** must produce immediate visible feedback, start the platform passkey prompt as
close to the user gesture as possible, and fail with an actionable message within a bounded time.
A slow or stuck platform dialog must never leave the button permanently inert.

## Design

### 1. Prefetch assertion options while the lock gate is visible

- When a web device has a **ready, locked** socket, fetch `passkey-assert-options` in the background
  and keep the decoded assertion request in memory only.
- The cache is bound to that exact `CompanionClient` and to a monotonically increasing
  `preparedAttempt` id. Its age is measured **from the moment the options request was sent**, not
  from response arrival, so network latency cannot make an old challenge look fresh. A request may be
  used only while the remaining Host challenge life is at least `25s + a send margin`; otherwise it
  is discarded. No client-side extension of the 60 s Host TTL is allowed.
- Serialize options requests: send at most one in flight per socket. Invalidate the cached request
  **before sending** a refresh — the Host replaces the challenge when it handles the request, even if
  its response has not arrived yet. Therefore a tap during a pending refresh must never use the old
  cache; it goes through the "preparing" path, reuses/awaits that single pending request when safe,
  or starts one only after it settles.
- Refresh only while idle: stop the refresh timer/sequence the moment Unlock is tapped. The tap
  **consumes** the cache immediately (clears it locally) and bumps the ceremony generation. Any
  options response that arrives late must be discarded by comparing client identity and
  `preparedAttempt`; it must never overwrite the challenge in use. Do not send another options
  request until the current ceremony settles.
- On `Unlock`, if a valid prepared request exists for the current socket, call
  `navigator.credentials.get()` immediately from that request — no WebSocket round-trip before the
  platform prompt. Then send `passkey-assert` once with the result.
- If no prepared request exists (or it is too old), fall back to the existing full `assertPasskey()`
  path and show a short "preparing" state; do not silently wait. The Host still verifies every
  assertion; prefetched options are never treated as authority to unlock.

### 2. Immediate, honest UI state

- Expose passkey work as `snapshot.webLock.pending` (or an equivalent typed field already used by the
  gate). `WebLockGate` must:
  - disable the action while pending,
  - show a spinner or explicit "Đang mở khóa…" / "Unlocking…" copy,
  - ignore duplicate taps instead of silently starting a second prompt.
- Clear pending in `finally`, including on timeout/cancel/socket replacement.

### 3. Bounded waits and distinct failures

- Add an app-side timeout for the platform WebAuthn call (start with **25 s**). Use `AbortController`
  / an `AbortSignal` when the browser accepts it, but treat abort support as best-effort: some WebAuthn
  implementations cannot close the native sheet. ALWAYS pair the timer with a ceremony generation
  guard so a late result cannot send `passkey-assert`, open the gate, clear the pending state of a NEW
  attempt, or overwrite the next attempt's prepared challenge.
- A timeout sets a dedicated reason/copy and allows a new attempt. A retry while the old native sheet
  is still open may be refused by the browser; the copy must say so neutrally instead of blaming the
  Host.
- Distinguish at least:
  - passkey timed out by the app timer (definite),
  - prompt dismissed / `NotAllowedError` (ambiguous: cancel, browser timeout or lost user activation),
  - Host/socket unreachable or timed out,
  - no passkey registered,
  - registration awaiting owner approval,
  - rate limited.
- `passkeySocket()` returning `null` must set a reason/bump instead of returning silently.
- Copy must say what the user can do next (retry, approve on desktop, or forget/re-pair), not a generic
  "locked".

### 4. iOS considerations

- WebAuthn runs only in a secure context; keep the existing `unavailable` handling.
- Do not add WebView/Capacitor or any native code. This remains the RN/Expo web target.
- Prefetch is the mitigation for transient user activation loss; it must not bypass Face ID / passcode:
  `userVerification: 'required'` stays.

## Non-goals

- No new protocol field, frame or revision bump.
- No change to 24h rolling grant or challenge TTL.
- No client-side decision to unlock; only the Host's `unlocked` answer opens the gate.
- No auto-retry loop that repeatedly shows the Face ID sheet.

## Acceptance

- Behavioural tests (no source regex):
  1. With a ready locked web socket, options are prefetched once; tapping Unlock uses the prepared
     request with no extra options request before the assertion.
  2. A second tap while pending does not start a second WebAuthn call; UI shows pending/disabled.
  3. WebAuthn promise that never settles is abandoned after the app timeout; pending clears, a reason
     is shown, and a late resolution cannot unlock. A retry can start while the old promise is still
     unresolved and is not corrupted by it.
  4. Refresh/timing: an options response arriving after the tap is discarded by client + prepared
     generation; a fresh-options request is not sent during the ceremony. A tap while a refresh
     request is already in flight never uses the old cached challenge (Host may already have replaced
     it); it takes the preparing path. At the age boundary (sent-at + remaining TTL < `25s + margin`)
     the prepared request is refused and a fresh one is requested instead of using a challenge that
     would expire mid-ceremony.
  5. `passkeySocket()` null / handshake timeout sets a visible reason and clears pending.
  6. Cancel, app timeout, no-passkey and approval-pending produce distinct copy paths; ambiguous
     `NotAllowedError` uses the neutral copy.
  7. Socket replacement, lock, revoke, background/foreground lock, expiry and a Host-confirmed unlock
     via grant invalidate the prepared request; a socket change **during** WebAuthn invalidates the
     in-flight ceremony.
- Reviewer **APPROVE** required (auth code).
- Live PWA check: tap Unlock, passkey sheet appears promptly; repeated taps give feedback; cancelled
  and timed-out attempts show distinct messages and can be retried.
