// Spec 008 P1b: the restricted pairing socket (proof, then wait for the Host user).
// Moved out of index.mjs (split plan step 4); behaviour unchanged. Mutable closure
// state is read through getters; this module never imports index.mjs.
import crypto from 'node:crypto'
import { log } from './logging.mjs'
import { stringifyWireFrame } from './wire-json.mjs'
import { isForwardedRequest } from './request-trust.mjs'
import { pairingSourceKey } from './pairing-source-limiter.mjs'
import { OP_FORBIDDEN } from './allowlist.mjs'

export function createPairingSocketAcceptor({
  pairingRequests, pendingSockets, reservedLongCodes, registry,
  remoteControlEnabled, gatewayEnabled,
  CLOSE_PAIRING_REJECTED, CLOSE_PAIRING_EXPIRED, PAIRING_HANDSHAKE_MS, PAIRING_NONCE,
}) {
  return (socketClient, { req, clientDeviceId, deviceName, transport, longCode }) => {
    const certSha256 = transport.certSha256
    // The peer address is the PROXY's when a reverse proxy fronts this listener (`tailscale
    // serve` dials the local target, so it arrives from this very machine). That address is
    // recorded for the owner's eyes only, so a proxied request records nothing rather than a
    // confident wrong answer: no forwarding header is trusted for it, because every one of them
    // is caller-supplied text on an unauthenticated hop.
    // A forwarding-family header means the peer address names the proxy, not the caller; the Host
    // it addressed may legitimately be a tailnet name for a DIRECT tailnet client, so the display
    // field keys on the header family alone and leaves a real tailnet peer's address intact.
    const proxied = isForwardedRequest(req)
    const clientIp = proxied ? '' : String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '')
    // Spec 023 R2: every proxied request shares the one `proxied` bucket (the peer address names
    // the proxy, not the caller). A DIRECT tailnet peer also addresses a non-loopback Host, so the
    // Host alone cannot be the signal or direct peers would share a bucket (acceptance: they do
    // not); the forwarding-family header is. Same classifier as `clientIp` above.
    const pairingSource = pairingSourceKey({ proxied, peerAddress: req.socket?.remoteAddress })
    const serverNonce = crypto.randomBytes(24).toString('base64url')
    let state = longCode !== undefined ? 'proof-long' : 'proof-otp'
    let request
    let clientNonce
    let finished = false
    let refused = 0
    const send = (frame) => { if (socketClient.readyState === 1) socketClient.send(stringifyWireFrame(frame)) }
    // Drop every listener this restricted state machine added, so the socket
    // can be handed to a MobileConnection (approve) without our handlers left on it.
    let detach = () => {}
    const finish = (reason, code) => {
      if (finished) return
      finished = true
      clearTimeout(handshakeTimer)
      if (request) {
        pairingRequests.take(request.id)
        pendingSockets.delete(request.id)
      }
      if (longCode !== undefined) reservedLongCodes.delete(longCode)
      if (reason) send({ kind: 'pairing-rejected', reason })
      try { socketClient.close(code ?? CLOSE_PAIRING_REJECTED, reason ?? 'pairing ended') } catch { /* already gone */ }
    }
    // A connection that never proves anything is dropped, so idle sockets
    // cannot pile up while holding no state at all.
    const handshakeTimer = setTimeout(() => { if (!request) finish('pairing/timeout', 4408) }, PAIRING_HANDSHAKE_MS)
    handshakeTimer.unref?.()
    const onError = () => {}
    const onClose = () => {
      // A client that goes away takes its pending request with it.
      if (finished) return
      finished = true
      clearTimeout(handshakeTimer)
      if (request) {
        pairingRequests.take(request.id)
        pendingSockets.delete(request.id)
        log(`pending pairing dropped: client disconnected (${request.id})`)
      }
      if (longCode !== undefined) reservedLongCodes.delete(longCode)
    }
    socketClient.on('error', onError)
    socketClient.on('close', onClose)

    const admit = (offer) => {
      request = pairingRequests.addPending({ offer, name: deviceName, clientIp, certSha256, clientNonce, serverNonce, deviceId: clientDeviceId })
      if (!request) { finish('pairing/busy', CLOSE_PAIRING_REJECTED); return }
      state = 'pending'
      pendingSockets.set(request.id, {
        socket: socketClient,
        transport,
        // Spec 021: the Origin THIS upgrade carried. The approval that promotes the
        // socket arrives on the Host management route, whose own `req.headers.origin`
        // is the owner page, not the browser that is pairing — so the browser origin
        // has to be captured here, while the upgrade request is still the one at hand.
        origin: req.headers.origin,
        end: finish,
        // Approve re-checks this after its (possibly stalled) body read: the
        // state machine must be unfinished and the socket still OPEN.
        live: () => !finished && socketClient.readyState === 1,
        // Called by Approve, after the request left the table. Marks this
        // state machine done and removes its listeners; the socket is then the
        // caller's to activate.
        release() {
          finished = true
          clearTimeout(handshakeTimer)
          if (longCode !== undefined) reservedLongCodes.delete(longCode)
          detach()
        },
        // Issue the token through the existing claim path (single use,
        // cert-bound, a re-pair bumps the generation). The grant is the offer
        // narrowed by the Host user: a long string's own offer is claimed as is
        // when nothing was narrowed; otherwise it is spent and an equivalent
        // narrower offer is claimed in its place, so the string cannot be reused.
        claim(grantedScopes) {
          const same = grantedScopes.length === request.requestedScopes.length
          if (longCode !== undefined && same) return registry.claimPairing(longCode, clientDeviceId, request.name, { certSha256 })
          if (longCode !== undefined) registry.claimPairing(longCode, clientDeviceId, request.name, { certSha256 })
          const narrowed = registry.createPairing(request.name, { kind: request.kind, scopes: grantedScopes, certSha256 })
          return registry.claimPairing(narrowed.code, clientDeviceId, request.name, { certSha256 })
        },
      })
      log(`pairing pending: ${request.name} (${request.id}) from ${clientIp}, kind=${request.kind}, scopes=${request.requestedScopes.join(', ')}`)
      send({ kind: 'pairing-pending', verificationCode: request.verificationCode, requestId: request.id, expiresAt: request.expiresAt })
    }

    send({ kind: 'pairing-challenge', serverNonce, certSha256, otpRequired: longCode === undefined })

    const onMessage = (data) => {
      let msg
      try { msg = JSON.parse(data.toString()) } catch { msg = undefined }
      // Only the proof is accepted, and only once and only before a request exists.
      if (state === 'pending' || finished || !msg || msg.type !== 'pairing-proof' || state === 'proof-done') {
        refused += 1
        send({ kind: 'error', code: OP_FORBIDDEN, requestType: typeof msg?.type === 'string' ? msg.type : 'unknown',
          message: 'only the pairing proof is accepted before the Host approves' })
        if (refused >= 3) finish('pairing/refused', CLOSE_PAIRING_REJECTED)
        return
      }
      if (typeof msg.clientNonce !== 'string' || !PAIRING_NONCE.test(msg.clientNonce)) {
        finish('pairing/bad-nonce', CLOSE_PAIRING_REJECTED)
        return
      }
      clientNonce = msg.clientNonce
      if (!remoteControlEnabled() || !gatewayEnabled()) { finish('pairing/disabled', CLOSE_PAIRING_REJECTED); return }
      if (longCode !== undefined) {
        // The long string is itself the secret (existing path). Reserve it so a
        // second connection cannot raise a second request with the same code.
        const offer = registry.pairingOffer(longCode)
        if (!offer || reservedLongCodes.has(longCode)) { finish('pairing/expired', CLOSE_PAIRING_EXPIRED); return }
        if (offer.certSha256 && offer.certSha256 !== String(certSha256).toLowerCase()) { finish('pairing/expired', CLOSE_PAIRING_EXPIRED); return }
        reservedLongCodes.add(longCode)
        state = 'proof-done'
        admit({ kind: offer.kind, scopes: offer.scopes })
        return
      }
      // Spec 023: the per-source brake keys on the peer address, or ONE shared key for every
      // proxied request (the classifier above; header values are never read).
      const result = pairingRequests.verifyProof({ proof: msg.otpProof, certSha256, clientNonce, serverNonce, source: pairingSource })
      if (!result.ok) {
        // Same wire answer whether the source is limited, the proof wrong, or the code burned:
        // a probe learns nothing about which. No wire code is added (contract unchanged).
        log(result.reason === 'source-limited'
          ? 'pairing proof refused: source limit reached'
          : 'pairing proof rejected (wrong or expired one-time code)')
        // Wrong proof: one attempt spent. The code may be burned by now; either
        // way this socket is done, the client retries on a fresh connection.
        finish('pairing/expired', CLOSE_PAIRING_EXPIRED)
        return
      }
      state = 'proof-done'
      admit(result.offer)
    }
    socketClient.on('message', onMessage)
    detach = () => {
      socketClient.off('message', onMessage)
      socketClient.off('close', onClose)
      socketClient.off('error', onError)
    }
  }
}
