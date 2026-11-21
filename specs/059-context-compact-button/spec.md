# 059 — Context compact button (Claude Code style)

Status: specified 2026-11-20; coder DeepSeek route. Owner request (session f29c01e8, turn 952):
"Có thể làm nút này như Claude Code được không? khi context quá 40% thì sẽ hiện màu cam, khi nhấn vào
thì sẽ gửi lệnh compact."

## Facts (b = read from installed DSH 0.2.2-rc.5 source)

- (b) The built-in context ring is `ContextMeter` in core `dsh-client-ui-conversation`. It reads the
  session projection `contextPressure` and computes
  `percent = min(100, round((projectedTokens ?? pressureTokens) / contextWindow * 100))`, returning
  null when either value is missing. Clicking it only opens a token breakdown panel. Core must not be
  patched (workspace rule), so it cannot be recoloured.
- (b) Slot `conversation.composer.dock` (kind list, scope session) sits beside that ring and is open to
  plugins. It passes standard props including `useProjection`, `inputActions`, `sessionId`,
  `useSessionStatus`. Fixed overlays must portal to `document.body`.
- (b) `inputActions` exposes `setDraft(text)` and `submit()` (`SessionInputShell.actions`). `/compact`
  comes from `dsh-command-compact`: no arguments; refused while compaction runs or the agent is busy.

## Requirements

1. New plugin package `plugins/compact-button/` (`@dsh-ext/compact-button`, private), client-only,
   registered through `ctx.slots.inject('conversation.composer.dock', …)` with its own id
   `dsh-ext-compact-button`. No wrap, no DOM patching, nothing of DSH mutated. `engines.dsh` is a
   bounded range in the 0.2.2 line, like the other plugins.
2. Render a small button (icon + `NN%`) using the same percent formula as `ContextMeter`. When the
   percent is unavailable, render nothing.
3. Colour: below 40% neutral (tertiary label colour); 40% and above orange; 70% and above red. Use DSH
   theme tokens where available (`--dsw-*`), with a fallback hex. Thresholds are constants in one place.
4. Click: if the draft is empty, call `inputActions.setDraft('/compact')` then
   `inputActions.submit()`. If the draft is not empty, never overwrite it: show a tooltip/notice "Draft
   is not empty, clear it or type /compact" and do nothing. Disable the button while the session is
   busy (not idle) so `/compact` is not refused. Tooltip text: "Context NN%, click to compact".
5. Locale strings in `locale/en.json` and `locale/vi.json`.
6. Remote sessions (devices plugin): the button submits through the same composer, so it works on a
   remote session with no extra code. Verify live, do not add a special path.
7. Tests (node:test): pure functions for percent, colour band (39 → neutral, 40 → orange, 70 → red),
   and click decision (empty draft → submit; non-empty → refuse; busy → disabled).
8. README lists the slot used, the behaviour, and the fact that the native ring stays beside it.

## Gates

Plugin tests, `node tools/verify-publish.mjs` if it covers the new package, `node tools/scan-pii.mjs`.
Install the bundle in the desktop profile and verify live: a session at or above 40% shows orange, a
click starts compaction and the percent drops. No commit/push without the owner's approval.

## Out of scope

Replacing or hiding the core ring (needs an upstream DSH change). Auto-compaction.
