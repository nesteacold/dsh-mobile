// Font-size setting (reference: `FontSizeSettingsScreen.kt`).
//
// Two halves have to agree or the feature is a lie:
//   * the SCREEN changes the theme and writes the choice down (`saveFontScale`);
//   * the APP ROOT reads it back at startup and hands it to the theme (`initialFontScale`), and the
//     provider must ADOPT the value when it arrives asynchronously — otherwise the first render's
//     default wins and the saved choice never applies.
//
// No component renderer exists in this repo, so the wiring half is asserted against the source.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeFontScale, DEFAULT_FONT_SCALE } from '../src/ui/font-scale-store';
import { FONT_SCALES } from '../src/ui/theme';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEME = readFileSync(path.join(ROOT, 'src', 'ui', 'theme.ts'), 'utf8');
const LAYOUT = readFileSync(path.join(ROOT, 'app', '_layout.tsx'), 'utf8');
const SETTINGS = readFileSync(path.join(ROOT, 'app', 'settings.tsx'), 'utf8');

describe('normalizeFontScale', () => {
  it('accepts every offered step, as a number or as the stored string', () => {
    for (const step of FONT_SCALES) {
      assert.equal(normalizeFontScale(step), step);
      assert.equal(normalizeFontScale(String(step)), step);
    }
  });

  it('falls back to the default for anything unusable', () => {
    for (const junk of [undefined, null, '', 'abc', Number.NaN, Number.POSITIVE_INFINITY, {}, [], 0, 5, -1]) {
      assert.equal(normalizeFontScale(junk), DEFAULT_FONT_SCALE, `junk: ${String(junk)}`);
    }
  });

  it('does not clamp to the nearest step (a stale value must not silently resize the app)', () => {
    assert.equal(normalizeFontScale(1.2), DEFAULT_FONT_SCALE, '1.2 is not an offered step');
  });
});

describe('the choice is remembered', () => {
  it('the settings screen writes the choice down when it changes', () => {
    assert.match(SETTINGS, /import \{ saveFontScale \} from '\.\.\/src\/ui\/font-scale-store'/, 'saves via the store');
    assert.match(SETTINGS, /void saveFontScale\(scale\)/, 'a tap persists the step');
    assert.match(SETTINGS, /setFontScale\(scale\)/, 'a tap still applies it immediately');
    // Each step has a locale-independent hook for Maestro.
    assert.match(SETTINGS, /testID=\{`settings-font-\$\{Math\.round\(scale \* 100\)\}`\}/);
  });

  it('the app root restores it and the theme adopts the restored value', () => {
    assert.match(LAYOUT, /import \{ loadFontScale \} from '\.\.\/src\/ui\/font-scale-store'/, 'reads the store');
    assert.match(LAYOUT, /<ThemeProvider initialFontScale=\{fontScale\}>/, 'hands it to the theme');
    assert.match(LAYOUT, /void loadFontScale\(\)\.then\(/, 'loads once at startup');
    // Async arrival: the provider must update when the prop lands, not only at first render.
    assert.match(
      THEME,
      /useEffect\(\(\) => \{\s*if \(props\.initialFontScale !== undefined\) setFontScale\(props\.initialFontScale\);/,
      'the provider adopts a late-arriving scale',
    );
    // And the scale must actually reach the typography.
    assert.match(THEME, /type: typeScale\(palette, fontScale\)/, 'typography is built from the scale');
  });
});
