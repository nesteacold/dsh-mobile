// Session list screen — the no-host empty state must still explain a banner state, and the rows must
// stay inside the screen.
//
// There is no component renderer in this repo (see test/ui-test-hooks.test.ts), so this is a
// **source** test: it reads the list screen and asserts the banner/empty-state structure and the row
// layout invariants.
//
// REWRITTEN for spec 011 parity (references 01/02/03): the list is now the app's single main screen
// (`app/(tabs)/index.tsx`) — the bottom tab bar, the filter tabs and the per-row relative time are
// gone by design, and the row is the reference's dot + one-line title. The *meaning* of each guard is
// kept: a revocation must still be explained on the empty state, and a row must never run off-screen.
//
// Why the banner matters here: a gateway revocation (`native-close … code=4401`) leaves the controller
// with `banner: 'revoked'` and `activeHost: null`. If the screen returns the empty state before the
// banner is rendered, the user only sees "no sessions" and never learns the computer revoked them.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LOCALES, t } from '../i18n';

const INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', '(tabs)', 'index.tsx');
const source = readFileSync(INDEX, 'utf8');

/** The `{ … }` block that opens after `marker`, braces balanced (JSX expressions included). */
function blockAfter(marker: string): string {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `marker not found in the list screen: ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  assert.fail(`unbalanced block after: ${marker}`);
}

function count(pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

describe('session list — banner on the no-host empty state', () => {
  const noHost = blockAfter('{snapshot.activeHost === null ? (');

  it('explains the banner above the empty state, and keeps the pair action', () => {
    // The screen renders ONE banner for every state, before the no-host branch: that ordering is what
    // guarantees a revocation is explained on the empty screen too.
    assert.ok(
      source.indexOf('<Banner') !== -1 && source.indexOf('<Banner') < source.indexOf('snapshot.activeHost === null'),
      'the banner is rendered above the no-host branch',
    );
    assert.match(noHost, /tr\('home\.emptyTitle'\)/, 'the empty copy is kept');
    assert.match(noHost, /tr\('sessions\.pair'\)/, 'the pair action is kept');
    assert.match(noHost, /router\.push\('\/pair'\)/, 'the pair action still navigates');
    assert.match(noHost, /styles\.center/, 'the empty state is centred');
  });

  it('renders the banner once, from one component (one hook, not two)', () => {
    assert.equal(count(/<Banner banner=\{banner\} warn=\{bannerWarn\} \/>/g), 1, 'one banner render');
    const hooks = [...source.matchAll(/testID=(?:"([^"]+)"|\{`([^`]+)`\})/g)]
      .map((match) => match[1] ?? match[2])
      .filter((id) => id === 'banner');
    assert.equal(hooks.length, 1, 'exactly one rendered banner hook');
    assert.match(source, /testID="banner"\s+accessibilityLabel=\{banner\}/);
  });

  it('renders no banner at all when there is no banner state', () => {
    assert.match(
      source,
      /const banner = snapshot\.banner !== 'none' \? t\(locale, bannerKey\(snapshot\.banner\)\) : null;/,
    );
    assert.match(source, /if \(banner === null\) return null;/);
  });
});

