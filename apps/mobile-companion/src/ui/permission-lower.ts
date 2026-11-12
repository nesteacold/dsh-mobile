// Spec 019 Wave 3 — the permission chip and the lower-only sheet: everything that is PURE policy,
// so `app/session/[id].tsx` stays a render surface and every rule is testable in Node without a
// renderer (this repo has none — see `test/ui-test-hooks.test.ts`).
//
// The rules this module keeps, and why each one exists:
//   * the capability comes LAST: connection state and a known preset decide first, because on
//     device a screen accused the Host of a permission problem during the first seconds after
//     launch, before `hello` had arrived (same ordering as `newSessionAvailability`);
//   * the chip's text is DATA (the Host's own preset name); a label is never substituted for it;
//   * the sheet lists ONLY the preset NAMES from the `permission-options` reply, and the gateway is
//     the authority on strictness: it drops anything looser on either axis before it offers it, and
//     it refuses a target it did not offer (`not-stricter`). This module keeps no second copy of that
//     comparison; it only drops blank rows, duplicates and the never-target names `custom`/`auto`;
//   * a DESKTOP preset row is `name → { sandbox, approval }` with no description (measured on
//     0.2.2-rc.1, dsh-permission-presets/lib/index.js:145-158), so the row's second line is fixed
//     local copy naming the pair — nothing here invents a description the Host never sent.

import type { PermissionOption } from '@dsh-ext/mobile-protocol';

import type { Locale } from '../../i18n';

export const PERMISSION_CAPABILITY = 'permission-lower';

/** A capability list must be a real array containing the capability; anything else grants nothing. */
export function canLowerPermission(capabilities: readonly string[] | null | undefined): boolean {
  return Array.isArray(capabilities) && capabilities.includes(PERMISSION_CAPABILITY);
}

/**
 * Should the header chip exist at all?
 *
 * `preset === null` covers the absent projection: a session row that never carried
 * `permissions.currentValue` (older gateway, or a Host with no preset service) must show no chip
 * rather than an invented default. The capability is the Host's own statement; the connection
 * check only says "do not promise a tap you cannot serve right now".
 */
export function shouldShowPermissionChip(input: {
  connection: string;
  capabilities: readonly string[] | null | undefined;
  preset: string | null | undefined;
}): boolean {
  if (input.connection !== 'ready') return false;
  if (!canLowerPermission(input.capabilities)) return false;
  const preset = typeof input.preset === 'string' ? input.preset.trim() : '';
  return preset !== '';
}

/** What the header chip renders: the announced label and the preset itself (data, never a label). */
export interface ChipView {
  readonly label: string;
  readonly preset: string;
}

/**
 * The chip's render data, or `null` when the chip must be absent. `label` is composed by the caller
 * in its locale; `preset` is the Host's own name and is what the chip SHOWS.
 */
export function chipView(input: {
  connection: string;
  capabilities: readonly string[] | null | undefined;
  preset: string | null | undefined;
  label: (preset: string) => string;
}): ChipView | null {
  if (!shouldShowPermissionChip(input)) return null;
  const preset = (input.preset as string).trim();
  return { label: input.label(preset), preset };
}

/** One row of the sheet: the preset NAME and the fixed local second line (no Host description exists). */
export interface OptionRowView {
  readonly preset: string;
  readonly description: string;
}

/**
 * One offered target, as a row: the preset NAME (the Host's data) plus one fixed local line naming
 * the pair the gateway resolved. The gateway's list is taken as-is — it already offers only presets
 * strictly stricter on one axis and looser on none (spec 019), so this function re-orders nothing,
 * hides nothing and adds nothing. `custom`/`auto` are never targets (the gateway refuses them too).
 */
export function optionRows(
  options: readonly PermissionOption[],
  description: (option: PermissionOption) => string,
): OptionRowView[] {
  const rows: OptionRowView[] = [];
  for (const option of options) {
    const preset = option.preset.trim();
    if (preset === '' || preset === 'custom' || preset === 'auto') continue;
    if (rows.some((row) => row.preset === preset)) continue;
    rows.push({ preset, description: description({ ...option, preset }) });
  }
  return rows;
}
