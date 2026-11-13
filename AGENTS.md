# AGENTS.md — dsh-mobile

Repo: **dsh-mobile** — the mobile product of DeepSeek Harness (DSH): a Host-side gateway, a native
iOS/Android companion app, the desktop remote plugin, and the versioned contract between them.
GitHub: `nesteacold/dsh-mobile`. **This repository is now canonical.** The copies of these folders in
`dsh-ext` are retired: do not add features there, and port deliberately from here.

Read this file first, then `CLAUDE.md` (standing rules, role split, hard rules).

## Layout

| Path | What lives there | npm package |
|---|---|---|
| `plugins/mobile-gateway/` | The Host-side gateway: TLS listener, pairing, per-device credentials and scopes, the WS protocol, remote bridge | `@dsh-ext/mobile-gateway` |
| `plugins/devices/` | The desktop "Remote" product: control another DSH Host's sessions from this window (runtime id `devices`) | `@dsh-ext/devices` |
| `plugins/sidebar-browser/` | Agent tools for DSH's built-in side-panel Browser tab (moved from dsh-ext 2026-11-13) | `@dsh-ext/sidebar-browser` |
| `apps/mobile-companion/` | The phone client: React Native + Expo (SDK 58), Expo Router, native `pinned-ws` module (Kotlin/Swift), i18n vi/en, a web (PWA) target | private app |
| `packages/mobile-protocol/` | The **versioned contract** shared by gateway and app: wire constants, types, the contract test | `@dsh-ext/mobile-protocol` |
| `bundles/dsh-roles/` | The shared role bundle (coder/beastcore/scout/reviewer presets and lead tools), linked into the DSH profile (moved from dsh-ext 2026-11-13) | `@local/dsh-roles` |
| `specs/<###-slug>/` | Spec Kit features (001–020, the mobile/remote set) | — |
| `docs/arch-notes/` | Architecture notes about the mobile product, the gateway, and the agent permission/preset surface | — |
| `tools/` | Repository gates: `scan-pii.mjs` (PII/secret scan), `verify-publish.mjs` (tree completeness) | — |
| `.githooks/` | Git hooks; `pre-push` runs the PII scan. Enable once: `git config core.hooksPath .githooks` | — |

Upstream reference: Clarklevis1995's gateway, forked at v0.12.0 @ `74ac444` and hardened since
(spec `001-gateway-hardening`); `UPSTREAM.md` and `NOTICE.md` record provenance and licences. DSH
itself is **not** vendored: every plugin declares `engines.dsh`, as a bounded range within the current DSH minor line (tested on 0.2.2-rc.3; see `CLAUDE.md`).

## Gates per package (run the one that covers what you touched)

| Package | Commands |
|---|---|
| `packages/mobile-protocol` | `npm test` (contract test; also checks the gateway's vendored copy is in sync) |
| `plugins/mobile-gateway` | `npm test` · `npm run check:protocol` · `npm run test:package` |
| `plugins/devices` | `npm test` |
| `plugins/sidebar-browser` | `npm test` |
| `apps/mobile-companion` | `npm run typecheck` · `npm run check:core` · `node e2e/check-flows.mjs` · `node --import tsx --import ./test/support/resolve.ts --import ./test/support/stub-platform.ts --test "test/*.test.ts"` |
| Repository | `node tools/verify-publish.mjs` · `node tools/scan-pii.mjs` (must be clean before any push) |

Networks installs may hang on this machine: prefer offline copies (there are sibling checkouts under
the DSH workspace) and report a hang instead of waiting on it. Report every gate with the literal
command and its output tail — "it builds fine" is not a result.

## Role split (owner decision 2026-11-08; models per role live in `CLAUDE.md`)

| Role | Responsibility |
|---|---|
| **lead** (architect) | evaluates, designs, prioritizes; owns `docs/`, `specs/`, `AGENTS.md`, `CLAUDE.md`, repo layout. Does not edit plugin/app code. |
| **coder** | every code change in `plugins/`, `apps/`, `packages/`, scoped to the package named in the task. Smallest correct change, reports literal build/test output. |
| **beastcore** | R&D on DSH source and third-party code. Read-only; facts labelled (a) measured / (b) read from source / (c) inferred. |
| **scout** | fast read-only lookups. |
| **reviewer** | independent review; mandatory before any store upload and for any auth/pairing/token/push/network-exposure code. |

Roles run as DSH subagents from the shared bundle `@local/dsh-roles`; the briefs in
`.claude/agents/<role>.md` (when present) supply the project-specific rules and override the bundle's
generic text.

## Hard rules (verbatim from the dsh-ext charter; they are not negotiable here)

- **Host executes, clients control.** Never run DSH Host code on a phone; never embed Node, a JS JIT
  runtime, DSH native addons, or a PTY in an app.
- **Contract-first.** Gateway and app pairs share a versioned contract in `packages/mobile-protocol`;
  a breaking change is a new major version, and a capability/version mismatch is surfaced to the user,
  never silent.
- **Secure by default.** Nothing listens beyond `127.0.0.1` unless the owner enables it; any remote
  surface needs TLS, per-device credentials with isolated revocation, and the narrowest API that works.
- **Approval decisions carry contract-defined `argsHash` for the exact request shown;** WS mismatches
  are normal receipts `accepted:false, reason:'hash-mismatch'` and stay pending. Decisions apply at
  most once; duplicates return `not-pending`; unavailable hashes are desktop-only. Push notifications
  hold ids/short text only. Owner-approved alignment 2026-11-09; constitution v1.1.1.
- **Native render only.** `apps/mobile-companion` is React Native + Expo; no WebView/Capacitor
  wrapping of `apps/web/dist`.
- **No secrets in git, logs or push payloads.** Never read, print or commit credentials, tokens,
  signing keys, APNs/FCM secrets.
- **Never commit, push, publish to stores, or upload builds without explicit owner approval.**
- **No `reset`/`clean`/`stash`/`checkout --`/`restore`/force-push.** Preserve working-tree changes.
- **Run the PII scan before push.** `node tools/scan-pii.mjs` over the whole tree (the `pre-push` hook
  does it), plus `gitleaks detect --source .` when gitleaks is installed.

## Pitfalls that have cost time here

- The gateway keeps a **vendored copy** of the contract (`plugins/mobile-gateway/lib/vendor/mobile-protocol.mjs`).
  Edit `packages/mobile-protocol` first, then `npm run check:protocol` / `scripts/sync-mobile-protocol.mjs`.
- Some tests really listen on TCP/WS: suites are slower than they look, and a hang is usually a port or
  a TLS identity, not an endless loop.
- Known pre-existing failure while it is owned elsewhere: `plugins/mobile-gateway/test/allowlist.test.mjs`
  does not classify question-answer / question-cancel frames the way its expectations say. Report it;
  do not "fix" it to make a gate green.
