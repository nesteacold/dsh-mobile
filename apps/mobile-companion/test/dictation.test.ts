// Spec 019 (Đợt 3) — dictation through the OS keyboard, not through a recorder we ship.
//
// The product promise is narrow and worth pinning: the composer must stay an ordinary text field so the
// keyboard's own mic (Gboard et al.) can transcribe into it, and our mic control must only FOCUS the
// field and explain where dictation lives. Anything that makes the field "special" — a secure entry,
// a non-default keyboard type, a suppression of autocorrect/suggestions — can quietly kill dictation,
// and a recording library would add a native module and a microphone permission we do not need.
//
// These are source-level guards, like the rest of this suite (no renderer here), so they read the real
// files rather than a mock.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The `<TextInput …>` tag of the conversation composer, as written in the screen. */
function composerTag(source: string): string {
  const match = /<TextInput[\s\S]{0,900}?testID="session-composer"[\s\S]{0,900}?\/>/.exec(source);
  return match?.[0] ?? '';
}

describe('conversation composer stays dictation-friendly (Đợt 3)', () => {
  const session = read('app/session/[id].tsx');

  it('renders the composer as a plain multiline field', () => {
    const tag = composerTag(session);
    assert.notEqual(tag, '', 'the composer TextInput is identifiable by its testID');
    assert.match(tag, /multiline/, 'dictation needs a multiline field so a spoken phrase wraps');
    assert.doesNotMatch(tag, /secureTextEntry/, 'secure entry suppresses the keyboard microphone');
    assert.doesNotMatch(tag, /keyboardType=/, 'a non-default keyboard type can drop the mic key');
    assert.doesNotMatch(tag, /autoCorrect=\{false\}/, 'disabling autocorrect also disables dictation hints');
    assert.doesNotMatch(tag, /autoComplete="off"|autoComplete=\{?['"]off['"]/, 'explicitly off kills suggestions/dictation');
    assert.doesNotMatch(tag, /textContentType="oneTimeCode"|importantForAutofill/, 'no autofill/one-time-code styling');
  });

  it('has a mic control that only focuses the field and shows where dictation lives', () => {
    assert.match(session, /<MicHintButton/, 'the composer offers the mic affordance');
    assert.match(session, /composerRef\.current\?\.focus\(\)/, 'it focuses the composer instead of recording');
    assert.match(session, /<MicHintLine text=\{tr\('session\.micHint'\)\}/, 'the hint is shown from i18n');
    assert.doesNotMatch(session, /requestPermission|RECORD_AUDIO|Audio\.Record|expo-av|expo-audio/, 'no microphone surface is introduced');
  });

  it('the mic lives beside the field, not as a second send control', () => {
    assert.equal(count(session, '<MicHintButton'), 1, 'exactly one mic control');
    assert.match(session, /testID="session-send"/, 'send stays the only submit control');
    // Positional check rather than a regex slice: the action row contains nested Views, so a
    // `<View>…</View>` window closes before the buttons. The mic must sit after the row opens and
    // before the send control closes it.
    const rowStart = session.indexOf('styles.composerRow');
    const micIndex = session.indexOf('<MicHintButton');
    const sendIndex = session.indexOf('testID="session-send"');
    assert.ok(rowStart >= 0, 'the composer action row exists');
    assert.ok(micIndex > rowStart, 'the mic is inside the composer action row');
    assert.ok(sendIndex > micIndex, 'the mic sits before the send control, in the same row');
  });
});

describe('typing is never blocked by connection state (Đợt 3, measured defect)', () => {
  const session = read('app/session/[id].tsx');

  it('the composer is not gated on the socket being ready', () => {
    const tag = composerTag(session);
    assert.notEqual(tag, '');
    assert.doesNotMatch(tag, /editable=\{[^}]*connection/, 'editable must not depend on the connection');
    assert.doesNotMatch(tag, /editable=\{false\}/, 'and never be hard-disabled');
    assert.match(tag, /\beditable\b/, 'the field is explicitly editable');
  });

  it('withholds Send only where delivery is impossible without the user acting', () => {
    const impossible = /function isDeliveryImpossible\(connection: ClientState\): boolean \{([\s\S]*?)\n\}/.exec(session)?.[1] ?? '';
    assert.notEqual(impossible, '', 'the predicate exists');
    for (const state of ['revoked', 'update-required', 'gateway-disabled', 'reauth-required']) {
      assert.ok(impossible.includes(`'${state}'`), `${state} withholds Send`);
    }
    for (const recoverable of ['connecting', 'waiting-hello', 'waiting-client-hello', 'idle', 'closed', 'ready']) {
      assert.equal(impossible.includes(`'${recoverable}'`), false, `${recoverable} must still allow Send (the outbox queues)`);
    }
    assert.match(session, /const canSend = !deliveryImpossible && text\.trim\(\) !== '' && !sending;/);
  });

  it('only the terminal states claim to be offline; recoverable ones say you can type meanwhile', () => {
    const copy = /function sendUnavailableCopy\([^)]*\): string \{([\s\S]*?)\n\}/.exec(session)?.[1] ?? '';
    assert.match(copy, /isDeliveryImpossible\(connection\)\) return tr\('session\.sendOffline'\)/);
    assert.match(copy, /return tr\('session\.sendNotReady'\)/);
  });
});

describe('mic hint copy exists in both locales (Đợt 3)', () => {
  const i18n = read('i18n/index.ts');

  it('defines session.mic and session.micHint for en and vi', () => {
    for (const key of ['session.mic', 'session.micHint']) {
      assert.equal(count(i18n, `'${key}':`), 2, `${key} is translated once per locale`);
    }
    assert.match(i18n, /'session\.micHint': 'Use the microphone key on your keyboard to dictate\.'/);
    assert.match(i18n, /'session\.micHint': 'Dùng nút micro trên bàn phím để đọc\.'/);
  });
});
