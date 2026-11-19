// Spec 018 item 4 — the shared PWA/native session screen renders a human question
// card with options, a custom answer field and Submit/Skip, wired to the controller.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MESSAGES, type MessageKey } from '../i18n';

const root = path.resolve(import.meta.dirname, '..');
const screen = readFileSync(path.join(root, 'app/session/[id].tsx'), 'utf8');

test('the session screen renders question cards with options, custom input, submit and skip', () => {
  assert.match(screen, /snapshot\.openQuestions\.map\(/, 'question cards come from the shared snapshot');
  assert.match(screen, /function QuestionCardView\(/, 'one shared component for PWA and native');
  assert.match(screen, /question-option-\$\{card\.rpcId\}/, 'offered options are selectable');
  assert.match(screen, /question-custom-\$\{card\.rpcId\}/, 'a custom answer can be typed');
  assert.match(screen, /question-submit-\$\{card\.rpcId\}/, 'submit is visible');
  assert.match(screen, /question-skip-\$\{card\.rpcId\}/, 'skip is visible');
  assert.match(screen, /controller\.decideQuestion\(card\.rpcId, answers\)/, 'submit answers the card');
  assert.match(screen, /controller\.decideQuestion\(card\.rpcId, \[\], true\)/, 'skip cancels the card');
});

test('question card copy exists in both locales', () => {
  const keys: MessageKey[] = ['question.title', 'question.custom', 'question.submit', 'question.skip', 'question.notice'];
  for (const locale of ['en', 'vi'] as const) {
    for (const key of keys) {
      assert.equal(typeof MESSAGES[locale][key], 'string', `${locale}:${key}`);
      assert.ok((MESSAGES[locale][key] as string).trim() !== '', `${locale}:${key}`);
    }
  }
});
