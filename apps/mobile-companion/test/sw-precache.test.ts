// The service worker's precache list (scripts/build-web.mjs#buildPrecacheList).
//
// Found by an OFFLINE RELOAD TEST, not by reading code: the worker had no precache, so a first visit
// never filled the cache and an offline reload failed with ERR_EMPTY_RESPONSE even though the worker
// was activated. The list has to come from the build because the bundle names are content-hashed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { buildPrecacheList } from '../scripts/build-web.mjs';

const SW = readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8');

describe('service worker precache list', () => {
  const dist = [
    'index.html',
    'manifest.json',
    'sw.js',
    'register-sw.js',
    'icon.svg',
    'icon-maskable.svg',
    'metadata.json',
    'precache.json',
    '_expo/static/js/web/index-10b55514dd1568e71143c26799e37027.js',
    '_expo/static/js/web/__common-c715fb2df12c15c4f1b0f29c38cd9bad.js',
    'assets/node_modules/expo-router/assets/error.d1ea1496f9057eb392d5bbf3732a61b7.png',
  ];

  it('lists the HTML shell, the hashed bundles and the static shell files', () => {
    const list: string[] = buildPrecacheList(dist);
    assert.equal(list[0], '/', 'the shell itself is first');
    assert.ok(list.includes('/_expo/static/js/web/index-10b55514dd1568e71143c26799e37027.js'));
    assert.ok(list.includes('/_expo/static/js/web/__common-c715fb2df12c15c4f1b0f29c38cd9bad.js'));
    for (const file of ['/manifest.json', '/icon.svg', '/icon-maskable.svg', '/register-sw.js']) {
      assert.ok(list.includes(file), file);
    }
  });

  it('never lists the worker, the list itself or build metadata', () => {
    const list: string[] = buildPrecacheList(dist);
    for (const never of ['/sw.js', '/precache.json', '/metadata.json']) {
      assert.equal(list.includes(never), false, `${never} must not be precached`);
    }
  });

  it('only lists absolute paths and never an API-ish path (the worker re-checks this too)', () => {
    const list: string[] = buildPrecacheList([...dist, 'api/devices.json', 'pair/x.json']);
    assert.ok(list.every((entry) => entry.startsWith('/')));
    assert.equal(list.some((entry) => /^\/(api|pair|devices|auth|push|rpc)/.test(entry)), false);
  });

  it('is stable regardless of the order the directory was walked in', () => {
    const forward: string[] = buildPrecacheList(dist);
    const backward: string[] = buildPrecacheList([...dist].reverse());
    assert.deepEqual(forward, backward);
  });

  it('the worker reads that list at install and bumps the cache name when the strategy changes', () => {
    assert.match(SW, /fetch\('\/precache\.json'/, 'install must read the build-generated list');
    assert.match(SW, /const CACHE = 'dsh-shell-v5'/, 'strategy changed => cache name bumped (see the note in sw.js)');
    // Never-cache stays in force at install, not only in the fetch handler.
    assert.match(SW, /NEVER_CACHE\.some\(\(prefix\) => path\.startsWith\(prefix\)\)\) continue/);
  });

  it('does not skip navigations or shell assets for `credentials: "include"` (measured to break offline)', () => {
    // A top-level navigation and a classic <script src> are both issued with credentials "include".
    // A `credentials === 'include'` bail-out therefore made the worker answer NOTHING: the cache was
    // full (19 entries, "/" included, found by an in-worker lookup) yet the offline reload showed
    // ERR_CONNECTION_REFUSED, because the fetch handler never took the request.
    assert.doesNotMatch(SW, /request\.credentials\s*===\s*'include'\s*\)\s*return/,
      'a credentials check must not run before navigations / shell assets');
    // What stays: an Authorization header is never ours, and the never-cache prefixes still bail out.
    assert.match(SW, /request\.headers\.has\('authorization'\)\) return/);
    assert.match(SW, /NEVER_CACHE\.some\(\(prefix\) => url\.pathname\.startsWith\(prefix\)\)\) return/);
  });

  it('keys every cache entry through one canonical URL form (put and match agree)', () => {
    // MEASURED, not assumed: `new URL()` keeps `[` `]` literal in a path, so Expo's `[id]-<hash>.js`
    // route chunks are NOT rewritten by this normalisation. (An earlier note here claimed the browser
    // requests them percent-encoded; that was never measured and `URL` proves it is not what this
    // code path produces.) What matters is that `put` and `match` use the SAME form.
    const raw = '/_expo/static/js/web/[id]-42805ee5.js';
    assert.equal(new URL(raw, 'http://h').href, `http://h${raw}`);
    assert.match(SW, /cache\.put\(new URL\(path, self\.location\.origin\)\.href, response\)/,
      'precache must key by the normalised URL');
    assert.match(SW, /cache\.match\(new URL\('\/', self\.location\.origin\)\.href\)/,
      'the offline shell lookup must use the same normalised key');
    assert.doesNotMatch(SW, /cache\.put\('\/'/, 'no entry may be stored under the raw "/" string');
  });
});
