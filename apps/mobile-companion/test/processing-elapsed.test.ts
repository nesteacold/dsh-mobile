// Spec 050 — observed processing elapsed time, label, liveness and reset behaviour.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatProcessingElapsed, progressPhase } from '../app/session/[id]';
import { t } from '../i18n';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREEN = readFileSync(path.join(APP, 'app', 'session', '[id].tsx'), 'utf8');
const I18N = readFileSync(path.join(APP, 'i18n', 'index.ts'), 'utf8');

describe('spec 050: formatProcessingElapsed', () => {
  it('formats whole seconds, minutes and hours', () => {
    assert.equal(formatProcessingElapsed(0), '0s');
    assert.equal(formatProcessingElapsed(59_000), '59s');
    assert.equal(formatProcessingElapsed(224_000), '3m 44s');
    assert.equal(formatProcessingElapsed(3_724_000), '1h 2m');
    assert.equal(formatProcessingElapsed(-1), '0s', 'never a negative age');
  });

  it('keeps progressPhase as the single source of truth', () => {
    assert.equal(progressPhase({ sending: true, outgoing: [], running: true }), 'sending');
    assert.equal(progressPhase({ sending: false, outgoing: [{ status: 'sent' }], running: true }), 'sending');
    assert.equal(progressPhase({ sending: false, outgoing: [{ status: 'failed' }], running: true }), 'processing');
    assert.equal(progressPhase({ sending: false, outgoing: [], running: false }), null);
  });
});

describe('spec 050: elapsed hook, label and animation composition', () => {
  it('starts on processing and resets on phase null / sending / session switch', () => {
    assert.match(SCREEN, /phase !== 'processing'[\s\S]{0,120}processingStart\.current = null/);
    assert.match(SCREEN, /processingStart\.current\?\.sessionId !== sessionId/);
    assert.match(SCREEN, /Date\.now\(\) - since/);
    assert.match(SCREEN, /setInterval\(tick, 1_000\)/);
    assert.match(SCREEN, /return \(\) => clearInterval\(timer\)/);
  });

  it('shows the localized label with the elapsed value and keeps the same a11y hook', () => {
    assert.match(SCREEN, /tr\('session\.processingElapsed', \{ elapsed: formatProcessingElapsed\(elapsedMs\) \}\)/);
    assert.match(SCREEN, /testID="session-progress-indicator"/);
    assert.match(SCREEN, /accessibilityLabel=\{phaseLabel\}/);
    assert.equal(t('en', 'session.processingElapsed', { elapsed: '12s' }), 'Processing… 12s');
    assert.equal(t('vi', 'session.processingElapsed', { elapsed: '12s' }), 'Đang xử lý… 12s');
    for (const key of ['session.processingElapsed']) {
      assert.equal(I18N.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g'))?.length, 2, `${key} in en + vi`);
    }
  });

  it('pulses only while processing, respects reduced motion, and uses fixed web chrome', () => {
    assert.match(SCREEN, /Animated\.loop\(Animated\.sequence\(\[/);
    assert.match(SCREEN, /phase !== 'processing' \|\| reduceMotion/);
    assert.match(SCREEN, /AccessibilityInfo\.isReduceMotionEnabled/);
    assert.match(SCREEN, /opacity: phase === 'processing' && !reduceMotion \? pulse : 1/);
    assert.match(SCREEN, /backgroundColor: isWeb \? chrome\.surface : colors\.surface/);
    assert.match(SCREEN, /color: isWeb \? chrome\.textMuted : colors\.textMuted/);
    assert.match(SCREEN, /<Animated\.View/);
    assert.equal((SCREEN.match(/testID="session-progress-indicator"/g) ?? []).length, 1);
  });

  it('does not disclose private reasoning text in the pill', () => {
    const labelBlock = SCREEN.slice(SCREEN.indexOf("tr('session.processingElapsed'"), SCREEN.indexOf('<GlassSurface', SCREEN.indexOf("tr('session.processingElapsed'")));
    assert.doesNotMatch(labelBlock, /reasoning|private|thought/i);
  });
});
