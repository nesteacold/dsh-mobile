// Web transport (spec 020 requirement 2) — the `*.web.ts` sibling Metro picks on the `web`
// platform instead of `pinned-transport.ts`, which drives the native `pinned-ws` Expo module.
//
// WHAT IS DELIBERATELY DIFFERENT — AND WHY (owner decision 2026-11-11, spec 020 §owner):
//   * **No certificate pinning.** A browser cannot inspect the TLS leaf before the handshake, so
//     the pin is impossible here by construction. The web build therefore relies on the *browser's*
//     trust store for the Host's Tailscale certificate (`*.ts.net`), i.e. a publicly-trusted CA.
//     Narrower than pinning; the mitigation is that the PWA is only reachable on the owner's
//     tailnet. `certSha256` is accepted and IGNORED — see `connect()`.
//   * **No custom headers.** Browsers do not let script set request headers on a WebSocket. The
//     device id therefore rides as the `dsh-device.<id>` subprotocol, which the gateway accepts as
//     an alternative to `X-DSH-Device-ID` (`plugins/mobile-gateway/lib/index.mjs:2386-2404,
//     5829-5831`), and the bearer token as `dsh-auth.<token>` (contract §3.4 already sends it both
//     ways). `extraProtocols()` below derives the device subprotocol from the header the core
//     client already sets, so the client code is unchanged.
//   * Everything else matches the native transport exactly: same `Transport` interface, same
//     event shapes, same `TRANSPORT_ERROR` codes, `wss://` only, no bytes before `open`.
//
// SECURITY NOTE FOR REVIEW: this is a network surface. It is weaker than the native transport
// because trust is delegated to the browser CA store; that is an accepted owner trade-off for web,
// not an oversight.

import { PROTOCOL_SUBPROTOCOL, deviceSubprotocol } from '@dsh-ext/mobile-protocol';

import { CoreError } from '../core';
import {
  TRANSPORT_ERROR,
  type Transport,
  type TransportConnectOptions,
  type TransportEvent,
  type TransportListener,
} from '../core/transport';

/** Shown when the browser cannot open a socket at all (no WebSocket API). */
export const PINNED_TRANSPORT_MESSAGE =
  'This browser cannot open a WebSocket, so the app cannot reach your computer.';

/** The web transport is always present (every supported browser has WebSocket). */
export const PINNED_TRANSPORT_AVAILABLE = typeof WebSocket !== 'undefined';

export interface PinnedTransportOptions {
  /** Transport trace sink (redacted lines only); kept for API parity with the native transport. */
  trace?: (line: string) => void;
  onListenerFailure?: (info: { boundary: 'transport'; stage: string }) => void;
}

export type CreatePinnedTransportOptions = Pick<PinnedTransportOptions, 'trace' | 'onListenerFailure'>;

/** Maps an HTTP upgrade refusal to a contract error code (native parity, used by callers/tests). */
export function defaultUpgradeMapping(status: number): { code: string; message: string } {
  if (status === 403) return { code: 'remote/disabled', message: 'remote control off' };
  if (status === 401) return { code: 'auth/required', message: 'authentication required' };
  return { code: TRANSPORT_ERROR.upgradeFailed, message: `The computer refused the connection (HTTP ${status})` };
}

/** Native parity: the `CoreError` for an upgrade refusal status. */
export function upgradeStatusError(status: number): CoreError {
  const mapped = defaultUpgradeMapping(status);
  return new CoreError({ code: mapped.code as never, message: mapped.message, details: { status } });
}

/**
 * The subprotocols to hand `new WebSocket(...)`: the caller's list, the device subprotocol derived
 * from `X-DSH-Device-ID` (browsers cannot send that header), and never a duplicate.
 *
 * The device id is validated first: the gateway rejects anything that is not a stable id, and an
 * invalid one would otherwise turn into a confusing upgrade failure after the socket opened.
 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

function extraProtocols(options: TransportConnectOptions): string[] {
  const protocols = [...(options.protocols ?? [PROTOCOL_SUBPROTOCOL])];
  const deviceId = options.headers?.['X-DSH-Device-ID'];
  if (typeof deviceId === 'string' && deviceId.length > 0) {
    const fromHeader = deviceSubprotocol(deviceId);
    if (!protocols.includes(fromHeader)) protocols.push(fromHeader);
  }
  return protocols;
}

/**
 * The web build only talks to the owner's tailnet: trust is delegated to the browser CA store (no
 * pinning is possible), so an arbitrary host would silently widen what the app connects to.
 * Anything that is not `<something>.ts.net` is refused BEFORE a socket is opened.
 *
 * PORT-AGNOSTIC BY CONSTRUCTION: `URL.hostname` never contains the port, so `:8443` — the Host's
 * port, because 443 on the tailnet belongs to another service (spec 020 §Port) — passes freely.
 */
export function isTailnetUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'wss:'
      && parsed.hostname.toLowerCase().endsWith('.ts.net')
      && parsed.hostname.length > '.ts.net'.length;
  } catch {
    return false;
  }
}

export class PinnedTransport implements Transport {
  private readonly options: PinnedTransportOptions;
  private readonly listeners = new Set<TransportListener>();
  private socket: WebSocket | null = null;
  private open = false;
  private closed = false;
  /** Guards `failOnce`: a pre-open failure is reported exactly once, never doubled. */
  private failureReported = false;

