# 035 — Live session state of a remote Host reaches the controller (`session/control` relay)

Status: draft (owner agreed to spec 2026-11-15). Package: `plugins/devices` (`lib/host-router.mjs`
and its tests). No gateway change is expected; Phase 0 confirms that. No code before Phase 0 is
recorded in this file.

Facts are labelled (a) measured, (b) read from source, (c) inferred. Line numbers are from the
working tree of 2026-11-15 and drift: `host-router.mjs` is being edited by another session.

## Problem (reported by the owner 2026-11-15)

On a controller (laptop) driving a remote Host with a fully scoped device: in a session that lives
on the remote Host the model picker lists the models; the owner picks another model; the Host's own
GUI shows the new model; the controller's composer keeps showing the old one. (a, owner)

## Cause (b, not yet measured live)

- The composer chip reads the session's `modelSelection` projection and nothing else. The reply of
  `session/selectModel` is checked for `ok` and discarded; there is no optimistic local value
  (`dsh-client-ui-model-selection/src/client/directory.ts` 92-129, 161-162, 180; `service.ts` 81).
- Live projection changes reach the client through one stream, `session/control`: a Host-wide stream
  with no session argument (`dsh-api-session-controller/src/client/transport.ts` 115-133,
  `sessions/manager.ts` 624-643). The other writers of the projection store are the opening
  snapshot of `session/follow` and `api-session/added`.
- `plugins/devices` routes a stream by the `h:<hostId>:` tag in its payload. `session/control` has
  none, so it is opened on the local Host only (`host-router.mjs` `#route`, `#openWireStream`; only
  `workspace/follow` and `$events` are merged). No projection frame of a remote Host ever reaches
  the controller. `host-router.mjs` contains no `session/control` string.
- Consequence: any projection of a remote session is stale on the controller until that session is
  reopened (the `session/follow` snapshot re-seeds it). The model chip is the reported case; title,
  queue and other projections are expected to behave the same (c).

## What is already in place (b)

- The Host side already forwards this stream to a device: `session/control` is in `SESSIONS_READ`
  (`plugins/mobile-gateway/lib/remote-bridge.mjs` 63, scope `sessions:read`), added by the spec 008
  audit. It is forwarded whole, through the owner Peer the bridge uses for every call.
- There is no per-device subset of sessions on the bridge. The gateway's `visibleSessionIds` is the
  owner's `session/list` of the whole Host (`plugins/mobile-gateway/lib/index.mjs` 1190, 5684-5700),
  the same for every device; `session/list` is itself forwarded whole under `sessions:read`. So
  relaying `session/control` gives a `sessions:read` device nothing it cannot already list.
  The companion (phone) channel is a different path and keeps refusing this stream
  (`companion-access.mjs` 151); this spec does not touch it.

## Phase 0 — measure (read-only, throwaway instances only)

Two throwaway DSH instances (own profiles, data dirs and ports), paired on loopback with full scopes.
Never the owner's GUI, never the live gateway.

1. Open `session/control` over the bridge as the device. Record the baseline frame and one update
   frame after a `session/selectModel` on the Host: exact keys, where the session id sits
   (map key, `sessionId`, other), and the shape of the changed value.
2. Does the baseline contain sessions that owner `session/list` does not (subagent children,
   archived)? List the difference.
3. On the controller: after a model pick in a remote session, leave and reopen the session. Does the
   chip show the new model? (confirms the cause)
4. Feed the shipped client a second `type:'baseline'` frame on `session/control`: does it reset the
   projections of sessions absent from it? (decides D2)
5. Confirm a device without `sessions:read` gets `auth/forbidden-scope` on the stream open.

Record each answer here, labelled, before Phase 1.

## Phase 0 findings (beastcore, 2026-11-15, two throwaway instances H:30931 / C:30932, gateway 30935)

All (a) measured unless marked.

1. Bridge frames on H, opened as the device: envelope `{kind:'remote-frame', streamId, seq, value}`.
   - Baseline: `{type:'baseline', value:{projections:{<sessionId>:{asOfSeq, values:{…}}}}}`. The
     session id is the MAP KEY; entries carry no `sessionId`. `values` holds every projection
     (`modelSelection`, `title`, `inbox`, `permissions`, `agentTeam`, `sessionListMetadata`, …).
   - Update after `session/selectModel`: `{type:'projection', sessionId, seq, changes:[{key:'modelSelection',
     val:{lastUsed:null, next:{provider:'fakeprov', model:'model-b'}}}]}`. The id is a `sessionId`
     field; the provider id is RAW.
   - The selectModel reply was `{ok:true, value:{selected:{provider, model}}}`.
   - H sent a SECOND `type:'baseline'` (same content, envelope seq 0) immediately before the update.
     Not yet known whether that is a redelivered opening baseline or a real re-baseline on change.
2. Control ids and owner `session/list` ids were identical on H. Limited: H had two blank sessions
   only, no subagent children or archived sessions, so the case this item worried about is untested.
