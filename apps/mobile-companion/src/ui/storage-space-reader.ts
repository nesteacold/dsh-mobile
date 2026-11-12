// Filesystem access for the storage screen. Kept apart from `storage-space.ts` (pure) so the rules can
// be tested without a native module.
//
// Same lazy-require pattern as `src/platform/debug-log-file.ts`: `expo-file-system` resolves its native
// module while its body runs, so it must not be imported by Node (tests) or web.
//
// It reads ONLY the app's own document directory and never opens `expo-secure-store`: credentials are
// not cache (see the header of `storage-space.ts`).

import type { StorageEntry } from './storage-space';

type FileSystemApi = typeof import('expo-file-system');

let fileSystem: FileSystemApi | null | undefined;

function loadFileSystem(): FileSystemApi | null {
  if (fileSystem !== undefined) return fileSystem;
  try {
    // Lazy require: an Expo native module must not be evaluated outside a real app runtime.
    fileSystem = require('expo-file-system') as FileSystemApi;
  } catch {
    fileSystem = null;
  }
  return fileSystem;
}

/** Name/size of every regular file in the app's document directory. Empty when unavailable. */
export function readStorageEntries(): StorageEntry[] {
  const fs = loadFileSystem();
  if (fs === null) return [];
  try {
    const directory = new fs.Directory(fs.Paths.document);
    const entries: StorageEntry[] = [];
    for (const entry of directory.list()) {
      // Directories are not counted: their children are listed individually when present.
      const size = typeof (entry as { size?: unknown }).size === 'number'
        ? (entry as { size: number }).size
        : 0;
      if (size <= 0) continue;
      entries.push({ name: entry.name, size });
    }
    return entries;
  } catch {
    // Unreadable directory is reported as "nothing cached" rather than crashing the screen.
    return [];
  }
}

/**
 * Delete the files of `names` (the ones the screen just listed) and return how many were removed.
 * Only names that were actually read from the app directory are ever passed in.
 */
export function deleteStorageEntries(names: readonly string[]): number {
  const fs = loadFileSystem();
  if (fs === null || names.length === 0) return 0;
  let removed = 0;
  try {
    const directory = new fs.Directory(fs.Paths.document);
    for (const entry of directory.list()) {
      if (!names.includes(entry.name)) continue;
      try {
        (entry as { delete: () => void }).delete();
        removed += 1;
      } catch {
        // A file that vanishes or is locked simply is not counted as removed.
      }
    }
  } catch {
    return removed;
  }
  return removed;
}
