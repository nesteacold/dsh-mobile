// Spec 041 FR-2 — the phone's narrow app-side half of the spec 013 remote-upload frames.
//
// CONTRACT (authoritative text: `packages/mobile-protocol/src/index.mjs:423-463`; Host side:
// `plugins/mobile-gateway/lib/file-upload.mjs:340-375`):
//
//   remote-upload-open   { type, requestId, sessionId, kind: 'file'|'image',
//                          name?, mediaType?, size, sha256 }
//     → remote-upload-result { ok: true, value: { uploadId, sessionId, kind, name?, mediaType?,
//                                                 size, chunkBytes, maxBytes, idleTimeoutMs } }
//   remote-upload-chunk  { type, requestId, uploadId, offset, data }
//     → remote-upload-result { ok: true, value: { uploadId, sessionId, nextOffset } }
//   remote-upload-finish { type, requestId, uploadId }
//     → remote-upload-result { ok: true, value: { receiptId, file | image } }
//   remote-upload-cancel { type, requestId, uploadId }
//     → remote-upload-result { ok: true, value: { uploadId, sessionId, cancelled: true } }
//
// These are NOT contract §4 operations (`OPS` is unchanged): every call uses the client's explicit
// `allowNonOpType` opt-in. Scope `attachments:write` is checked by AppController BEFORE a frame is
// sent; nothing here widens a grant or touches the blocked `session/attachment` / `file-upload-*`
// legacy endpoints. `data` is CANONICAL padded base64, `offset` counts DECODED bytes, and `sha256`
// is computed from the very same bytes the chunks encode. Pure TS: no react-native/expo/Node imports.

import {
  ATTACHMENTS_WRITE_SCOPE,
  REMOTE_UPLOAD_MAX_CHUNK_BYTES,
  REMOTE_UPLOAD_RESULT_KIND,
  type Op,
} from '@dsh-ext/mobile-protocol';

import type { CompanionClient } from './client';
import { sha256, toHex } from './hmac';

export { ATTACHMENTS_WRITE_SCOPE, REMOTE_UPLOAD_MAX_CHUNK_BYTES, REMOTE_UPLOAD_RESULT_KIND };

/**
 * Pre-open safety bound. The contract only reports the gateway's authoritative `maxBytes` in the
 * `remote-upload-open` REPLY, so before opening we cannot know the server's exact limit. Reading an
 * unbounded file into memory just to be told "too large" is the resource-exhaustion risk this cap
 * prevents: 64 MiB is a conservative client-side ceiling for a phone attachment, deliberately not
 * a claim about the Host. The server's `maxBytes` is STILL enforced after open and may be lower.
 */
export const CLIENT_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Fail-closed admission for a size reported BEFORE the bytes are read (picker `asset.size` or
 * `File.info().size`). A missing, non-finite, negative or oversized size is refused: the phone must
 * never allocate an unbounded buffer just to discover it cannot be uploaded.
 */
export function admitClientUploadSize(size: unknown): number {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0 || size > CLIENT_UPLOAD_MAX_BYTES) {
    throw new CoreUploadError('file-too-large');
  }
  return size;
}

export type RemoteUploadKind = 'file' | 'image';

export interface RemoteUploadInput {
  readonly sessionId: string;
  readonly kind: RemoteUploadKind;
  /** The exact bytes that will be uploaded; hashes and chunks are both derived from this. */
  readonly bytes: Uint8Array;
  /** Leaf name for the Host's receipt; never a path. */
  readonly name?: string;
  /** Required for images, forbidden for files (gateway `file-upload.mjs:145-155`). */
  readonly mediaType?: string;
}

export interface RemoteUploadOpenView {
  readonly uploadId: string;
  readonly chunkBytes: number;
  readonly maxBytes: number;
  readonly size: number;
}

export interface RemoteUploadReceipt {
  readonly receiptId: string;
  /** The Host's attachment id, when its receipt named one. */
  readonly attachmentId: string | null;
}

/** A caller-supplied stop flag: checked between chunks, never inside a chunk. */
export interface RemoteUploadCancel {
  readonly cancelled: () => boolean;
}

