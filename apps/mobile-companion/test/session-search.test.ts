// Session title search — pure filter rules.
//
// Why these tests exist: the list is the app's main screen, and a search that silently matches the
// wrong field (the raw wire title instead of the displayed one) or that cannot find Vietnamese titles
// typed without accents is worse than no search at all.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LOCALES, t } from '../i18n';
import type { SessionSummary } from '../src/core/sessions';
import { filterSessionsByTitle, foldForSearch } from '../src/ui/session-search';

const trEn = (key: Parameters<typeof t>[1], params?: Record<string, string | number>) => t('en', key, params);

function session(id: string, title: string): SessionSummary {
  return { id, title, state: 'idle', updatedAt: 0, needsDecision: false };
}

const rows = [
  session('s1', 'Refactor gateway TLS'),
  session('s2', 'Phiên mới'),
  session('s3', 'dsh-wiki worker protocol'),
  session('s4', ''),
];

describe('search folding', () => {
  it('is case-insensitive and accent-insensitive for Vietnamese', () => {
    assert.equal(foldForSearch('PHIÊN'), 'phien');
    assert.equal(foldForSearch('Đường dẫn'), 'duong dan');
    assert.equal(foldForSearch('  spaced  '), 'spaced');
  });
});

describe('filterSessionsByTitle', () => {
  it('returns everything for a blank query', () => {
    assert.equal(filterSessionsByTitle(rows, '', trEn, 'en').length, rows.length);
    assert.equal(filterSessionsByTitle(rows, '   ', trEn, 'en').length, rows.length);
  });

  it('matches a substring of the displayed title', () => {
    const found = filterSessionsByTitle(rows, 'gateway', trEn, 'en');
    assert.deepEqual(found.map((row) => row.id), ['s1']);
  });

  it('finds a Vietnamese title typed without accents', () => {
    const found = filterSessionsByTitle(rows, 'phien moi', trEn, 'en');
    assert.deepEqual(found.map((row) => row.id), ['s2']);
  });

  it('searches the DISPLAY title, so an untitled session is findable by its label', () => {
    // s4 has no title at all: on screen it reads "New session" (en) / "Phiên mới" (vi).
    assert.deepEqual(filterSessionsByTitle(rows, 'new session', trEn, 'en').map((row) => row.id), ['s4']);
    // ...and its label is locale-dependent, which is why the locale is a parameter.
    assert.deepEqual(
      filterSessionsByTitle(rows, 'phien moi', (key, params) => t('vi', key, params), 'vi').map((row) => row.id).sort(),
      ['s2', 's4'],
    );
  });

  it('searches the CLEANED title, so a markdown marker is not searchable', () => {
    const marked = [session('s5', '# dsh-wiki worker protocol')];
    // The '#' is stripped for display (device defect: rows read "# dsh-wiki worker protocol"), so what
    // the user sees — and therefore what search matches — has no marker.
    assert.deepEqual(filterSessionsByTitle(marked, '#', trEn, 'en'), []);
    assert.deepEqual(filterSessionsByTitle(marked, 'dsh-wiki', trEn, 'en').map((row) => row.id), ['s5']);
    assert.deepEqual(filterSessionsByTitle(marked, 'worker', trEn, 'en').map((row) => row.id), ['s5']);
  });

  it('returns nothing when nothing matches, and never throws on empty input', () => {
    assert.deepEqual(filterSessionsByTitle(rows, 'zzzz', trEn, 'en'), []);
    assert.deepEqual(filterSessionsByTitle([], 'anything', trEn, 'en'), []);
  });

  it('has copy for the field and the empty result in every locale', () => {
    for (const locale of LOCALES) {
      for (const key of ['list.search', 'list.searchPlaceholder', 'list.noMatches'] as const) {
        assert.ok(t(locale, key).trim() !== '', `${locale}: ${key}`);
      }
    }
  });
});