3. Cause confirmed. Opening `session/control` on C (via `/api/remote.mux`) yields one baseline with
   `projections:{}` and nothing after the remote model change; no `h:` id ever appears. `session/follow`
   on C for `h:<hostId>:<sid>` opens with `modelSelection.next = {provider:'fakeprov@<hostId>',
   model:'model-b'}`: the follow snapshot is rewritten correctly by the existing ingress. Owner, live:
   the chip is correct after leaving and reopening the session.
4. (b) `replaceControlBaseline` (manager.ts 635-643) seeds only the sessions present in the baseline;
   absent sessions are untouched. `seed()` clears, within that one session, `cached` rows and
   `sequenced` rows with `seq <= asOfSeq` that the baseline omits. So another Host's baseline cannot
   wipe this Host's projections, but a repeated baseline for the SAME session downgrades older
   sequenced keys it omits.
5. Without `sessions:read` the open is refused as `{kind:'remote-stream-closed', error:{code:
   'auth/forbidden-scope', scope:'sessions:read'}}` (a stream close, not an error frame).

Side observation, not this spec: owner `session/list` on C returned `items: []` with the remote
online. Hand to the session-list work (spec 034).

Harness pitfall for later runs: changing a paired desktop device's scopes with
`POST /mgw/devices/<id>/scopes` closes the controller's socket with 4401 and the controller DELETES
its token (treated as revoked). Pair with the full scope set from the start.

## Design

- D1 Merge. For a `session/control` open that carries no host hint, the router returns a merged
  stream: the local stream passes through unchanged, and for every connected remote Host the router
  opens that Host's `session/control` and forwards its frames after namespacing.
- D2 Namespacing. Every session id in a remote frame becomes `h:<hostId>:<id>`, including ids used
  as MAP KEYS (the baseline's `projections` map is keyed by session id; `rewriteIds` rewrites values
  only, so keys are renamed explicitly) and the `sessionId` field of `type:'projection'` frames.
  The Host sends provider ids RAW (Phase 0 item 1), so every value, including each
  `changes[].val` and each baseline entry's `values`, goes through the same ingress rewrite the
  `session/follow` snapshot already uses; a `{provider, model}` selection must arrive as
  `<provider>@<hostId>` to match the merged catalog. A frame of Host A must never be attributed to
  Host B or to the local Host.
- D3 Baselines. The shell's own baseline is the local one. A remote baseline is never forwarded as
  `type:'baseline'`: it is converted into per-session updates, so it can only touch that Host's
  `h:`-tagged sessions (Phase 0 item 4: absent sessions are untouched, but a same-session reseed
  downgrades omitted sequenced keys). A Host may send a baseline more than once, not only on
  connect (Phase 0 item 1); every one is handled the same way. A late, repeated or reconnecting
  Host must not wipe the projections of other Hosts or of the local Host.
- D4 Lifecycle. A Host that connects later gets its stream opened then; a disconnect ends that
  Host's stream and keeps the last known projections; a reconnect re-seeds them. Everything is
  aborted when the merged stream is closed or the plugin is disposed.
- D5 Data is not view-filtered. The local/remote sidebar tab filters what the sidebar shows. It must
  not filter this stream (nor `workspace/follow`): the shell validates selections against the data.
- D6 Refusal is quiet. If a Host refuses the stream (`auth/forbidden-scope`, bridge busy), the
  controller behaves as today for that Host, logs one line, and retries only on the next connection
  of that Host. No retry loop.
- D7 Cost. One extra stream per connected Host per controller window; it counts against the
  bridge's `maxStreamsPerDevice` when the owner configured one.

## Out of scope

- A per-device partition of sessions on the bridge. None exists today; if the owner wants one it is
  its own spec and covers every per-session endpoint, not this stream alone.
- Relaying `api-session/*` events (a new remote session appearing in the list): spec 034 / the
  session-list work. Note for that work: `session/control` does not announce new sessions.
- The companion channel.

## Constitution A1.1

Uses the existing wrap of `typertGateway.openWireStream`; no new wrapped method, README list
unchanged. The structural self-test is unaffected.

## Tests (`plugins/devices/test`)

1. A remote update for a model change reaches the merged stream with a tagged session id and a
   tagged provider.
2. A remote baseline's map keys are namespaced; the shell-facing stream carries one baseline.
3. Two remote Hosts with the same raw session id stay distinct.
4. Disconnect keeps projections; reconnect re-seeds; a late Host does not reset the others.
5. A refused open is quiet and does not retry within the same connection.
6. Local frames are byte-identical to the unwrapped stream.
7. The sidebar view (local / remote) does not change what this stream delivers.

## Acceptance

On a throwaway pair, picking a model in a remote session updates the controller's chip without
reopening the session (a), and the `plugins/devices` gate is green.

## Review

Reviewer pass required before reload: the change relays Host-wide state through the A1.1 wrapper
and the cross-Host attribution rule (D2) is an isolation property.

## Ordering

One writer per file. `plugins/devices/lib/host-router.mjs` is held by the "local / remote tab"
session; Phase 1 starts after that session releases it. Phase 0 can run now.
