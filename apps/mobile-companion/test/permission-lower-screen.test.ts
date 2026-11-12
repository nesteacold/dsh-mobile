// Spec 019 Wave 3 — the session screen's permission surface, as a SOURCE test.
//
// There is no component renderer in this repo (see `test/ui-test-hooks.test.ts`), so the wiring in
// `app/session/[id].tsx` is pinned by reading it. What must not drift:
//   * the chip is drawn from `chipView` (capability + the preset the `permission-options` read named),
//     never from a label and never from the session row (the row carries no preset);
//   * tapping the chip opens the sheet, which reads `permission-options` through the CONTROLLER
//     accessor — the screen never touches the client object or the plugin module;
//   * a row tap asks the confirmation Alert first, and only its confirm sends `permission-lower`
//     (through `controller.lowerPermission`), with the receipt rendered from fixed i18n copy;
//   * the Host's message is never interpolated into the receipt.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MESSAGES } from '../i18n';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const SCREEN = path.join(APP_DIR, 'session', '[id].tsx');
const source = readFileSync(SCREEN, 'utf8');
const COMPONENT = path.join(APP_DIR, '..', 'src', 'ui', 'components', 'permission-lower.tsx');
const component = readFileSync(COMPONENT, 'utf8');

const count = (needle: string): number => source.split(needle).length - 1;

describe('permission chip (spec 019)', () => {
  it('is drawn from chipView and hidden when it returns null', () => {
    assert.match(source, /import \{ canLowerPermission, chipView, optionRows \} from '..\/..\/src\/ui\/permission-lower'/);
    assert.match(source, /const permissionChip = chipView\(\{/);
    // The gateway's `sessions` reply carries no `permissions` for a device (its per-row filter drops
    // it), so the chip can only come from the screen's own `permission-options` read: a preset read
    // off the row in `chipView` would leave the chip hidden forever.
    assert.equal(source.includes('permissionPreset'), false, 'the chip never reads a preset off the session row');
    assert.match(source, /preset: permissionView !== null && permissionView\.state === 'ready' \? permissionView\.value\.currentValue : null/);
    assert.match(source, /if \(!canLowerPermission\(snapshot\.capabilities\)\) return;\s*void loadPermissionOptions\(\)/);
    assert.match(source, /{permissionChip === null \? null : \(/);
    assert.equal(count('<PermissionChip'), 1);
    // The hook lives in the component and is what `e2e/check-flows.mjs` resolves.
    assert.equal(component.split('testID="permission-chip"').length - 1, 1, 'the chip keeps its static hook');
  });
});

describe('permission sheet (spec 019)', () => {
  it('reads through the controller accessor, never the client or the plugin', () => {
    assert.match(source, /awa(it|t) controller\.readPermissionOptions\(sessionId\)/);
    assert.equal(source.includes("from '../../plugins"), false, 'the app never imports the plugin');
    assert.equal(source.includes('client.request'), false, 'the screen never touches the client object');
  });

  it('asks before switching, then sends the preset through the controller', () => {
    assert.match(source, /Alert\.alert\(\s*tr\('session\.permissionConfirmTitle', \{ preset \}\)/);
    assert.match(source, /tr\('session\.permissionConfirm'\)/);
    assert.match(source, /controller\.lowerPermission\(sessionId, preset\)/);
    // The write happens in the Alert's confirm, not on the row tap.
    const rowTap = source.indexOf("onChoose={confirmPermissionLower}");
    assert.ok(rowTap > 0, 'a row tap goes to the confirmation, not to the wire');
    // The chip renders from the read, so a switch (accepted or refused) must re-read it.
    const confirmLower = source.indexOf('const confirmPermissionLower = useCallback(');
    assert.ok(source.indexOf('void loadPermissionOptions()', confirmLower) > confirmLower && confirmLower > 0,
      'the confirm reloads the presets');
  });

  it('releases the rows lock when the Alert is dismissed without a button', () => {
    // Backdrop tap and Android back reach neither button: only `options.onDismiss` reports them, and
    // without it `permissionBusy` stays true for the whole visit.
    assert.match(source, /cancelable: true,[\s/]*(?:[^/\n]*\/\/[\s\S]*?)?\s*onDismiss: \(\) => setPermissionBusy\(false\)/);
    assert.match(source, /style: 'cancel', onPress: \(\) => setPermissionBusy\(false\)/);
    // The write clears it in its `finally`, so the lock spans tap → confirm → receipt.
    assert.match(source, /finally \{\s*setPermissionBusy\(false\)/);
  });

  it('renders a receipt from fixed copy only', () => {
    assert.equal(component.split('testID="permission-receipt"').length - 1, 1);
    assert.equal(component.split('testID="permission-sheet"').length - 1, 1);
    assert.equal(component.split('testID={`permission-option-${row.preset}`}').length - 1, 1);
    assert.match(source, /function permissionErrorKey/);
    for (const key of [
      'session.permissionNotStricter',
      'session.permissionCustomCurrent',
      'session.permissionRaced',
      'session.permissionUnavailable',
      'session.permissionError',
    ]) {
      assert.equal(source.includes(`'${key}'`), true, `${key} must be reachable from the screen`);
    }
  });

  it('every sentence the screen can show exists in BOTH locales', () => {
    for (const locale of ['en', 'vi'] as const) {
      for (const key of [
        'session.permissionChip',
        'session.permissionTitle',
        'session.permissionCurrent',
        'session.permissionEmpty',
        'session.permissionUnavailable',
        'session.permissionLoadFailed',
        'session.permissionConfirmTitle',
        'session.permissionConfirmBody',
        'session.permissionConfirm',
        'session.permissionPair',
        'session.permissionNotStricter',
        'session.permissionCustomCurrent',
        'session.permissionRaced',
        'session.permissionError',
      ] as const) {
        assert.equal(typeof MESSAGES[locale][key], 'string', `${locale} is missing ${key}`);
      }
    }
  });
});
