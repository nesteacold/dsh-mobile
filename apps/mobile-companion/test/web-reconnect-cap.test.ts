// Spec 046 — web-only bounded pre-open attempts (source wiring + copy), plus the shared
// Reconnector's failure counting used by the web cap.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_STATE = readFileSync(path.join(ROOT, 'src', 'app-state.ts'), 'utf8');
const HOME = readFileSync(path.join(ROOT, 'app', '(tabs)', 'index.tsx'), 'utf8');
const I18N = readFileSync(path.join(ROOT, 'i18n', 'index.ts'), 'utf8');

describe('spec 046: web connection-unavailable wiring', () => {
  it('only the web branch counts three pre-open failures, keeps the credential, and stops', () => {
    assert.match(APP_STATE, /snapshot\.connections === 0 && snapshot\.attempt >= 3/);
    assert.match(APP_STATE, /this\.banner = 'connect-failed'/);
    assert.doesNotMatch(APP_STATE, /credentialRejected = true;\s*\/\/.*three/);
    assert.match(APP_STATE, /this\.webMode && this\.isCurrent\(generation\)/);
    assert.match(APP_STATE, /reconnector\.stop\(\)/);
    // Shared maxAttempts semantics are untouched.
    assert.match(readFileSync(path.join(ROOT, 'src', 'core', 'reconnect.ts'), 'utf8'), /attempt > this\.options\.maxAttempts/);
  });

  it('foreground resume and Retry open a fresh budget without duplicating a live socket', () => {
    assert.match(APP_STATE, /this\.webMode && this\.banner === 'connect-failed'/);
    assert.match(APP_STATE, /void this\.retryConnection\(\)/);
    assert.match(APP_STATE, /liveState === 'ready' \|\| liveState === 'connecting'/);
  });

  it('home shows a connection-unavailable banner with Retry and confirmed Pair again', () => {
    // The banner compares the RAW kind; `banner` is localized copy and can never match a key.
    assert.match(HOME, /<Banner kind=\{snapshot\.banner\} banner=\{banner\}/);
    assert.match(HOME, /kind === 'connect-failed'/);
    assert.match(HOME, /case 'connect-failed':/);
    assert.match(HOME, /testID="banner-retry"/);
    assert.match(HOME, /testID="banner-pair-again"/);
    assert.match(HOME, /confirmAndForget\(/);
    for (const key of ['banner.connectFailed', 'banner.retry', 'banner.pairAgain']) {
      assert.equal(I18N.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g'))?.length, 2, `${key} in en + vi`);
    }
  });
});
