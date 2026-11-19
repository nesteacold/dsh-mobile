// Spec 044 — web/PWA byte reader for a file chosen with expo-document-picker.
//
// Metro resolves the extensionless `./picked-file` import in the session screen to THIS file on the
// web platform and to `picked-file.ts` on native. On web the picker already hands us the browser's
// real DOM `File` as `asset.file`; expo-file-system's web build is a warn-only stub with no
// `info()`/`arrayBuffer()`, so it must never enter this module (nor the screen's web bundle).
//
// Security/robustness (reviewer 044):
//   * admission happens BEFORE any allocation: asset.size and the DOM File.size are both admitted,
//     and a data URL's encoded length is admitted BEFORE `atob` allocates its binary string;
//   * only a `data:…;base64,…` URL is decoded — `asset.uri` is never fetched;
//   * name/mediaType are untrusted metadata: prefer the DOM File's own values, never infer a MIME
//     type from a filename or a data-URL header;
//   * reads are bounded by a deadline and can be aborted by the owning transfer;
//   * this module never displays, logs or returns a path, URL or exception text.

import { admitClientUploadSize, CLIENT_UPLOAD_MAX_BYTES } from '../core/remote-upload';

/** The narrow projection of `DocumentPickerAsset` this reader needs (both platforms). */
export interface PickedFileAsset {
  uri?: string | null;
  name?: string | null;
  size?: number | null;
  mimeType?: string | null;
  base64?: string | null;
  file?: {
    name?: string | null;
    type?: string | null;
    size?: number | null;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null;
}

export interface ReadPickedFileResult {
  bytes: Uint8Array;
  name: string;
  mediaType?: string;
}

/** Stable codes only: the screen maps these to fixed localized copy; no exception text escapes. */
export type PickedFileErrorCode = 'no-file' | 'read-failed' | 'read-timeout' | 'file-too-large';

export class PickedFileError extends Error {
  readonly code: PickedFileErrorCode;

  constructor(code: PickedFileErrorCode) {
    super(code);
    this.name = 'PickedFileError';
    this.code = code;
  }
}

/** Bounded read window for the web seam; a late result is dropped by the screen's ownership guard. */
export const WEB_PICKED_FILE_READ_TIMEOUT_MS = 15_000;

export interface ReadPickedFileOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Expo's web picker always builds an object URL (`blob:…`) for the picked file. */
export function isPickerObjectUrl(uri: unknown): boolean {
  return typeof uri === 'string' && uri.startsWith('blob:');
}

/**
 * Revoke ONLY a picker-created object URL, at most once per caller-owned closure. The screen never
 * passes an arbitrary URI here and never creates a second object URL.
 */
export function revokePickerObjectUrl(uri: string): void {
  if (!isPickerObjectUrl(uri)) return;
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  URL.revokeObjectURL(uri);
}

/**
 * Decode a `data:…;base64,…` URL without fetching `asset.uri`. The encoded/decoded length is checked
 * against the ceiling BEFORE `atob` allocates its binary string; `maxBytes` exists only to make the
 * guard testable with a small fixture — production callers use the client ceiling.
 */
export function decodeBase64DataUrl(value: unknown, maxBytes: number = CLIENT_UPLOAD_MAX_BYTES): Uint8Array {
  if (typeof value !== 'string') throw new PickedFileError('read-failed');
  const comma = value.indexOf(',');
  const header = comma < 0 ? '' : value.slice(0, comma + 1);
  if (comma < 0 || !header.toLowerCase().startsWith('data:') || !header.toLowerCase().includes(';base64,')) {
    throw new PickedFileError('read-failed');
  }
  const payload = value.slice(comma + 1);
  // Strict standard-base64 spelling only: no URL-safe alphabet, whitespace or stray padding.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) {
    throw new PickedFileError('read-failed');
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  if (padding > 0 && payload.length - padding < 2) throw new PickedFileError('read-failed');
  const decodedLength = (payload.length / 4) * 3 - padding;
  if (!Number.isFinite(maxBytes) || maxBytes < 0 || decodedLength > maxBytes) {
    throw new PickedFileError('file-too-large');
  }
  if (decodedLength === 0) throw new PickedFileError('no-file');
  // `atob` itself allocates a binary string; the length gate above is deliberately before it.
  const binary = atob(payload);
  if (binary.length !== decodedLength) throw new PickedFileError('read-failed');
  const bytes = new Uint8Array(decodedLength);
  for (let i = 0; i < decodedLength; i += 1) bytes[i] = binary.charCodeAt(i);
  admitClientUploadSize(bytes.length);
  return bytes;
}

/** Race the read against a fixed deadline and the owning transfer's abort signal. */
function bounded<T>(work: Promise<T>, options: ReadPickedFileOptions | undefined): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? WEB_PICKED_FILE_READ_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new PickedFileError('read-failed'));
  const signal = options?.signal;
  if (signal?.aborted) return Promise.reject(new PickedFileError('read-failed'));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PickedFileError('read-timeout')), timeoutMs);
  });
  const aborted = signal === undefined ? null : new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new PickedFileError('read-failed'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const cleanup = (): void => {
    if (timer !== null) clearTimeout(timer);
    if (signal !== undefined && onAbort !== null) signal.removeEventListener('abort', onAbort);
  };
  return Promise.race([work, deadline, ...(aborted === null ? [] : [aborted])])
    .then((value) => { cleanup(); return value; })
    .catch((error: unknown) => { cleanup(); throw error; });
}

