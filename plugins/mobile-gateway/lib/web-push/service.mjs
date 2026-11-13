/**
 * Spec 026 — the web push service: the one place the gateway turns an event into zero or more
 * outbound push messages.
 *
 * It exists to keep the invariants of R1–R5 in ONE place instead of at each event site:
 *  - OFF means zero outbound requests. {@link createWebPushService.notify} returns before it
 *    touches the store, the sender or the network when the owner switch is off — the event
 *    sites do not have to re-state that, and cannot get it wrong;
 *  - the payload is built here and nowhere else: `{ v: 1, kind, sessionId, requestId? }`, with a
 *    field allowlist enforced before encryption, so no caller can smuggle prompt text, a tool
 *    name, arguments or a title into a notification;
 *  - the rate limit (30/h/device) and the collapse by sessionId live in the store, and a refused
 *    push never counts;
 *  - a 404/410 from the push service removes that subscription (and only that one).
 */
import {
  WEB_PUSH_EVENT_KINDS,
  WEB_PUSH_PAYLOAD_FIELDS,
  WEB_PUSH_PAYLOAD_VERSION,
} from '../vendor/mobile-protocol.mjs'
import { createWebPushSender } from './sender.mjs'
import { createWebPushStore } from './store.mjs'

/**
 * Build the payload of one event, refusing anything outside the allowlist.
 *
 * This is the privacy boundary of spec 026 R5 and the constitution: a caller passes the event
 * kind and the ids it already has, and gets back exactly `{ v, kind, sessionId, requestId? }`.
 * `requestId` is dropped unless the kind is one that has one, so a stray id never widens it.
 *
 * @param {{ kind: string, sessionId: string, requestId?: string }} event
 * @returns {{ v: 1, kind: string, sessionId: string, requestId?: string } | undefined}
 *   `undefined` when the event is not one this gateway may push at all.
 */
export function webPushPayload(event) {
  if (event === null || typeof event !== 'object') return undefined
  if (!WEB_PUSH_EVENT_KINDS.includes(event.kind)) return undefined
  if (typeof event.sessionId !== 'string' || event.sessionId === '') return undefined
  const payload = { v: WEB_PUSH_PAYLOAD_VERSION, kind: event.kind, sessionId: event.sessionId }
  // Only the two interaction kinds are bound to a request; `session-finished` never carries one.
  if ((event.kind === 'approval' || event.kind === 'question')
    && typeof event.requestId === 'string' && event.requestId !== '') {
    payload.requestId = event.requestId
  }
  // Cheap invariant: the object really only holds allowlisted fields. A future edit that adds
  // one fails here instead of in a notification a user sees.
  for (const key of Object.keys(payload)) {
    if (!WEB_PUSH_PAYLOAD_FIELDS.includes(key)) throw new Error(`web push payload field ${key} is not allowlisted`)
  }
  return payload
}

/**
 * The web push service of one gateway process.
 *
 * @param {object} options
 * @param {{ privateKeyPem: string, publicKey: string }} options.vapid
 * @param {ReturnType<typeof createWebPushStore>} options.store
 * @param {() => boolean} options.enabled the owner switch, read on EVERY send (never cached)
 * @param {object} [options.eventKinds] owner toggles per kind, e.g. `{ approval: true }`
 * @param {(request: object) => Promise<{ status: number }>} [options.transport] test-only
 * @param {(line: string) => void} [options.log]
 */
export function createWebPushService(options) {
  const { store, enabled, log } = options
  const sender = createWebPushSender({ vapid: options.vapid, transport: options.transport, log })
  const kindEnabled = (kind) => {
    const toggles = options.eventKinds
    // Default ON per kind: the owner switch that matters is the master one, and a missing toggle
    // must not silently disable a kind the Devices page shows as enabled.
    if (toggles === null || typeof toggles !== 'object') return true
    return toggles[kind] !== false
  }

  /** One delivery attempt for one subscription; returns whether the record must be dropped. */
  const deliver = async (deviceId, subscription, payload) => {
    if (!store.withinRateLimit(deviceId)) {
      log?.(`web push skipped: device=${deviceId} reason=rate-limited`)
      return false
    }
    store.noteDelivery(deviceId)
    const outcome = await sender.send({ endpoint: subscription.endpoint, keys: subscription.keys, payload })
    if (outcome.ok) return false
    if (outcome.gone) {
      // 404/410 (or keys that could never decrypt): this record is dead (spec 026 R2).
      store.dropEndpoint(deviceId, subscription.endpoint)
    }
    return outcome.gone
  }

  return {
    /** Whether the owner switch is on. Read live; this is what `hello` and the frame gate use. */
    enabled() {
      return enabled() === true
    },

    /** The VAPID public key every device receives in `hello.webPush` (never the private one). */
    vapidPublicKey() {
      return options.vapid.publicKey
    },

    /**
     * Push one event to every subscriber (spec 026 R5).
     *
     * Returns immediately with `0` when the owner switch is off, the kind is toggled off, or the
     * event is not one this gateway pushes — before any store read and any socket, so that OFF
     * really is zero outbound requests.
     *
     * @param {{ kind: string, sessionId: string, requestId?: string }} event
     * @returns {Promise<number>} how many subscriptions were attempted
     */
    async notify(event) {
      if (!this.enabled()) return 0
      const payload = webPushPayload(event)
      if (payload === undefined) return 0
      if (!kindEnabled(payload.kind)) return 0
      let attempted = 0
      for (const deviceId of store.deviceIds()) {
        const subscriptions = store.subscriptionsFor(deviceId)
        if (subscriptions.length === 0) continue
        // One queue entry per device and session: a newer event for the same session replaces the
        // older one, so a burst on one session is a single notification (spec 026 R5).
        const message = store.enqueue(deviceId, { sessionId: payload.sessionId })
        for (const subscription of subscriptions) {
          if (!store.isCurrent(deviceId, message)) break // a newer event for this session won
          if (!store.withinRateLimit(deviceId)) break
          attempted += 1
          await deliver(deviceId, subscription, payload)
        }
        store.settle(deviceId, message)
      }
      return attempted
    },
  }
}
