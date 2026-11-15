# 031 — Pairing ingress and transport identity

Status: design approved with constraints by pairing-design-review; owner requested assessment and repair on 2026-11-14. Implementation and runtime acceptance pending.
Scope: mobile-protocol, mobile-gateway, devices, mobile-companion, deployment scripts.

## Problem

One gateway bind and one advertised address currently mix three independent facts: where the gateway listens, where each client connects, and whose TLS certificate the client observes. Tailscale Serve terminates browser-facing TLS; the gateway leaf pin does not identify that certificate. A direct Tailscale listener also does not answer the deployment's loopback upstream. Static HTTP 200 is not a pairing health check.

## Required design

1. Preserve the existing v1 pinned pairing fields and meaning. QR/string native and desktop offers contain only direct TLS endpoints that present the gateway's leaf certificate. Never substitute a Serve certificate or silently fall back to CA trust on a pin mismatch. Every fallback endpoint shares that verified identity.
2. Describe the web origin separately. Browser pairing uses the current HTTPS origin's WSS `/ws/mobile`, browser CA/hostname validation, explicit allowed Origin, and existing OTP proof/owner approval. A challenge fingerprint is protocol material, not browser-observed pin evidence. An eight-digit code is not endpoint discovery.
3. Model direct ingress and Serve ingress independently. Keep the existing owner-enabled direct listener. Add an explicitly enabled plugin-owned loopback TLS upstream for Serve, WS-only, sharing device authentication and the pairing state machine. Do not expose DSH administration or bind wildcard addresses. No new relay process or plaintext trusted-proxy shortcut.
4. Loopback Serve ingress is off until explicitly configured by the owner or an explicit deployment Apply action. Toggling direct bind must not silently strand an enabled web ingress. Persist each enabled state, bind/port and advertised web origin; preserve the gateway TLS identity across restart. Reject conflicts transactionally and report failures rather than claiming ready.
5. Management remains on the existing authenticated/local management surface. Proxied, direct tailnet and loopback-device traffic are never owner administration merely because of their source address. Forwarding headers never grant identity or scopes.
6. UI separates This Host / incoming devices from Remote Hosts / outgoing desktop connections. Pairing offers identify the target client: native/desktop direct pinned offer versus web open-origin + eight-digit-code guidance. Never produce a native QR with a Serve URL and gateway pin.
7. Status distinguishes configured, listening, direct TLS/WS healthy, web upstream reachable, assets healthy, pairing pending and ready. Ready requires accepted client-hello after paired and any required passkey unlock. Never equate HTTP 200 or initial hello with authenticated readiness.
8. Browser UI shows its authoritative current origin and does not accept an address override that is ignored. Errors distinguish unreachable/502, TLS/pin mismatch, expired/consumed offer, pending/rejected approval, storage failure and contract mismatch without disclosing secrets.

## Amendment A (owner-approved 2026-11-15): ported origin + PWA assets on the web ingress

Measured: a PWA opened at `https://<label>.ts.net:30443` sends `Origin: https://<label>.ts.net:30443`, which the portless-only origin rule refuses (403). The owner chose to serve the PWA and the web WS from one Serve port (30443) through the web ingress; native/desktop Remote keeps its direct pinned listener (item 1 unchanged, never via Serve).

A1. Configured web origin: canonical `https://<label>.ts.net` with an OPTIONAL explicit port 1–65535 (`https://<label>.ts.net:30443`). Exactly one origin; the WS fence stays an exact whole-string match (case-sensitive after canonical lowercase host, no default-port equivalence: `:443` is refused, the portless form is used for 443). Still refused: http, IP literals, trailing dot, userinfo, path/query/fragment, a port of 0 or with leading zeros, more than one origin.
A2. The web ingress listener additionally serves the built PWA as static files: GET/HEAD only (others 405), from one configured/packaged asset root. Path components must be plain names (no `.`/`..`, dotfiles, `*.map`, encoded separators); no symlink/junction/reparse segment; final realpath inside the realpathed root; SPA fallback to `index.html` only for extension-less paths. Responses carry the same headers as `apps/mobile-companion/scripts/serve-web.mjs` (CSP header incl. `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, correct service-worker/manifest types, no-cache for `index.html`/SW). No directory listing; every fs error is a generic 404/500 that never echoes a path and never throws out of the handler. `/ws/mobile` upgrade behaviour (exact Origin, browser-only) is unchanged; HTTP to `/ws/mobile` stays non-200. No `/mgw` or DSH admin route is reachable on this listener.
A3. Status reports assets separately (`webIngress.assets`: root configured/missing, `index.html` present) — never folded into `listening`/ready (item 7).
A4. Serve layout: `:30443 /` → `https+insecure://127.0.0.1:<webIngressPort>`; the separate static server on 18480 is retired after acceptance.

## Contract compatibility

Contract changes precede consumers and vendored sync. Prefer additive ingress descriptions and capability negotiation without altering existing endpoint/pin semantics. Unknown trust modes fail closed for pinned clients. Any change to existing trust-field meaning requires a major contract change, not a shape-compatible reinterpretation. Exact wire names/versioning are to be finalized from the contract audit before implementation.

## Invariants

Keep OTP entropy/expiry, proof nonce binding, one-time consumption before approval, conservative per-source limits, bounded pending requests and disconnect cleanup. Approval rechecks live connection and enabled state, grants only scopes within the offer. Re-pair rotates generation; revoke isolates a device. No tokens before approval or business frames before authorization/unlock. Approval decisions retain exact-request argsHash binding. Origin changes do not silently migrate credentials/passkeys across browser security boundaries.

## Acceptance

- Native iOS/Android and desktop: direct QR/paste -> verified leaf before secret -> pending -> owner approval -> paired -> accepted client-hello -> authorized session read -> reconnect. Serve URL + gateway pin fails before credential.
- PWA on actual Serve origin: page -> WSS upgrade through dedicated upstream -> OTP proof -> owner approval -> paired -> accepted hello -> passkey where required -> authorized session read -> reload reconnect.
- Both ingresses work concurrently with separate device credentials and one Host authorization core. Spoofed forwarding/Host/Origin headers cannot reach management or widen scopes.
- Test failed binds/port collisions, both listener disposal, enabled-state changes during proof/approval, replay/expired/consumed code, rejected approval, credential persistence failure, identity rotation and isolated revocation.
- Deployment checks exact Serve mounts and gateway upgrades separately from assets. Unexpected occupied ports are errors, not service identity success. Restart/logon restores configured services; transient OTP/pending requests do not survive.

## Delivery order

1. Contract audit and design review; finalize field names and test matrix.
2. Contract + gateway ingress/status/offer validation, with tests and security review.
3. Devices UI and PWA/native consumers in disjoint scopes, with compatibility tests.
4. Deployment startup and diagnostics; review network changes before live Apply.
5. Run package gates and actual PWA/desktop/native acceptance. Report unavailable physical-device tests explicitly. No automatic commit, release tag, store upload or application restart.
