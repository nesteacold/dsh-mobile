// Spec 019 Wave 3 — permission control, view + lower-only (app half).
//
// CONTRACT (authoritative text: `packages/mobile-protocol/index.d.ts:214-269`; Host side:
// `plugins/mobile-gateway/lib/permission-lower.mjs`):
//
//   request  { type: 'permission-options', requestId, sessionId }
//     reply  { kind: 'permission-options', requestId, sessionId, currentValue, options: [{ preset, sandbox, approval }] }
//   request  { type: 'permission-lower', requestId, sessionId, preset }
//     reply  { kind: 'permission-lower', requestId, sessionId, preset, currentValue, accepted: true }
//          | { kind: 'permission-lower', requestId, sessionId, currentValue, accepted: false, reason }
//   error    { kind: 'error', code, requestType, sessionId?, message }   — code = one of the four reasons, or bad-request
//
// WHAT THE APP MAY AND MAY NOT DO with that:
//   * it sends a PRESET NAME, never a command line. The desktop's `/permission` command is not a
//     companion surface and this module has no path to `commands/execute`;
//   * it FILTERS NOTHING: the gateway already computed the list and offers only presets strictly
//     stricter on one axis and looser on none. A reply is taken as the Host's statement; a preset the
//     reply did not offer is never shown as an option;
//   * a DESKTOP preset row (`permissionPresets.catalog`) has NO description member — measured on
//     0.2.2-rc.1 (dsh-permission-presets/lib/index.js:145-158 is `name → { sandbox, approval }`), so
//     none of these functions invents one. The sheet's "description" is a fixed `sandbox/approval`
//     pair label composed locally, and the preset NAME itself is rendered as data.
//
// The same rule as `team.ts`: these types are not contract §4 ops (`OPS` is unchanged), so they go
// through the client's explicit `allowNonOpType` opt-in, never a loosened allowlist. A Host that
// does not advertise `permission-lower` is never sent either frame — that check lives in
// `AppController` (the screen also hides the chip, two defences for one rule).

import { PERMISSION_LOWER_CAPABILITY, PERMISSION_LOWER_REASONS, type PermissionLowerReason, type PermissionOption } from '@dsh-ext/mobile-protocol';

import type { CompanionClient } from './client';
import { CoreError } from './errors';

export { PERMISSION_LOWER_CAPABILITY, PERMISSION_LOWER_REASONS };
export type { PermissionLowerReason, PermissionOption };

/** Fixed copy slots the receipt renders. The app never shows the Host's `message` (internal text). */
export type PermissionLowerMessage =
  | 'session.permissionNotStricter'
  | 'session.permissionCustomCurrent'
  | 'session.permissionRaced'
  | 'session.permissionUnavailable'
  | 'session.permissionError';

/**
 * One receipt's outcome: whether the switch took, what the preset is now, and — for a refusal —
 * which of the fixed sentences to show. `currentValue` is the Host's own re-read (`null` when it
 * could not name one), shown as the chip's data, never substituted by a label.
 */
export type PermissionLowerOutcome =
  | { readonly accepted: true; readonly preset: string; readonly currentValue: string | null }
  | {
      readonly accepted: false;
      /** One of the four contract reasons, or `null` for a refusal that carried no usable one. */
      readonly reason: PermissionLowerReason | null;
      readonly code: string;
      readonly currentValue: string | null;
      readonly message: PermissionLowerMessage;
    };

/** The read: the preset in effect plus the strictly-stricter options the Host offers. */
export interface PermissionOptionsView {
  readonly currentValue: string | null;
  readonly options: readonly PermissionOption[];
}

export type PermissionOptionsResult =
  | { readonly state: 'ready'; readonly value: PermissionOptionsView }
  /**
   * The Host cannot serve these ops: no `permission-lower` capability, no usable preset service,
   * or a session it does not hold live. Not an error the user should read as a fault.
   */
  | { readonly state: 'unavailable' };

const SANDBOX_ORDER = ['read-only', 'workspace-write', 'danger-full-access'] as const;
const APPROVAL_ALLOW_LIST = ['ask', 'never'] as const;

