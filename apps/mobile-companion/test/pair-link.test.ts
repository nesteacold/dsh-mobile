import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePairHash, parsePairLinkUrl } from '../src/core/pair-link';
import { consumePairHashFrom } from '../src/platform/pair-hash.web';

describe('pairing-code link', () => {
  it('parses the fragment form the Devices dialog encodes', () => {
    assert.deepEqual(parsePairHash('#a=node.tail.ts.net%3A30443&c=12345678'), { address: 'node.tail.ts.net:30443', otp: '12345678' });
    assert.deepEqual(parsePairHash('c=1234-5678'), { address: '', otp: '12345678' });
  });

  it('refuses malformed links', () => {
    for (const bad of ['', '#', '#a=h:1', '#a=h:1&c=123', '#a=h:1&c=abcdefgh', '#a=h/x:1&c=12345678', '#a=u%40h:1&c=12345678', null, undefined]) {
      assert.equal(parsePairHash(bad as string), null, String(bad));
    }
  });

  it('recognizes only https …/pair URLs with the code in the fragment', () => {
    assert.deepEqual(parsePairLinkUrl('https://n.ts.net:30443/pair#a=n.ts.net%3A30443&c=12345678'), { address: 'n.ts.net:30443', otp: '12345678' });
    assert.equal(parsePairLinkUrl('http://n.ts.net/pair#c=12345678'), null);
    assert.equal(parsePairLinkUrl('https://n.ts.net/other#c=12345678'), null);
    assert.equal(parsePairLinkUrl('https://n.ts.net/pair?c=12345678'), null);
    assert.equal(parsePairLinkUrl('dshpair:v1:abc'), null);
  });

  it('strips the fragment with history.replaceState, keeping path and query', () => {
    const calls: unknown[][] = [];
    const win = {
      location: { hash: '#a=h.example%3A30443&c=12345678', pathname: '/pair', search: '?x=1' },
      history: { state: { k: 1 }, replaceState: (...args: unknown[]) => { calls.push(args); } },
    };
    assert.deepEqual(consumePairHashFrom(win), { address: 'h.example:30443', otp: '12345678' });
    assert.deepEqual(calls, [[{ k: 1 }, '', '/pair?x=1']]);
  });

  it('leaves a non-pair fragment untouched', () => {
    const calls: unknown[] = [];
    const win = {
      location: { hash: '#section', pathname: '/', search: '' },
      history: { state: null, replaceState: () => { calls.push(1); } },
    };
    assert.equal(consumePairHashFrom(win), null);
    assert.equal(calls.length, 0);
    assert.equal(consumePairHashFrom(null), null);
  });
});
