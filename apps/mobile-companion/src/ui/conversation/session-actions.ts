// Session rename / archive — the parts that are pure policy, so the two files that own the surface
// (`app/(tabs)/index.tsx` row long-press and `src/app-state.ts` accessor) can stay thin.
//
// WHY here: my declared write scope is `app/session/**`, `src/ui/conversation/**`, `src/ui/markdown/**`
// and `src/core/history.ts`; the list screen and app-state belong to other agents this round, so the
// decisions live in my scope and the callers only call.
//
// The rule from spec 011 (line 65) is "no button without something behind it": a control whose
// operation the Host does not serve must be ABSENT, not drawn disabled. There is no per-op capability
// string today — the contract advertises only `CAPABILITIES` = ['sessions-read','prompt','cancel',
// 'approval-v1'] plus OPTIONAL `push-v1` / `browser-agent:1`, and `session-rename` / `session-archive`
// are not in the contract at all (measured: grep over `packages/mobile-protocol/src` returns nothing).
// So the predicates below ask for the capability names that the contract revision will add. Until it
// lands, they return false and the menu stays hidden — which is the correct state, not a gap to paper
// over with a disabled row.

/** Names the Host must advertise before the corresponding control may exist. */
export const SESSION_RENAME_CAPABILITY = 'session-rename';
export const SESSION_ARCHIVE_CAPABILITY = 'session-archive';

/** The gateway refuses a blank title and would store an unbounded one; the Host title field is free text. */
export const MAX_TITLE_CHARS = 200;

/** Trimmed title: what would actually be sent. */
export function normalizeTitle(raw: string): string {
  return raw.trim();
}

export type TitleProblem = 'empty' | 'too-long';

/**
 * Why a title cannot be saved, or `null` when it can.
 *
 * Length is measured AFTER trimming, so trailing whitespace never makes an over-long title pass.
 * The limit is counted in code points (`Array.from`) rather than UTF-16 units, so a two-unit emoji
 * counts as one character — otherwise a title of 200 emoji would be refused while looking short.
 */
export function titleProblem(raw: string): TitleProblem | null {
  const trimmed = normalizeTitle(raw);
  if (trimmed === '') return 'empty';
  if (Array.from(trimmed).length > MAX_TITLE_CHARS) return 'too-long';
  return null;
}

/** True only when the Host advertised the rename op. A malformed capability list grants nothing. */
export function canRenameSession(capabilities: readonly string[] | null | undefined): boolean {
  return Array.isArray(capabilities) && capabilities.includes(SESSION_RENAME_CAPABILITY);
}

/** True only when the Host advertised the archive op. */
export function canArchiveSession(capabilities: readonly string[] | null | undefined): boolean {
  return Array.isArray(capabilities) && capabilities.includes(SESSION_ARCHIVE_CAPABILITY);
}

/**
 * The exact frames the accessor must send. Built here so the two call sites cannot drift, and so a
 * missing id is caught before it reaches the wire (the gateway answers `bad-request` for a blank id,
 * which would surface as a confusing generic error instead of the caller's bug).
 */
export function renameFrame(sessionId: string, raw: string): { sessionId: string; title: string } {
  const id = sessionId.trim();
  if (id === '') throw new Error('session-rename needs a session id');
  const title = normalizeTitle(raw);
  const problem = titleProblem(title);
  if (problem !== null) throw new Error(`session-rename title is ${problem}`);
  return { sessionId: id, title };
}

export function archiveFrame(sessionId: string): { sessionId: string } {
  const id = sessionId.trim();
  if (id === '') throw new Error('session-archive needs a session id');
  return { sessionId: id };
}

export type SessionActionKey =
  | 'sessionActions.rename'
  | 'sessionActions.archive'
  | 'sessionActions.renameTitle'
  | 'sessionActions.renameEmpty'
  | 'sessionActions.renameTooLong'
  | 'sessionActions.save'
  | 'sessionActions.archiveConfirm'
  | 'sessionActions.archiveConfirmBody'
  | 'sessionActions.errorNotFound'
  | 'sessionActions.errorAuth'
  | 'sessionActions.errorGeneric';

/**
 * Map a failure CODE to copy. The Host's `message` is never shown — it is an internal string, and this
 * session has paid for that lesson more than once.
 */
export function sessionActionErrorKey(code: string | null | undefined): SessionActionKey {
  if (code === 'session/not-found') return 'sessionActions.errorNotFound';
  if (typeof code === 'string' && code.startsWith('auth/')) return 'sessionActions.errorAuth';
  return 'sessionActions.errorGeneric';
}
