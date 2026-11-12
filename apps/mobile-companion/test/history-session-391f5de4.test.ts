// The real history page of session-391f5de4-f4ec-41e6-b22f-24b25455ba1a (spec 017 wave 1 fix).
//
// WHY this fixture is 20 hand-written events instead of a capture: the device rendered NOTHING for a
// turn that the Host really ran. DSH writes its own bookkeeping into the transcript as `user/message`
// (runtime-context, skill catalog, "Time sampled…", <system-reminder>) and the phone drew each one as
// if the user had typed it — three fake user turns, and the answer lost among them. This file pins the
// corrected reading of the exact event sequence:
//
//   seq 1-4    permission / preset noise            (no row)
//   seq 5      turn/start                           (no row)
//   seq 6-8    job registered/settled               (no row)
//   seq 9      user/message  ← THE one real prompt   (1 row)
//   seq 10-12  user/message  ← Host bookkeeping     (no row)
//   seq 13-14  llm request/response                 (no row)
//   seq 15-17  session/title                        (no row)
//   seq 18     assistant/message, 1 content block, 498 chars of markdown table  (1 row)
//   seq 19-20  step/end, turn/end                   (no row)
//
// Expected reading: ONE turn — one real user message and one assistant message carrying a markdown
// table — and zero system messages.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coerceHistoryEvent, coerceHistoryEvents, isHostInjectedUserText } from '../src/core/history';
import { parseMarkdown } from '../src/ui/markdown/parse';

/** The one real prompt (byte-identical to what was typed on the device). */
const REAL_PROMPT =
  'Draw a markdown table with 3 columns (Name, Role, Notes) and 4 rows about DSH Mobile components. Reply with the table only, no tools.';

/** The answer body: one `text` block, a 3-column markdown table (the Host's body measured 498 chars). */
const TABLE_BODY = [
  '| Name | Role | Notes |',
  '| --- | --- | --- |',
  '| mobile-gateway | Host bridge for the phone | WebSocket transport, per-device credentials, isolated revocation |',
  '| mobile-companion | The phone app | React Native + Expo, native render only, never a WebView wrapper |',
  '| mobile-protocol | Shared contract | Versioned and typed, so a mismatch is surfaced and never silent |',
  '| dsh-wiki | Local repo wiki | Fully offline, every claim cites path:line from the snapshot |',
  '',
  'These four make up the mobile product.',
].join('\n');

const RUNTIME_CONTEXT =
  'The following workspace instructions are relevant when applicable: Current working directory: '
  + 'C:\\Users\\me\\Documents\\DSH_Project. Current DSH file policy: danger-full-access.';

const SKILL_CATALOG =
  'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session: <available_skills> - office - dsh-wiki - rea-toolkit </available_skills>';

const TIME_SAMPLED =
  'Time sampled while preparing turn 1, step 2: 2026-11-11T11:33:00+07:00[Asia/Saigon]\n'
  + 'Browser time zone for this request: unavailable.\n'
  + '<system-reminder>Instructions from: AGENTS.md are guidance only.</system-reminder>';

const userMessage = (seq: number, text: string) => ({
  type: 'user/message',
  seq,
  time: 1_700_000_000_000 + seq,
  data: { message: { role: 'user', content: [{ type: 'text', text }] } },
});

const EVENTS: unknown[] = [
  { type: 'permission/set', seq: 1, data: { mode: 'default' } },
  { type: 'preset/set', seq: 2, data: { preset: 'coder' } },
  { type: 'permission/set', seq: 3, data: { mode: 'default' } },
  { type: 'preset/set', seq: 4, data: { preset: 'coder' } },
  { type: 'turn/start', seq: 5, data: { turn: 1 } },
  { type: 'job/registered', seq: 6, data: { id: 'job-1' } },
  { type: 'job/registered', seq: 7, data: { id: 'job-2' } },
  { type: 'job/settled', seq: 8, data: { id: 'job-1' } },
  userMessage(9, REAL_PROMPT),
  userMessage(10, RUNTIME_CONTEXT),
  userMessage(11, SKILL_CATALOG),
  userMessage(12, TIME_SAMPLED),
  { type: 'llm/request', seq: 13, data: { model: 'r9-fallback/ds41-cmc-ccsonnet' } },
  { type: 'llm/response', seq: 14, data: { finish: 'stop' } },
  { type: 'session/title', seq: 15, data: { title: 'Markdown table for three DSH Mobile things' } },
  { type: 'session/title', seq: 16, data: { title: 'Markdown table' } },
  { type: 'session/title', seq: 17, data: { title: 'Markdown table for three DSH Mobile things' } },
  {
    type: 'assistant/message',
    seq: 18,
    time: 1_700_000_000_018,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: TABLE_BODY }] } },
  },
  { type: 'step/end', seq: 19, data: { step: 1 } },
  { type: 'turn/end', seq: 20, data: { turn: 1 } },
];