function isReason(value: unknown): value is PermissionLowerReason {
  return typeof value === 'string' && (PERMISSION_LOWER_REASONS as readonly string[]).includes(value);
}

/** A fixed pair as the contract declares it, or `null` when a field is outside that set. */
function coerceOption(raw: unknown): PermissionOption | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.preset !== 'string' || row.preset === '') return null;
  if (typeof row.sandbox !== 'string' || !(SANDBOX_ORDER as readonly string[]).includes(row.sandbox)) return null;
  if (typeof row.approval !== 'string' || !(APPROVAL_ALLOW_LIST as readonly string[]).includes(row.approval)) return null;
  return { preset: row.preset, sandbox: row.sandbox as PermissionOption['sandbox'], approval: row.approval as PermissionOption['approval'] };
}

/** `currentValue` is a preset name or nothing: anything else is read as "the Host named none". */
function coerceCurrentValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Two envelope checks every reply must pass: it names THIS session (a reply about another one would
 * repaint the wrong header), and a `auth/*` code is the device's own grant, which rejects rather than
 * becoming a receipt sentence (this Host no longer lets this device read or write presets).
 */
function replyIsFor(reply: Record<string, unknown>, type: string, sessionId: string): void {
  if (reply.sessionId !== undefined && reply.sessionId !== sessionId) {
    // A reply about another session would be attached to the wrong header.
    throw new CoreError({
      code: 'client/bad-message',
      message: `The ${type} reply was for a different session`,
      details: { type, sessionId, replySessionId: reply.sessionId },
    });
  }
  if (typeof reply.code === 'string' && reply.code.startsWith('auth/')) {
    throw new CoreError({ code: reply.code as never, message: `The Host refused the ${type}`, details: { type, sessionId } });
  }
}

/** The options the app can offer from a `ready` reply: well-formed pairs only, order preserved. */
export function toOptionsView(reply: Record<string, unknown>): PermissionOptionsView {
  const options: PermissionOption[] = [];
  const raw = Array.isArray(reply.options) ? reply.options : [];
  for (const entry of raw) {
    const option = coerceOption(entry);
    // The gateway never sends an unusable pair; dropping one here would silently hide an option
    // the Host believes it offered, so it is a contract violation instead of a shorter list.
    if (option === null) {
      throw new CoreError({ code: 'client/bad-message', message: 'The preset list had an unexpected shape' });
    }
    options.push(option);
  }
  return { currentValue: coerceCurrentValue(reply.currentValue), options };
}

/**
 * One `permission-lower` reply, whichever side of the contract it is:
 *   * `{ kind: 'permission-lower', accepted: true, preset, currentValue }` → accepted;
 *   * `{ kind: 'permission-lower', accepted: false, reason, currentValue }` → a receipt refusal;
 *   * `{ kind: 'error', code, requestType }` → a frame refusal carrying one of the four codes.
 * Anything else is a contract violation and rejects, because a switch that silently did nothing is
 * worse than a visible failure.
 */
export function toLowerOutcome(reply: Record<string, unknown>, sessionId: string): PermissionLowerOutcome {
  if (reply.kind === 'error') {
    if (reply.requestType !== undefined && reply.requestType !== 'permission-lower') {
      throw new CoreError({ code: 'client/bad-message', message: 'The refusal was for a different request', details: { requestType: reply.requestType } });
    }
    const code = typeof reply.code === 'string' && reply.code !== '' ? reply.code : 'internal';
    // `auth/*` is the device's own grant (routine after a revoke), and `bad-request` is a frame this
    // app never sends; both survive as typed codes. The four reasons become the fixed receipt.
    if (!isReason(code) && code === 'bad-request') {
      throw new CoreError({ code: code as never, message: 'The Host refused the permission switch', details: { sessionId } });
    }
    const reason = isReason(code) ? code : null;
    return {
      accepted: false,
      reason,
      code,
      // An error frame names no re-read; the chip keeps what it already shows (the caller passes it).
      currentValue: coerceCurrentValue(reply.currentValue),
      message: reasonMessage(reason),
    };
  }
  if (reply.kind !== 'permission-lower') {
    throw new CoreError({ code: 'client/bad-message', message: 'Expected a permission-lower reply', details: { kind: reply.kind } });
  }
  const currentValue = coerceCurrentValue(reply.currentValue);
  const preset = typeof reply.preset === 'string' && reply.preset !== '' ? reply.preset : null;
  if (reply.accepted === true) {
    if (preset === null) throw new CoreError({ code: 'client/bad-message', message: 'An accepted switch named no preset' });
    return { accepted: true, preset, currentValue };
  }
  if (reply.accepted === false) {
    const reason = isReason(reply.reason) ? reply.reason : null;
    return {
      accepted: false,
      reason,
      code: reason ?? 'permission-lower',
      currentValue,
      message: reasonMessage(reason),
    };
  }
  throw new CoreError({ code: 'client/bad-message', message: 'The switch receipt had no accepted flag' });
}

