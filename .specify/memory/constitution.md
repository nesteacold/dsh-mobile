# dsh-ext — Constitution

Version 1.3.0 | Ratified 2026-11-08 | Amended 2026-11-11 (v1.3.0: A1.1 extended to one attachment-upload route for remote sessions, spec 013) and 2026-11-09 (v1.1.1: safe-approval terminology/refusal receipts aligned with the mobile wire contract. v1.2.0: added A1.1, the owner-approved controlled instance-wrapper exception for plugins/devices native remote UI; A1 itself unchanged) | Owner: the repository owner

Part A applies to every plugin, app and package in this repo. Part B adds rules for the mobile
companion product (`plugins/mobile-gateway`, `apps/mobile-companion`, `packages/mobile-protocol`). A new
product adds its own Part with owner approval; it may tighten Part A, never relax it.

## Part A — Repo-wide principles

### A1. Extend, never fork DSH core (NON-NEGOTIABLE)
DSH upstream is not vendored. Every Host-side change is a Cordis plugin that registers its own
services/routes and touches only its own composition rows. Each plugin declares `engines.dsh`
(currently `0.2.2-rc.1`). No monkey-patching, no editing DSH files, no overriding other plugins' config.

#### A1.1 Controlled instance-wrapper exception (owner approved 2026-11-09)
The only permitted exception, granted for `plugins/devices` (spec 008) to render a remote Host's
session in the NATIVE DSH UI, which rc.1 offers no public API for:
- a plugin may wrap **instance methods of a live service object** it obtained from the Host
  (`typertGateway.dispatchRpc`, `typertGateway.openWireStream`) — never a prototype, never a module
  export, never a DSH file on disk;
- only while its self-test matches the pinned `engines.dsh`; on mismatch it must not wrap and must
  surface the reason in its UI;
- it must restore the exact original methods on dispose, and must not wrap a method it did not install;
- the wrapper must not weaken any authorization: the gateway remains the sole authority for what a
  remote device may do;
- each DSH version bump requires a reviewer pass on the wrapper before it is enabled;
- the plugin README lists the wrapped methods, the pinned version and the failure mode.

Amendment v1.3.0 (owner approved 2026-11-11, spec 013): one further interception is permitted for
`plugins/devices`, because the native composer uploads attachment bytes over HTTP outside
`dispatchRpc`:
- exactly the local route `POST /api/session/uploadFileBinary`, and only when its `sessionId` is
  host-tagged (`h:<host>:<id>`); every other request reaches the original handler byte-for-byte
  unchanged;
- the bytes are forwarded over the existing pinned link and the remote gateway alone decides
  (scope `attachments:write`, size, content type, session visibility); the local Host stores nothing;
- all A1.1 conditions above apply unchanged (live instance only, self-test against the pinned
  version, exact restore on dispose, README entry, reviewer pass).
Nothing else in A1 is relaxed. Still forbidden: editing DSH files, patching prototypes, overriding
other plugins' config.

### A2. Host executes, clients control
All agent execution (LLM calls, tools, filesystem, PTY, sandbox, computer-use) runs on the DSH Host.
Anything in `apps/` is a controller/viewer and never embeds Node, a JS JIT runtime, DSH native addons,
or PTY.

### A3. Contract-first
A plugin and the apps that talk to it share a versioned contract in `packages/`. Breaking change =
new major version. Capability/version mismatch is surfaced to the user, never fails silently.

### A4. Secure by default
Nothing listens beyond 127.0.0.1 unless the owner enables it. Any remote surface requires TLS,
per-device credentials with isolated revocation, and the narrowest API that does the job. Secrets,
tokens and signing material never enter git, logs, or push payloads.

### A5. Evidence over assertion
Claims about DSH or third-party internals are labelled (a) measured/run, (b) read from source,
(c) inferred. Build/test results are reported with the literal command and output.

### A6. One folder per unit
A plugin/app/package lives entirely in its own folder with its own README, tests and changelog.
Adding one must not require editing others beyond registering it.

## Part B — Mobile companion

### B1. Native render, no WebView shell
`apps/mobile-companion` renders natively (React Native + Expo, TypeScript). Wrapping `apps/web/dist` in
Capacitor/Tauri/WebView is out of scope; browser/PWA is only a temporary fallback.

### B2. Owner switch and pairing
The gateway refuses all companion traffic unless `remoteControl.enabled` is on (default off). Pairing
uses a one-time QR code (TTL <= 5 min) carrying the certificate fingerprint; WSS/HTTPS only, pinned.

### B3. Safe approvals
An approval decision carries the `argsHash` of the exact request shown, as defined by the versioned mobile wire contract. A mismatch is refused without applying the decision or closing the pending approval: the WebSocket reply is a normal receipt `accepted:false, reason:'hash-mismatch'`, not an error frame or HTTP 409. Matching decisions apply at most once; duplicates return `not-pending`. A missing/unavailable hash is desktop-only. Push notification payloads carry ids and short text only.

### B4. Scope
MVP is exactly 4 surfaces: pairing, session list, chat + approve/respond, push. Cloud tasks are out of
MVP. Defaults from Qoder Mobile: artifact <= 100 MiB, history 30 days / 500 items, keep-awake off when
the Host exits. Store policy: minimal permissions, iOS privacy manifest, Play data-safety form.

### B5. Base
The Host layer is a hardened fork of `Clarklevis1995/dsh-plugin-mobile-gateway` v0.12.0 @ `74ac444`
(MIT, attribution kept). Audit findings in `docs/arch-notes/audit-clarklevis-20261108.md` must be fixed
before any device build.

## Workflow
Role split per `CLAUDE.md`: lead designs and owns docs/specs; coder implements per package; beastcore
researches; scout looks up; reviewer reviews independently — mandatory before store uploads and for
auth/pairing/token/push/network-exposure code. Every feature gets `specs/<###-slug>/` before code.

## Governance
This constitution overrides ad-hoc decisions. Amendments require owner approval, a version bump, and a
note in `CLAUDE.md`. Models per role change only on the owner's word.
