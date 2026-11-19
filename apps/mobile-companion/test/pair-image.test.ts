// Spec 053 review — pure photo-QR decisions, synchronous acquisition behavior and source wiring.
// No renderer exists in this repo, so panel contracts are pinned by reading the source like the
// other pair screen tests; the acquisition race is exercised behaviorally (no source regex only).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chooseQrCandidate, createAcquisitionGate, imagePickerFailureKey } from '../src/ui/pair-image';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = readFileSync(path.join(ROOT, 'src', 'ui', 'pair-panel.tsx'), 'utf8');
const LAYOUT = readFileSync(path.join(ROOT, 'app', '_layout.tsx'), 'utf8');

describe('photo QR candidate choice', () => {
  it('returns none for empty or blank results', () => {
    assert.deepEqual(chooseQrCandidate([]), { kind: 'none' });
    assert.deepEqual(chooseQrCandidate(['', '   ']), { kind: 'none' });
  });

  it('chooses one deterministic value and ignores duplicate decodes', () => {
    assert.deepEqual(chooseQrCandidate(['payload']), { kind: 'one', value: 'payload' });
    assert.deepEqual(chooseQrCandidate([' payload ', 'payload']), { kind: 'one', value: 'payload' });
  });

  it('refuses multiple distinct QR payloads instead of pairing arbitrarily', () => {
    assert.deepEqual(chooseQrCandidate(['a', 'b', 'a']), { kind: 'multiple', count: 2 });
  });
});

describe('synchronous acquisition gate (behavioral)', () => {
  it('allows exactly one picker in the same tick', () => {
    const gate = createAcquisitionGate();
    const photo = gate.acquire('photo');
    assert.ok(photo);
    assert.equal(gate.acquire('photo'), null, 'a second photo tap cannot start another picker');
    assert.equal(gate.acquire('camera'), null, 'a camera callback in the same tick cannot compete');
    assert.equal(gate.acquire('manual'), null, 'a manual submit in the same tick cannot compete');
    assert.equal(gate.owns(photo), true);
    assert.equal(gate.release(photo), true);
    assert.equal(gate.owns(photo), false, 'a released lease is stale');
    assert.equal(gate.release(photo), false, 'only the owning token may release');
  });

  it('keeps a photo-to-submit handoff without deadlocking', () => {
    const gate = createAcquisitionGate();
    const photo = gate.acquire('photo');
    assert.ok(photo);
    // submit() receives this lease instead of acquiring again; no second acquisition is needed.
    assert.equal(gate.owns(photo), true);
    assert.equal(gate.release(photo), true);
    const next = gate.acquire('camera');
    assert.ok(next);
    assert.notEqual(next.token, photo.token, 'generation is unique after release');
  });

  it('invalidate/deactivate make every older lease stale', () => {
    const gate = createAcquisitionGate();
    const old = gate.acquire('camera');
    assert.ok(old);
    gate.invalidate();
    assert.equal(gate.owns(old), false);
    const newer = gate.acquire('photo');
    assert.ok(newer);
    gate.deactivate();
    assert.equal(gate.owns(newer), false);
    assert.equal(gate.acquire('manual'), null, 'a deactivated gate never acquires');
    assert.equal(gate.release(newer), false, 'stale cleanup never touches a newer attempt');
  });

  it('StrictMode setup → cleanup → setup reactivates without resetting generations', () => {
    const gate = createAcquisitionGate();
    gate.activate();
    const first = gate.acquire('photo');
    assert.ok(first);
    gate.deactivate(); // StrictMode cleanup
    assert.equal(gate.owns(first), false);
    assert.equal(gate.acquire('camera'), null, 'no lease while deactivated');
    gate.activate(); // StrictMode replay setup
    const second = gate.acquire('camera');
    assert.ok(second, 'the same gate accepts a new lease after replay');
    assert.ok(second.token > first.token, 'generation increases; no token reset');
    assert.equal(gate.owns(first), false, 'the old lease stays stale');
    assert.equal(gate.release(first), false, 'old cleanup cannot release the new lease');
    assert.equal(gate.release(second), true);
  });

  it('a held blank lease can be released by its owning cleanup (no stranding)', () => {
    const gate = createAcquisitionGate();
    const held = gate.acquire('camera');
    assert.ok(held);
    // The panel's blank path returns inside submit's try; the owning finally releases this lease.
    assert.equal(gate.owns(held), true);
    assert.equal(gate.release(held), true);
    assert.equal(gate.acquire('photo') !== null, true, 'the released gate is usable again');
  });

  it('classifies only real permission errors as permission feedback', () => {
    assert.equal(imagePickerFailureKey({ code: 'permission-denied', message: 'no' }), 'pair.imagePermission');
    assert.equal(imagePickerFailureKey({ code: 'E_UNAVAILABLE', message: 'no' }), 'pair.imageError');
    assert.equal(imagePickerFailureKey(new Error('boom')), 'pair.imageError');
  });
});

