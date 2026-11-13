# Web (PWA) target — build, hosting and CSP notes

Spec: `specs/020-pwa-web-target/spec.md`. This note records what the **build** produces and what
the **host serving the PWA** must add, because two things cannot be expressed by the app itself.

## Build

```
npm run build:web      # expo export --platform web, then scripts/build-web.mjs
```

Output goes to `dist/`. `public/` is copied verbatim by the export; the build script then:

- injects into `dist/index.html` (idempotently — running it twice leaves exactly one of each tag):
  - `Content-Security-Policy` (meta)
  - `<link rel="manifest" href="/manifest.json">`
  - `<link rel="icon" type="image/svg+xml" href="/icon.svg">` and an `apple-touch-icon`
    (an explicit icon stops the browser falling back to `/favicon.ico`, which this export does not
    contain — that fallback produced a console 404 on every load)
  - `<meta name="theme-color">`
  - `<script src="/register-sw.js" defer></script>` (external, so `script-src 'self'` needs no
    `'unsafe-inline'`)
- writes `dist/precache.json` — the list the service worker pre-caches at install. The bundle names
  are content-hashed, so only the build knows them.

## Port: CONFIGURABLE — nothing is hardcoded

The Host address **and port come from the pairing QR / URL**; no app code, build step or CSP
hardcodes 443, 8443 or any other number. The CSP admits any port on the tailnet on purpose:
`connect-src 'self' wss://*.ts.net:*` (a port-less source expression would **not** match
`wss://host.example.ts.net:8443`, so `:*` is required), and the transport's Tailscale check compares
`URL.hostname`, which never contains a port — so `:8443`, `:18443` or anything else passes.
`manifest.json` uses relative `start_url`/`scope` (`/`), correct on any port and host.

### Same-origin gateway address (owner decision 2026-11-13)

The supported web deployment is **one tailnet-only HTTPS origin serving both the PWA and the
gateway**, with `tailscale serve` splitting the paths:

| Path | Target |
|---|---|
| `/` | the built PWA (`node scripts/serve-web.mjs --port 18480`) |
| `/ws/mobile` | the gateway TLS listener (`https+insecure://<this host's tailnet ip>:30081`) |

That is why the PWA does **not** use the address inside the pairing QR. The QR names the gateway's
own listener, which is self-signed on purpose (the native app pins its leaf); a browser refuses it
before a single frame moves and cannot pin anything. Instead `src/core/gateway-address.ts` derives
the page's OWN origin — `wss://<location.host>/ws/mobile` — whenever the page is served over HTTPS
from a `*.ts.net` name, and `pair()` connects there (`ControllerOptions.webLocation` supplies the
location; native answers `null`, so a phone keeps dialling the pinned listener untouched).

The socket's CSP admission comes from `wss://*.ts.net:*`: `*.ts.net` matches the page's own tailnet
hostname as a host-part suffix and `*` matches any port, and the derivation produces nothing but
`<name>.ts.net:<port>`. `'self'` remains in `connect-src` as a second allowance, but the same-origin
case does not depend on CSP3's `'self'` scheme-upgrade rule being implemented. No source expression
hardcodes the machine name, and `wss://*` is deliberately not used.

Two things the deployment must therefore get right, neither of which the app can enforce:

- **`allowedOrigins` must contain the exact page origin**, e.g.
  `https://<tailnet-host>:30443` — scheme, host and port as the browser writes them. The list is
  both the WS upgrade fence and the WebAuthn site (spec 021), so a missing entry is a 403 at the
  upgrade: the PWA cannot pair at all, and no passkey can exist.
- **Route only `/ws/mobile` to the gateway.** The gateway refuses every `/mgw/*` request that
  carries proxy headers, whatever the peer address is, so a mistaken `/mgw` route is inert rather
  than an exposed management surface — but there is no reason to route it.


Measured facts about this machine (2026-11-11):

| Port | State |
|---|---|
| **443** | taken — belongs to another tailnet service (Tàng Thư Các), per the owner's decision |
| **8443** | **held by `tailscaled.exe`** (a `/subproc` child with a definite listen socket). Do not assume it is free |
| **18443** | free; used for the offline verification recorded below |

## Hosting requirements the app cannot express

1. **CSP `frame-ancestors` must be an HTTP response header.** A `frame-ancestors` directive inside a
   `<meta http-equiv="Content-Security-Policy">` is **ignored by browsers** — Chrome logs
   `The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta>
   element` (measured in this build). The meta CSP injected into `index.html` therefore lists the
   other directives only; the host serving the PWA (nginx/Caddy on the tailnet) MUST send:
   `Content-Security-Policy: frame-ancestors 'none'` (plus the same policy as a header if it wants
   header-level enforcement). While this is missing, clickjacking protection relies on nothing.
2. **HSTS / TLS**: the PWA must be served over HTTPS with the Tailscale certificate so the service
   worker can register (`isSecureContext`).
3. **Content types**: `manifest.json` as `application/manifest+json` (or `application/json`),
   `sw.js` as `text/javascript`, `precache.json` as `application/json`, all same-origin, so `/sw.js`
   keeps scope `/`.

## Running it locally (for review, not for production)

Serve the **built** directory, never the source tree: the service worker and the injected CSP only
exist in `dist/`, and `register-sw.js` requires a secure context (`localhost`/`127.0.0.1` counts as
secure, a LAN IP does not).

```
npm run build:web            # export + inject tags + write precache.json
npx serve dist -l 18443      # pick a FREE port (see the table), then open http://127.0.0.1:18443
```

`npx serve` is only an example: any static server works. Two caveats:

- **Pick a free port.** 443 is another service and 8443 is held by `tailscaled` on this machine;
  testing on a port something else owns says nothing about the PWA.