describe('the real 20-event history page renders one turn (session-391f5de4)', () => {
  it('the fixture is exactly the 20 events described', () => {
    assert.equal(EVENTS.length, 20, 'twenty events');
    const seqs = EVENTS.map((event) => (event as { seq?: number }).seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    assert.equal((EVENTS[17] as { data: { message: { content: unknown[] } } }).data.message.content.length, 1, 'one content block');
    assert.ok(
      TABLE_BODY.length >= 480 && TABLE_BODY.length <= 520,
      `answer body is paragraph-sized, like the Host's 498 chars (${TABLE_BODY.length})`,
    );
  });

  it('yields exactly one user message and one assistant message', () => {
    const rows = coerceHistoryEvents(EVENTS);
    assert.equal(rows.length, 2, `expected 2 rows, got ${rows.length}: ${rows.map((row) => `${row.seq}:${row.role}`).join(', ')}`);
    assert.deepEqual(rows.map((row) => row.role), ['user', 'assistant']);
    assert.deepEqual(rows.map((row) => row.seq), [9, 18], 'the surviving rows are the real prompt and the answer');
  });

  it('renders NO system message: the three injected user/message bodies are dropped', () => {
    const rows = coerceHistoryEvents(EVENTS);
    for (const injected of [RUNTIME_CONTEXT, SKILL_CATALOG, TIME_SAMPLED]) {
      assert.equal(
        rows.some((row) => row.text === injected),
        false,
        `the injected body must not become a bubble: ${injected.slice(0, 40)}…`,
      );
    }
    // And not by accident: each one is recognised on its own.
    assert.equal(isHostInjectedUserText(RUNTIME_CONTEXT), true, 'runtime-context');
    assert.equal(isHostInjectedUserText(SKILL_CATALOG), true, 'skill catalog');
    assert.equal(isHostInjectedUserText(TIME_SAMPLED), true, 'time-sampled / system-reminder');
    assert.equal(isHostInjectedUserText(REAL_PROMPT), false, 'a real prompt is never filtered');
  });

  it('the assistant text comes from data.message.content[].text and is a real table', () => {
    const rows = coerceHistoryEvents(EVENTS);
    const answer = rows.find((row) => row.role === 'assistant');
    assert.ok(answer, 'the answer exists');
    assert.equal(answer.text, TABLE_BODY, 'text is the content block, not a stream reconstruction');

    const blocks = parseMarkdown(answer.text);
    const tables = blocks.filter((block) => block.kind === 'table');
    assert.equal(tables.length, 1, 'the body parses as one markdown table');
    const table = tables[0];
    assert.ok(table && table.kind === 'table');
    assert.equal(table.header.length, 3, 'three columns');
    assert.equal(table.rows.length, 4, 'four rows');
    assert.deepEqual(
      table.header.map((cell) => cell.map((part) => ('text' in part ? part.text : '')).join('')),
      ['Name', 'Role', 'Notes'],
    );
  });

  it('keeps seq order and no reasoning for an answer without a reasoning block', () => {
    const rows = coerceHistoryEvents(EVENTS);
    assert.equal(rows[1]?.reasoning, undefined, 'no reasoning invented');
    const ascending = [...rows].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    assert.deepEqual(rows.map((row) => row.seq), ascending.map((row) => row.seq));
  });

  it('drops each injected event individually through coerceHistoryEvent', () => {
    for (const index of [9, 10, 11]) {
      assert.equal(coerceHistoryEvent(EVENTS[index]), null, `seq ${index + 1} is Host bookkeeping`);
    }
    assert.notEqual(coerceHistoryEvent(EVENTS[8]), null, 'seq 9 is the real prompt');
    assert.notEqual(coerceHistoryEvent(EVENTS[17]), null, 'seq 18 is the answer');
  });

  it('filters the same markers on the contract shape too (role-carrying rows)', () => {
    assert.equal(coerceHistoryEvent({ seq: 10, role: 'user', text: TIME_SAMPLED }), null);
    assert.equal(coerceHistoryEvent({ seq: 9, role: 'user', text: REAL_PROMPT })?.role, 'user');
  });
});
