# DSH Orbit — Privacy Policy

> **DRAFT 2 (2026-11-14) — pending public hosting and final reviewer approval; not published.** Every
> factual claim below is checked against this repository's source; the *How this was verified* table at
> the end names the file for each one. The in-app Privacy screen (`app/privacy.tsx`) carries a shorter
> version of the same statements and shows the policy version and contact itself (`privacy.p10`).

**Effective date:** not yet set (to be set on the submission build) · **Version:** DRAFT 2 · **Applies
to:** DSH Orbit, iOS and Android (`com.dshext.companion`), and the web/PWA build of the same product
when it is served from a host's Tailscale address.

**Contact:** developer@sunjin.vn

---

## 1. What this app is

DSH Orbit is a controller for **your own** DeepSeek Harness (DSH) computer ("Host"). The Host does the
work: it runs the agent, the model calls, the tools and everything that touches your files and
network. The app pairs with that Host, lists its sessions, shows their history and lets you answer
approval prompts. The app never runs Host code, Node, a terminal (PTY) or your agent's tools on the
phone; it only displays results the Host sends and sends your decisions back.

You do not create an account with us. There is no sign-in to a service of ours, and the app never
sends anything to a server run by the developer.

## 2. How the phone reaches your Host — native app

- The app dials the address in the pairing code you scanned or pasted, and only accepts `wss://`.
- The TLS certificate is **pinned to the Host**: the app accepts the connection only when the SHA-256
  of the host's leaf certificate equals the value in the pairing code. There is no fallback to a
  public certificate authority, no hostname identity check, no user-installed CA, no "allow invalid"
  switch and no cleartext. A mismatch aborts the handshake **before** the pairing code, the device id
  or the access credential is sent.
- On Android the app's network security config trusts **no** CA at all and switches cleartext off;
  on iOS it does not permit arbitrary loads.

## 3. How the web/PWA build reaches your Host — weaker, by design

A browser cannot inspect a TLS certificate before it establishes the connection, so the web build
**does not pin** anything:

- The transport accepts only a `wss://` URL whose hostname ends in `.ts.net` (a Tailscale name);
  anything else is refused before a socket exists.
- The server certificate is then validated by the **browser's own TLS validation** against its
  certificate-authority store — not by the pinned leaf, and not by this app.
- The `certSha256` value from the pairing code is **ignored** on web. If you pair a web build with the
  same code you would scan on the phone, the pin does not apply there.
- Browsers cannot set request headers on a WebSocket, so on web the install-scoped device id travels
  as a `dsh-device.<id>` subprotocol instead of the `X-DSH-Device-ID` header, and the access
  credential travels as a `dsh-auth.<token>` subprotocol. A browser may log those handshake values in
  its own network tooling; treat a paired browser profile as a credential holder.

If you need the pin, use the iOS or Android app. The web build is for the Host's own Tailscale origin.

## 4. Data the app sends, and where it goes

| Data | Destination | When |
|---|---|---|
| Pairing proof and the one-time pairing code | The paired Host only, over TLS (web: to its tailnet origin) | During pairing |
| A random, install-scoped device id (a UUID) | Your Host: as `X-DSH-Device-ID` on native, as the `dsh-device.<id>` subprotocol on web | Every connection, so the Host can reuse its trusted-device record |
| The per-device access credential the Host issued | Stored on the phone (or browser); replayed to the paired Host | Every connection |
| Session content — titles, message history, prompts you send, approval decisions | Your Host, over the TLS connection | When you use the app |
| The certificate fingerprint from the pairing code | Used locally only, and only on native; never transmitted | Native connections |

Session content and the pairing/access credentials therefore go only to **the Host you paired**. The
one optional extra path is web notifications: if you switch them on, your Host sends the encrypted
message described in section 6 to your browser's push service. The app contains no analytics, no
crash-reporting SDK, no advertising SDK and no tracking library.

## 5. What is stored, and how well it is protected

**iOS and Android (native):**

| Item | Where | Removing it |
|---|---|---|
| The access credential (per paired Host) | The platform's encrypted store — Android Keystore-backed, iOS Keychain. On iOS it is stored with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (readable only while the device is unlocked, never migrated to another device) | *Forget this computer* in the app, or revoke the device on the Host |
| The install-scoped device id | The same encrypted store | Stays on this device until the app's stored entry is deleted — see the uninstall rule below (dropping it only makes the Host record a new device) |
| The list of paired Hosts (name, address, certificate fingerprint) — no credential in it | The same encrypted store | *Forget this computer* |
| The optional debug log (bounded, redacted; only builds compiled with the debug flag write it) | The app's private document directory | Settings → Storage |
| Files the Storage screen lists | The app's private document directory | Settings → Storage |