// Device defect (owner's emulator pass, v3): the user typed a prompt, the send button turned green,
// two taps 2 s apart did nothing, 50 s later the text was still in the box and no session existed.
//
// Root cause found in the code, not the tap: `send()` created a session and then DROPPED the typed
// text (creating an empty session), and `createSession` does not open a session, so `sendPrompt` —
// which targets the OPEN session — could never deliver it. These assertions pin the real sequence.
describe('composer send — the typed text reaches the new session', () => {
  const sendBody = (() => {
    const start = source.indexOf('const send = useCallback');
    const end = source.indexOf('}, [availability.enabled, controller, draft, router, workspaceId]);');
    return start === -1 || end === -1 ? '' : source.slice(start, end);
  })();

  it('has the send callback', () => {
    assert.notEqual(sendBody, '', 'send() is found');
  });

  it('creates, then OPENS the session, then sends the prompt (in that order)', () => {
    const create = sendBody.indexOf('controller.createSession(');
    const open = sendBody.indexOf('controller.openSession(');
    const send = sendBody.indexOf('controller.sendPrompt(');
    assert.notEqual(create, -1, 'it creates the session');
    assert.notEqual(open, -1, 'it opens the new session before sending');
    assert.notEqual(send, -1, 'it sends the typed text');
    assert.ok(create < open, 'open happens after the id exists');
    assert.ok(open < send, 'sendPrompt needs an OPEN session — open must come first');
    assert.match(sendBody, /await controller\.sendPrompt\(text\)/, 'the draft text is what gets sent');
  });

  it('never clears the draft unless the session was actually created', () => {
    const failureReturn = sendBody.indexOf('setCreateError({ code: created.code');
    const clear = sendBody.indexOf("setDraft('')");
    assert.notEqual(failureReturn, -1, 'a failed create is surfaced with its code');
    assert.ok(failureReturn < clear, 'the draft is only cleared on the success path');
  });

  it('shows why a create failed instead of failing silently', () => {
    assert.match(source, /setCreateError\(\{ code: created\.code/, 'the controller code is kept');
    assert.match(source, /\(\$\{createError\.code\}\)/, 'the code is rendered');
  });

  it('lets a tap reach Send while the keyboard is open', () => {
    assert.match(source, /keyboardShouldPersistTaps="handled"/, 'the scroll parent keeps the tap');
  });
});
describe('revoked banner copy', () => {
  it('says what happened and what to do next (en), in every locale', () => {
    for (const locale of LOCALES) {
      assert.ok(t(locale, 'banner.revoked').trim() !== '', `${locale}: banner.revoked`);
    }
    assert.match(t('en', 'banner.revoked'), /removed from the computer/i);
    assert.match(t('en', 'banner.revoked'), /pair again/i);
  });

  it('says what happened and what to do next (vi)', () => {
    assert.match(t('vi', 'banner.revoked'), /xoá khỏi máy tính/i);
    assert.match(t('vi', 'banner.revoked'), /ghép đôi lại/i);
  });

  it('keeps a distinct message for every banner state', () => {
    for (const locale of LOCALES) {
      assert.match(t(locale, 'banner.reauth'), /re-?authenticate|xác thực lại/i);
      assert.ok(t(locale, 'banner.gatewayOff').trim() !== '', `${locale}: banner.gatewayOff`);
    }
  });
});

// Device regression (owner's emulator pass, both light and dark): rows ran edge to edge and the text
// was clipped at BOTH edges. The reference layout keeps rows inset with a single line of text, so
// these assertions pin the invariants that keep a row inside the screen — restated for the new
// dot + title row (the old `rowBody`/`rowTitle`/`rowTime` columns are gone with the redesign).
describe('session list — row layout (no edge clipping)', () => {
  /** One `name: { ... }` entry from the screen's `StyleSheet.create` block. */
  function styleEntry(name: string): string {
    const match = new RegExp(`\\n  ${name}: \\{([^}]*)\\}`).exec(source);
    assert.notEqual(match, null, `style ${name} not found in the list screen`);
    return match?.[1] ?? '';
  }

  it('insets rows and lays them out horizontally', () => {
    const row = styleEntry('row');
    assert.match(row, /paddingHorizontal: space\.(xl|lg|md)/, 'rows must have a horizontal inset');
    assert.doesNotMatch(row, /paddingHorizontal: 0\b/, 'rows must not be flush to the screen edges');
    assert.match(row, /flexDirection: 'row'/, 'the row lays its children out horizontally');
  });

  it('gives the title the leftover space so it ellipsizes instead of pushing out', () => {
    // The reference row is [dot][title]; the title must be the flexible, shrinkable piece.
    assert.match(
      source,
      /<Text numberOfLines=\{1\} style=\{\[type\.body, \{ color: colors\.text, flex: 1 \}\]\}>/,
      'the title takes the leftover space and is single-line',
    );
    assert.match(styleEntry('dot'), /width: 7/, 'the status dot keeps a fixed size');
  });

  it('keeps every row line to one line of text', () => {
    const titleLines = [...source.matchAll(/<Text numberOfLines=\{1\}/g)];
    assert.ok(titleLines.length >= 2, 'section header and row title are both single-line');
  });

  // Parity change, deliberately recorded: reference 01 shows NO timestamps, so the old "show the
  // relative time exactly once" guard becomes "the list shows no relative time at all". The intent is
  // preserved — the row must not repeat or leak a second time value — and the detail is one tap away
  // inside the session screen.
  it('shows dot + title only (reference parity): no relative time in the list', () => {
    assert.equal(/sessions\.updatedAgo/.test(source), false, 'no "updated …" line');
    assert.equal(/styles\.rowTime/.test(source), false, 'no trailing time column');
    assert.equal(/relativeTime\(/.test(source), false, 'the list does not compute relative times');
  });
});
