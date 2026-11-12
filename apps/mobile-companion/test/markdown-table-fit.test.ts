// The table grid must FIT the phone (spec 017 wave 1, measured defect).
//
// The first real table rendered with only two of its three columns visible: each column was sized from
// its own longest cell, the three maxima summed past the viewport, and the horizontal scroller pushed
// `Notes` — the column the whole answer was about — off the right edge. The fix scales the grid down to
// the available width while keeping every column above a readable floor, so the table stays a table.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { columnWidths } from '../src/ui/markdown/Markdown';
import { parseMarkdown } from '../src/ui/markdown/parse';

const PADDING = 12;
const PHONE = 1080 - 32;

const table = (markdown: string) => {
  const block = parseMarkdown(markdown).find((candidate) => candidate.kind === 'table');
  assert.ok(block && block.kind === 'table', 'fixture parses to a table');
  return block;
};

const REAL_ANSWER = [
  '| Name | Role | Notes |',
  '| --- | --- | --- |',
  '| Mobile Shell | App container and navigation | Owns routing and the tab layout |',
  '| Session Client | Communication with the DSH backend | WebSocket, per-device auth |',
  '| Chat View | Conversation interface | Markdown, tables, code cards |',
  '| Approval Prompt | Permission handling | Exact-request binding, argsHash |',
].join('\n');

describe('markdown table columns fit the viewport (3 columns stay visible)', () => {
  it('a three-column answer fits the phone width instead of scrolling', () => {
    const widths = columnWidths(table(REAL_ANSWER), PADDING, PHONE);
    assert.equal(widths.length, 3, 'three columns');
    const total = widths.reduce((sum, width) => sum + width, 0);
    assert.ok(total <= PHONE, `the grid fits: ${total} <= ${PHONE}`);
  });

  it('keeps every column above the readable floor', () => {
    const widths = columnWidths(table(REAL_ANSWER), PADDING, PHONE);
    for (const [index, width] of widths.entries()) {
      assert.ok(width >= 88, `column ${index} is at least 88pt (got ${width})`);
    }
  });

  it('does not shrink a table that already fits', () => {
    const narrow = table('| A | B |\n| --- | --- |\n| 1 | 2 |');
    const widths = columnWidths(narrow, PADDING, PHONE);
    const total = widths.reduce((sum, width) => sum + width, 0);
    assert.ok(total <= PHONE, 'a small table stays inside the viewport');
    assert.equal(widths.length, 2);
  });

  it('still scrolls when the floor makes fitting impossible (many columns)', () => {
    // 14 columns × the 88pt floor = 1232 > a 1048pt phone, so the floor wins and the grid scrolls.
    const headers = Array.from({ length: 14 }, (_, index) => `column-${index + 1}`);
    const cells = Array.from({ length: 14 }, (_, index) => `value ${index + 1}`);
    const wide = table(
      `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n| ${cells.join(' | ')} |`,
    );
    const widths = columnWidths(wide, PADDING, PHONE);
    const total = widths.reduce((sum, width) => sum + width, 0);
    assert.equal(widths.length, 14, 'fourteen columns');
    assert.ok(total > PHONE, 'the grid is allowed to exceed the viewport when the floor wins');
    assert.ok(widths.every((width) => width >= 88), 'but no column is squeezed below the floor');
  });
});
