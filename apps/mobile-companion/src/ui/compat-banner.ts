// Spec 029: map a compat decision to the one banner the home screen shows (pure).

import type { MessageKey } from '../../i18n';
import type { CompatDecision } from '../core/compat';

export interface CompatBannerView {
  key: MessageKey;
  params?: Record<string, string | number>;
  blocking: boolean;
  tone: 'warn' | 'info';
  /** Non-null only for the dismissible "gateway is newer" banner. */
  dismissKey: string | null;
}

export function compatBannerView(
  compat: CompatDecision | null,
  dismissed: ReadonlySet<string>,
): CompatBannerView | null {
  if (compat === null) return null;
  if (compat.kind === 'malformed') return { key: 'compat.malformed', blocking: true, tone: 'warn', dismissKey: null };
  if (compat.kind === 'incompatible') {
    return {
      key: 'compat.incompatible',
      params: { app: compat.appVersion, gateway: compat.gatewayVersion },
      blocking: true,
      tone: 'warn',
      dismissKey: null,
    };
  }
  if (compat.missingCapabilities.length > 0) {
    return {
      key: 'compat.missing',
      params: { caps: compat.missingCapabilities.join(', ') },
      blocking: false,
      tone: 'warn',
      dismissKey: null,
    };
  }
  if (compat.dismissKey !== null && !dismissed.has(compat.dismissKey)) {
    return {
      key: 'compat.newer',
      params: { caps: compat.unknownCapabilities.join(', ') },
      blocking: false,
      tone: 'info',
      dismissKey: compat.dismissKey,
    };
  }
  return null;
}
