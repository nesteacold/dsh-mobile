// History rendering — the five defects packaging measured on the LIVE session
// `session-391f5de4-f4ec-41e6-b22f-24b25455ba1a` (REA_Project, one completed turn, 6 s).
//
// THE FIXTURE IS THE MEASUREMENT. That session's 20 events, in order:
//   seq1-4   permission …            (bookkeeping)
//   seq5     turn/start             (the turn exists)
//   seq9     user/message           (the REAL prompt — the table request)
//   seq10-12 user/message           (DSH-injected: runtime-context, skill catalog, time-sampled)
//   seq13-14 request/context …      (bookkeeping)
//   seq15-17 session/title …        (bookkeeping)
//   seq18    assistant/message      (the answer: 1 text block, 498 chars, no `data.stream`)
//   seq19-20 step/end, turn/end
//
// What went wrong on the device: the first `history` page held only 7 events (request/context …
// turn/end) because the Host pages by BYTES, so the prompt and turn/start were on an older page; the
// app read one page, so the transcript showed an answer with no question. Three extra "user" bubbles
// came from seq10-12. And any `beforeSeq` request without `historyFormatVersion` is refused outright
// with `resetRequired: true`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HistoryStore, coerceHistoryEvents, isHostInjectedUserText } from '../src/core/history';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_STATE = readFileSync(path.join(ROOT, 'src', 'app-state.ts'), 'utf8');
const CLIENT = readFileSync(path.join(ROOT, 'src', 'core', 'client.ts'), 'utf8');

const PROMPT =
  'Draw a markdown table with 3 columns (Name, Role, Notes) and 4 rows about DSH Mobile components. '
  + 'Reply with the table only, no tools.';
const ANSWER = '| Name | Role | Notes |\n| --- | --- | --- |\n| Composer | input | … |\n… (498 chars total)';

/** One DSH session event, history shape: `{type, seq, time, data}`. */
function event(type: string, seq: number, data: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, seq, time: 1_700_000_000_000 + seq, data };
}

/** `user/message` carrying a content-block array, exactly as the Host sends it. */
function userMessage(seq: number, text: string): Record<string, unknown> {
  return event('user/message', seq, { content: [{ type: 'text', text }] });
}

/** `assistant/message` with its text ONLY inside `data.message.content[].text` (no `data.stream`). */
function assistantMessage(seq: number, text: string): Record<string, unknown> {
  return event('assistant/message', seq, { message: { content: [{ type: 'text', text }] } });
}

const INJECTED = [
  userMessage(10, '<system-reminder>\nruntime-context: file policy workspace-write\n</system-reminder>'),
  userMessage(11, 'The following skills are available for use with the Skill tool:\n\n<available_skills>…'),
  userMessage(12, 'Time sampled while preparing turn 40, step 1: 2026-11-11T13:40:58+07:00\nBrowser time zone: unavailable'),
];

/** The OLDER page: the question and the turn bookkeeping (what the first page was missing). */
const OLDER_PAGE = [
  event('permission', 1, { scope: 'sessions:author' }),
  event('permission', 2, {}),
  event('permission', 3, {}),
  event('permission', 4, {}),
  event('turn/start', 5, {}),
  userMessage(9, PROMPT),
  ...INJECTED,
];

/** The OPENING page as measured: no user/message at all — that is the whole bug. */
const OPENING_PAGE = [
  event('request/context', 13, {}),
  event('request/header', 14, {}),
  event('session/title', 15, {}),
  event('agent-preset/selected', 16, {}),
  event('session/title', 17, {}),
  assistantMessage(18, ANSWER),
  event('step/end', 19, {}),
  event('turn/end', 20, {}),
];

describe('(3) DSH-injected user messages are not user turns', () => {
  it('recognises every marker the Host writes around a real prompt', () => {
    for (const injected of INJECTED) {
      const text = coerceHistoryEvents([injected]);
      assert.deepEqual(text, [], 'an injected user/message is dropped');
    }
    assert.equal(isHostInjectedUserText('<system-reminder>x</system-reminder>'), true);
    assert.equal(isHostInjectedUserText('runtime-context'), true);
    assert.equal(isHostInjectedUserText('Time sampled while preparing turn 40'), true);
  });

  it('never drops the real prompt, even though it mentions tools and tables', () => {
    // Both of these are genuine prompts from this project and must survive verbatim.
    for (const prompt of [
      PROMPT,
      'Reply with the table only, no tools.',
      'Sửa màn danh sách để dòng cuối nằm trên composer',
    ]) {
      assert.equal(isHostInjectedUserText(prompt), false, `kept: ${prompt.slice(0, 40)}`);
      const rows = coerceHistoryEvents([userMessage(9, prompt)]);
      assert.equal(rows.length, 1, 'a real prompt is one row');
      assert.equal(rows[0]?.role, 'user');
      assert.equal(rows[0]?.text, prompt);
    }
  });
});