- The app does **not** create biometric-bound store entries on Android: the store options it uses
  carry no Android `requireAuthentication`, so reading the credential is not itself gated by the
  Keystore. The unlock step is the app's own gate — the app asks for biometrics or the device
  passcode and only reads the credential after that succeeds. Anyone who can operate this device's
  unlocked store can read what it holds; the protection is the device lock plus the app's gate, not
  a per-read biometric prompt.
- **Uninstall:** on Android, uninstalling removes the app's Keystore-backed store, so the credential
  and the device id go with it. On iOS, the Keychain entry **may survive an uninstall**; use *Forget
  this computer* first (it removes the Host record and then tries to delete the credential under the
  same key), or revoke the device on the Host, which withdraws the authorization so the leftover entry
  can no longer be used.
- The app asks for the camera (pairing QR), biometrics/device passcode (unlock) and notifications
  permissions only. It has no photo library, contacts or general files permission.

**Web/PWA:**

| Item | Where | Removing it |
|---|---|---|
| The access credential, as AES-GCM ciphertext | Browser IndexedDB. The wrapping AES-256 key is **non-extractable** (page script cannot export it), but it sits in **the same IndexedDB** as the ciphertext | *Forget this computer* asks the app to remove it locally (best effort); clearing site data is the guaranteed removal |
| The list of paired Hosts, as plaintext JSON | The same IndexedDB | *Forget this computer* (best effort), or clearing site data |
| The install-scoped device id | `localStorage` | Clearing site data |
| The optional debug log / listed files | — (the storage screen lists app files; on web there are none to read) | — |

The web store is **weaker than Keychain/Keystore by design**: it is not hardware-backed, not isolated
per app and not tied to device unlock. Anyone who can read the browser profile (or run script in that
origin) can decrypt the stored credential; the browser profile is the security boundary. Uninstalling
a PWA does **not** guarantee that the browser deleted its site data, so after a web build you should
*Forget this computer* in the app **and** clear the site's data in the browser.

Web unlock, when the Host grants it, is not a phone biometric prompt: the Host sends a challenge that
the browser answers with the passkey registered for that pairing.

## 6. Notifications

**Native (iOS/Android): local only.** The app raises a notification on the phone when the live
connection reports an approval request. The text is a short fixed line, the tool name (a fixed word
from the tool vocabulary, not your content), and identifiers — session, approval, request ids — plus
the deep link the tap opens. It never carries the approval arguments, tool inputs, message bodies or
the access credential. The app never registers a remote push token with Apple (APNs) or Google (FCM);
there is no push service of ours. Because the app closes its authenticated socket when it goes to the
background, a notification can only be raised while the app is running.

**Web (PWA): optional, and it does leave the browser.** If you switch notifications on in Settings,
the browser creates a push subscription and the app hands your Host its **endpoint** (a URL at a
push-service origin — a push service run by Google, Apple, Mozilla, Microsoft or your browser's own
vendor) and the subscription's two keys. Your Host then sends to that push service an **encrypted**
message whose entire plaintext content is `{ v, kind, sessionId, requestId? }` — a version number, an
event kind (`approval`, `question`, `session-finished`), a session id, and for the two interactive
kinds a request id. The fixed notification text (English or Vietnamese, from the browser language) is
written by the app's service worker on the device, not carried in the message.

The push service (Google, Apple, Mozilla, Microsoft or your browser vendor) therefore sees delivery
metadata about that message: your Host's push identity, the endpoint and the time of delivery, plus
whatever metadata the provider itself records. It does not receive the message content in readable
form (the payload is encrypted with the subscription keys), and it does not receive session titles,
prompts or approval arguments at all.

**Turning notifications off** is two attempts: the app asks your Host to forget this subscription (a
Host-side unsubscribe), and the app then tries to drop the browser's own subscription. Either step can
fail.

***Forget this computer*** removes the pairing locally, which is best effort. **Revoking the device on
the Host** stops **future** sends: it withdraws the authorization and removes the Host's stored
subscription, so from then on the Host produces no further notifications for this device. Delivery
that a push service already accepted or queued before that can still reach the browser, and a push
service may keep records of prior deliveries under its own policy.

