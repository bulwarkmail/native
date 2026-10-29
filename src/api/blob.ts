import { File } from 'expo-file-system';
import type * as LegacyFileSystemTypes from 'expo-file-system/legacy';
import { jmapClient } from './jmap-client';
import { batched } from './jmap-result';
import { downloadNameSegment } from './download-name';
import { CAPABILITIES } from './types';
import { getClientCertAlias, secureFetch } from '../lib/client-cert';

// The legacy expo-file-system API (streaming upload tasks with progress and
// cancellation) is required lazily: it touches native globals at import time,
// which would break every module that merely imports this file in unit tests.
type LegacyFileSystemModule = typeof LegacyFileSystemTypes;
let legacyFileSystem: LegacyFileSystemModule | null = null;
async function loadLegacyFileSystem(): Promise<LegacyFileSystemModule> {
  if (!legacyFileSystem) {
    legacyFileSystem = (await import('expo-file-system/legacy')) as LegacyFileSystemModule;
  }
  return legacyFileSystem;
}

export interface UploadBlobOptions {
  /** Called with bytes sent / total as the upload streams. */
  onProgress?: (sent: number, total: number) => void;
  /** Abort the in-flight upload; the promise then rejects with an AbortError. */
  signal?: AbortSignal;
}

interface UploadResult {
  blobId: string;
  size: number;
  type: string;
}

function abortError(): Error {
  const err = new Error('Upload cancelled');
  err.name = 'AbortError';
  return err;
}

// JMAP servers return either the direct shape `{blobId, type, size}` or
// the per-account nested shape `{[accountId]: {blobId, type, size}}`.
// Stalwart has shipped both depending on version; mirror the webmail's
// tolerant parsing so uploads don't silently lose the blobId.
function parseUploadResponse(
  raw: Record<string, unknown>,
  accountId: string,
  fallbackSize: number,
  fallbackType: string,
): UploadResult {
  const direct = raw as { blobId?: string; type?: string; size?: number };
  if (typeof direct.blobId === 'string') {
    return {
      blobId: direct.blobId,
      size: typeof direct.size === 'number' ? direct.size : fallbackSize,
      type: typeof direct.type === 'string' && direct.type ? direct.type : fallbackType,
    };
  }
  const nested = raw[accountId] as
    | { blobId?: string; type?: string; size?: number }
    | undefined;
  if (nested?.blobId) {
    return {
      blobId: nested.blobId,
      size: typeof nested.size === 'number' ? nested.size : fallbackSize,
      type: typeof nested.type === 'string' && nested.type ? nested.type : fallbackType,
    };
  }
  throw new Error('Upload succeeded but response did not include a blobId');
}

function uploadUrlFor(accountId: string): string {
  const session = jmapClient.currentSession;
  if (!session) throw new Error('Not connected');
  return session.uploadUrl.replace('{accountId}', encodeURIComponent(accountId));
}

// Upload a local file to the JMAP upload endpoint.
//
// The default path streams the file from disk through expo-file-system's
// native upload task, which reports progress and can be cancelled, so large
// videos/PDFs from the document picker no longer have to fit in JS memory
// (webmail #162/#333). When the user has picked a client certificate the
// native task can't present it, so we fall back to buffering the bytes and
// posting them through the cert-aware fetch.
export async function uploadBlob(
  uri: string,
  type: string,
  options: UploadBlobOptions = {},
): Promise<UploadResult> {
  const accountId = jmapClient.accountId;
  const uploadUrl = uploadUrlFor(accountId);
  const contentType = type || 'application/octet-stream';
  const { signal } = options;
  if (signal?.aborted) throw abortError();

  const alias = await getClientCertAlias();
  if (alias) {
    return uploadBlobBuffered(uri, contentType, accountId, uploadUrl, signal);
  }

  const LegacyFileSystem = await loadLegacyFileSystem();
  const cacheCopy = await copyContentUriToCache(LegacyFileSystem, uri);
  try {
    return await uploadFileStreamed(LegacyFileSystem, cacheCopy ?? uri, contentType, accountId, uploadUrl, options);
  } finally {
    if (cacheCopy) {
      await LegacyFileSystem.deleteAsync(cacheCopy, { idempotent: true }).catch(() => undefined);
    }
  }
}

let cacheCopySeq = 0;
const UPLOAD_COPY_NAME = /^upload-(\d+)-\d+$/;
const loadedAt = Date.now();

/**
 * Whether a cache file is an upload copy (see below) made by an earlier run
 * of the app: one killed mid-upload never deleted it. Copies of this run may
 * still be uploading and are left alone.
 */
export function isStaleUploadCopy(name: string): boolean {
  const match = UPLOAD_COPY_NAME.exec(name);
  return !!match && Number(match[1]) < loadedAt;
}

