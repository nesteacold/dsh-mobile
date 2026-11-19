// "QR or code" holds a long pairing string — or the 8-digit code, because its label invites exactly
// that paste. WHAT THIS PINS:
//
//   * an 8-digit code (grouped, padded, however `normalizeOtp` accepts it) is classified as a CODE,
//     normalized to the code tab's own field format;
//   * 7 digits, 9 digits, letters, a long pairing string and a pair-link URL are all PAYLOAD — the
//     code path never claims text it cannot prove;
//   * the panel keeps the promise around it: a pasted code switches tabs and pre-fills, never
//     submits, and says so in its own line; anything else that is not a payload gets its own copy
//     instead of the generic "pairing failed".
//
// There is no component renderer in this repo (no react-test-renderer — see
// `test/ui-test-hooks.test.ts`), so the panel half is a SOURCE tripwire, the same way the pair screen
// is guarded there and in `test/pair-web-origin.test.ts`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyPastedPairing } from '../src/ui/pair-classify';

const PANEL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'pair-panel.tsx');

describe('classifyPastedPairing — an 8-digit code is not a pairing payload', () => {
  it('classifies the code the way the code tab normalizes it', () => {
    // The Host dialog shows the code grouped; users paste it both ways, with stray padding.
    const cases: Array<[string, string]> = [
      ['12139679', '12139679'],
      ['1213 9679', '12139679'],
      ['1213-9679', '12139679'],
      ['  1213 9679  ', '12139679'],
      ['00000000', '00000000'],
    ];
    for (const [input, otp] of cases) {
      assert.deepEqual(classifyPastedPairing(input), { kind: 'code', otp }, JSON.stringify(input));
    }
  });

  it('never classifies a near-miss as a code', () => {
    // One digit short or long, a letter, an empty field: all stay on the payload path, so the code
    // tab is never filled with something it would have to reject a second time. Only space and dash
    // are grouping (`normalizeOtp`), so a tab, a non-breaking space and a plus sign are NOT a code.
    // Classification reads the text as pasted: a leading non-breaking space must not be `trim()`ed
    // into an ordinary code that the code tab would then refuse.
    for (const input of ['1213967', '121396790', '1213 967', '1213967a', 'abcdefgh', '', '   ',
      '1213\t9679', '\u00a012139679', '12139679\u00a0', '+12139679', '1213_9679']) {
      assert.deepEqual(classifyPastedPairing(input), { kind: 'payload' }, JSON.stringify(input));
    }
  });

  it('leaves the long pairing string and the pair-link URL on the payload path', () => {
    // A real payload is one base64url field, hundreds of characters long; a pair link is a URL with
    // the code in its fragment. Neither may be mistaken for a pasted code (the URL carries 8 digits
    // that are NOT its whole text).
    const longString = Buffer.from(JSON.stringify({
      version: 3,
      publicUrl: 'wss://100.100.10.20:30081/ws/mobile',
      pairingCode: `${'A'.repeat(42)}Q`,
      expiresAt: Date.now() + 240_000,
      certSha256: 'a'.repeat(64),
      gatewayId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      gatewayName: 'my-pc',
      endpoints: ['wss://100.100.10.20:30081/ws/mobile'],
    }), 'utf8').toString('base64url');
    assert.deepEqual(classifyPastedPairing(longString), { kind: 'payload' });
    assert.deepEqual(
      classifyPastedPairing('https://host.example.ts.net:8443/pair#a=100.100.10.20:30081&c=12139679'),
      { kind: 'payload' },
    );
    // Anything else copied off the computer is a payload-shaped miss, not a code.
    for (const other of ['192.168.1.20:3081', 'wss://100.100.10.20:30081/ws/mobile', 'my-pc']) {
      assert.deepEqual(classifyPastedPairing(other), { kind: 'payload' }, other);
    }
  });
});