  constructor(options: PinnedTransportOptions = {}) {
    this.options = options;
  }

  private emit(event: TransportEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A listener must never break the transport; report the boundary exactly like native.
        this.options.onListenerFailure?.({ boundary: 'transport', stage: `event:${event.type}` });
      }
    }
  }

  connect(url: string, options: TransportConnectOptions): void {
    this.closed = false;
    this.open = false;
    this.failureReported = false;
    // `wss://` only, and Tailscale-only: same invariant as the native transport plus the web's
    // narrower trust model (browser CA store instead of a pin). Refused before any socket exists.
    if (!/^wss:\/\//i.test(url)) {
      this.failOnce(TRANSPORT_ERROR.insecureUrl, 'The companion only connects over wss:// (TLS)', 'insecure-url');
      return;
    }
    if (!isTailnetUrl(url)) {
      this.failOnce(
        TRANSPORT_ERROR.badUrl,
        'The web app only connects to a Tailscale host (*.ts.net). Open the app from your tailnet address.',
        'not-tailnet',
      );
      return;
    }
    const deviceId = options.headers?.['X-DSH-Device-ID'];
    if (typeof deviceId === 'string' && deviceId.length > 0 && !DEVICE_ID_PATTERN.test(deviceId)) {
      // Fail before the upgrade: an invalid id would otherwise look like an auth/upgrade refusal.
      this.failOnce(TRANSPORT_ERROR.badUrl, 'This installation id is not usable for pairing; reinstall the app.', 'bad-device-id');
      return;
    }
    if (typeof WebSocket === 'undefined') {
      this.failOnce(TRANSPORT_ERROR.pinnedTransportUnavailable, PINNED_TRANSPORT_MESSAGE, 'no-websocket');
      return;
    }
    // `certSha256` is intentionally unused: a browser cannot pin the leaf certificate. See header.
    this.options.trace?.('web transport connect (no pinning: browser CA trust)');
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, extraProtocols(options));
    } catch (error) {
      this.failOnce(
        TRANSPORT_ERROR.connectFailed,
        error instanceof Error ? error.message : 'The browser refused the connection',
        'connect-threw',
      );
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.closed) return;
      // A server that ignores our subprotocol list would leave the socket without the contract
      // protocol; treat that as a protocol mismatch instead of talking to it anyway.
      if (socket.protocol !== PROTOCOL_SUBPROTOCOL) {
        this.emit({
          type: 'error',
          code: TRANSPORT_ERROR.protocolMismatch,
          message: `The computer did not accept the ${PROTOCOL_SUBPROTOCOL} protocol`,
        });
        try {
          socket.close(1002, 'protocol-mismatch');
        } catch {
          // Already gone.
        }
        return;
      }
      this.open = true;
      this.emit({ type: 'open' });
    };
    socket.onmessage = (event: MessageEvent) => {
      if (this.closed) return;
      // The protocol is text-only; a Blob/ArrayBuffer frame is a protocol error, never parsed.
      if (typeof event.data !== 'string') {
        this.emit({
          type: 'error',
          code: 'client/bad-message',
          message: 'The computer sent a binary frame; this protocol carries text only',
        });
        return;
      }
      this.emit({ type: 'message', data: event.data });
    };
    socket.onerror = () => {
      // NO event here: `onerror` carries no status and is always followed by `onclose`, so the
      // single failure below is reported from `onclose`. Emitting both doubled the failure and
      // made the client look like it had retried. (Web cannot distinguish 401/403 at this layer;
      // see the note on `failOnce`.)
      this.options.trace?.('web transport socket error (reported on close)');
    };
    socket.onclose = (event: CloseEvent) => {
      const wasOpen = this.open;
      this.open = false;
      if (!wasOpen && !this.closed) {
        // Exactly one `connect-failed` for a socket that never opened.
        this.emit({
          type: 'error',
          code: TRANSPORT_ERROR.connectFailed,
          message: event.reason || 'The connection closed before it opened',
          details: { closeCode: event.code },
        });
      }
      this.emit({ type: 'close', code: event.code, reason: event.reason, wasClean: event.wasClean });
    };
  }

  /**
   * Report a pre-open failure exactly once (error + close), the shape `onclose` produces.
   *
   * NOTE FOR THE CLIENT: web cannot read the HTTP status of a refused upgrade, so an auth refusal
   * (401), a disabled gateway (403) and a plain network failure all arrive here as
   * `client/connect-failed`. The client's own rule — several failures before `open` may mean the
   * device needs to pair again — is therefore the honest hint, and the UI shows it; the web
   * transport cannot be more specific without a custom header the browser will not send.
   */
  private failOnce(code: string, message: string, reason: string, closeCode = 1006): void {
    if (this.failureReported) return;
    this.failureReported = true;
    this.emit({ type: 'error', code, message });
    this.emit({ type: 'close', code: closeCode, reason, wasClean: false });
  }

  send(data: string): boolean {
    if (!this.open || this.socket === null || this.closed) return false;
    try {
      this.socket.send(data);
      return true;
    } catch {
      return false;
    }
  }

  close(code = 1000, reason = 'client-close'): void {
    this.closed = true;
    this.open = false;
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    try {
      socket.close(code, reason);
    } catch {
      // Already gone: nothing to release.
    }
  }

  on(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const createPinnedTransport = (options: CreatePinnedTransportOptions = {}): Transport =>
  new PinnedTransport(options);

export type { TransportEvent };
