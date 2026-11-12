// Session rename / archive — the pure policy the list screen and the controller accessor share.
//
// Two things are pinned here, and both are about honesty rather than mechanics:
//   * a control exists only when the Host advertised the operation, because there is no per-op
//     capability in the contract yet (CAPABILITIES is ['sessions-read','prompt','cancel',
//     'approval-v1'] and rename/archive appear nowhere in packages/mobile-protocol/src);
//   * a title is validated the way it will be sent — trimmed, non-empty, at most 200 characters
//     counted in code points — so the dialog cannot hand the accessor something it must refuse.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_TITLE_CHARS,
  SESSION_ARCHIVE_CAPABILITY,
  SESSION_RENAME_CAPABILITY,
  archiveFrame,
  canArchiveSession,
  canRenameSession,
  normalizeTitle,
  renameFrame,
  sessionActionErrorKey,
  titleProblem,
} from '../src/ui/conversation/session-actions';

describe('session actions — a control exists only when the Host serves it', () => {
  it('hides rename/archive when the Host advertises neither (today\'s contract)', () => {
    const today = ['sessions-read', 'prompt', 'cancel', 'approval-v1'];
    assert.equal(canRenameSession(today), false, 'no rename capability ⇒ no rename control');
    assert.equal(canArchiveSession(today), false, 'no archive capability ⇒ no archive control');
  });

  it('shows each control only for its own capability', () => {
    assert.equal(canRenameSession([SESSION_RENAME_CAPABILITY]), true);
    assert.equal(canArchiveSession([SESSION_RENAME_CAPABILITY]), false, 'rename does not imply archive');
    assert.equal(canArchiveSession([SESSION_ARCHIVE_CAPABILITY]), true);
  });

  it('a malformed capability list grants nothing', () => {
    assert.equal(canRenameSession(null), false);
    assert.equal(canRenameSession(undefined), false);
    assert.equal(canArchiveSession(null), false);
  });
});

describe('session actions — title validation matches what will be sent', () => {
  it('trims before deciding', () => {
    assert.equal(normalizeTitle('  Sprint 3  '), 'Sprint 3');
    assert.equal(titleProblem('   '), 'empty', 'whitespace only is empty');
    assert.equal(titleProblem(''), 'empty');
  });

  it('accepts a title at the limit and refuses one over it', () => {
    assert.equal(MAX_TITLE_CHARS, 200);
    assert.equal(titleProblem('a'.repeat(200)), null, 'exactly 200 is allowed');
    assert.equal(titleProblem('a'.repeat(201)), 'too-long');
  });

  it('counts characters in code points, not UTF-16 units', () => {
    // 200 emoji are 400 UTF-16 units: a unit-based limit would refuse a legal title.
    const emoji = '🙂'.repeat(200);
    assert.equal(emoji.length, 400, 'the fixture really is two units per character');
    assert.equal(titleProblem(emoji), null);
    assert.equal(titleProblem('🙂'.repeat(201)), 'too-long');
  });

  it('trailing whitespace cannot smuggle an over-long title through', () => {
    assert.equal(titleProblem(`${'a'.repeat(200)}   `), null, 'the padding is trimmed, length is legal');
    assert.equal(titleProblem(`${'a'.repeat(201)}   `), 'too-long');
  });
});

describe('session actions — frames are built in one place', () => {
  it('builds the rename frame the gateway expects', () => {
    assert.deepEqual(renameFrame('session-1', '  New name '), { sessionId: 'session-1', title: 'New name' });
  });

  it('refuses to build a frame that the Host would reject', () => {
    assert.throws(() => renameFrame('  ', 'name'), /needs a session id/);
    assert.throws(() => renameFrame('session-1', '  '), /title is empty/);
    assert.throws(() => renameFrame('session-1', 'a'.repeat(201)), /title is too-long/);
    assert.throws(() => archiveFrame(''), /needs a session id/);
  });

  it('builds the archive frame with only the session id', () => {
    assert.deepEqual(archiveFrame(' session-1 '), { sessionId: 'session-1' });
  });
});

describe('session actions — failures are explained by code', () => {
  it('maps the codes the gateway can answer', () => {
    assert.equal(sessionActionErrorKey('session/not-found'), 'sessionActions.errorNotFound');
    assert.equal(sessionActionErrorKey('auth/revoked'), 'sessionActions.errorAuth');
    assert.equal(sessionActionErrorKey('bad-request'), 'sessionActions.errorGeneric');
    assert.equal(sessionActionErrorKey(undefined), 'sessionActions.errorGeneric');
  });
});
