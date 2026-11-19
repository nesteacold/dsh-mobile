# 046 — Surface an unusable web credential instead of endless reconnecting

Status: **proposed — reviewer pass required** (auth/pairing/connection).

Affects `apps/mobile-companion` web target only. No gateway or contract wire change.

## Problem

Reproduced 2026-11-18:

- A PWA whose stored device credential was revoked/replaced opens at `/` and shows only
  “Reconnecting… / Reconnecting to this computer…”, with zero session rows.
- Gateway log: `auth rejected: missing or invalid device credential ... user-agent=iPhone Safari`
  repeatedly. A fresh pairing in the same build shows 92 rows immediately.
- Root: browser WebSocket `onerror/onclose` exposes no HTTP status
  (`pinned-transport.web.ts:249-279`). The gateway's 401 cannot be classified by
  `classifyUpgradeRefusal`, so the client treats it as retryable `client/connect-failed` and the
  Reconnector backs off forever with `banner='reconnecting'`. No `reauthRequired` event fires.

This is a web-only visibility/recovery defect. Native pinned transport gets `details.status` and is
unchanged.

## Goal

When a paired web install cannot establish a bearer connection after a small bounded number of
pre-open failures, stop the reconnect loop and show an actionable **connection unavailable** state.
Browser WebSocket failures are ambiguous (revoked credential, offline, DNS/TLS, gateway off), so the
app must NOT claim the credential was rejected and must NOT set `credentialRejected`. **Retry** is the
primary action; **Pair again** is secondary and uses the existing confirm/forget path. Do not keep the
user on a blank reconnecting screen and do not wipe the credential silently.

## Design

1. **Bounded pre-open attempts on web**
   - In `connectHost`, when `webMode === true`, give the Reconnector an explicit web-only cap of
     **three consecutive pre-open failures** before any successful handshake/resync in that
     `connectHost` generation. Do not change the shared `maxAttempts` semantics for native/other
     callers: if the existing `attempt > maxAttempts` check cannot express “exactly three”, add a
     web-only pre-open counter/callback instead of changing the shared class contract.
   - On exhaustion, stop retrying, keep the stored credential, and set a new web-only banner state
     that renders “connection unavailable” (e.g. reuse `offline` copy or add a `connect-failed`
     banner). `credentialRejected` stays false: only a definite auth refusal may set it.
   - Once a socket has been live/resynced in this generation, the cap is disabled and later drops use
     the normal backoff. Generation-guard every callback so a stale stopped state cannot overwrite a
     newer host, pairing or connection.
   - Foreground resume, explicit **Retry**, and host switch open a fresh budget; never duplicate a
     socket that is already live or connecting.

2. **Recovery UI**
   - The home screen already exposes “Pair a computer” and banner rendering. On exhaustion show a
     fixed **connection unavailable** banner plus a primary **Retry** button. A secondary **Pair
     again** action calls the existing `forget()` path with the existing confirm copy. Do not
     auto-forget or delete the stored credential: three opaque browser failures are not proof of a
     401 or revocation.
   - Retry starts a fresh `connectHost` for the same host; Pair again forgets only after confirm and
     returns to the pair panel. Neither action looks like or reintroduces the PWA lock screen.

3. **Honest copy**
   - Fixed vi/en copy only: say the saved connection could not be reached; offer Retry, with Pair
     again as a secondary option. Do not say “credential rejected”, “removed”, or “must pair again”
     as the only remedy. Never include a token, URL, socket reason or exception.
   - Keep `Reconnecting…` for genuine transient drops before the cap.

4. **Tests**
   - `Reconnector` web cap: exactly three pre-open failures → stopped/connection-unavailable, loop
     stopped, no session request sent; the fourth failure does not happen; one success before the cap
     disables it for later drops.
   - Simulated opaque browser failure (transport `connect-failed` repeated) → connection-unavailable
     banner with primary Retry and secondary Pair again behind confirm; `credentialRejected` remains
     false and no credential is wiped.
   - Foreground resume, explicit Retry and host switch each open a fresh budget; stale callbacks from
     an old generation cannot set the banner or drop a newer host.
   - Offline/DNS/TLS failure also uses the connection-unavailable state; native transport still maps
     a real 401 to `reauthRequired` unchanged. Fresh pairing and normal reconnect still load rows.

## Non-goals

- No gateway change: browser WebSocket status remains opaque.
- No automatic credential deletion on a capped reconnect; the owner chooses Pair again.
- No cached-session fallback: with no usable credential there is nothing authoritative to show.

## Acceptance

- Reviewer **APPROVE** required.
- Live PWA with an unusable stored connection: `/` reaches the connection-unavailable banner with
  Retry/Pair again after the bounded attempts instead of an endless `Reconnecting…`; Retry recovers a
  transient outage, Pair again restores sessions after a fresh approval.
- Normal PWA reload/background/resume still has no lock screen and loads sessions.