describe('(4) the answer renders from data.message.content[].text with no stream', () => {
  it('takes the text of an assistant/message that carries no data.stream', () => {
    const rows = coerceHistoryEvents([assistantMessage(18, ANSWER)]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.role, 'assistant');
    assert.equal(rows[0]?.text, ANSWER, 'the block text is the row text');
    assert.equal(rows[0]?.seq, 18);
  });

  it('does not need a live subscribe to see the answer', () => {
    // A page that contains only the answer still renders it.
    const store = new HistoryStore();
    store.setPage(coerceHistoryEvents(OPENING_PAGE), { hasMore: true, nextBeforeSeq: 14, formatVersion: 4 });
    const answer = store.items.find((item) => item.role === 'assistant');
    assert.notEqual(answer, undefined, 'the assistant row exists');
    assert.equal(answer?.text, ANSWER);
  });
});

describe('a cursor request always carries sessionId', () => {
  // DEVICE DEFECT (AOW Remaster capture, `wave1-code-card-dark.png`): the "load earlier" affordance
  // always showed "Could not load earlier messages". Cause: the cursor params sent `beforeSeq` (and
  // the format version) but NOT `sessionId`, and the gateway requires it
  // (`plugins/mobile-gateway/lib/index.mjs:1695-1697` → `parseSessionTarget`), so every older-page
  // request was refused before the Host was ever asked.
  const cursorHelper = (() => {
    const start = APP_STATE.indexOf('private historyCursorParams(');
    assert.notEqual(start, -1, 'the helper exists');
    const end = APP_STATE.indexOf('\n  }', start);
    return APP_STATE.slice(start, end === -1 ? start + 800 : end);
  })();

  it('the helper takes sessionId and includes it in the params', () => {
    assert.match(cursorHelper, /private historyCursorParams\(sessionId: string, beforeSeq: number\)/);
    assert.match(cursorHelper, /sessionId, beforeSeq/, 'sessionId is sent');
    assert.match(cursorHelper, /historyFormatVersion: formatVersion/, 'and the format version with it');
  });

  it('every history request in app-state passes a sessionId', () => {
    const calls = APP_STATE.match(/request\('history', [^;]+\)/g) ?? [];
    assert.notEqual(calls.length, 0, 'history requests exist');
    for (const call of calls) {
      assert.match(call, /sessionId/, `request without a sessionId: ${call}`);
    }
    // Both paging paths go through the helper with the id.
    assert.match(APP_STATE, /this\.historyCursorParams\(sessionId, beforeSeq\)/);
    assert.equal(/historyCursorParams\(beforeSeq\)/.test(APP_STATE), false,
      'no call site may omit the session id');
  });

  it('the older-page failure is surfaced as a code, never as a bare generic line', () => {
    // `historyError` is the code string; the screen is expected to render it beside the sentence.
    assert.match(APP_STATE, /historyError: string \| null/);
    assert.match(APP_STATE, /historyError: this\.historyLoad\.error/);
    assert.match(APP_STATE, /this\.historyLoad = \{ loading: false, error: authoringErrorCode\(error\) \}/);
  });
});

