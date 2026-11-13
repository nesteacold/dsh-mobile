# Split plans (P1-2 gateway, P1-7 app) — 2026-11-14

Read-only scout output. Line numbers are from the working tree on 2026-11-14 and will drift; every
step re-greps before cutting. (b) = read from source, (c) = inferred.

## Rules for every step
- Pure move, no rename, no behaviour change; one step per commit; full package gates after each.
- Children never import `index.mjs` / `app-state.ts` (no cycles). Shared constants go to a leaf
  module (`lib/gateway-constants.mjs`).
- Mutable closure state (`gatewayEnabled`, listener handles) is passed as a getter, never by value.
- Test seams (`sealTestSeams` / `testSeamsInForce`) are threaded into factories that read time.

## Gateway `plugins/mobile-gateway/lib/index.mjs` (~7,640 lines)
1. `lib/request-trust.mjs`: forwarding/loopback/origin/credential predicates (~2491–2953 minus
   frame and HTTP-io helpers) + new pure `classifyRequest(req)`; table test of 17 cases
   (`test/request-trust.test.mjs`). Check whether `assertTrustedLocalAuthority` needs `badRequest`.
2. `lib/file-transfer.mjs`: transfer manager and directory helpers (~868–1327) + constants; add a
   `..`/symlink escape test.
3. `lib/host-commands.mjs` (~676–867) first, then `lib/query-handlers.mjs` (~1328–2490,
   `handleQuery`). `PLUGIN_VERSION` moves to `gateway-constants.mjs`.
4. `lib/pairing-socket.mjs`: `acceptPendingSocket` as `createPairingSocketAcceptor(deps)`; inject
   `activateBusinessConnection` etc.; timers still cleared by dispose.
5. `lib/passkey-gate.mjs` (`createPasskeyGate`, service+lock built together) and
   `lib/web-push/wiring.mjs`. Lock-gate condition (~6126–6137) stays inline; add a locked-socket
   test (`send-message` → `auth/locked`, `passkey-assert` passes).

## App `apps/mobile-companion/src/app-state.ts` (3,811 lines; class 677–3811)
Facade `AppController` keeps every public member and delegates; `ControllerContext` holds shared
fields/primitives; concerns are `new XCtrl(ctx, peers)` with lazy peer getters.
Order: (1) free types/helpers → `controller/*` with re-exports; (2) `ControllerContext`;
(3) leaves: compat, web-push, snapshot, authoring; (4) history → outbox → sessions;
(5) approvals + deep link; (6) web-lock; (7) credentials → connection + events; (8) pairing;
(9) lifecycle, trim facade. Target: every file < 800 lines (pairing ~560).
Before step 3: add dedicated web-push and compat smoke tests at controller level; grep tests for
`as any` private access and keep forwarding getters where hit.
Gate per step: `tsc --noEmit` + full unit suite with unchanged pass count.

Pre-split tests added 2026-11-14: `test/app-controller-web-push.test.ts` (7), `test/app-controller-compat.test.ts` (7);
suite at 1238/1238. Private members tests reach via `as unknown as {…}` — keep them reachable on the
facade (forwarding getter/setter) when they move: `client` (7 files), `pairingHostConflict`,
`webLocked`, `onRevoked`, `mismatchHello`.