/**
 * Read the exact picked bytes. Size is admitted BEFORE `arrayBuffer()` / `atob`, so an oversized
 * pick is refused without allocating a whole-file buffer.
 */
export async function readPickedFile(
  asset: PickedFileAsset,
  options?: ReadPickedFileOptions,
): Promise<ReadPickedFileResult> {
  if (options?.signal?.aborted) throw new PickedFileError('read-failed');
  if (asset.size !== undefined && asset.size !== null) admitClientUploadSize(asset.size);

  const file = asset.file;
  let bytes: Uint8Array;
  if (file !== null && file !== undefined && typeof file.arrayBuffer === 'function') {
    // Missing size is allowed ONLY when the DOM File supplies a finite one; never read an
    // unbounded buffer just to discover it is too large.
    if (typeof file.size !== 'number') throw new PickedFileError('read-failed');
    admitClientUploadSize(file.size);
    let buffer: ArrayBuffer;
    try {
      buffer = await bounded(file.arrayBuffer(), options);
    } catch (error) {
      // A DOM read can reject with any ordinary Error (security error, detached file, I/O...).
      // Only our own typed codes are meaningful; everything else becomes the fixed read-failed
      // copy instead of leaking through as the generic upload failure.
      if (error instanceof PickedFileError) throw error;
      throw new PickedFileError('read-failed');
    }
    if (!(buffer instanceof ArrayBuffer)) throw new PickedFileError('read-failed');
    bytes = new Uint8Array(buffer);
  } else {
    bytes = decodeBase64DataUrl(asset.base64);
  }

  // Defense in depth: trust the bytes, not the metadata, for size and emptiness.
  if (bytes.length === 0) throw new PickedFileError('no-file');
  admitClientUploadSize(bytes.length);

  // Untrusted metadata: prefer the DOM File's own name/type; never infer either from a URL.
  const name = (typeof file?.name === 'string' && file.name !== '') ? file.name
    : (typeof asset.name === 'string' && asset.name !== '' ? asset.name : 'attachment');
  const mediaType = (typeof file?.type === 'string' && file.type !== '') ? file.type
    : (typeof asset.mimeType === 'string' && asset.mimeType !== '' ? asset.mimeType : undefined);
  return mediaType === undefined ? { bytes, name } : { bytes, name, mediaType };
}
