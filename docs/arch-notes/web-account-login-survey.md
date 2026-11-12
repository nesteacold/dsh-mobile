# Survey: option B — separate DeepSeek login in the PWA to unlock (beastcore, 2026-11-12)

Labels: (a) measured at runtime, (b) read from source, (c) inferred / not checked.
Source: `_upstream/dsh-rc1-extract/dsh/node_modules/@deepseek-ai/...` (rc.1). No network calls to DeepSeek were made, no credentials read.
Prior work: `plugins/mobile-gateway/lib/web-unlock.mjs` (current mechanism) — its status/profile assumptions are confirmed below.

## 1. How DSH signs in (b)
- No email+password, no SMS/OTP, no QR in DSH. Single method `browser` registered via `ctx.authorization.registerFlow` (`dsh-deepseek-account-platform/lib/index.js:573-586`).
- Flow = OAuth-style **PKCE** against **`https://platform.deepseek.com`** (config `platformOrigin`, `:501`), private DSH endpoints:
  - `POST /auth-api/v0/dsh/auth_init` {code_challenge(S256), state, redirect_uri, locale, login_source} → {authorize_url, authorize_id, expires_in} (`:131-139`, `:1019-1026`, schema `:111-115`).
  - User approves in a browser at `authorize_url` (rewritten to `/dsh/authorize`, `:1028`); DeepSeek's own page does the actual credential entry (email/phone/OTP methods live there, not in DSH) (c).
  - Callback `GET <origin>/oauth/callback?code&state` on DSH's own `webServer` (`:991-1016`); `redirect_uri = ${attempt.origin}/oauth/callback` (`:1018`) and the origin must be **loopback http with explicit port** (`loginOrigin`, `:311-325`) — remote domains explicitly unsupported.
  - `POST /auth-api/v0/dsh/auth_exchange` {code, code_verifier, redirect_uri, device_id, device_model, os_version} → {token, authorized_url, user?} (`:1056-1063`, schema `:117-121`).
- Result: opaque bearer `token` stored as credential record `kind:'grant'`, payload `{version:1, token, issuer}` under key `credentialKey("deepseek-account-platform","default")` (`:491-497`). One slot only. Device id under key `...,"device"` (`:492`, `:1050-1053`). Token sent as header `x-dsh-auth-token` (`:276`).
- Profile: `GET /auth-api/v0/users/current` (`:388-395`); logout `POST /auth-api/v0/users/logout` (`:204`).

## 2. Account API reachable by a plugin (b)
- Controller methods (`dsh-api-account-controller`), all **owner-only** in liveshare policy (`dsh-experimental-liveshare/lib/index.js:6198-6208`): `getState, getProfile, getBalance, getUnnotifiedBonuses, ackBonusNotified, startSignIn, cancelSignIn, signOut, watch, watchExpiry, hasRunningAccountTasks`.
- `getState()` → `{status:'signed-out'|'credential-stored', links:{usageUrl,topUpUrl}, attempt:null|{id, phase:initializing|waiting-browser|exchanging|committing|succeeded|cancelled|expired|failed, authorizeUrl?, expiresAt?, errorCode?}}` (`:615-627`, `typert.host.js`). **`credential-stored` is real.**
- `getProfile(client{version,locale,timezoneOffsetSeconds})` → `null | {status:'ready', value:{id:string|null, name, contact, avatarUrl?}} | {status:'failed'}` (`typert.host.js:62-72`, impl `:628-640`). **`{status:'ready', value:{id}}` is real**; `id` may be null; `contact` is email/phone (PII — do not use/log).
- There is **no** "verify another token" / "login without storing" API. `startSignIn` drives the single flow that commits into the single `default` slot → would **replace the Host's login** (c, strongly implied by `:491`, `:1079` committing).

## 3. Designs for B
| | (i) PWA → DeepSeek directly | (ii) gateway-run separate PKCE | (iii) OTP/email-code proof |
|---|---|---|---|
| Core patch | no | no | no |
| Works? | Unknown CORS on `platform.deepseek.com/auth-api/*` (c, unmeasured); and even with a token, the PWA must *send the token or id* to the gateway, which can't verify a client-claimed id unless it sees the token → collapses into (ii). | Gateway calls `auth_init`/`auth_exchange` itself with its own verifier and a fresh throwaway device_id, then `users/current` once, compares id, calls `users/logout`, discards token. Blocker: redirect_uri must be loopback (`:311-325`) and is likely allow-listed server-side (c); phone browser redirect to `127.0.0.1` lands on the phone, not the gateway → needs a manual "paste the redirect URL/code" step, or the owner opening the authorize URL on the Host machine (defeats the purpose). | DSH has no OTP API; would mean gateway driving DeepSeek's web login (email+code) endpoints — undocumented, captcha-protected (c), ToS risk. |
| Secret crossing | token only (DeepSeek→PWA) | auth code (phone browser→gateway via paste), token (DeepSeek→gateway, RAM only) | email + code through gateway |
| Identity compare | — | stable `profile.value.id` HMAC vs Host's HMAC (same as today); never email | email/phone = PII, unstable |
| Abuse | — | code is single-use, PKCE-bound, ~`expires_in`; gateway rate-limit attempts per device; gateway-held verifier so stolen code is useless to others | brute force of codes, SMS cost |
| Risk | private undocumented API either way | uses DSH's **private** `/auth-api/v0/dsh/*` contract as a 3rd-party client; can break on any DeepSeek change; creates extra sessions on the account (mitigated by immediate logout) | highest |

## 4. Recommendation
B is only feasible as **(ii) with manual code relay**, and it depends on unmeasured server behaviour (redirect_uri allow-list, whether DeepSeek accepts a non-DSH caller). Before any code: owner/lead should accept the private-API risk, and beastcore should measure (with owner consent, a test account) whether `auth_init` accepts `redirect_uri=http://127.0.0.1:<port>/oauth/callback` from the gateway and whether the authorize page shows the code in the final URL. Until then keep the current Host-fingerprint + pairing lock.

Wire sketch (reuse existing `web:unlock` scope semantics; new frames, never-default):
- `web.unlock.begin {}` → `{attemptId, authorizeUrl, expiresAt}` (gateway generates verifier/state, keeps them in RAM, 1 active attempt per device, ≤5 attempts/10 min/device, global ≤20/h).
- `web.unlock.complete {attemptId, callbackUrl}` → gateway parses `code`+`state` (timing-safe state check), exchanges, `users/current`, `users/logout`, drops token; compares `HMAC(secret, id)` to Host fingerprint from `account.getProfile`.
- Results: `{unlocked:true}` | failure codes `attempt-expired`, `state-mismatch`, `exchange-failed`, `account-mismatch`, `host-signed-out`, `host-profile-unavailable`, `rate-limited`, `protocol`.
- Fail-closed: any non-`ready` profile or null id on either side → locked; Host account change (fingerprint change) → re-lock all web devices; gateway persists only `{deviceId, fingerprint, unlockedAt}`; never stores/logs token, code, email, contact or raw id.

## Uncertain
- CORS policy and redirect_uri allow-list of `platform.deepseek.com` (not measured).
- Whether the authorize page accepts non-loopback or shows the code to the user.
- ToS acceptability of reusing the DSH client contract.