- **The Host must be reachable over `wss://<machinename>.<tailnetname>.ts.net:<port>`.** The web transport refuses any
  other host (it delegates trust to the browser CA store instead of pinning), so a plain `http://`
  or `ws://` dev gateway cannot be used from the web build. Native builds are unaffected.

To check the SW/manifest by hand: DevTools → *Application → Service Workers* (should show `/sw.js`
**activated and running**) and *Application → Manifest* (name and icons, no installability errors).

## PWA acceptance checklist

Each line is observable, not a claim. Rows marked **measured** were actually run on 2026-11-11
against a build served on port 18443 in a fresh Chrome profile (raw CDP, not a screenshot alone).

| # | Check | How to verify |
|---|---|---|
| 1 | Build succeeds | `npm run build:web` prints `injected 4/4 PWA tags` and `wrote precache.json (N entries)` |
| 2 | Manifest is installable | DevTools → Manifest: name, icons, `start_url`, `display: standalone`; no errors. **Measured**: `GET /manifest.json` → 200, `application/json`, 644 B, correct body |
| 3 | Service worker is active | DevTools → Service Workers: `/sw.js` activated; `navigator.serviceWorker.controller` non-null. **Measured**: registration scope `/`, state `activated` |
| 4 | The shell is precached on the FIRST visit | `caches.open('dsh-shell-v4')` contains the HTML shell, the hashed bundles and the icons. **Measured**: 19 entries including `/`, from a single first visit — do not rely on a second load to fill it |
| 5 | Offline shows the shell | Stop the server (verify with a raw TCP connect, not a guess), then reload: the shell renders and the main document response reports `fromServiceWorker: true`. **Measured**: TCP refused, `{"status":200,"fromServiceWorker":true}`, no network failures, full unlock screen rendered |
| 6 | Non-shell traffic is never cached | DevTools → Application → Cache Storage: only shell/hashed assets; no `/api`, `/pair`, `/auth` entries |
| 7 | The gate stays LOCKED before pairing | Fresh profile: the unlock screen appears and no credential is read |
| 8 | The gate shows the WEB copy | The passkey sentence ("This browser cannot use a passkey…"), never the phone instruction "Set up a screen lock". **Measured** in the screenshot before spec 021 (which showed the older account sentence) |
| 9 | No console 404 for the icon | The page declares `/icon.svg` and does not request `/favicon.ico` |
| 10 | The gate does not loop | Without WebAuthn the gate shows its single message; retrying shows the same message, never a repeating "Could not verify you" |

## Web unlock (spec 021: a passkey, not an account)

The browser has no biometric, so the PWA proves possession of a **WebAuthn passkey bound to its paired
device**. The Host is the only judge: it sends a fresh 32-byte challenge, and on `passkey-assert` it
checks the type, the challenge, the exact origin, `rpIdHash`, the UP and UV flags, the signature and
the sign counter (contract §14.1). A success unlocks THAT socket. See `src/core/web-lock.ts` (the
policy and the frame codec) and `src/platform/passkey.web.ts` (the browser calls).

- **Every new connection starts LOCKED.** While locked the Host answers only hello, ping,
  `device-forget` and the four `passkey-*` frames, so the app resyncs nothing and shows the lock
  screen instead of an empty session list. A tab reload always needs a new assertion.
- **Re-registration needs the owner.** A device with no passkey registers right after pairing; a
  device that already has one is refused `passkey/already-registered` until the owner approves the
  replacement on the Host, which arrives as a `passkey-approval` push carrying the 8-character code.
- **Refusals are distinguished, never collapsed:** `passkey/not-registered`, `already-registered`,
  `challenge-expired`, `verification-failed`, `rate-limited` and `auth/locked` (`reason`:
  `locked` | `unregistered` | `rate-limited`) each have their own sentence in both locales.
- **The user never sees the Host's raw `message`** (it is a fixed internal string while locked); the
  copy is chosen from the code/reason alone.
- **"Lock now"** (Settings, web only) sends `passkey-lock` and closes the socket, so the next frame
  or reload needs the passkey again.
- **Close code 4412 = "re-lock"**: the credential is KEPT (unlike 4401, which is a revocation and
  wipes it), and the socket reconnects into the lock screen.
- **Native (iOS/Android) is unaffected**: a native device never carries `web:unlock`, never receives
  `hello.webLock` and is never locked.

**The browser profile is the security boundary, as before.** The passkey itself never leaves the
authenticator, and the PWA stores no copy of it; what protects the credential is the passkey's own user
verification plus the Host's origin/rpId checks. Re-pairing the same installation clears the old
passkey record with the old pairing (contract §14.6), so a wrong or stale registration is fixed by
pairing again — never by clearing site data.

## Trust model (web only)

The browser cannot pin a leaf certificate, so the web transport relies on the **browser CA store**
for the Host's `*.ts.net` certificate instead of the native pin. This is weaker than the native
transport (publicly-trusted CA vs. exact leaf) and is an accepted owner trade-off, mitigated by the
tailnet-only reachability. See the header comment of `src/platform/pinned-transport.web.ts`.

## Service worker scope

`public/sw.js` caches the **app shell only** — the HTML shell, the content-hashed bundles, the icons
and the manifest. It:

- pre-caches that list at install (from `/precache.json`), because a first visit is not yet
  controlled and would otherwise leave the cache empty;
- never caches API/RPC/pairing/auth/push paths, nor non-hashed `/assets/` files;
- never reads or writes credential storage (its only storage is the Cache API);
- answers navigations network-first with the cached shell as the offline fallback, and never fakes a
  connected app.

Bump `CACHE` in `sw.js` whenever the strategy changes; `activate` deletes every other cache.