## 7. Build and distribution

This text covers the app's runtime, not how the app is built or delivered. Building and shipping the
app uses Expo's cloud build tooling (EAS) and Apple's App Store or Google Play; if a store build is
made, those providers see the build artifact and generate their own store/crash diagnostics, under
**their** policies, and what the developer receives from those consoles depends on the provider.

## 8. Your controls

- **Revoke the device on the Host** ends it on the Host: the authorization is withdrawn and the
  Host-side subscription dropped, so no further sends are produced from then on. The app wipes the
  credential it holds (and verifies the wipe).
- ***Forget this computer*** in the app: removes the paired-Host record and then tries to delete the
  credential for the same key — including a credential retained through an earlier iOS reinstall. If
  the delete cannot be completed, the app reports the cleanup failure and does not claim the wipe
  succeeded. It does not unpair anything on the Host.
- **Turn off web notifications**: the app asks the Host to forget the subscription, then attempts to
  drop the browser subscription (see section 6).
- **Clear the browser's site data** after *Forget* on the web build, since uninstall alone does not.
- **Delete the debug log and listed files** in Settings → Storage; this does not unpair.
- **Uninstall:** on Android the encrypted store and private files go with it; on iOS the Keychain
  entry may outlive the uninstall — see section 5.

## 9. Children

The app is a controller for a developer tool and is not directed at children. The developer does not
knowingly collect personal information from anyone through it, children included; the app has no
"collect" path to begin with — it talks to your own Host.

## 10. Security

Credentials live in the platform's encrypted store (native) or the encrypted IndexedDB store
described in section 5 (web); they are never written to a log or to a notification. On native the
connection pins the host certificate; on web the transport accepts only `wss://` to a `.ts.net`
hostname and the certificate is validated by the browser (section 3). Approval decisions are bound to
the exact request shown: one decision applies at most once, and a request that changed after it was
rendered is refused.

## 11. Changes to this policy

When a feature changes any of the above, this text and the in-app Privacy screen change in the same
release, with a new version line and date.

## 12. Contact

**developer@sunjin.vn**

---

## How this was verified (internal — strip before publishing)

| Claim | Evidence |
|---|---|
| Native pins the leaf, no CA fallback, no cleartext; nothing sent on mismatch | `modules/pinned-ws/` (leaf SHA-256 pin, `client/pin-mismatch`), `plugins/withPinnedWsConfig.js` (empty Android `<trust-anchors>`, ATS assertion), `src/platform/pinned-transport.ts:1-20` |
| Web: `wss://` only, hostname must end `.ts.net`, no pinning, `certSha256` ignored, device id/credential as subprotocols, browser TLS validation | `src/platform/pinned-transport.web.ts:85-98,124-156` (`isTailnetUrl`, `wss:` check, `certSha256` intentionally unused), `src/core/gateway-address.ts:39-48`, `src/core/client.ts:680-700` |
| Native store = platform encrypted store; iOS `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; no Android `requireAuthentication`, app gates unlock | `src/platform/secure-store.ts:12-15` (option + the comment saying `requireAuthentication` would double-prompt), `src/platform/install-id.ts:10-13`, `src/platform/biometrics.ts:1-4` |
| Web store = IndexedDB, non-extractable AES-GCM key in the same DB, hosts JSON, device id in `localStorage` | `src/platform/secure-store.web.ts:1-30`, `src/platform/install-id.web.ts:1-20` |
| Web unlock is a passkey challenge, not phone biometrics | `src/platform/biometrics.web.ts:1-12` |
| Web push: only endpoint + 2 keys leave the page; payload `{v,kind,sessionId,requestId?}`; fixed text on device | `src/core/web-push.ts:24-31`, `src/platform/web-push.web.ts:1-3`, `plugins/mobile-gateway/lib/web-push/service.mjs:25-50`, `public/sw.js` (push section) |
| Native notification = fixed line + tool name + ids + deep link | `src/platform/notifications.ts:52-76`; no APNs/FCM registration in `src/` |
| No analytics/crash/ad SDK | `apps/mobile-companion/package.json` dependency list |
| Debug log opt-in, bounded, redacted | `src/platform/debug-log-file.ts:93-102`, `src/core/debug-log.ts` |
| Import check: `src/core` imports no react-native/expo/node | gate `npm run check:core` (passes) |
