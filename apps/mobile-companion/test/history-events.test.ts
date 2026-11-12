// Tests for the DSH event → history row mapping (spec 011 P1-B, parity fix A).
//
// FIXTURES ARE MEASURED, NOT INVENTED. The live shapes below are what `buildWireEvent()` actually
// emits (`plugins/mobile-gateway/lib/index.mjs:416-460`: user/assistant text flattened to `text`,
// tool/call → {callId,name,arguments}, tool/result → {callId,isError,preview}); the history shapes
// are raw DSH SessionEvents as `PROTOCOL.md:744,768` describes (`{type,seq,time,data}`, with
// `data.message.content` for assistant/tool text and `data.stream` stripped in `view:'conversation'`).
//
// The regression these lock down: every one of those rows used to reach the screen with role
// 'other', so user prompts AND agent prose both rendered as the "HOẠT ĐỘNG" tool pill on device.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SKIPPED_HISTORY_EVENT_TYPES,
  coerceHistoryEvent,
  coerceHistoryEvents,
} from '../src/core/history';

describe('history events: live wire shapes (buildWireEvent)', () => {
  it('maps an assistant message to role assistant with its flattened text', () => {
    // lib/index.mjs:452-459
    const row = coerceHistoryEvent({
      type: 'assistant/message', turn: 1, step: 0,
      text: 'Progress: `README.vi.md` just written (331 lines).\n\nMore prose.',
      reasoning: '', toolCalls: [], interrupted: false,
    });
    assert.equal(row?.role, 'assistant');
    assert.equal(row?.text, 'Progress: `README.vi.md` just written (331 lines).\n\nMore prose.');
  });

  it('maps a user message to role user', () => {
    // lib/index.mjs:423-438
    const row = coerceHistoryEvent({ type: 'user/message', text: 'Tất cả Readme phải cùng nội dung', source: 'user' });
    assert.equal(row?.role, 'user');
    assert.equal(row?.text, 'Tất cả Readme phải cùng nội dung');
  });

  it('maps a tool call to a compact tool row (name + argument summary)', () => {
    const row = coerceHistoryEvent({
      type: 'tool/call', turn: 1, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}\nsecond',
    });
    assert.equal(row?.role, 'tool');
    assert.equal(row?.text, 'bash {"command":"ls -la"}');
  });

  it('maps a tool result to a tool row using its preview', () => {
    const row = coerceHistoryEvent({
      type: 'tool/result', turn: 1, step: 0, callId: 'c1', isError: false, preview: 'total 0',
    });
    assert.equal(row?.role, 'tool');
    assert.equal(row?.text, 'total 0');
  });

  it('carries the frame sequence through, so transcript order survives', () => {
    const row = coerceHistoryEvent({ type: 'assistant/message', seq: 42, time: 1_700_000_000_000, text: 'x' });
    assert.equal(row?.seq, 42);
    assert.equal(row?.at, 1_700_000_000_000);
  });
});

