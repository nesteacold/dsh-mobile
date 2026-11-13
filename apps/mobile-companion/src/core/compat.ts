// Spec 029 — capability / version mismatch decision (pure; no platform imports).
//
// Reuses what `hello` already carries (contract §3.5): `companionProtocol` (the major line),
// `minClientVersion`, and `capabilities`. The blocking major case is ALREADY enforced by
// `client.ts` `handleHello` -> `requireUpdate` (no `client-hello`, so no session action is sent);
// this module only classifies the same facts so the UI can say so, plus the non-blocking cases.

import { CAPABILITIES, COMPANION_PROTOCOL_VERSION, OPTIONAL_CAPABILITIES } from '@dsh-ext/mobile-protocol';

export type CompatDecision =
  | { kind: 'malformed' }
  | { kind: 'incompatible'; appVersion: number; gatewayVersion: number; side: 'app' | 'host' }
  | {
      kind: 'ok';
      /** Capabilities this app does not know: the gateway is newer. Non-blocking, dismissible. */
      unknownCapabilities: string[];
      /** Baseline capabilities the gateway did not advertise: the gateway is older. */
      missingCapabilities: string[];
      /** Dismiss key for the "newer" banner: gateway id + its unknown capability set. */
      dismissKey: string | null;
    };

const KNOWN: ReadonlySet<string> = new Set<string>([...CAPABILITIES, ...OPTIONAL_CAPABILITIES]);

export function decideCompat(hello: unknown, appVersion: number = COMPANION_PROTOCOL_VERSION): CompatDecision {
  if (hello === null || typeof hello !== 'object') return { kind: 'malformed' };
  const h = hello as Record<string, unknown>;
  const gatewayVersion = h.companionProtocol;
  // `client.ts` normalizes a missing/non-numeric `companionProtocol` to -1: any negative value is
  // therefore "the host did not say", i.e. malformed — never an "incompatible v-1".
  if (typeof gatewayVersion !== 'number' || !Number.isInteger(gatewayVersion) || gatewayVersion < 0) {
    return { kind: 'malformed' };
  }
  if (!Array.isArray(h.capabilities)) return { kind: 'malformed' };
  // Same default as the client normalization (-1 = absent, never above the app).
  const min = typeof h.minClientVersion === 'number' ? h.minClientVersion : -1;
  if (gatewayVersion !== appVersion || min > appVersion) {
    const side = min > appVersion || gatewayVersion > appVersion ? 'app' : 'host';
    return { kind: 'incompatible', appVersion, gatewayVersion, side };
  }
  const caps = h.capabilities.filter((c): c is string => typeof c === 'string');
  const unknownCapabilities = [...new Set(caps.filter((c) => !KNOWN.has(c)))].sort();
  const missingCapabilities = CAPABILITIES.filter((c) => !caps.includes(c));
  const gatewayId = typeof h.gatewayId === 'string' ? h.gatewayId : '';
  return {
    kind: 'ok',
    unknownCapabilities,
    missingCapabilities: [...missingCapabilities],
    dismissKey: unknownCapabilities.length === 0 ? null : `${gatewayId}|${typeof h.protocol === 'number' ? h.protocol : ''}|${unknownCapabilities.join(',')}`,
  };
}
