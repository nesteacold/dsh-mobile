// Spec 018 item 3 — the READ-ONLY schedule frames (`schedule:read`, revision 12).
//
// CONTRACT (authoritative text: `packages/mobile-protocol/src/index.mjs:691-704`; Host side:
// `plugins/mobile-gateway/lib/schedule-management.mjs:40-68` and
// `plugins/mobile-gateway/lib/dsh-host-adapter.mjs:519-533`; reply example in
// `plugins/mobile-gateway/PROTOCOL.md:1674-1694` and
// `plugins/mobile-gateway/docs/dsh-0.2.2-rc.1-mobile-integration.md:112-125`):
//
//   request  { type: 'schedule-catalog', requestId }                          -> { kind, items }
//   request  { type: 'schedule-list', requestId, active?, limit?, offset? }   -> { kind, items, shown?, total?, limit?, offset? }
//   request  { type: 'schedule-view', requestId, id }                         -> { kind, ...one task record }
//
// host-wide: schedules are NOT a session resource, so `active`/`limit`/`offset` are only legal on
// `schedule-list` without a `sessionId` (the app never sends one), and the scope IS the boundary.
// A `schedule-view` that names a task the Host does not have answers `{ kind, id, code }` with code
// `schedule_not_found` (a structured answer, not `{ kind: 'error' }`).
//
// These are not contract §4 operations (`OPS` is unchanged) and they are the ONLY schedule types a
// device may issue: every write (`schedule-create/edit/update/delete/run/delete-inactive`) and
// `schedule-history` stay `op/forbidden` whatever the device holds — this module has no path to them.
// A refusal (missing scope, a write-only family, a malformed reply) REJECTS with a `CoreError`
// carrying the Host's code; the Host's `message` is never rendered.

import { SCHEDULE_READ_CLIENT_TYPES, SCHEDULE_READ_SCOPE, type Op } from '@dsh-ext/mobile-protocol';

import type { CompanionClient } from './client';
import { CoreError } from './errors';

export { SCHEDULE_READ_CLIENT_TYPES, SCHEDULE_READ_SCOPE };

/** The three read types this module owns. Derived from the contract so a new one cannot be missed. */
export type ScheduleReadType = (typeof SCHEDULE_READ_CLIENT_TYPES)[number];

/** `schedule-list` page size the app asks for: the gateway's maximum (1..500). */
export const SCHEDULE_PAGE_LIMIT = 500;

/**
 * One scheduled task, reduced to the fields an app can honestly draw.
 *
 * The rule fields (`scheduledAt`, `everySeconds`, `time`, `weekdays`, `expression`, `rrule`, …) and
 * `nextRunAt` are passed through as the Host sent them; the UI summarises them and never re-derives
 * a run time. Unknown rule kinds are kept as their `kind` string (the integration note asks clients to
 * treat them read-only).
 */
export interface ScheduledTask {
  readonly id: string;
  /** The Host's rule kind (`after`/`at`/`every`/`daily`/`weekly`/`cron`/`rrule`, …). */
  readonly kind: string | null;
  readonly title: string | null;
  /** `active` / `paused` / `ended`, or whatever the Host names; `null` when absent. */
  readonly status: string | null;
  readonly active: boolean;
  readonly everySeconds: number | null;
  readonly time: string | null;
  readonly timeZone: string | null;
  /** Host weekday numbering (1 = Monday … 7 = Sunday), as sent. */
  readonly weekdays: number[];
  readonly expression: string | null;
  readonly scheduledAt: string | null;
  /** Next run in epoch ms; shown as given, never computed here. */
  readonly nextRunAt: number | null;
  readonly updatedAt: string | null;
  readonly targetSessionId: string | null;
}

/** One `schedule-catalog` row: the rule types the Host can schedule, with no user data. */
export interface ScheduleCatalogEntry {
  readonly kind: string;
  readonly label: string | null;
}

export interface ScheduleCatalog {
  readonly state: 'ready';
  readonly items: ScheduleCatalogEntry[];
}

export interface ScheduleList {
  readonly state: 'ready';
  readonly items: ScheduledTask[];
  /** Present only when the Host paginated (`schedule-list` host-wide reply). */
  readonly total: number | null;
  readonly offset: number | null;
  readonly limit: number | null;
}

export type ScheduleViewResult =
  | { readonly state: 'ready'; readonly task: ScheduledTask }
  /** `schedule_not_found`: the Host answered `{ id, code }` — the task is gone, not a fault. */
  | { readonly state: 'not-found' };

/** One request path: send the frame, refuse a Host error frame, require the matching `kind`. */
async function requestScheduleRead(
  client: CompanionClient,
  type: ScheduleReadType,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reply = await client.request(type as Op, params, { allowNonOpType: true });
  if (reply.kind === 'error') {
    throw new CoreError({
      code: typeof reply.code === 'string' ? (reply.code as never) : 'internal',
      message: typeof reply.message === 'string' ? reply.message : 'The computer refused the schedule read',
      details: { type },
    });
  }
  // `schedule-view` is the ONE exception: the gateway answers `{ kind: msg.type, ...record }`
  // (`schedule-management.mjs:96`), and the task record's own rule `kind` lands on top of the
  // envelope — measured against the real handler. So a view reply is identified by its `id`
  // (`toScheduleView` does that and rejects another task's record); only catalog/list carry a `kind`.
  if (type !== 'schedule-view' && reply.kind !== type) {
    throw new CoreError({ code: 'client/bad-message', message: `Expected a ${type} reply`, details: { type, kind: reply.kind } });
  }
  return reply;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function weekdays(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 7)
    : [];
}