describe('pair screen source — a pasted code switches tabs, it never submits', () => {
  const source = readFileSync(PANEL, 'utf8');

  it('declares the pasted-code notice and clears it on edit, tab switch and submit', () => {
    assert.match(source, /const \[otpDetected, setOtpDetected\] = useState\(false\)/, 'the notice has its own state');
    // Rendered on the code tab, with its own hook so a flow can assert it.
    assert.match(source, /\{otpDetected \? \(\s*<Text[^>]*testID="pair-otp-detected">\{tr\('pair\.otpDetected'\)\}/);
    // Cleared wherever the code it describes stops being what the field holds.
    assert.match(source, /onChangeText=\{\(text\) => \{ setOtpCode\(text\); setOtpDetected\(false\); \}\}/, 'editing the code');
    for (const tab of ['code', 'otp']) {
      assert.match(source, new RegExp(`setMode\\('${tab}'\\); setOtpDetected\\(false\\)`), `the ${tab} tab switch`);
    }
    // Both submit handlers end it: the paste it described is spent either way. (Six call sites in
    // the panel: the code edit, two tab switches, a pairing link taking over the field, and one at
    // the top of each submit handler.)
    const clears = (source.match(/setOtpDetected\(false\)/g) ?? []).length;
    assert.equal(clears, 6, 'code edit, two tab switches, a pairing link, and one clear per submit handler');
    // The QR handler clears it first, before it classifies, so the notice can only be raised by the
    // branch below — never left over from a previous paste. (The handler body starts where the
    // classify call is, so this reads that call, not the import at the top of the file.)
    const submitStart = source.indexOf('const submit = useCallback(');
    const handlerStart = source.indexOf('classifyPastedPairing(raw)', submitStart);
    const handlerHead = source.slice(submitStart, handlerStart);
    assert.ok(handlerHead.includes('setOtpDetected(false);'), 'the QR handler clears it at the top');
    assert.ok(handlerHead.indexOf('setOtpDetected(false);') < handlerHead.length, 'cleared before classifying');
    assert.match(source, /const submitOtp = useCallback\(async \(\) => \{\s*if \(busy\) return;\s*setFailure\(null\);\s*setOtpDetected\(false\);/);
    // A pairing link is a different paste: it fills its own line, never this one.
    assert.match(source, /setOtpDetected\(false\);\s*setFailure\(null\);\s*setPrefilled\(true\);/);
  });

  it('classifies the paste before anything parses it, and returns without a controller call', () => {
    const submitStart = source.indexOf('const submit = useCallback(');
    const classify = source.indexOf('classifyPastedPairing(raw)', submitStart);
    const parse = source.indexOf('parsePairLinkUrl(raw)', submitStart);
    const pair = source.indexOf('controller.pair(', submitStart);
    assert.ok(submitStart > 0 && classify > submitStart, 'the QR/paste handler classifies first');
    assert.ok(classify < parse, 'the code branch runs before the pair-link parse');
    assert.ok(classify < pair, 'the code branch runs before any connection');
    // The code branch ends in `return;` before the payload path continues.
    const branch = source.slice(classify, source.indexOf('const link = parsePairLinkUrl(raw)', classify));
    assert.match(branch, /if \(pasted\.kind === 'code'\) \{[\s\S]*?return;\s*\}/, 'the code branch returns');
    assert.equal(branch.includes('controller.'), false, 'a pasted code never reaches the controller');
    // The pre-fill carries the NORMALIZED code and refuses a phone/foreign page instead of filling in.
    assert.match(branch, /setMode\('otp'\);\s*setOtpCode\(pasted\.otp\);\s*setOtpDetected\(true\);/);
    // The paste field is cleared: the code now lives in the code tab's field, not in two places.
    assert.match(branch, /setManual\(''\)/);
    // The branch only FILLS the tab. A phone and a foreign page are refused by the code tab's own
    // submit (its seam call + `refusalKey`), which is why this branch adds no third seam call there.
    assert.match(source, /case 'otpNative':\s*return 'pair\.error\.otpNative';/);
    assert.match(source, /if \(decision\.kind !== 'otp'\) \{\s*\/\/[^\n]*\n\s*setFailure\('pair\.error\.otpNative'\);/, 'the code tab still refuses a phone before connecting');
  });

  it('maps a non-payload to its own copy instead of the generic pairing failure', () => {
    // `errorKey` is the one place a typed failure becomes copy; the QR parse failures now arrive as
    // `badPayload`, and a missing case there would silently show "pairing failed" again.
    assert.match(source, /case 'badPayload':\s*return 'pair\.error\.badPayload';/);
    assert.equal(/case 'badPayload':\s*return 'pair\.error\.generic';/.test(source), false);
  });
});
