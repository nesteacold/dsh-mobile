// Tests for the wave-1 pure helpers on the conversation screen (spec 017).
//
// These lock the rules that the UI depends on and that no renderer test can reach in this repo:
//   * reasoning arrives on the history row (and only on assistant rows);
//   * a reply quote is one flattened, word-boundary-trimmed line carried as a markdown blockquote;
//   * the scroll-to-bottom button's threshold.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coerceHistoryEvent } from '../src/core/history';
import { buildQuotePrompt, quoteExcerpt, quotePreview, QUOTE_MAX_CHARS } from '../src/ui/conversation/reply-quote';
import { isAwayFromBottom, SCROLL_BOTTOM_SLACK } from '../src/ui/conversation/scroll-threshold';

describe('reasoning on history rows (ProcessReasoningDisclosure)', () => {
  it('takes the flattened live reasoning field', () => {
    const row = coerceHistoryEvent({
      type: 'assistant/message', seq: 3, time: 3,
      text: 'Done.', reasoning: 'First I checked the worker, then the queue.',
    });
    assert.equal(row?.text, 'Done.');
    assert.equal(row?.reasoning, 'First I checked the worker, then the queue.');
  });

  it('reads reasoning blocks out of the history page content', () => {
    const row = coerceHistoryEvent({
      type: 'assistant/message', seq: 4, time: 4,
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'thinking part one' },
            { type: 'text', text: 'the answer' },
            { type: 'reasoning', text: 'thinking part two' },
          ],
        },
      },
    });
    assert.equal(row?.text, 'the answer');
    assert.equal(row?.reasoning, 'thinking part one\nthinking part two');
  });

  it('omits reasoning entirely when the host sent none', () => {
    const row = coerceHistoryEvent({ type: 'assistant/message', text: 'plain answer' });
    assert.equal(row?.reasoning, undefined);
    assert.ok(!Object.hasOwn(row as object, 'reasoning'), 'no empty reasoning field');
  });

  it('never attaches reasoning to a user or tool row', () => {
    const user = coerceHistoryEvent({ type: 'user/message', text: 'hi', reasoning: 'ignored' });
    const tool = coerceHistoryEvent({ type: 'tool/result', preview: 'out', reasoning: 'ignored' });
    assert.equal(user?.reasoning, undefined);
    assert.equal(tool?.reasoning, undefined);
  });

  it('keeps reasoning through the contract shape too (spread of the source row)', () => {
    const row = coerceHistoryEvent({ seq: 9, role: 'assistant', text: 'x', reasoning: 'why' });
    assert.equal(row?.reasoning, 'why');
  });
});

describe('reply quotes (ComposerReplyPreview)', () => {
  it('flattens markdown to one line', () => {
    const excerpt = quoteExcerpt('## Heading\n\n- first bullet\n- second with **bold** and `code`');
    assert.equal(excerpt, 'Heading first bullet second with bold and code');
  });

  it('drops fence markers and language tags', () => {
    assert.equal(quoteExcerpt('```ts\nconst a = 1;\n```'), 'const a = 1;');
  });

  it('trims on a word boundary with an ellipsis', () => {
    const excerpt = quoteExcerpt('alpha beta gamma delta epsilon zeta eta theta', 20);
    assert.ok(excerpt.endsWith('…'));
    assert.ok(excerpt.length <= 21, `got ${excerpt.length}`);
    assert.ok(!excerpt.includes(' g…'), 'cut inside a word');
  });

  it('keeps short text untouched', () => {
    assert.equal(quoteExcerpt('short one'), 'short one');
  });

  it('builds a markdown blockquote followed by the reply', () => {
    assert.equal(buildQuotePrompt('the original text', 'my reply'), '> the original text\n\nmy reply');
  });

  it('degrades to the plain reply when there is nothing to quote', () => {
    assert.equal(buildQuotePrompt('   ', 'my reply'), 'my reply');
    assert.equal(buildQuotePrompt('', '  spaced  '), 'spaced');
  });

  it('uses the whole-message budget for the sent quote and the smaller one for the preview', () => {
    const long = 'word '.repeat(200);
    assert.ok(quoteExcerpt(long, QUOTE_MAX_CHARS).length <= QUOTE_MAX_CHARS + 1);
    assert.ok(quotePreview(long).length <= 121);
  });
});

describe('scroll-to-bottom threshold (ScrollToBottomButton)', () => {
  it('never shows when everything fits on screen', () => {
    assert.equal(isAwayFromBottom({ offsetY: 0, contentHeight: 400, viewportHeight: 800 }), false);
  });

  it('hides within the slack of the bottom', () => {
    assert.equal(isAwayFromBottom({ offsetY: 1000, contentHeight: 2000, viewportHeight: 1000 }), false);
    assert.equal(
      isAwayFromBottom({ offsetY: 1000 - SCROLL_BOTTOM_SLACK + 1, contentHeight: 2000, viewportHeight: 1000 }),
      false,
    );
  });

  it('shows once the reader is past the slack', () => {
    assert.equal(isAwayFromBottom({ offsetY: 0, contentHeight: 2000, viewportHeight: 1000 }), true);
    assert.equal(isAwayFromBottom({ offsetY: 1000 - SCROLL_BOTTOM_SLACK - 1, contentHeight: 2000, viewportHeight: 1000 }), true);
  });

  it('clamps an over-scroll bounce instead of reporting a negative distance', () => {
    assert.equal(isAwayFromBottom({ offsetY: 5000, contentHeight: 2000, viewportHeight: 1000 }), false);
  });

  it('honours an explicit slack', () => {
    assert.equal(isAwayFromBottom({ offsetY: 900, contentHeight: 2000, viewportHeight: 1000, slack: 10 }), true);
  });
});