/** The fixed sentence for one reason; the generic one when the Host named no usable reason. */
export function reasonMessage(reason: PermissionLowerReason | null): PermissionLowerMessage {
  switch (reason) {
    case 'not-stricter':
      return 'session.permissionNotStricter';
    case 'custom-current':
      return 'session.permissionCustomCurrent';
    case 'raced':
      return 'session.permissionRaced';
    case 'unavailable':
      return 'session.permissionUnavailable';
    default:
      return 'session.permissionError';
  }
}

/** Refuse a blank id before the wire (the gateway answers `bad-request`, which is our bug, not the user's). */
function requireSessionId(sessionId: string): string {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (id === '') throw new CoreError({ code: 'client/bad-state', message: 'A session id is required to read or change the permission preset' });
  return id;
}

/**
 * Read the current preset and the strictly-stricter options (`permission-options`).
 *
 * `{ state: 'unavailable' }` for a Host with no usable preset service (`reason: 'unavailable'`,
 * or an error frame of that code): that is the Host saying it cannot serve these ops, which is a
 * normal state to render, not a failure to shout about. Any other refusal - a scope refusal, a
 * malformed reply, a reply for another session - REJECTS with `CoreError`, never swallowed.
 */
export async function readPermissionOptions(client: CompanionClient, sessionId: string): Promise<PermissionOptionsResult> {
  const id = requireSessionId(sessionId);
  const reply = await client.request('permission-options' as never, { sessionId: id }, { allowNonOpType: true });
  replyIsFor(reply, 'permission-options', id);
  if (reply.kind === 'error') {
    if (reply.requestType !== undefined && reply.requestType !== 'permission-options') {
      throw new CoreError({ code: 'client/bad-message', message: 'The refusal was for a different request' });
    }
    const code = typeof reply.code === 'string' && reply.code !== '' ? reply.code : 'internal';
    if (code === 'unavailable' || code === 'custom-current') return { state: 'unavailable' };
    throw new CoreError({ code: code as never, message: 'The Host refused the preset read', details: { sessionId: id } });
  }
  if (reply.kind !== 'permission-options') {
    throw new CoreError({ code: 'client/bad-message', message: 'Expected a permission-options reply', details: { kind: reply.kind } });
  }
  return { state: 'ready', value: toOptionsView(reply) };
}

/**
 * Switch one session to one of the offered presets (`permission-lower`).
 *
 * A refusal is an ANSWER, not a throw: the receipt's `reason` decides which fixed sentence the
 * sheet shows. The exceptions are the device's own grant (`auth/*`) and a frame this app never
 * builds (`bad-request`), which reject with their code.
 */
export async function lowerPermission(client: CompanionClient, sessionId: string, preset: string): Promise<PermissionLowerOutcome> {
  const id = requireSessionId(sessionId);
  const name = typeof preset === 'string' ? preset.trim() : '';
  if (name === '') throw new CoreError({ code: 'client/bad-state', message: 'A preset name is required to switch the permission preset' });
  const reply = await client.request('permission-lower' as never, { sessionId: id, preset: name }, { allowNonOpType: true });
  replyIsFor(reply, 'permission-lower', id);
  return toLowerOutcome(reply, id);
}
