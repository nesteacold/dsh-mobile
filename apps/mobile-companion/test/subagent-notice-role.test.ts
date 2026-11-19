// Spec 051 — a harness completion notice is a system note, never an owner bubble.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { coerceHistoryEvent, isSubagentCompletionNotice } from '../src/core/history';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTICE = 'Background subagent coder-app-nolock finished and will do no further work unless you send it more. It sent you a message just before finishing, so its closing message is omitted.';

describe('spec 051: strict completion-notice classifier', () => {
  it('requires both the phrase and a harness footer, case-insensitively', () => {
    assert.equal(isSubagentCompletionNotice(NOTICE), true);
    assert.equal(isSubagentCompletionNotice('background SUBAGENT finished and will do no further work'), true);
    assert.equal(isSubagentCompletionNotice('Its closing message is omitted — background subagent'), true);
    assert.equal(isSubagentCompletionNotice('Background subagent coder is working on the task'), false);
    assert.equal(isSubagentCompletionNotice('finished and will do no further work'), false);
    assert.equal(isSubagentCompletionNotice(''), false);
  });

  it('contract-shape {role:user,text} maps to system and preserves the text', () => {
    const row = coerceHistoryEvent({ seq: 9, role: 'user', text: NOTICE });
    assert.ok(row !== null);
    assert.equal(row.role, 'system');
    assert.equal(row.text, NOTICE, 'visible for audit, never silent-dropped');
  });

  it('live user/message shape maps to system and preserves the text', () => {
    const row = coerceHistoryEvent({
      type: 'user/message',
      seq: 10,
      text: NOTICE,
      data: { message: { content: [] } },
    });
    assert.ok(row !== null);
    assert.equal(row.role, 'system');
    assert.equal(row.text, NOTICE);
  });

  it('a real prompt mentioning background subagent stays a user row; host markers still drop', () => {
    const prompt = 'Please check what the background subagent found before we merge.';
    assert.equal(isSubagentCompletionNotice(prompt), false);
    const row = coerceHistoryEvent({ type: 'user/message', text: prompt, data: {} });
    assert.equal(row?.role, 'user');
    assert.equal(coerceHistoryEvent({ type: 'user/message', text: '<system-reminder>x</system-reminder>', data: {} }), null);
  });

  it('render contract: system rows still use ToolRow, not the user bubble', () => {
    const screen = readFileSync(path.join(APP, 'app', 'session', '[id].tsx'), 'utf8');
    assert.match(screen, /message\.role === 'system'[\s\S]{0,300}ToolRow/);
  });
});
