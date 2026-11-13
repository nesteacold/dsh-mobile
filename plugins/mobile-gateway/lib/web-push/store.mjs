/**
 * Spec 026 R1/R2/R5 — the web push store: the VAPID key pair, one subscription set per device,
 * the per-device hourly budget and the collapse-by-session outbound queue.
 *
 * Key handling (R1) follows the passkey store: the key file is written with
 * `writeSecretFile` (0600 / an owner-only ACL) and RE-READ only after `assertOwnerOnly`, so a
 * pre-existing explicit grant cannot make the Host serve a key it cannot prove is private. The
 * private key is never logged, never returned to a caller outside this process and never travels
 * on the wire; `hello` carries only `vapidPublicKey`.
 *
 * A subscription record is `{ endpoint, keys: { p256dh, auth }, addedAt }`. Keys are the device's
 * OWN browser key material, kept in the same protected file: the Host needs them to encrypt, and
 * they are not a Host credential. Removing them is therefore the whole of "unsubscribe" — nothing
 * else is retained once the last subscription of a device goes.
 */
import fs from 'node:fs'
import path from 'node:path'

import { WEB_PUSH_RATE_LIMIT_PER_HOUR } from '../vendor/mobile-protocol.mjs'
import { assertOwnerOnly, ensureOwnerOnlyDirectory, restrictToOwnerSync, writeSecretFile } from '../secure-file.mjs'
import { publicKeyOf, generateVapidKeys } from './vapid.mjs'

/** File name of the VAPID identity, next to the device store. */
export const WEB_PUSH_KEY_FILE = 'mobile-gateway-web-push-key.json'
/** File name of the subscription store, next to the device store. */
export const WEB_PUSH_SUBSCRIPTION_FILE = 'mobile-gateway-web-push-subscriptions.json'
const STORE_VERSION = 1
/** Bound of stored subscriptions: one per paired device would be ~1, plus one per browser profile. */
const MAX_SUBSCRIPTIONS_PER_DEVICE = 8
const ENDPOINT_MAX_LENGTH = 2048

/**
 * Load the VAPID key pair, generating it on first use (spec 026 R1).
 *
 * A corrupt or unreadable key file is NOT fatal: the pair is regenerated, and every stored
 * subscription is dropped with it (a device cannot read a message encrypted to the old key), so
 * the owner re-subscribes instead of the gateway refusing to start. `regenerated` reports that.
 *
 * @param {string} directory the plugin data directory
 * @param {(line: string) => void} [log]
 * @returns {{ vapid: { privateKeyPem: string, publicKey: string }, file: string, regenerated: boolean, problem?: string }}
 */
export function loadOrCreateVapidKeys(directory, log) {
  const file = path.join(directory, WEB_PUSH_KEY_FILE)
  const unusable = (problem) => {
    log?.(`web push key unusable (${problem}); generating a new VAPID key pair`)
    return persist()
  }
  const persist = () => {
    const keys = generateVapidKeys()
    ensureOwnerOnlyDirectory(directory)
    const target = `${file}.${process.pid}.tmp`
    writeSecretFile(target, JSON.stringify({ version: STORE_VERSION, ...keys }, null, 2))
    fs.renameSync(target, file)
    restrictToOwnerSync(file, 'file')
    // The key that is USED is the key that was written: a failed rename must not leave the
    // process holding a pair nobody else will ever see.
    return { vapid: keys, file, regenerated: true }
  }
  try {
    if (!fs.existsSync(file)) return persist()
    // A pre-existing explicit grant survives the write-time restriction, so the file that is read
    // is checked like a served secret (R1: the same rules as every other gateway secret).
    assertOwnerOnly(file)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed.privateKeyPem !== 'string' || typeof parsed.publicKey !== 'string') {
      return unusable('store has an unexpected shape')
    }
    // The advertised public key MUST belong to the stored private key: a mismatch would encrypt
    // to nothing a device could decrypt while every status looked healthy.
    if (publicKeyOf(parsed.privateKeyPem) !== parsed.publicKey) return unusable('public and private keys disagree')
    return { vapid: { privateKeyPem: parsed.privateKeyPem, publicKey: parsed.publicKey }, file, regenerated: false }
  } catch (error) {
    // Only the error class is reported: a message can quote a path.
    return unusable(error && error.code ? String(error.code) : 'unreadable')
  }
}

