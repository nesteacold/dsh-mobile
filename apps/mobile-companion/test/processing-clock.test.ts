// Spec 050 amendment: the observed processing start lives in the controller, not the screen.
import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_PROCESSING_CLOCKS, ProcessingClock } from '../src/ui/processing-clock';

test('start survives an unmount/remount while the same turn keeps processing', () => {
  const clock = new ProcessingClock();
  const firstView = clock.observe('s1', 'processing', 1_000);
  // The screen unmounts and remounts; the controller asks again for the same session/phase.
  const secondView = clock.observe('s1', 'processing', 9_000);
  assert.equal(firstView, 1_000);
  assert.equal(secondView, 1_000, 'the clock was not restarted by navigation');
});

test('turn end and a new processing phase reset the observation', () => {
  const clock = new ProcessingClock();
  assert.equal(clock.observe('s1', 'processing', 1_000), 1_000);
  assert.equal(clock.observe('s1', null, 2_000), null, 'turn end clears it');
  assert.equal(clock.observe('s1', 'sending', 3_000), null, 'sending clears it');
  assert.equal(clock.observe('s1', 'processing', 4_000), 4_000, 'a new turn gets a fresh start');
});

test('sessions are independent and the store is bounded', () => {
  const clock = new ProcessingClock();
  assert.equal(clock.observe('s1', 'processing', 10), 10);
  assert.equal(clock.observe('s2', 'processing', 20), 20);
  assert.equal(clock.observe('s1', 'processing', 30), 10);
  for (let i = 0; i < MAX_PROCESSING_CLOCKS + 5; i += 1) clock.observe(`s-${i}`, 'processing', i);
  assert.equal(clock.observe('s1', 'processing', 99), 99, 'the oldest entry was evicted');
  clock.forget('s2');
  assert.equal(clock.observe('s2', 'processing', 101), 101);
});
