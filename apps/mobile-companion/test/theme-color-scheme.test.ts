// Lock-screen visual regression guard — BEHAVIOURAL, not source regex.
//
// iPhone PWA (1170x2532) showed a light page with a DARK gate palette: `useColorScheme()` answered
// `null`, the old `=== 'light' ? 'light' : 'dark'` fallback chose dark, so the Ink title was nearly
// white on white and the "forget" control became a heavy dark block next to Unlock.
//
// There is no component renderer in this Node suite (see test/ui-test-hooks.test.ts), so the two
// seams that decide the visuals are imported and CALLED: `resolveColorScheme` / `paletteFor` from the
// theme, and `webLockGateStyles` exported by app/_layout.tsx. The latter is the SAME object the JSX
// consumes (`style={gate.title}`, `testID={gate.hooks.*}`, …) — not a parallel description — so a
// regression cannot hide behind a green test while the rendered style is wrong.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  darkColors,
  lightColors,
  paletteFor,
  resolveColorScheme,
  type ColorScheme,
} from '../src/ui/theme';
import { webLockGateStyles } from '../app/_layout';

/** WCAG contrast, computed from the palette values the gate actually uses. */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  assert.ok(match !== null, `${hex} must be a 6-digit hex colour`);
  const value = Number.parseInt(match[1] as string, 16);
  return 0.2126 * linear((value >> 16) & 0xff) + 0.7152 * linear((value >> 8) & 0xff) + 0.0722 * linear(value & 0xff);
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('unknown colour scheme falls back to LIGHT (web/PWA)', () => {
  it('resolves null/undefined to light, and keeps explicit light and dark', () => {
    assert.equal(resolveColorScheme(null), 'light');
    assert.equal(resolveColorScheme(undefined), 'light');
    assert.equal(resolveColorScheme('light'), 'light');
    assert.equal(resolveColorScheme('dark'), 'dark', 'a real dark system setting is still honoured');
  });

  it('paletteFor(resolveColorScheme(unknown)) is the light palette, never the dark one', () => {
    const unknown = paletteFor(resolveColorScheme((null as unknown) as ColorScheme | null));
    assert.equal(unknown.isDark, false);
    assert.equal(unknown, lightColors);
    assert.equal(unknown.text, lightColors.text, 'title uses Ink on light — not near-white dark text');
    assert.equal(unknown.bg, lightColors.bg);
  });

  it('a real dark system setting still produces the dark palette (not hard-coded light)', () => {
    const dark = paletteFor(resolveColorScheme('dark'));
    assert.equal(dark.isDark, true);
    assert.equal(dark, darkColors);
    assert.equal(dark.text, darkColors.text);
    assert.equal(dark.bg, darkColors.bg);
  });
});

describe('WebLockGate — the ACTUAL styles JSX renders (both schemes)', () => {
  for (const [name, palette] of [['light', lightColors], ['dark', darkColors]] as const) {
    describe(name, () => {
      // This is the object passed to `style={...}` / `testID={...}` in WebLockGate.
      const gate = webLockGateStyles(palette);

      it('title uses primary text and subtitle uses readable muted text on the gate background', () => {
        assert.equal(gate.container.backgroundColor, palette.bg, 'the View uses the factory background');
        assert.equal(gate.title.color, palette.text);
        assert.equal(gate.subtitle.color, palette.textMuted);
        assert.ok(contrast(gate.title.color, gate.container.backgroundColor) >= 4.5, 'title ≥ 4.5:1 on the gate background');
        assert.ok(contrast(gate.subtitle.color, gate.container.backgroundColor) >= 4.5, 'subtitle ≥ 4.5:1, never fainter');
      });

      it('Unlock is the filled primary action; Forget is a quiet outlined link set apart', () => {
        assert.equal(gate.action.backgroundColor, palette.accent, 'Unlock keeps the accent fill');
        assert.equal(gate.actionText.color, palette.onAccent);
        assert.equal((gate.forget as Record<string, unknown>).backgroundColor, undefined, 'Forget has no dark fill');
        assert.equal(gate.forget.borderWidth, 1, 'a hairline outline');
        assert.equal(gate.forget.borderColor, palette.border);
        assert.equal(gate.forgetText.color, palette.textMuted);
        assert.ok(contrast(gate.forgetText.color, palette.bg) >= 4.5, 'the link label stays legible');
        assert.ok(gate.forget.minHeight >= 44, 'Forget keeps the 44pt touch target');
        assert.equal(gate.action.minHeight, gate.forget.minHeight);
        assert.ok(gate.forgetText.fontSize < gate.actionText.fontSize, 'Forget label is smaller than the Unlock label');
        assert.ok(gate.forget.marginTop > gate.action.marginTop, 'Forget is further from the gate edge than Unlock');
      });

      it('exposes stable test hooks consumed by the rendered nodes', () => {
        assert.equal(gate.hooks.gate, 'web-lock-gate');
        assert.equal(gate.hooks.title, 'web-lock-title');
        assert.equal(gate.hooks.subtitle, 'web-lock-subtitle');
        assert.equal(gate.hooks.action, 'web-lock-action');
        assert.equal(gate.hooks.forget, 'web-lock-forget');
      });
    });
  }

  it('the light fallback styles are the light ones, the dark styles the dark ones', () => {
    const lightGate = webLockGateStyles(paletteFor(resolveColorScheme(null)));
    const darkGate = webLockGateStyles(paletteFor(resolveColorScheme('dark')));
    assert.equal(lightGate.title.color, lightColors.text);
    assert.equal(darkGate.title.color, darkColors.text);
    assert.notEqual(lightGate.title.color, darkGate.title.color, 'no scheme is hard-coded');
    assert.equal(lightGate.action.backgroundColor, lightColors.accent);
    assert.equal(darkGate.action.backgroundColor, darkColors.accent);
    assert.equal(lightGate.forget.borderColor, lightColors.border);
    assert.equal(darkGate.forget.borderColor, darkColors.border);
  });
});