/**
 * Load the subscription store. A corrupt file yields an empty store (a device just subscribes
 * again) and never stops the gateway.
 *
 * @param {string} directory
 * @returns {{ byDevice: Map<string, Array<{ endpoint: string, keys: { p256dh: string, auth: string }, addedAt: number }>>, file: string, problem?: string }}
 */
export function loadWebPushSubscriptions(directory) {
  const file = path.join(directory, WEB_PUSH_SUBSCRIPTION_FILE)
  const byDevice = new Map()
  try {
    ensureOwnerOnlyDirectory(directory)
    if (!fs.existsSync(file)) return { byDevice, file }
    assertOwnerOnly(file)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || !Array.isArray(parsed.devices)) return { byDevice, file, problem: 'store has an unexpected shape' }
    for (const row of parsed.devices) {
      if (!row || typeof row.deviceId !== 'string' || !Array.isArray(row.subscriptions)) continue
      const kept = []
      for (const entry of row.subscriptions) {
        if (!entry || typeof entry.endpoint !== 'string' || entry.endpoint.length === 0) continue
        if (entry.endpoint.length > ENDPOINT_MAX_LENGTH) continue
        const keys = entry.keys
        if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') continue
        kept.push({
          endpoint: entry.endpoint,
          keys: { p256dh: keys.p256dh, auth: keys.auth },
          addedAt: Number.isFinite(entry.addedAt) ? entry.addedAt : Date.now(),
        })
        if (kept.length >= MAX_SUBSCRIPTIONS_PER_DEVICE) break
      }
      if (kept.length > 0) byDevice.set(row.deviceId, kept)
    }
    return { byDevice, file }
  } catch (error) {
    return { byDevice: new Map(), file, problem: error && error.code ? String(error.code) : 'unreadable' }
  }
}

/**
 * The web push service of one gateway process.
 *
 * @param {object} options
 * @param {Map<string, Array<object>>} options.byDevice the loaded subscriptions
 * @param {string} options.file store path (written on every change)
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log]
 */