/** One request/answer pair, validated for THIS session and upload. */
async function exchange(
  client: CompanionClient,
  type: 'remote-upload-open' | 'remote-upload-chunk' | 'remote-upload-finish' | 'remote-upload-cancel',
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reply = await client.request(type as Op, params, { allowNonOpType: true });
  if (reply.kind === 'error') {
    throw new CoreUploadError(typeof reply.code === 'string' ? reply.code : 'file-upload-failed');
  }
  if (reply.kind !== REMOTE_UPLOAD_RESULT_KIND) {
    throw new CoreUploadError('client/bad-message');
  }
  return reply;
}

/** The error is a fixed CODE; the Host's internal `message` is never user copy on the phone. */
export class CoreUploadError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Remote upload failed: ${code}`);
    this.name = 'CoreUploadError';
    this.code = code;
  }
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * CANONICAL padded base64: the standard alphabet, `=` padding, no line breaks. The gateway compares
 * `Buffer.from(data, 'base64').toString('base64') === data`, so any other spelling is refused. This
 * encoder is byte-driven (no Buffer / btoa) so the same bytes work in Hermes and Node tests.
 */
export function canonicalBase64(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] as number;
    const second = index + 1 < bytes.length ? bytes[index + 1] as number : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] as number : 0;
    out += BASE64_ALPHABET[first >> 2];
    out += BASE64_ALPHABET[((first & 0x03) << 4) | (second >> 4)];
    out += index + 1 < bytes.length ? BASE64_ALPHABET[((second & 0x0f) << 2) | (third >> 6)] : '=';
    out += index + 2 < bytes.length ? BASE64_ALPHABET[third & 0x3f] : '=';
  }
  return out;
}

/** SHA-256 of the SAME bytes the chunks encode, as the 64 lowercase hex digits the gateway checks. */
export function uploadSha256(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** `remote-upload-open` params. The client supplies `requestId`; this module never invents one. */
export function openParams(input: RemoteUploadInput): Record<string, unknown> {
  const sessionId = nonEmpty(input.sessionId);
  if (sessionId === null) throw new CoreUploadError('bad-request');
  if (input.kind !== 'file' && input.kind !== 'image') throw new CoreUploadError('bad-request');
  const size = admitClientUploadSize(input.bytes.length);
  if (!Number.isSafeInteger(size)) throw new CoreUploadError('bad-request');
  const name = input.name === undefined ? null : nonEmpty(input.name);
  const mediaType = input.mediaType === undefined ? null : nonEmpty(input.mediaType);
  if (input.kind === 'image' && mediaType === null) throw new CoreUploadError('bad-request');
  if (input.kind === 'file' && input.mediaType !== undefined) throw new CoreUploadError('bad-request');
  return {
    sessionId,
    kind: input.kind,
    ...(name === null ? {} : { name }),
    ...(mediaType === null ? {} : { mediaType }),
    size,
    sha256: uploadSha256(input.bytes),
  };
}

/** `remote-upload-chunk` params: `offset` is decoded bytes, `data` is canonical base64 of THAT slice. */
export function chunkParams(uploadId: string, offset: number, bytes: Uint8Array): Record<string, unknown> {
  if (nonEmpty(uploadId) === null || !Number.isSafeInteger(offset) || offset < 0 || bytes.length === 0) {
    throw new CoreUploadError('bad-request');
  }
  return { uploadId, offset, data: canonicalBase64(bytes) };
}

/** The gateway lowers `chunkBytes` for its own WS budget; a reply outside these bounds is a defect. */
export function toOpenView(reply: Record<string, unknown>, input: RemoteUploadInput): RemoteUploadOpenView {
  const value = object(reply.value);
  if (value === null || reply.ok !== true) throw new CoreUploadError('file-upload-invalid-response');
  const uploadId = nonEmpty(value.uploadId);
  if (uploadId === null || value.sessionId !== input.sessionId || value.kind !== input.kind) {
    throw new CoreUploadError('client/bad-message');
  }
  if (value.size !== input.bytes.length) throw new CoreUploadError('client/bad-message');
  const chunkBytes = value.chunkBytes;
  const maxBytes = value.maxBytes;
  if (typeof chunkBytes !== 'number' || !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0
    || chunkBytes > REMOTE_UPLOAD_MAX_CHUNK_BYTES) {
    throw new CoreUploadError('file-upload-invalid-response');
  }
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new CoreUploadError('file-upload-invalid-response');
  }
  return { uploadId, chunkBytes, maxBytes, size: input.bytes.length };
}

/** A chunk answer is accepted only if it advances by EXACTLY the decoded bytes just sent. */
export function toChunkView(reply: Record<string, unknown>, uploadId: string, offset: number, sent: number): number {
  const value = object(reply.value);
  if (value === null || reply.ok !== true || value.uploadId !== uploadId || value.nextOffset !== offset + sent) {
    throw new CoreUploadError('file-upload-offset');
  }
  return value.nextOffset as number;
}

/** The finish answer carries the Host's own receipt, which the next prompt must echo. */
export function toFinishView(reply: Record<string, unknown>, uploadId: string): RemoteUploadReceipt {
  const value = object(reply.value);
  if (value === null || reply.ok !== true) throw new CoreUploadError('file-upload-invalid-response');
  if (value.uploadId !== undefined && value.uploadId !== uploadId) throw new CoreUploadError('client/bad-message');
  const receiptId = nonEmpty(value.receiptId);
  if (receiptId === null) throw new CoreUploadError('file-upload-invalid-response');
  const reference = object(value.file) ?? object(value.image);
  const attachmentId = reference === null ? null : nonEmpty(reference.attachmentId);
  return { receiptId, attachmentId };
}

/**
 * One transfer: open → every chunk → finish. A rejection at any step attempts ONE best-effort
 * `remote-upload-cancel` so the gateway does not keep the slot, then rethrows the fixed-code error.
 * `progress(sent, total)` fires after each accepted chunk; the UI owns the display.
 */
export async function remoteUpload(
  client: CompanionClient,
  input: RemoteUploadInput,
  options: {
    progress?: (sent: number, total: number) => void;
    cancel?: RemoteUploadCancel;
    /** Lets the caller cancel from OUTSIDE (session change/unmount) once a slot exists. */
    onUploadId?: (uploadId: string) => void;
  } = {},
): Promise<RemoteUploadReceipt> {
  const params = openParams(input);
  const openReply = await exchange(client, 'remote-upload-open', params);
  // Keep ANY uploadId the reply named BEFORE validating the rest of it: a malformed/late reply can
  // still have reserved a transfer slot on the gateway, and that slot must be cancelled on failure.
  let uploadId: string | null = nonEmpty(object(openReply.value)?.uploadId);
  if (uploadId !== null) options.onUploadId?.(uploadId);
  let sent = 0;
  try {
    const open = toOpenView(openReply, input);
    uploadId = open.uploadId;
    if (input.bytes.length > open.maxBytes) throw new CoreUploadError('file-too-large');
    while (sent < input.bytes.length) {
      if (options.cancel?.cancelled() === true) throw new CoreUploadError('file-upload-cancelled');
      const end = Math.min(sent + open.chunkBytes, input.bytes.length);
      const slice = input.bytes.subarray(sent, end);
      const reply = await exchange(client, 'remote-upload-chunk', chunkParams(uploadId, sent, slice));
      sent = toChunkView(reply, uploadId, sent, slice.length);
      options.progress?.(sent, input.bytes.length);
    }
    // A cancel that lands after the LAST chunk must not commit a transfer the user abandoned.
    if (options.cancel?.cancelled() === true) throw new CoreUploadError('file-upload-cancelled');
    return toFinishView(await exchange(client, 'remote-upload-finish', { uploadId }), uploadId);
  } catch (error) {
    if (uploadId !== null) {
      try {
        await exchange(client, 'remote-upload-cancel', { uploadId });
      } catch {
        // The original failure is the one worth reporting; a failed cleanup must not mask it.
      }
    }
    throw error;
  }
}

/**
 * Best-effort cancel from a caller that owns a live uploadId (the screen's session-change/unmount
 * path). The transfer's own cleanup may also send one; duplicate cancels are harmless and both are
 * swallowed by that caller. Never throws a Host message into the UI.
 */
export async function cancelUpload(client: CompanionClient, uploadId: string): Promise<void> {
  if (nonEmpty(uploadId) === null) return;
  try {
    const reply = await exchange(client, 'remote-upload-cancel', { uploadId });
    const value = object(reply.value);
    if (value === null || value.cancelled !== true) throw new CoreUploadError('file-upload-cancelled');
  } catch {
    // The cancellation attempt is cleanup; failure there must not mask a session change.
  }
}
