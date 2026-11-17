# 038 — Offline resistance for DSH desktop remote

Status: proposed, owner request 2026-11-17. Package: `plugins/devices` only.

## Problem

Owner report: on the desktop remote client, losing the link to a remote Host makes the remote
workspace and conversation rows disappear. The experience must behave like a chat application:
cached data stays visible while offline, a Send made offline is retained and replayed when the
link returns, and no message is silently lost or duplicated.

Source-backed causes (installed DSH `0.2.2-rc.3`, read from the packaged platform in this session):

- `plugins/devices/lib/host-router.mjs:3553-3557,3632-3637` removes a Host from the merged
  `workspace/follow` state as soon as its link drops (`dropHost` + whole-state `replace`), so remote
  workspaces vanish.
- `host-router.mjs:2348-2390` already retains `session/list` rows in memory across a link failure.
  It has no persisted copy across a plugin reload.
- `host-router.mjs:3049-3065` already replays cached `session/follow` frames when a session route
  fails, but only as a read-only stream and only from the existing JSONL cache.
- `plugins/devices/lib/index.mjs:1183-1189` rejects a prompt while the Host is offline:
  `remoteOffline(remote, 'the prompt was not sent')`. There is no desktop-side outbox.
- DSH's `SessionManager` keeps summaries when `session/list` errors, and its rows are keyed by
  `sessionId`. A retained row should carry `projections.kind:'cached'` so it never competes with a
  sequenced Host projection.
- DSH's Host prompt admission is idempotent on `requestId`: `hasPromptRequest` scans durable
  `user/message` and `agent/inbox/spliced` events for the same `source.rpcId`. Replaying the original
  `requestId` is therefore safe against duplicate delivery.

## Requirement

R1. **Workspace survival.** While a paired Host is offline, its last merged workspace rows remain
in the sidebar. A link failure must not emit a `dropHost` replacement. The Host entry is marked
stale internally but the stale marker is never sent as a DSH workspace field. On reconnect, the
fresh baseline replaces the stale entry. `dropHost` is reserved for an explicit forget or a 4401
revoke.

R2. **Session list survival.** Retain the last `session/list` rows for an offline Host. Retained rows
use the real row shape, keep their namespaced `sessionId`, and carry `projections.kind:'cached'`
with finite `asOfSeq` when a projection value is present. Never emit a session-removed event merely
because the link dropped. Retention is bounded by host count and row count/byte size.

R3. **Transcript survival.** When `session/follow` cannot reach the Host — whether the Host is absent
from the inventory or still listed with a dead/reconnecting link — the FIRST stream open must settle
immediately: replay the existing per-session JSONL cache as a read-only stream if it has an opening
snapshot, otherwise reject with a remote failure so DSH shows a visible load error. The router must
never leave the opening snapshot pending, because DSH rc.3 stays in `openState:'loading'` until the
first `snapshot` frame arrives. Do not synthesize a `session/follow` snapshot, cursor,
`assistantStream.revision`, or any event that the Host did not issue. Every path of the follow pump,
including a Host disappearing between the route check and stream open, must settle the first-open
promise. If no cache exists, show the offline state without inventing a transcript.

R4. **Offline send queue.** When a prompt targets a session owned by a Host that is not online, the
router keeps the originating `session/prompt` request pending and stores a durable outbox item for
the plugin. The item records host id, session id, original `requestId`, text, creation time, attempt
count, and status. It must be sent in order with the original `requestId` after reconnect. Only
plain text prompts are eligible; file attachments, file receipts, `mode:'steer'`, and prompt types
whose content is not representable on the wire are refused with a visible reason rather than
queued.

R5. **No silent background send.** While queued, the native prompt stays pending rather than
becoming a failed send. Any DSH/gateway/remote-client timeout on this prompt path must be suspended
for the queue lifetime while still honoring the caller's abort signal. A final permanent Host
refusal rejects the original prompt with its real reason and removes the item. A caller abort or
explicit cancel removes the item and abandons the echo. The original request is never replayed after
it has been settled. Ordinary plugin teardown is NOT a terminal settlement: it leaves eligible queued
items in storage for the next instance, and the abandoned native call is handled by the host process
restart. Settling a call as failed/expired/cancelled always removes its stored item first, so no
settled request can be replayed later.

R6. **Reconnect replay.** On Host `state` becoming `online`, replay eligible items in per-session
order with bounded backoff. The Host's idempotency on `requestId` prevents duplicates. A successful
replay marks the item acknowledged and lets the Host's durable `user/message` settle the native
echo. A transport failure leaves the item queued and retries with backoff; a terminal rejection is
surfaced. New online prompts for a session with any queued or in-flight item join the same ordered
lane instead of bypassing it. Replay must not reorder prompts for the same session.

R7. **Persistence and bounds.** Workspace/session retention and the outbox live in plugin-owned
storage, not in DSH files or state. They survive a DSH restart. Storage is capped by host count,
item count, bytes, and TTL; the default bounds are host retention 32, session rows 200 per host,
outbox 100 items, 256 KiB per item, and TTL 7 days. Expired items are discarded without replay.

R8. **Visibility and diagnosis.** The Devices page shows, per Host: online/offline state, number of
retained workspace/session rows, and queued prompt count. It never shows prompt bodies in logs or
status. A queued prompt is visibly pending, then acknowledged or failed with a reason. No raw Host
or session id is written to logs; use the existing namespace-safe logging conventions.

R9. **Safety boundaries.** No DSH object or file is wrapped or modified. No gateway contract,
mobile app, or protocol version changes. Authorization is unchanged: a queued prompt is replayed
only for the same paired Host and the same device/session scope that created it. A Host identity
change, credential revoke, or device unlink invalidates its retained state and outbox. This change
touches the A1.1 wrapper surface, so a reviewer pass is mandatory before use.

## Acceptance

- Unit tests with a fake Host:
  - link drop keeps workspace rows and session rows; no `dropHost`/session-removed frame; reconnect
    replaces them; explicit forget/revoke clears them.
  - offline `session/prompt` returns a pending queue state, survives an outbox reload, and replays
    once with the identical `requestId` after reconnect.
  - replay after the Host already accepted the same `requestId` stays acknowledged without a second
    durable message.
  - abort, permanent rejection, TTL expiry, per-item size cap, and outbox cap behave per R4-R7.
  - file-carrying prompts and `mode:'steer'` are refused visibly and never queued.
  - local sessions and local workspaces are unchanged.
- Real-gateway integration: start the in-process gateway, pair a desktop device, open a remote
  session, stop the Host link, assert cached workspace/session/transcript and queue a prompt,
  restore the link, and assert prompt replay with the original id, one durable message, and no
  session switch. Also cover DSH reload with persisted retention/outbox.
- Gates: `node --check` on changed files, `npm test` in `plugins/devices`, repository PII scan and
  `verify-publish`.
- Live (owner, DNLP25-IT09): disconnect the Host, confirm workspace and session list remain,
  send a prompt while offline, reconnect, and confirm the prompt appears once and the session is
  usable without manual replay.
