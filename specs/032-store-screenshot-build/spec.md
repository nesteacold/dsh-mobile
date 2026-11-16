# 032 — Store screenshot build

Package: `apps/mobile-companion` only (contract, gateway and `plugins/devices` untouched).
Owner decision 2026-11-15. Scope narrowed to the **iOS simulator only** (owner decision 2026-11-15,
after review): Android screenshots need a separate, owner-approved design. Status: implemented
(review #2 fixes applied; re-review pending).

## Problem

App Store / Play screenshots are captured on a simulator over ssh. The native unlock gate
(`app/_layout.tsx` `attemptUnlock`, `src/platform/biometrics.ts`) calls LocalAuthentication, and on
a headless iOS simulator nobody can answer the Face ID prompt — so every capture showed the lock
screen. The capture run needs a build whose gate opens by itself, **without** weakening the gate of
any shipped build and **without** ever touching a real paired credential.

## The flag

`DSH_SCREENSHOT_MODE=1`, read at **build time** by `app.config.ts` and written into
`expo.extra.screenshotMode`. It is baked into the bundle. It is never a runtime toggle: no setting,
storage value, deep link, notification, or server frame can change it, and the app reads it once
per process through `src/platform/screenshot-mode.ts`.

## The three conditions

Mode is on only when **all** hold (`src/core/screenshot-mode.ts` `decideScreenshotMode`):

1. the flag is baked in (`extra.screenshotMode === true`, exactly — anything else is "off");
2. the platform is **exactly `ios`** **and** the app runs on an **iOS simulator**, decided by a
   **compile-time** fact: the native `pinned-ws` module's `Constants` (`#if
   targetEnvironment(simulator)` → `true`, `#else` → `false`; Android's module always answers
   `false`). It is read through `src/platform/screenshot-mode.ts` and passed as `isSimulator`; only
   exactly `true` enables the mode, so a physical phone, a "Designed for iPad" binary running on a
   Mac, or an unknown fact (module absent, `constants()` missing, a throwing call, a non-boolean
   value) keeps the normal gate;
3. the build profile is **not** production/store (`production`, `prod*`, `release`, `release-apk`,
   `store`, `app-store`…); a missing profile counts as `development`.

Review #1 defect fixed: an earlier version read `expo-device` `Device.isDevice === false` and
passed it as a field **named** `isDevice` into a decision comparing `isDevice !== false`, so a
physical phone unlocked the demo gate and a simulator kept it. There is no "is a device" input any
more.

**Android is always `normal`** (`reason: 'android'`), whatever the flag or the build looks like:
there is no emulator detection in this build (an Android emulator and a Play machine look the same
to JS), and an emulator heuristic is exactly the class of trick this mode must not rely on.
Android store screenshots need a separate, owner-approved design.

Web is always `normal` (no native gate to skip). If any condition fails the A020 gate runs
unchanged — same `unlockCapability()` / `authenticate()` calls, same copy.

## Demo-data-only rule

In `unlocked-demo` the gate skips **only** the biometric prompt. The controller is built in demo
mode (`AppController` `screenshotMode` option), which:

- refuses to **pair** anything that is not a loopback pairing (`isLoopbackPairingEndpoint`: every
  endpoint `wss://127.0.0.1` / `localhost` / `::1`, no credentials, no query); refusal happens
  before any socket exists;
- refuses to **connect** to any stored host without `demoPairing` + loopback addresses
  (`isDemoPairingHost`, re-verified against the addresses, not just the flag);
- keeps its **own host/credential lifecycle** (`src/platform/demo-store.ts`, in memory, dies with
  the process). In demo mode **no path** — pair, connect, reconnect, revoke, forget, failed-pair
  cleanup, push registration, upload — reaches `readHosts` / `saveHost` / `forgetHost` /
  `readToken` / `saveToken`, **nor the secure-store install id** (`getInstallId`): the demo
  controller uses a per-controller in-memory install id, so the demo makes zero secure-store calls
  (amendment 2026-11-16: an unsigned simulator Release build cannot use the Keychain, and the
  install-id read made demo `pair()` fail as `client/bad-message` before any socket);
  `start()` reads the demo store's list, `pair()` writes it, and
  `deleteCredentialInstance` (the one transaction a revoke or a forget uses) calls
  `DemoStore.forgetHost`. The device's real credential and host list are neither read nor written
  nor deleted. (Review #1 defect: the demo revoke/forget still reached `forgetHost()`, which reads
  the keychain entry back and deletes it.) The credential itself is the token the loopback fake
  gateway (`e2e/harness/gateway.mjs`) minted for the simulator in its `paired` frame, held in memory
  and dropped on lock/stop;
- dials only `wss://127.0.0.1:<port>` **through the native pinned transport**
  (`src/platform/pinned-transport.demo.ts` → `PinnedTransport` → `modules/pinned-ws`), so the real
  leaf-pin check runs inside the TLS handshake and before the upgrade (and its credential headers)
  leaves the device. It refuses anything but the exact `wss://127.0.0.1:<port>` spelling and a
  pairing with no pin, before any I/O. (Review #1 defect: the pin was compared with a local
  `demo-pair.txt` and then an **unpinned** `WebSocket` was dialled — that file and that socket are
  gone.)