describe('spec 053 wiring', () => {
  it('uses a localized back label on the pair route', () => {
    assert.match(LAYOUT, /<Stack\.Screen name="pair" options=\{\{ title: tr\('pair\.title'\), headerBackTitle: tr\('common\.back'\) \}\} \/>/);
  });

  it('launches the Photos picker directly with no media-library read preflight', () => {
    assert.match(PANEL, /import \* as ImagePicker from 'expo-image-picker';/);
    assert.match(PANEL, /ImagePicker\.launchImageLibraryAsync\(\{/);
    assert.match(PANEL, /mediaTypes: \['images'\]/);
    assert.match(PANEL, /allowsEditing: false/);
    assert.match(PANEL, /allowsMultipleSelection: false/);
    assert.equal(PANEL.includes('getMediaLibraryPermissionsAsync'), false);
    assert.equal(PANEL.includes('requestMediaLibraryPermissionsAsync'), false);
  });

  it('decodes locally and feeds the unchanged submit seam', () => {
    assert.match(PANEL, /scanFromURLAsync, useCameraPermissions/);
    assert.match(PANEL, /scanFromURLAsync\(uri, \['qr'\]\)/);
    assert.match(PANEL, /chooseQrCandidate\(found\.map\(\(entry\) => entry\.data\)\)/);
    assert.match(PANEL, /await submit\(decision\.value, lease\)/);
    assert.match(PANEL, /gate\.owns\(lease\)/);
  });

  it('keeps a stable accessibility-labelled hook, cancel silent and errors localized', () => {
    assert.match(PANEL, /testID="pair-image-picker"/);
    assert.match(PANEL, /accessibilityLabel=\{tr\('pair\.imagePicker'\)\}/);
    assert.match(PANEL, /if \(picked\.canceled\) return;/);
    for (const key of ['pair.imageNoQr', 'pair.imageMultiple', 'pair.imageError']) {
      assert.match(PANEL, new RegExp(`setFailure\\('${key.replace('.', '\\.')}'\\)`));
    }
    assert.match(PANEL, /setFailure\(imagePickerFailureKey\(error\)\)/);
  });

  it('uses the synchronous gate for camera, photo and manual submit', () => {
    assert.match(PANEL, /const lease = gate\.acquire\('photo'\)/);
    assert.match(PANEL, /const lease = gate\.acquire\('camera'\)/);
    assert.match(PANEL, /gate\.acquire\('manual'\)/);
    assert.match(PANEL, /await submit\(scan\.data, lease\)|void submit\(scan\.data, lease\)/);
    assert.match(PANEL, /await submit\(decision\.value, lease\)/);
    assert.equal(PANEL.includes('imageAttempt.current'), false, 'no stale ref-based second gate');
  });

  it('never strands a lease on blank payloads and uses symmetric gate lifecycle', () => {
    assert.match(PANEL, /gate\.activate\(\);[\s\S]*?return \(\) => gate\.deactivate\(\);/);
    assert.equal(PANEL.includes('gate.unmount('), false);
    assert.match(PANEL, /if \(typeof scan\.data !== 'string' \|\| scan\.data\.trim\(\) === ''\) return;/);
    assert.match(PANEL, /if \(held === undefined && raw\.trim\(\) === ''\) return;/);
    assert.match(PANEL, /if \(!gate\.owns\(lease\)\) return;\s*\/\/ A held lease[\s\S]*?if \(raw\.trim\(\) === ''\) return;/);
  });
});
