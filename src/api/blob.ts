import { File } from 'expo-file-system';
import type * as LegacyFileSystemTypes from 'expo-file-system/legacy';
import { jmapClient } from './jmap-client';
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
    .replace('{name}', encodeURIComponent(name ?? 'download'))
    .replace('{type}', encodeURIComponent(type ?? 'application/octet-stream'));
}