The demo dial itself needs **no trust exception**, and none exists (review #2 removed the one that
did): an earlier revision passed a `loopbackAllowance` option so the native delegate answered a
non-server-trust challenge with `.defaultHandling` on the simulator. That option is gone from the
demo factory, from `PinnedTransport` (`CreatePinnedTransportOptions` no longer has the key) and from
both native modules. On iOS the challenge handler is back to its shipped shape: a
`NSURLAuthenticationMethodServerTrust` whose leaf equals the pin and whose validity window covers
now gets `.useCredential`, and every other method gets `.cancelAuthenticationChallenge` — there is no
option, build or target that can make it defer to the platform policy. The demo socket therefore
runs the shipped pin-only handshake byte for byte; if the OS policy refuses a self-signed loopback
leaf on a capture Mac, the socket is refused, and that is the honest outcome.

The simulator fact is read as a **property** of the native module (`Constants { simulator }` is
decorated onto the module object, so JS reads `module.simulator`; there is no `constants()`
function — `expo-modules-core/ios/Core/Objects/ObjectDefinition.swift:111-118`), only exactly `true`
counts, and `app/_layout.tsx` hands the resulting fact to the demo transport factory explicitly.
It is recorded only; it is not a trust switch.

## Release guard

- `mac/ios-build.sh` `validate_args` refuses `DSH_SCREENSHOT_MODE=1` with `--profile=production`
  (exit 2, before the lock/volume/transfer).
- `scripts/remote-ios-build/Invoke-RemoteIosBuild.ps1` refuses the same combination before any
  ssh call.
- `app.config.ts` resolves `screenshotMode: false` whenever the profile is production/store or
  `ENVIRONMENT=production`, even if the flag leaks (safe-off), and throws when the flag is set with
  no profile label at all (fail-closed).
- There is no Android release gradle path in this repo (`android/` is generated by prebuild); the
  Android store build is the `release-apk` EAS profile, which the profile rule and `app.config.ts`
  refuse.
- `test/screenshot-mode.test.ts` asserts: the production config resolves `screenshotMode: false`
  **even with the env var leaking**, both release scripts carry the guard, and the profile list in
  `app.config.ts` matches the core's.

## Acceptance

- Unit (`test/screenshot-mode.test.ts`, the pure decision): flag off → normal; flag on + physical
  phone (`isSimulator: false`) → normal; flag on + unknown simulator fact (`null`) → normal; flag
  on + iOS simulator + production profile → normal; flag on + iOS simulator + non-production →
  unlocked-demo; **Android → normal for `isSimulator` true/false/null alike**; web → normal.
- Unit (the **platform adapter**, not only the pure function): a native module answering `false`
  (physical phone) → normal; answering `true` (simulator) → unlocked-demo; absent module, a module
  that exposes only `constants()` (the review #2 defect: the constant is a PROPERTY, not a function),
  a missing `simulator` property, a wrong type or a throwing getter → normal (`null`, never `false`);
  the module is not consulted unless the flag is baked in; the iOS module declares the constant
  under `#if targetEnvironment(simulator)` and the Android module answers `false`; `expo-device` and
  the field name `isDevice` are gone from the adapter.
- Unit (no trust relaxation): no app or native layer carries `loopbackAllowance` in code; the iOS
  challenge handler contains no `defaultHandling`/`performDefaultHandling`, uses
  `URLSession.AuthChallengeDisposition` exactly and answers `.cancelAuthenticationChallenge` /
  `.useCredential`; an injected simulator fact changes no dial option.
- **MAT-032-PIN (Mac simulator run, native):** on a simulator build (flag on, non-production
  profile), the demo leaf-pin rejection is verified end-to-end against the fixture gateway serving a
  DIFFERENT leaf: the socket must fail with `client/pin-mismatch`, the fixture's `GET /state` must
  show zero upgrades, zero pairing codes, zero frames. The Node rule below is NOT that evidence —
  the native delegate is Swift, compiled out of every non-simulator build.
- Unit (`test/screenshot-mode.test.ts`, Node rule of the pinned transport): a different TLS leaf
  served on the approved loopback endpoint is refused as `client/pin-mismatch` and the server
  receives zero upgrade attempts, zero credentials and zero frames (bounded by 2 s timeouts).
- Unit (`test/screenshot-demo-store.test.ts`, executable, in-process fixture over real TLS): with a
  REAL pairing's token + host list already on the device, a demo **start + pair + connect +
  reconnect**, a demo **revoke (4401)**, a demo **forget()** and a **failed pair** each leave the
  keychain counters at zero reads, zero writes and zero deletes (the install id is in memory in
  demo mode); a further case where the secure store throws on every call still pairs, connects and
  reconnects; outside demo mode, a secure-store failure while reading the install id during pair
  surfaces as `client/store-unavailable`, not a generic failure; and the real token
  and host list are byte-identical afterwards.
- Unit (`test/screenshot-mode.test.ts`, source guards for the remaining paths): every real store
  call (`readHosts`/`saveHost`/`forgetHost`/`readToken`/`saveToken`) is behind the demo store being
  absent; `deleteCredentialInstance` has one branch for the demo store and one for the real wipe;
  demo mode refuses a non-loopback pairing before any socket.
- Unit: the demo transport refuses anything but `wss://127.0.0.1:<port>` and a pairing with no pin
  before any dial; it forwards the pairing's pin and exactly the three shipped options to the native
  transport (options forwarding only — no TLS claim).
- Unit: a loopback pairing is a demo pairing, a Tailscale/other-host pairing is not, and demo mode
  refuses to pair a non-loopback payload.
- Unit: release guard (both scripts) + production config resolution with the env var present.
- Gates: `npm run typecheck`, `npm run check:core`, `node e2e/check-flows.mjs`, the unit suite, and
  the repo PII scan stay green. The capture run itself is dispatched by the lead on the Mac.
- Docs: `docs/remote-ios-build.md` §4.9a (iOS simulator only; no `demo-pair.txt` step).
