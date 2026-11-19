// Spec 044 — native half of the picked-file seam. This is deliberately a NO-OP seam: the bytes
// come from the same expo-file-system `File(asset.uri) → info() → arrayBuffer()` path that spec 041
// already ships. Metro resolves the extensionless `./picked-file` import to this file on native and
// to `picked-file.web.ts` on web. Keeping the path here also keeps expo-file-system OUT of the web
// bundle (its web build is a warn-only stub with no info()/arrayBuffer()).

import { File } from 'expo-file-system';

import { admitClientUploadSize } from '../core/remote-upload';

/** The narrow projection of `DocumentPickerAsset` this reader needs (both platforms). */
export interface PickedFileAsset {
  uri: string;
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

/** Stable codes only; the screen maps these to fixed localized copy, never to exception text. */
export type PickedFileErrorCode = 'no-file' | 'read-failed' | 'read-timeout' | 'file-too-large';

export class PickedFileError extends Error {
  readonly code: PickedFileErrorCode;

  constructor(code: PickedFileErrorCode) {
    super(code);
    this.name = 'PickedFileError';
    this.code = code;
  }
}

/** Web-only deadline constant, exported so the screen's shared call site has one signature. */
export const WEB_PICKED_FILE_READ_TIMEOUT_MS = 15_000;

export interface ReadPickedFileOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** No object URL is created by the native picker: nothing to revoke. */
export function isPickerObjectUrl(_uri: unknown): boolean {
  return false;
}

/** Native no-op: object URLs are a browser-only artifact of Expo's web picker. */
export function revokePickerObjectUrl(_uri: string): void {}

/** Native no-op seam: unchanged spec 041 read path, same result shape as the web reader. */
export async function readPickedFile(
  asset: PickedFileAsset,
  _options?: ReadPickedFileOptions,
): Promise<ReadPickedFileResult> {
  if (asset.size !== undefined && asset.size !== null) admitClientUploadSize(asset.size);
  let bytes: Uint8Array;
  try {
    const file = new File(asset.uri);
    const info = file.info();
    if (!info.exists) throw new PickedFileError('no-file');
    admitClientUploadSize(info.size);
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    // Spec 044: an ordinary native file read failure is a READ failure, not an upload failure.
    // Typed admission/no-file codes keep their own stable meaning.
    if (error instanceof PickedFileError) throw error;
    if ((error as { code?: string } | null)?.code === 'file-too-large') throw error;
    throw new PickedFileError('read-failed');
  }
  if (bytes.length === 0) throw new PickedFileError('no-file');
  admitClientUploadSize(bytes.length);
  const name = typeof asset.name === 'string' && asset.name !== '' ? asset.name : 'attachment';
  const mediaType = typeof asset.mimeType === 'string' && asset.mimeType !== '' ? asset.mimeType : undefined;
  return mediaType === undefined ? { bytes, name } : { bytes, name, mediaType };
}