/**
 * One task record. `id` is the only required member: a row without one cannot be opened or re-read,
 * so it is dropped from a list (never drawn as a task with a blank identity). Everything else is
 * reduced to what the UI draws; a missing field stays `null` instead of being invented.
 */
export function parseScheduledTask(value: unknown): ScheduledTask | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id);
  if (id === null) return null;
  const target = typeof raw.target === 'object' && raw.target !== null ? raw.target as Record<string, unknown> : null;
  return {
    id,
    kind: text(raw.kind),
    title: text(raw.title),
    status: text(raw.status),
    active: raw.active === true,
    everySeconds: number(raw.everySeconds),
    time: text(raw.time),
    timeZone: text(raw.timeZone),
    weekdays: weekdays(raw.weekdays),
    expression: text(raw.expression),
    scheduledAt: text(raw.scheduledAt),
    nextRunAt: number(raw.nextRunAt),
    updatedAt: text(raw.updatedAt),
    targetSessionId: target === null ? null : text(target.sessionId),
  };
}

function parseCatalogEntry(value: unknown): ScheduleCatalogEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const kind = text(raw.kind);
  if (kind === null) return null;
  return { kind, label: text(raw.label) };
}

/** `schedule-catalog` reply → the rule types the Host can schedule. */
export function toCatalog(reply: Record<string, unknown>): ScheduleCatalog {
  if (!Array.isArray(reply.items)) {
    throw new CoreError({ code: 'client/bad-message', message: 'The schedule catalog had an unexpected shape' });
  }
  const items: ScheduleCatalogEntry[] = [];
  for (const entry of reply.items) {
    const parsed = parseCatalogEntry(entry);
    if (parsed !== null) items.push(parsed);
  }
  return { state: 'ready', items };
}

/** `schedule-list` reply → the tasks, with the Host's page counters when it sent them. */
export function toScheduleList(reply: Record<string, unknown>): ScheduleList {
  if (!Array.isArray(reply.items)) {
    throw new CoreError({ code: 'client/bad-message', message: 'The schedule list had an unexpected shape' });
  }
  const items: ScheduledTask[] = [];
  for (const entry of reply.items) {
    const parsed = parseScheduledTask(entry);
    if (parsed !== null) items.push(parsed);
  }
  return {
    state: 'ready',
    items,
    total: number(reply.total),
    offset: number(reply.offset),
    limit: number(reply.limit),
  };
}

/**
 * `schedule-view` reply → the task, or `not-found` when the Host answered `{ id, code }`.
 * Any other shape (no `id`) is a contract violation and rejects.
 */
export function toScheduleView(reply: Record<string, unknown>, taskId: string): ScheduleViewResult {
  if (typeof reply.id !== 'string' || reply.id !== taskId) {
    throw new CoreError({ code: 'client/bad-message', message: 'The schedule reply was for a different task', details: { taskId } });
  }
  if (typeof reply.code === 'string') {
    if (reply.code === 'schedule_not_found') return { state: 'not-found' };
    throw new CoreError({
      code: reply.code as never,
      message: 'The computer could not show this scheduled task',
      details: { type: 'schedule-view', taskId },
    });
  }
  const task = parseScheduledTask(reply);
  if (task === null) {
    throw new CoreError({ code: 'client/bad-message', message: 'The scheduled task was missing from the reply' });
  }
  return { state: 'ready', task };
}

/** Read the Host's rule catalog (`schedule-catalog`). */
export async function readScheduleCatalog(client: CompanionClient): Promise<ScheduleCatalog> {
  return toCatalog(await requestScheduleRead(client, 'schedule-catalog', {}));
}

/**
 * Read one page of the Host-wide list (`schedule-list`).
 *
 * `active` is only sent when the caller has a real filter: the gateway refuses `active` together with
 * a `limit` that is out of range, and it treats an omitted `active` as "every task". `limit`/`offset`
 * are bounded here before the wire so a bad call is our bug and not a `bad-request` round trip.
 */
export async function readScheduleList(
  client: CompanionClient,
  options: { active?: boolean; limit?: number; offset?: number } = {},
): Promise<ScheduleList> {
  const limit = options.limit ?? SCHEDULE_PAGE_LIMIT;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SCHEDULE_PAGE_LIMIT || !Number.isSafeInteger(offset) || offset < 0) {
    throw new CoreError({ code: 'client/bad-state', message: 'The schedule page must be within 1..500 at a nonnegative offset' });
  }
  const params: Record<string, unknown> = { limit, offset };
  if (typeof options.active === 'boolean') params.active = options.active;
  return toScheduleList(await requestScheduleRead(client, 'schedule-list', params));
}

/** Read one scheduled task (`schedule-view`). */
export async function readScheduleView(client: CompanionClient, taskId: string): Promise<ScheduleViewResult> {
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  if (id === '') throw new CoreError({ code: 'client/bad-state', message: 'A task id is required to read one scheduled task' });
  return toScheduleView(await requestScheduleRead(client, 'schedule-view', { id }), id);
}

/**
 * The read-only schedule frames are lifted by `schedule:read`, an explicit-only scope that is in
 * `NEVER_DEFAULT_SCOPES` — so the device's own granted scopes ARE the gate, and a Host that did not
 * grant it never receives these frames. An absent scope list grants nothing (fail closed).
 */
export function hasScheduleReadScope(scopes: readonly string[] | null | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes(SCHEDULE_READ_SCOPE);
}
