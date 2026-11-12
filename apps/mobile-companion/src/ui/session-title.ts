// Session display title — ONE helper for every place a session name is shown.
//
// Device defect: the header of a just-created session read
// `session-de1cb815-5a53-4dcb-8cd8-b64e53773df4`. A brand-new session genuinely has no Host title
// yet, and the wire id is not a name — it is a coordinate. Every surface (conversation header, recent
// rows on the workspace tab, conversation rows) now goes through this helper, so:
//   * a real Host title is shown the moment it exists (nothing is cached or invented);
//   * with no title, a human, localized label is shown instead, plus when it was created;
//   * the id is never rendered as content (it stays reachable via the route/testID, not as text).

import type { Locale, MessageKey } from '../../i18n';

/** Interpolator the screens already have (`useApp().tr`). */
type Tr = (key: MessageKey, params?: Record<string, string | number>) => string;

/** True when the Host has not reported a usable title for this session yet. */
export function sessionTitleMissing(title: string | undefined | null): boolean {
  return title === undefined || title === null || title.trim() === '';
}

/**
 * Titles are derived from the user's prompt, which is markdown: on device they rendered as
 * `# dsh-wiki worker protocol (Host-pinned,`. Strip leading heading markers and collapse the
 * whitespace a wrapped title leaves behind. Inner text is untouched.
 */
export function cleanSessionTitle(title: string): string {
  return title
    .replace(/^[\s#>*_-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What the user sees as the session's name.
 *
 * An untitled session shows the localized "New session" label and NOTHING else: the reference list
 * carries no timestamps, and a relative time in the title read as a clock time in Vietnamese
 * ("Phiên mới · 11 giờ" = "11 o'clock" rather than "11 hours ago"). The creation time is available
 * inside the session screen.
 *
 * `_locale`/`_now` are kept in the signature so call sites and tests stay stable.
 */
export function sessionDisplayTitle(
  session: { readonly title?: string; readonly updatedAt?: number },
  tr: Tr,
  _locale?: Locale,
  _now?: number,
): string {
  const title = session.title === undefined ? '' : cleanSessionTitle(session.title);
  if (title !== '') return title;
  return tr('session.untitled');
}
