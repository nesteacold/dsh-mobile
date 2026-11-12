// Storage space (reference: `StorageSpaceScreen.kt`): what the app keeps on this phone, and clearing it
// by category.
//
// SCOPE — deliberately narrow, and the whole point of this module:
//   * only files inside the app's OWN documents/cache directories are looked at;
//   * `expo-secure-store` is NEVER opened here. Credentials, the install id and the paired token are
//     not "cache", and a privacy screen that could delete them would be a security bug;
//   * nothing leaves the device and no size is invented: a category with no files reports 0 B.
//
// The pure half lives here so it can be unit-tested without a filesystem.

export interface StorageEntry {
  /** File name as it appears in the app's directory (never displayed raw, see `categorizeEntry`). */
  readonly name: string;
  readonly size: number;
}

export type StorageCategoryId = 'logs' | 'images' | 'documents' | 'other';

export interface StorageCategory {
  readonly id: StorageCategoryId;
  readonly bytes: number;
  readonly files: number;
}

/** Byte count as a short human string. Kept small and locale-independent (numbers + unit). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal from KB up, none for plain bytes.
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Which bucket a file belongs to. Extension-based, so an unknown file lands in `other` honestly. */
export function categorizeEntry(name: string): StorageCategoryId {
  const lower = name.toLowerCase();
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'logs';
  if (/\.(png|jpe?g|webp|gif|heic)$/.test(lower)) return 'images';
  if (/\.(json|md|db|sqlite|csv|xml|pdf)$/.test(lower)) return 'documents';
  return 'other';
}

/** Per-category totals, in a FIXED order so the screen never reshuffles between refreshes. */
export function summarizeStorage(entries: readonly StorageEntry[]): StorageCategory[] {
  const totals = new Map<StorageCategoryId, { bytes: number; files: number }>();
  for (const entry of entries) {
    if (!Number.isFinite(entry.size) || entry.size <= 0) continue;
    const id = categorizeEntry(entry.name);
    const current = totals.get(id) ?? { bytes: 0, files: 0 };
    totals.set(id, { bytes: current.bytes + entry.size, files: current.files + 1 });
  }
  const order: readonly StorageCategoryId[] = ['logs', 'images', 'documents', 'other'];
  return order
    .filter((id) => totals.has(id))
    .map((id) => ({ id, bytes: totals.get(id)?.bytes ?? 0, files: totals.get(id)?.files ?? 0 }));
}

/** Total across categories. */
export function totalStorage(categories: readonly StorageCategory[]): number {
  return categories.reduce((sum, category) => sum + category.bytes, 0);
}