describe('history events: raw session events (history page)', () => {
  it('reads assistant text out of data.message.content', () => {
    const row = coerceHistoryEvent({
      type: 'assistant/message', seq: 4, time: 4,
      data: { turn: 1, message: { content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] } },
    });
    assert.equal(row?.role, 'assistant');
    assert.equal(row?.text, 'first\nsecond');
  });

  it('reads user text out of data.content and tolerates a single text block', () => {
    const row = coerceHistoryEvent({
      type: 'user/message', seq: 2, time: 2,
      data: { content: [{ type: 'text', text: 'Please refactor the TLS listener' }], source: { kind: 'user' } },
    });
    assert.equal(row?.role, 'user');
    assert.equal(row?.text, 'Please refactor the TLS listener');
  });

  it('reads a tool result out of data.message.content (V4 flat result)', () => {
    const row = coerceHistoryEvent({
      type: 'tool/result', seq: 5, time: 5,
      data: { turn: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'x'.repeat(20) }] } },
    });
    assert.equal(row?.role, 'tool');
    assert.equal(row?.text, 'x'.repeat(20));
  });

  it('falls back to the flattened `data.output` (measured: tool/result carries both)', () => {
    const row = coerceHistoryEvent({
      type: 'tool/result', seq: 6, time: 6,
      data: { turn: 1, message: { role: 'tool', toolCallId: 'c1', content: [] }, output: 'branch main …', meta: { cwd: 'C:\\w' } },
    });
    assert.equal(row?.role, 'tool');
    assert.equal(row?.text, 'branch main …');
  });

  it('reports an errored tool result that has no text, instead of dropping it', () => {
    const row = coerceHistoryEvent({
      type: 'tool/result', seq: 7, time: 7,
      data: { turn: 1, message: { role: 'tool', isError: true, content: [] } },
    });
    assert.equal(row?.role, 'tool');
    assert.equal(row?.text, 'error');
  });

  it('ignores non-text blocks instead of rendering JSON', () => {
    const row = coerceHistoryEvent({
      type: 'user/message', seq: 1, time: 1,
      data: { content: [{ type: 'image', attachment: { attachmentId: 'sha256-x' } }, { type: 'text', text: 'caption' }] },
    });
    assert.equal(row?.text, 'caption');
  });
});

describe('history events: protocol chatter is skipped, never turned into rows', () => {
  it('every documented skip type yields null', () => {
    for (const type of SKIPPED_HISTORY_EVENT_TYPES) {
      assert.equal(coerceHistoryEvent({ type, seq: 1, time: 1, data: {} }), null, type);
    }
  });

  it('unknown/never-rendered types are dropped rather than guessed at', () => {
    for (const type of ['schedule/changed', 'auth/revoked', 'something/new', '', 'tool/other']) {
      assert.equal(coerceHistoryEvent({ type, seq: 1, time: 1, data: {} }), null, type);
    }
  });

  it('an empty-text message is dropped instead of rendering an empty bubble', () => {
    assert.equal(coerceHistoryEvent({ type: 'assistant/message', text: '' }), null);
    assert.equal(coerceHistoryEvent({ type: 'assistant/message', data: { message: { content: [] } } }), null);
  });
});

describe('history events: the contract shape still wins unchanged', () => {
  it('a row that already carries a role keeps its old behaviour', () => {
    const row = coerceHistoryEvent({ seq: 2, id: 'm2', role: 'assistant', text: 'two' });
    assert.equal(row?.role, 'assistant');
    assert.equal(row?.text, 'two');
    assert.equal(row?.seq, 2);
    assert.equal(row?.id, 'm2');
  });

  it('keeps additive fields a later host may add (e.g. the list screen\'s workspaceId)', () => {
    const row = coerceHistoryEvent({ seq: 3, role: 'user', text: 'hi', workspaceId: 'ws-1' });
    assert.equal(row?.role, 'user');
    assert.equal((row as unknown as { workspaceId?: string }).workspaceId, 'ws-1');
  });

  it('lowercases/case-insensitive roles as before', () => {
    assert.equal(coerceHistoryEvent({ role: 'ASSISTANT', text: 'x' })?.role, 'assistant');
  });
});

describe('history events: page mapping', () => {
  it('maps a mixed page in order and drops the chatter', () => {
    const page = [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'prompt' }] } },
      { type: 'turn/start', seq: 2, time: 2, data: { turn: 1 } },
      { type: 'assistant/message', seq: 3, time: 3, data: { message: { content: [{ type: 'text', text: 'answer' }] } } },
      { type: 'session/title', seq: 4, time: 4, data: { title: 'T' } },
      { type: 'tool/call', seq: 5, time: 5, data: { callId: 'c1', name: 'bash', arguments: '{"command":"pwd"}' } },
    ];
    const rows = coerceHistoryEvents(page);
    assert.deepEqual(rows.map((row) => [row.seq, row.role]), [[1, 'user'], [3, 'assistant'], [5, 'tool']]);
  });

  it('returns [] for a non-array page instead of throwing', () => {
    for (const value of [undefined, null, {}, 'x', 42]) {
      assert.deepEqual(coerceHistoryEvents(value), []);
    }
  });
});
