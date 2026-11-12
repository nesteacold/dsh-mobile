// Storage space — the pure rules, plus the two invariants that make the screen safe to ship.
//
// The safety half is why these source assertions exist: a "clear cache" button that could reach
// credentials would be a security defect, so the reader must never import the secure store, and the
// screen must never claim a size it did not measure.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LOCALES, t } from '../i18n';
import {
  categorizeEntry,
  formatBytes,
  summarizeStorage,
  totalStorage,
} from '../src/ui/storage-space';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawReader = readFileSync(path.join(ROOT, 'src', 'ui', 'storage-space-reader.ts'), 'utf8');
const rawScreen = readFileSync(path.join(ROOT, 'app', 'storage.tsx'), 'utf8');

/**
 * Strip comments before asserting on behaviour. Both files TALK about `expo-secure-store` in their
 * headers precisely to record that they must never import it, so a raw text match would fail on the
 * documentation instead of on the code.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

const READER = code(rawReader);
const SCREEN = code(rawScreen);

describe('formatBytes', () => {
  it('never invents a size for nothing', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(-1), '0 B');
    assert.equal(formatBytes(Number.NaN), '0 B');
  });

  it('scales through the units', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1024 * 1024), '1 MB');
    assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3 GB');
  });
});

describe('categorizeEntry', () => {
  it('buckets by extension and admits the unknown bucket', () => {
    assert.equal(categorizeEntry('dsh-companion-debug.log'), 'logs');
    assert.equal(categorizeEntry('notes.txt'), 'logs');
    assert.equal(categorizeEntry('shot.PNG'), 'images');
    assert.equal(categorizeEntry('cache.json'), 'documents');
    assert.equal(categorizeEntry('weird.bin'), 'other');
  });
});

describe('summarizeStorage', () => {
  it('totals per category in a fixed order and ignores empty sizes', () => {
    const categories = summarizeStorage([
      { name: 'a.log', size: 100 },
      { name: 'b.log', size: 50 },
      { name: 'c.png', size: 2000 },
      { name: 'zero.json', size: 0 },
    ]);
    assert.deepEqual(categories.map((category) => category.id), ['logs', 'images']);
    assert.deepEqual(categories[0], { id: 'logs', bytes: 150, files: 2 });
    assert.deepEqual(categories[1], { id: 'images', bytes: 2000, files: 1 });
    assert.equal(totalStorage(categories), 2150);
  });

  it('reports nothing for no files (the screen must be able to say "nothing cached")', () => {
    assert.deepEqual(summarizeStorage([]), []);
    assert.equal(totalStorage([]), 0);
  });
});

describe('the screen can never touch credentials', () => {
  it('the reader does not open the secure store', () => {
    assert.equal(/expo-secure-store/.test(READER), false, 'secure store must never be imported here');
    assert.equal(/SecureStore|getItemAsync|setItemAsync/.test(READER), false,
      'no credential-shaped access in the reader');
  });

  it('the screen only clears what it measured, from the app directory only', () => {
    assert.equal(/expo-secure-store/.test(SCREEN), false, 'the screen must never import the secure store');
    assert.match(SCREEN, /from '\.\.\/src\/ui\/storage-space-reader'/, 'it goes through the reader');
    assert.match(SCREEN, /deleteStorageEntries\(/, 'clearing goes through the reader');
    // No raw path building in the screen: the reader owns directory access.
    assert.equal(/Paths\.|documentDirectory|cacheDirectory/.test(SCREEN), false,
      'the screen does not address the filesystem directly');
  });

  it('has copy for every category and action in both locales', () => {
    for (const locale of LOCALES) {
      for (const key of [
        'storage.title',
        'storage.total',
        'storage.clear',
        'storage.clearAll',
        'storage.empty',
        'storage.category.logs',
        'storage.category.images',
        'storage.category.documents',
        'storage.category.other',
        'storage.cleared',
        'storage.hint',
      ] as const) {
        assert.ok(t(locale, key).trim() !== '', `${locale}: ${key}`);
      }
    }
  });
});
