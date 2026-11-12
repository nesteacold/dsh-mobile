// Session title search (reference: Clarklevis `SessionSearch` / `LocalChatSearchContent`).
//
// A pure filter so it can be unit-tested without a renderer: the list screen owns the input, this
// owns the matching rules. Two deliberate choices:
//
//   * it matches the DISPLAY title (`sessionDisplayTitle`), not the raw wire field, so what the user
//     types is what they see — an untitled session is found by "New session"/"Phiên mới" too;
//   * it is case- and accent-insensitive for Vietnamese. DSH session titles are often Vietnamese and
//     typing "phien" must find "Phiên", which a plain `toLowerCase()` does not do.

import type { Locale } from '../../i18n';
import type { SessionSummary } from '../core/sessions';
import { sessionDisplayTitle } from './session-title';

type Tr = (key: import('../../i18n').MessageKey, params?: Record<string, string | number>) => string;

/** Lowercase and strip Vietnamese diacritics so unaccented typing still matches. */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    // Combining marks: the accents themselves.
    .replace(/[\u0300-\u036f]/g, '')
    // `đ`/`Đ` are single code points with no decomposition, so they are folded explicitly.
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

/**
 * Sessions whose display title contains `query`. An empty/blank query matches everything (the list
 * reverts to its normal grouping rather than showing an empty result).
 */
export function filterSessionsByTitle(
  sessions: readonly SessionSummary[],
  query: string,
  tr: Tr,
  locale: Locale,
): readonly SessionSummary[] {
  const needle = foldForSearch(query);
  if (needle === '') return sessions;
  return sessions.filter((session) => foldForSearch(sessionDisplayTitle(session, tr, locale)).includes(needle));
}