describe('(1) the cursor carries historyFormatVersion', () => {  it('remembers the version from the first reply and exposes it with the page', () => {
    const store = new HistoryStore();
    store.setPage(coerceHistoryEvents(OPENING_PAGE), { hasMore: true, nextBeforeSeq: 14, formatVersion: 4 });
    assert.equal(store.page.formatVersion, 4, 'the Host version is kept on the page');
    assert.equal(store.page.nextBeforeSeq, 14, 'and with it the Host cursor');
  });

  it('builds beforeSeq requests with the version, never a bare cursor', () => {
    // The gateway refuses a cursor without it (`PROTOCOL.md:748`).
    assert.match(APP_STATE, /private historyCursorParams\(sessionId: string, beforeSeq: number\)/);
    assert.match(APP_STATE, /historyFormatVersion: formatVersion/, 'the version is attached');
    assert.match(APP_STATE, /this\.client\.request\('history', this\.historyCursorParams\(sessionId, beforeSeq\)\)/,
      'loadOlderHistory goes through it');
    assert.equal(/request\('history', \{ sessionId, beforeSeq \}\)/.test(APP_STATE), false,
      'no request sends a bare beforeSeq');
  });

  it('keeps the Host cursor instead of re-deriving it from the filtered rows', () => {
    const store = new HistoryStore();
    store.setPage(coerceHistoryEvents(OPENING_PAGE), { hasMore: true, nextBeforeSeq: 14, formatVersion: 4 });
    // The older page is entirely filtered out (bookkeeping only) — the cursor must still move back.
    store.prependPage(coerceHistoryEvents([event('request/context', 8, {})]), {
      hasMore: true,
      nextBeforeSeq: 4,
    });
    assert.equal(store.page.nextBeforeSeq, 4, 'the Host cursor survives a page with no rows');
  });
});

describe('(2) pages load until the transcript contains the prompt', () => {
  it('hasUserTurn() reports whether a real prompt is present', () => {
    const store = new HistoryStore();
    store.setPage(coerceHistoryEvents(OPENING_PAGE), { hasMore: true, nextBeforeSeq: 14, formatVersion: 4 });
    assert.equal(store.hasUserTurn(), false, 'the opening page alone has no prompt');
    store.prependPage(coerceHistoryEvents(OLDER_PAGE), { hasMore: false });
    assert.equal(store.hasUserTurn(), true, 'after the older page the prompt is there');
  });

  it('the two full pages together reconstruct question + answer', () => {
    const store = new HistoryStore();
    store.setPage(coerceHistoryEvents(OPENING_PAGE), { hasMore: true, nextBeforeSeq: 14, formatVersion: 4 });
    store.prependPage(coerceHistoryEvents(OLDER_PAGE), { hasMore: false });
    const rows = store.items;
    const user = rows.filter((row) => row.role === 'user');
    const assistant = rows.filter((row) => row.role === 'assistant');
    assert.equal(user.length, 1, 'exactly one real prompt — the three injected ones are gone');
    assert.equal(user[0]?.text, PROMPT);
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0]?.text, ANSWER);
    // Ordered by seq: the question (9) before the answer (18).
    assert.deepEqual(rows.map((row) => row.seq), [9, 18]);
  });

  it('the auto-pager stops, and is bounded', () => {
    assert.match(APP_STATE, /private async loadHistoryWithPrompts\(sessionId: string, maxPages = 5\)/,
      'bounded to ~5 pages');
    assert.match(APP_STATE, /if \(!page\.hasMore \|\| this\.history\.hasUserTurn\(\)\) break;/,
      'it stops once a prompt is present');
    assert.match(APP_STATE, /pages < maxPages/, 'and the bound is enforced');
    assert.match(APP_STATE, /if \(beforeSeq === null\) break;/, 'no cursor means no further paging');
  });
});

describe('(5) history-format-mismatch is never swallowed', () => {
  it('the client forwards resetRequired and the required version to the caller', () => {
    assert.match(CLIENT, /resetRequired: f\.resetRequired/, 'resetRequired survives the error frame');
    assert.match(CLIENT, /historyFormatVersion: f\.historyFormatVersion/, 'the required version survives');
  });

  it('the app reloads the baseline when the Host says resetRequired', () => {
    assert.match(APP_STATE, /private isHistoryResetRequired\(error: unknown\): boolean/);
    assert.match(APP_STATE, /error\.code !== 'history-format-mismatch'/, 'only that code resets');
    assert.match(APP_STATE, /error\.details\?\.resetRequired === true/, 'and only with resetRequired');
    assert.match(APP_STATE, /await this\.resetHistoryBaseline\(sessionId\)/, 'the baseline is reloaded');
    assert.match(APP_STATE, /private async resetHistoryBaseline\(sessionId: string\)/);
    assert.match(APP_STATE, /this\.history\.clear\(\);/, 'the stale generation is dropped first');
  });

  it('any other history failure still surfaces its code', () => {
    // The generic branch must survive: one muted line with the code, never a silent empty transcript.
    assert.match(APP_STATE, /this\.historyLoad = \{ loading: false, error: authoringErrorCode\(error\) \}/);
    assert.match(APP_STATE, /this\.recordError\(error\)/);
  });
});
