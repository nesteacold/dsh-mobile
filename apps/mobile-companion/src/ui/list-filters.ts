// List filters for the `⋯` menu — Date and Status (Clarklevis parity).
//
// WHY a module rather than inline predicates: the menu can only honestly offer a filter when the
// data behind it exists. `archived` needs `session-archives` / `archivedSessionIds` (the gateway
// sends them, `plugins/mobile-gateway/lib/index.mjs:123-125`, but this app does not consume the frame
// yet) and "online" needs a per-session reachability field the wire does not carry at all. Those two
// are therefore gated by `listFilterCapabilities()` and stay OUT of the menu until the data lands —
// a dead menu row is worse than an absent one.

import type { SessionSummary } from '../core/sessions';

/** Date buckets offered by the menu. */
export type ListDateFilter = 'any' | 'today' | 'week' | 'older';

/** Status buckets offered by the menu. Every one is backed by a measured field. */
export type ListStatusFilter = 'any' | 'running' | 'idle' | 'decision';

export interface ListFilters {
  date: ListDateFilter;
  status: ListStatusFilter;
}

export const DEFAULT_LIST_FILTERS: ListFilters = { date: 'any', status: 'any' };

/** All offered values, in menu order. */
export const DATE_FILTERS: readonly ListDateFilter[] = ['any', 'today', 'week', 'older'];
export const STATUS_FILTERS: readonly ListStatusFilter[] = ['any', 'running', 'idle', 'decision'];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight of the day `at` falls in, in the device's own timezone. */
function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Keep sessions whose last activity falls in the chosen bucket.
 *
 * `now` is injected so the buckets are testable and so a caller can freeze time: "today" means the
 * calendar day on the device, not 24 hours ago, because that is what a person means by it.
 */
export function filterByDate(
  sessions: readonly SessionSummary[],
  filter: ListDateFilter,
  now: number,
): SessionSummary[] {
  if (filter === 'any') return [...sessions];
  const todayStart = startOfDay(now);
  const weekStart = todayStart - 6 * DAY_MS;
  return sessions.filter((session) => {
    const at = typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
      ? session.updatedAt
      : null;
    // No timestamp is not "old": it cannot be placed in ANY bucket, so it is kept only by 'any'
    // (handled above) and dropped from every dated bucket, which is honest rather than guessed.
    if (at === null) return false;
    if (filter === 'today') return at >= todayStart;
    if (filter === 'week') return at >= weekStart;
    return at < weekStart; // 'older'
  });
}

/**
 * Keep sessions in the chosen state.
 *
 * `decision` is `needsDecision`, which is a different axis from `state` (a running session can be
 * waiting for an approval), so it is checked first and does not look at `state`.
 */
export function filterByStatus(
  sessions: readonly SessionSummary[],
  filter: ListStatusFilter,
): SessionSummary[] {
  if (filter === 'any') return [...sessions];
  if (filter === 'decision') return sessions.filter((session) => session.needsDecision === true);
  return sessions.filter((session) => session.state === filter);
}

/** Apply both menus. Order is irrelevant (both are pure predicates). */
export function applyListFilters(
  sessions: readonly SessionSummary[],
  filters: ListFilters,
  now: number,
): SessionSummary[] {
  return filterByStatus(filterByDate(sessions, filters.date, now), filters.status);
}

/** True when a filter is narrowing the list, so the screen can offer "clear". */
export function hasActiveFilters(filters: ListFilters): boolean {
  return filters.date !== 'any' || filters.status !== 'any';
}

/**
 * Which optional filters the data actually supports.
 *
 * Both are FALSE today, and that is the point of the function: the menu reads it, so the two rows
 * appear by themselves the moment the underlying data exists, and nothing has to remember to unhide
 * them. Unlock conditions are documented beside each field.
 */
export interface ListFilterCapabilities {
  /** Needs `session-archives` / `archivedSessionIds` consumed into the session rows. */
  archived: boolean;
  /** Needs a per-session reachability field (the wire has none; `running` is NOT "online"). */
  online: boolean;
}

export const LIST_FILTER_CAPABILITIES: ListFilterCapabilities = {
  archived: false,
  online: false,
};

/** Does any row carry an explicit archive marker? (Used to flip `archived` on when it lands.) */
export function detectArchiveCapability(sessions: readonly SessionSummary[]): boolean {
  return sessions.some((session) => session.state === 'archived');
}
