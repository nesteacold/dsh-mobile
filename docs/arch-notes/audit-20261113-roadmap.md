# Architecture audit 2026-11-13 — findings and upgrade roadmap

Source: three read-only audits (gateway + protocol, companion app, devices + ops). Evidence is
(b) read from source unless marked; no gate was run by the auditors. Line numbers drift while
coders work — re-locate before acting.

## Verdict

The security core is sound (per-device credentials, nonce-bound OTP proof, passkey lock, proxied
request fence, reviewer-gated). The risk is concentrated in four places:

1. **Operations are hand-made** — no CI, no runbook, ad-hoc PWA server, profile lockfile drift.
2. **Three oversized files** — gateway `lib/index.mjs` (~7400 lines), app `src/app-state.ts`
   (~3700), devices `lib/host-router.mjs` (~1900).
3. **Contract leaks** — wire literals outside `packages/mobile-protocol`; hand-written fake gateway.
4. **Feature gaps on the client** — OTP pairing (in progress), attachments, agent preset at create,
   web push, capability-mismatch banner, no device-verified e2e.

## P0 — do now

| # | Item | Owner | Spec |
|---|---|---|---|
| P0-1 | OTP cross-burn DoS: one wrong proof burns every live offer (`pairing-requests.mjs`) | coder + reviewer | 023 |
| P0-2 | CI: GitHub Actions running protocol, gateway, devices, app gates + `scan-pii` + `verify-publish` | coder | 022 |
| P0-3 | Durable deployment: runbook, `tools/ops/deploy.ps1` (WhatIf default), `check-profile.mjs` | coder (scripts), lead (runbook) | 022 |
| P0-4 | Pairing errors surface the real cause (no generic "Could not pair") | coder, after OTP merge | 024 |
| P0-5 | OTP pairing in the companion (in progress) | coder + reviewer | 024 |

## P1 — next

| # | Item | Notes |
|---|---|---|
| P1-1 | Every wire `kind`/`code` is an exported contract constant (`passkey-lock` first) + grep-test | contract-first rule |
| P1-2 | Gateway split, pure moves, one step per change: request-trust → file-transfer → query-handlers → pairing-socket → passkey-gate | `classifyRequest(req)` table test with step 1 |
| P1-3 | Test runner: timeouts, per-suite timing, "every test file is wired" check (gateway + devices) | removes hang risk |
| P1-4 | Device scope update route (owner-approved, loopback-only) so old records can gain `attachments:write` | spec + reviewer |
| P1-5 | `ID_FIELDS` completeness test in devices | prevents reorder-class bugs |
| P1-6 | A1.1: upload-route wraps a third method — amend the constitution exception or remove the wrap | lead decision + reviewer |
| P1-7 | App: split `AppController` into `src/controller/*` after OTP merges | no file > 800 lines |
| P1-8 | App: capability-mismatch banner; attachments; agent preset at session create | each needs a spec |
| P1-9 | Contract test driving fake gateway and real gateway with the same frames | |
| P1-10 | One device-verified e2e run recorded in `e2e/RESULTS.md` | |
| P1-11 | Web push (VAPID, ids only) | owner decision + reviewer |

## P2 — hygiene

Spec numbering (two `011`, gaps), stale arch notes, `PROTOCOL.md` normative banner, exact pin for
`ws`, atomic state writes check, SW cache name from build hash, safe-area insets instead of literal
paddings, accessibility lint, i18n literal grep, trickle flake measurement.

## Rules added by this audit

- A wire literal outside `packages/mobile-protocol` is a contract defect.
- A test file not referenced by `npm test` (or a named `test:official` suite) is a defect.
- Deployment state (serve mounts, listen target, profile links) is changed only through
  `tools/ops/` scripts and recorded in `docs/ops/runbook.md`.
