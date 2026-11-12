# CLAUDE.md — dsh-mobile context

## Project
- Repo: dsh-mobile (this checkout; the repository root is the directory holding this file). Owner: the repository owner.
  GitHub: `nesteacold/dsh-mobile`. **This repository is canonical** for the mobile product; the
  copies of these folders in `dsh-ext` are retired (owner decision, migration 2026-11-12).
- Purpose: control a DSH Host from your phone — a hardened Host-side gateway, a native RN + Expo
  companion app, the desktop remote plugin, and the versioned contract between them.

## Read first
- `AGENTS.md` — layout, gates per package, role split, hard rules.
- `.claude/agents/<role>.md` — role briefs when present (`coder`, `beastcore`, `scout`, `reviewer`).
- `specs/` — the feature specs (001–020); every feature gets a spec before code.
- `docs/arch-notes/` — architecture notes about the mobile product, the gateway, and the agent
  permission/preset surface. Verify any claim against the code before acting on it.

## Role split (owner decision 2026-11-08; shared with DXVK_Project)
- **lead (architect)**: evaluates, designs, prioritizes; owns `docs/`, `specs/`, `CLAUDE.md`,
  `AGENTS.md`, repo layout. Does not edit plugin/app code.
- **coder**: every code change in `plugins/`, `apps/`, `packages/`, scoped to the package named in the
  task. Smallest correct change, reports literal build/test output.
- **beastcore**: R&D on DSH source and third-party code. Read-only, facts labelled (a)/(b)/(c).
- **scout**: fast read-only lookups.
- **reviewer**: independent review; mandatory before any store upload and for any
  auth/pairing/token/push/network-exposure code.

## Models per role (owner 2026-11-08; change only on the owner's word)

| Role | Provider / model |
|---|---|
| coder | `r9-fallback / ds41-cmc-ccsonnet` |
| beastcore | `r9-commandcode / cc/claude-opus-5-5` |
| scout | `r9-commandcode / cc/claude-haiku-5-5` |
| reviewer | `r9-fallback / sol61-opus55` |

Do not silently substitute a model when a route fails; report the failure and keep the requested route.
Roles run as DSH subagents from the shared bundle `@local/dsh-roles`; project rules come from this
repo's `AGENTS.md` / `CLAUDE.md` and the role briefs.

## Hard rules (verbatim from the dsh-ext charter)
- **Host executes, clients control.** Never run DSH Host code on a phone; never embed Node, a JS JIT
  runtime, DSH native addons, or a PTY in an app.
- **Contract-first.** Plugin/app pairs share a versioned contract in `packages/mobile-protocol`; a
  breaking change is a new major version, and a capability/version mismatch is surfaced to the user,
  never silent.
- **Secure by default.** Nothing listens beyond `127.0.0.1` unless the owner enables it; any remote
  surface needs TLS, per-device credentials with isolated revocation, and the narrowest API that works.
  Secrets, tokens and signing material never enter git, logs, or push payloads.
- **Approval decisions carry contract-defined `argsHash` for the exact request shown;** WS mismatches
  are normal receipts `accepted:false, reason:'hash-mismatch'` and stay pending. Decisions apply at most
  once; duplicates return `not-pending`; unavailable hashes are desktop-only. Push notifications hold
  ids/short text only. Owner-approved alignment 2026-11-09; constitution v1.1.1.
- **Native render only.** `apps/mobile-companion` is React Native + Expo; no WebView/Capacitor wrapping
  of `apps/web/dist`.
- **Never commit, push, publish to stores, or upload builds without explicit owner approval.**
- **Never read, print, or commit credentials, signing keys, APNs/FCM secrets.**
- Do not change model policy or permission mode to work around a failure; report it.
- Preserve working-tree changes; no reset/clean/stash unless asked.
- **Run the PII scan before push.** `node tools/scan-pii.mjs` over the whole tree; the `pre-push` hook
  runs it too. Enable the hooks once per clone: `git config core.hooksPath .githooks`. Also run
  `gitleaks detect --source .` when gitleaks is installed.

## Naming
- npm scope `@dsh-ext/` for every package: `@dsh-ext/mobile-gateway`, `@dsh-ext/mobile-protocol`,
  `@dsh-ext/devices`. Private until the owner decides to publish.
- Specs: `specs/<###>-<slug>/`, numbered across the product; the spec states which package it touches.

## Base-repo decision (owner 2026-11-08)
- Audit `docs/arch-notes/audit-clarklevis-20261108.md`: Clarklevis gateway PASS WITH CONDITIONS.
- **Option A:** fork only the gateway (v0.12.0 @ `74ac444`) into `plugins/mobile-gateway/` and harden it
  (spec `001-gateway-hardening`); build our own app in RN + Expo at `apps/mobile-companion/` (spec `002`).
  The contract between them lives in `packages/mobile-protocol/`. Upstream app is reference only.

## Approved amendments carried over
- 2026-11-09: owner approved constitution v1.1.1 alignment with the normative mobile wire contract:
  approval `argsHash`, normal WS refusal receipt `accepted:false, reason:'hash-mismatch'`, pending
  retained and at-most-once decisions. This replaces obsolete `payloadHash`/HTTP409 wording; no
  relaxation of exact-request binding.
- 2026-11-09: constitution **v1.2.0** adds **A1.1**, the controlled instance-wrapper exception.
  `plugins/devices` may wrap exactly `typertGateway.dispatchRpc` and `typertGateway.openWireStream`
  on the live instance (never a prototype, module export, or DSH file) so a remote Host's session
  renders in the native DSH UI, which rc.1 offers no public API for. Conditions: a self-test against
  the pinned `engines.dsh` (no wrap, and a visible reason, on mismatch); exact restore on dispose;
  never wrap a method it did not install; no weakening of gateway authorization; a reviewer pass on
  the wrapper for every DSH version bump; the plugin README lists the wrapped methods. A1 otherwise
  unchanged.

## Standing rules
- Spec Kit is the work process: every feature gets `specs/<###-slug>/` before code.
- Pin DSH upstream to `dsh-v0.2.2-rc.1` until the owner bumps it. Every plugin declares `engines.dsh`.
- Network installs may hang on this machine; prefer offline copies and report hangs.
- Evidence over assertion: build/test results are reported with the literal command and output;
  claims about DSH internals are labelled (a) measured/run, (b) read from source, (c) inferred.
- Known pre-existing failure owned by another session: `plugins/mobile-gateway/test/allowlist.test.mjs`
  question-answer/question-cancel classification. Report it; do not fix it here.
