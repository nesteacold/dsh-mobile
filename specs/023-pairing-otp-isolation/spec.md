# 023 — Pairing OTP isolation (no cross-offer burn)

Package: `plugins/mobile-gateway`. Reviewer mandatory (pairing).

## Problem
`lib/pairing-requests.mjs` charges a wrong OTP proof against **every** live offer
(`OTP_MAX_FAILURES = 3`). Any peer that can reach the listener burns the owner's pending code with
three junk proofs. Availability defect; no confidentiality loss.

## Requirements
- R1. A wrong proof never consumes an attempt of an offer it could not have matched *unless* the
  global guess budget (R3) says so. Each offer keeps its own failure counter.
- R2. Before any proof is verified, a per-source limiter applies: at most 5 wrong proofs per
  10 minutes per source key. Source key = socket peer address for direct connections; for proxied
  requests (forwarded-family header or non-loopback Host) all proxied peers share one key
  (`proxied`) — header values are never trusted.
- R3. Guessing strength must not get weaker: across all sources, at most 3 wrong proofs may be
  *tested against* a given offer; after that the offer is burned (as today). A limited source's
  proofs are refused without being tested.
- R4. Refusals use existing contract codes (`pairing/expired`, rate-limit code already in the
  contract if one exists; otherwise reuse `pairing/expired` — no new wire code without a contract
  change). No OTP, proof or nonce in logs.
- R5. State is in-memory, bounded (max 1024 source keys, LRU), cleared on plugin stop.

## Decision 2026-11-13 (architect) — R2/R3 reconciliation
Per-source budget is **2** wrong proofs per 10 min (not 5). Each offer is burned after **3** tested
wrong proofs in total, from any sources. Hence one source can never burn an offer alone, all
proxied peers (one shared key) can never burn it alone, and the guess budget per offer stays at
3 as before. Acceptance "3+ wrong proofs from A" reads "wrong proofs from A until A is limited".

## Acceptance
- 3+ wrong proofs from source A: A is limited; a correct proof from source B still pairs.
- 3 wrong proofs tested against one offer (from distinct sources) burn that offer only; a second
  live offer is unaffected.
- Limited source sending a correct proof is refused until the window passes (fake clock).
- Proxied peers share one bucket; direct tailnet peers do not.
- `npm test`, `check:protocol`, `test:package` green; log-scan corpus includes OTP/proof.
