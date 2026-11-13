// PairedHost record: everything the app needs to reconnect without the QR, minus the secret.
// The device token lives ONLY in the secure store (`src/platform/secure-store.ts`); this
// record is safe to keep in a plain key-value store and safe to log (no token, no code).
//
// Pure: no react-native/expo/Node imports.

import type { PairingPayload } from '@dsh-ext/mobile-protocol';

import { redactString } from './redact';

export const PAIRED_HOST_SCHEMA_VERSION = 1;

export interface PairedHost {
  schemaVersion: typeof PAIRED_HOST_SCHEMA_VERSION;
  /** `gatewayId` from the QR: stable identity of one host across addresses and restarts. */
  gatewayId: string;
  /** `gatewayName` from the QR (display only, never an identity). */
  name: string;
  /** `publicUrl` from the QR: the address this pairing used (`wss://`). */
  publicUrl: string;
  /** Every `wss://` address the host offered; the first is `publicUrl`. */
  endpoints: string[];
  /** Pinned TLS leaf SHA-256 (64 lowercase hex) — the only certificate this host may present. */
  certSha256: string;
  /** Server-side device id confirmed by `paired`/`hello`. */
  deviceId: string;
  /** Display name we sent while pairing. */
  deviceName: string;
  /** Epoch ms of the successful pairing. */
  pairedAt: number;
}

/**
 * Build the record from a decoded QR payload (before the `paired` answer fills `deviceId`).
 *
 * `gatewayId` may be empty: an OTP pairing has no QR, so the Host's id is not known until its
 * `hello` arrives. `gatewayIdFromHello` below then supplies it, and `isReconnectable` refuses a
 * record that still has none — a host record without an id cannot be looked up or revoked.
 */
export function pairedHostFromPayload(
  payload: Pick<PairingPayload, 'gatewayId' | 'gatewayName' | 'publicUrl' | 'endpoints' | 'certSha256'>,
  device: { id: string; name: string },
  pairedAt: number,
  gatewayIdFromHello?: string,
): PairedHost {
  // Contract §3.5: `hello.gatewayId` is the Host's own statement of its identity. It wins when the
  // payload has none (OTP pairing); a payload pairing keeps the QR's id, which the Host already
  // agreed to by accepting that code.
  const gatewayId = payload.gatewayId !== '' ? payload.gatewayId : (gatewayIdFromHello ?? '');
  return {
    schemaVersion: PAIRED_HOST_SCHEMA_VERSION,
    gatewayId,
    name: payload.gatewayName,
    publicUrl: payload.publicUrl,
    endpoints: [...payload.endpoints],
    certSha256: payload.certSha256,
    deviceId: device.id,
    deviceName: device.name,
    pairedAt,
  };
}

/** True when the stored record can drive an authenticated connection. */
export function isReconnectable(host: PairedHost | null): host is PairedHost {
  return host !== null
    && host.schemaVersion === PAIRED_HOST_SCHEMA_VERSION
    && host.gatewayId !== ''
    && /^wss:\/\//.test(host.publicUrl)
    && /^[0-9a-f]{64}$/.test(host.certSha256)
    && host.deviceId.length > 0;
}

/** JSON-safe copy for logs / support screens: no token (never stored here), no full pin. */
export function describeHost(host: PairedHost): Record<string, unknown> {
  return {
    gatewayId: host.gatewayId,
    name: redactString(host.name),
    publicUrl: redactString(host.publicUrl),
    certSha256: `${host.certSha256.slice(0, 8)}…`,
    deviceId: host.deviceId,
    pairedAt: host.pairedAt,
  };
}