// The native upload task reads from a file path, but files shared into the
// app from another app arrive as Android `content://` URIs with nothing on
// disk behind them. Stream those into the cache first; returns null when
// `uri` is already a file.
async function copyContentUriToCache(
  LegacyFileSystem: LegacyFileSystemModule,
  uri: string,
): Promise<string | null> {
  if (!uri.startsWith('content://')) return null;
  const to = `${LegacyFileSystem.cacheDirectory}upload-${Date.now()}-${++cacheCopySeq}`;
  try {
    await LegacyFileSystem.copyAsync({ from: uri, to });
  } catch (e) {
    await LegacyFileSystem.deleteAsync(to, { idempotent: true }).catch(() => undefined);
    throw e;
  }
  return to;
}

async function uploadFileStreamed(
  LegacyFileSystem: LegacyFileSystemModule,
  fileUri: string,
  contentType: string,
  accountId: string,
  uploadUrl: string,
  { onProgress, signal }: UploadBlobOptions,
): Promise<UploadResult> {
  if (signal?.aborted) throw abortError();
  const task = LegacyFileSystem.createUploadTask(
    uploadUrl,
    fileUri,
    {
      httpMethod: 'POST',
      uploadType: LegacyFileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: {
        'Content-Type': contentType,
        Authorization: jmapClient.authHeader,
      },
    },
    onProgress
      ? (data) => onProgress(data.totalBytesSent, data.totalBytesExpectedToSend)
      : undefined,
  );

  const onAbort = () => void task.cancelAsync();
  signal?.addEventListener('abort', onAbort);
  let result: LegacyFileSystemTypes.FileSystemUploadResult | null | undefined;
  try {
    result = await task.uploadAsync();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted || !result) throw abortError();

  if (result.status < 200 || result.status >= 300) {
    const detail = (result.body || '').slice(0, 300);
    throw new Error(`Upload failed: ${result.status}${detail ? ` ${detail}` : ''}`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(result.body) as Record<string, unknown>;
  } catch {
    throw new Error('Upload succeeded but the server response was not JSON');
  }
  return parseUploadResponse(raw, accountId, 0, contentType);
}

async function uploadBlobBuffered(
  uri: string,
  contentType: string,
  accountId: string,
  uploadUrl: string,
  signal?: AbortSignal,
): Promise<UploadResult> {
  // Read via the file-system API so this works for both `file://` (image
  // picker, iOS document picker) and `content://` (Android SAF) URIs. We pass
  // the underlying ArrayBuffer rather than the Uint8Array view because some
  // RN transports stringify typed-array bodies, which silently produces an
  // empty/garbage upload.
  const bytes = await new File(uri).bytes();
  if (signal?.aborted) throw abortError();

  const response = await secureFetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      Authorization: jmapClient.authHeader,
    },
    body: bytes.buffer as ArrayBuffer,
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Upload failed: ${response.status}${detail ? ` ${detail}` : ''}`);
  }
  const raw = (await response.json()) as Record<string, unknown>;
  return parseUploadResponse(raw, accountId, bytes.byteLength, contentType);
}

// Direct in-memory upload. The on-disk variant goes through expo-file-system's
// `new File(uri).bytes()`, which is overkill when we already have the bytes
// (e.g. the empty-blob trick used to create directories on Stalwart).
export async function uploadBytes(
  bytes: Uint8Array,
  type: string,
  // Blobs are account-scoped: a message imported into a shared/group account's
  // folder has to be uploaded to that account, not the user's own.
  accountId?: string,
): Promise<UploadResult> {
  const targetAccountId = accountId ?? jmapClient.accountId;
  const uploadUrl = uploadUrlFor(targetAccountId);

  const response = await secureFetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': type || 'application/octet-stream',
      Authorization: jmapClient.authHeader,
    },
    body: bytes.buffer as ArrayBuffer,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Upload failed: ${response.status}${detail ? ` ${detail}` : ''}`);
  }

  const raw = (await response.json()) as Record<string, unknown>;
  return parseUploadResponse(raw, targetAccountId, bytes.byteLength, type);
}

export function getDownloadUrl(
  blobId: string,
  name?: string,
  type?: string,
  // Blobs of nodes shared by another principal live in the owner's account;
  // downloading them with our own accountId 404s.
  accountId?: string,
): string {
  const session = jmapClient.currentSession;
  if (!session) throw new Error('Not connected');

  return session.downloadUrl
    .replace('{accountId}', encodeURIComponent(accountId ?? jmapClient.accountId))
    .replace('{blobId}', encodeURIComponent(blobId))
    .replace('{name}', encodeURIComponent(downloadNameSegment(name)))
    .replace('{type}', encodeURIComponent(type ?? 'application/octet-stream'));
}

/**
 * Bytes of blob data one Blob/get in getBlobsAsBase64 asks for. They come
 * back as base64 inside the JSON, a third larger.
 */