export function createWebPushStore(options) {
  const { byDevice, file } = options
  const now = options.now ?? (() => Date.now())
  const log = options.log

  const save = () => {
    const devices = [...byDevice.entries()].map(([deviceId, subscriptions]) => ({ deviceId, subscriptions }))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const target = `${file}.${process.pid}.tmp`
    // The file holds browser key material: owner-only, like every other secret of this gateway.
    writeSecretFile(target, JSON.stringify({ version: STORE_VERSION, devices }, null, 2))
    fs.renameSync(target, file)
    restrictToOwnerSync(file, 'file')
  }

  /** Per-device send timestamps inside the rolling hour, and the pending queue per device. */
  const sent = new Map()
  const pending = new Map()

  const withinWindow = (deviceId) => {
    const at = now()
    const list = (sent.get(deviceId) ?? []).filter((time) => at - time < 60 * 60_000)
    if (list.length === 0) sent.delete(deviceId)
    else sent.set(deviceId, list)
    return list
  }

  const removeEndpoint = (deviceId, endpoint) => {
    const list = byDevice.get(deviceId)
    if (list === undefined) return false
    const kept = list.filter((entry) => entry.endpoint !== endpoint)
    if (kept.length === list.length) return false
    if (kept.length === 0) byDevice.delete(deviceId)
    else byDevice.set(deviceId, kept)
    save()
    return true
  }

  return {
    /** Whether this host has any subscriber at all (the gate in front of every send path). */
    hasSubscribers() {
      return byDevice.size > 0
    },

    /** How many devices currently hold at least one subscription (status reporting). */
    subscriberCount() {
      return byDevice.size
    },

    /** The subscriptions of one device (a copy: a caller cannot mutate the store). */
    subscriptionsFor(deviceId) {
      return (byDevice.get(deviceId) ?? []).map((entry) => ({ ...entry, keys: { ...entry.keys } }))
    },

    /**
     * Store (or replace) one subscription of `deviceId` (spec 026 R2).
     *
     * Endpoint identity is what makes this idempotent: the same browser re-subscribing replaces
     * its record instead of accumulating one per page load.
     *
     * @returns {number} the device's subscription count after the write
     */
    subscribe(deviceId, subscription) {
      const list = (byDevice.get(deviceId) ?? []).filter((entry) => entry.endpoint !== subscription.endpoint)
      list.push({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
        addedAt: now(),
      })
      // Oldest first out: a device cannot fill the file (or the outbound fan-out) without bound.
      while (list.length > MAX_SUBSCRIPTIONS_PER_DEVICE) list.shift()
      byDevice.set(deviceId, list)
      save()
      log?.(`web push subscribed: device=${deviceId} subscriptions=${list.length}`)
      return list.length
    },

    /**
     * Drop one subscription, or every subscription of the device when `endpoint` is omitted
     * (spec 026 R2). Idempotent: unsubscribing twice is not an error.
     *
     * @returns {number} how many records were removed
     */
    unsubscribe(deviceId, endpoint) {
      if (endpoint === undefined) {
        const had = byDevice.get(deviceId)?.length ?? 0
        if (had > 0) {
          byDevice.delete(deviceId)
          save()
          log?.(`web push unsubscribed: device=${deviceId} removed=${had}`)
        }
        return had
      }
      const removed = removeEndpoint(deviceId, endpoint) ? 1 : 0
      if (removed > 0) log?.(`web push unsubscribed: device=${deviceId} removed=1`)
      return removed
    },

    /** Drop every subscription of a device (revoke / forget / re-pair), idle or not. */
    forgetDevice(deviceId) {
      const had = byDevice.get(deviceId)?.length ?? 0
      pending.delete(deviceId)
      sent.delete(deviceId)
      if (had > 0) {
        byDevice.delete(deviceId)
        save()
        log?.(`web push subscriptions dropped: device=${deviceId} removed=${had}`)
      }
      return had
    },

    /** A push service said 404/410: that subscription can never deliver again (spec 026 R2). */
    dropEndpoint(deviceId, endpoint) {
      // A queued message for that endpoint is meaningless once the record is gone.
      const queue = pending.get(deviceId)
      if (queue !== undefined) {
        for (const [sessionId, message] of queue) if (message.endpoint === endpoint) queue.delete(sessionId)
        if (queue.size === 0) pending.delete(deviceId)
      }
      const removed = removeEndpoint(deviceId, endpoint)
      if (removed) log?.(`web push subscription removed after a permanent failure: device=${deviceId}`)
      return removed
    },

    /** Drop the records of devices that no longer exist (cheap housekeeping on every change). */
    pruneDevices(liveDeviceIds) {
      const live = new Set(liveDeviceIds)
      let changed = false
      for (const deviceId of [...byDevice.keys()]) {
        if (live.has(deviceId)) continue
        pending.delete(deviceId)
        sent.delete(deviceId)
        byDevice.delete(deviceId)
        changed = true
      }
      if (changed) save()
      return changed
    },

    /**
     * Whether `deviceId` still has budget in its rolling hour (spec 026 R5: 30 per hour).
     * A refused push is NOT counted; only a real delivery attempt is.
     */
    withinRateLimit(deviceId) {
      return withinWindow(deviceId).length < WEB_PUSH_RATE_LIMIT_PER_HOUR
    },

    /** Count one delivery attempt against the device's hourly budget. */
    noteDelivery(deviceId) {
      const list = withinWindow(deviceId)
      list.push(now())
      sent.set(deviceId, list)
    },

    /**
     * Queue one event for a device, collapsing by `sessionId` (spec 026 R5).
     *
     * There is at most ONE pending message per device and session: a newer event for the same
     * session replaces the older one, so a burst on one session costs one notification instead of
     * a stack of them. The replacement is unconditional — the newest event for a session is the
     * one worth waking the device for, whatever kind the older one was.
     *
     * @returns {object} the message object that is now the current one for that session
     */
    enqueue(deviceId, message) {
      let queue = pending.get(deviceId)
      if (queue === undefined) {
        queue = new Map()
        pending.set(deviceId, queue)
      }
      queue.set(message.sessionId, message)
      return message
    },

    /** Whether `message` is still the pending one for its session (a newer event may have replaced it). */
    isCurrent(deviceId, message) {
      return pending.get(deviceId)?.get(message.sessionId) === message
    },

    /** Remove one queue entry once its delivery attempt settled, unless a newer one replaced it. */
    settle(deviceId, message) {
      const queue = pending.get(deviceId)
      if (queue === undefined) return
      if (queue.get(message.sessionId) === message) queue.delete(message.sessionId)
      if (queue.size === 0) pending.delete(deviceId)
    },

    /** Every device id that currently holds at least one subscription. */
    deviceIds() {
      return [...byDevice.keys()]
    },

    /** Pending queue size of one device (status and tests). */
    pendingCount(deviceId) {
      return pending.get(deviceId)?.size ?? 0
    },
  }
}