const BLOB_BATCH_BYTES = 4 * 1024 * 1024;
/** The largest contact photo Stalwart 1.0 takes by default (maxMediaSize). */
const BLOB_LARGE_BYTES = 2 * 1024 * 1024;

/** What getBlobsAsBase64 brought back. */
export interface BlobBatch {
  /** Contents as base64 by blobId, for every blob the server returned. */
  data: Map<string, string>;
  /** Blobs left unfetched because a request failed; they can still be downloaded one by one. */
  failed: string[];
}

/**
 * Split `items` into consecutive batches whose sizes add up to at most
 * `budget`, and of at most `maxCount` entries. An item larger than the budget
 * gets a batch of its own; an item without a size counts as the whole budget.
 */
function batchedBySize<T>(items: T[], sizeOf: (item: T) => number | undefined, budget: number, maxCount: number): T[][] {
  const limit = Math.max(1, Math.floor(maxCount));
  const result: T[][] = [];
  let batch: T[] = [];
  let total = 0;
  for (const item of items) {
    const size = sizeOf(item) ?? budget;
    if (batch.length > 0 && (total + size > budget || batch.length >= limit)) {
      result.push(batch);
      batch = [];
      total = 0;
    }
    batch.push(item);
    total += size;
  }
  if (batch.length > 0) result.push(batch);
  return result;
}

/**
 * The contents of many blobs as base64, through Blob/get (RFC 9404), for an
 * export that needs a lot of them (webmail getBlobsAsBase64): one download per
 * blob queues behind the server's per-user limits (Stalwart: 4 requests at a
 * time, 1000 a minute), while one Blob/get returns many.
 *
 * More blobs than two of the largest photos would fill are first asked for
 * their sizes, then fetched in requests of about BLOB_BATCH_BYTES, so a
 * response stays bounded however large the photos are.
 *
 * Null when the session doesn't advertise the blob capability, which then
 * must stay out of `using`. Blobs the server doesn't find are left out; once a
 * request fails, the blobs not fetched yet are listed in `failed`.
 *
 * Stalwart answers Blob/get only in accounts the user is a member of: an
 * address book shared with the user is in an account that isn't one, and the
 * call comes back `forbidden` ("You are not an owner of account ..."). It
 * checks the access to each blob by itself, though, whichever account the
 * request names, so the rest are asked for in the user's own account
 * (webmail 7977a6ed).
 */
export async function getBlobsAsBase64(blobIds: string[], accountId?: string): Promise<BlobBatch | null> {
  if (!jmapClient.hasCapability(CAPABILITIES.BLOB)) return null;
  let account = accountId || jmapClient.accountId;
  const ids = [...new Set(blobIds)];
  const data = new Map<string, string>();
  const blobGet = async (chunk: string[], property: 'size' | 'data:asBase64') => {
    const call = () => jmapClient.request(
      [['Blob/get', { accountId: account, ids: chunk, properties: [property] }, '0']],
      [CAPABILITIES.CORE, CAPABILITIES.BLOB],
    );
    let [name, result] = (await call()).methodResponses?.[0] ?? [];
    if (name === 'error' && result?.type === 'forbidden' && account !== jmapClient.accountId) {
      account = jmapClient.accountId;
      [name, result] = (await call()).methodResponses?.[0] ?? [];
    }
    if (name !== 'Blob/get') {
      throw new Error(`Blob/get failed: ${result?.description || result?.type || 'unknown'}`);
    }
    return (result.list ?? []) as Array<Record<string, unknown>>;
  };

  let chunks: string[][] = ids.length > 0 ? [ids] : [];
  if (ids.length * BLOB_LARGE_BYTES > BLOB_BATCH_BYTES) {
    const sizes = new Map<string, number | undefined>();
    try {
      for (const chunk of batched(ids, jmapClient.getMaxObjectsInGet())) {
        for (const blob of await blobGet(chunk, 'size')) {
          if (typeof blob.id === 'string') sizes.set(blob.id, typeof blob.size === 'number' ? blob.size : undefined);
        }
      }
    } catch (err) {
      console.warn('[blob] Blob/get of sizes failed', err);
      return { data, failed: ids };
    }
    chunks = batchedBySize(
      ids.filter((id) => sizes.has(id)),
      (id) => sizes.get(id),
      BLOB_BATCH_BYTES,
      jmapClient.getMaxObjectsInGet(),
    );
  }

  for (let i = 0; i < chunks.length; i++) {
    try {
      for (const blob of await blobGet(chunks[i], 'data:asBase64')) {
        const base64 = blob['data:asBase64'];
        if (typeof blob.id === 'string' && typeof base64 === 'string') data.set(blob.id, base64);
      }
    } catch (err) {
      console.warn('[blob] Blob/get failed', err);
      return { data, failed: chunks.slice(i).flat() };
    }
  }
  return { data, failed: [] };
}
