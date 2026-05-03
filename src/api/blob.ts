import { File } from 'expo-file-system';
import { jmapClient } from './jmap-client';

export async function uploadBlob(
  uri: string,
  type: string,
): Promise<{ blobId: string; size: number; type: string }> {
  const session = jmapClient.currentSession;
  if (!session) throw new Error('Not connected');

  const uploadUrl = session.uploadUrl.replace(
    '{accountId}',
    encodeURIComponent(jmapClient.accountId),
  );

  // Read the source via the file-system API so this works for both `file://`
  // (image picker, iOS document picker) and `content://` (Android SAF) URIs.
  const bytes = await new File(uri).bytes();

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': type,
      Authorization: (jmapClient as any).authHeader,
    },
    body: bytes as unknown as BodyInit,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Upload failed: ${response.status}${detail ? ` ${detail}` : ''}`);
  }

  // JMAP servers return either the direct shape `{blobId, type, size}` or
  // the per-account nested shape `{[accountId]: {blobId, type, size}}`.
  // Stalwart has shipped both depending on version; mirror the webmail's
  // tolerant parsing so uploads don't silently lose the blobId.
  const raw = (await response.json()) as Record<string, unknown>;
  const direct = raw as { blobId?: string; type?: string; size?: number };
  if (typeof direct.blobId === 'string') {
    return {
      blobId: direct.blobId,
      size: typeof direct.size === 'number' ? direct.size : bytes.byteLength,
      type: typeof direct.type === 'string' && direct.type ? direct.type : type,
    };
  }
  const nested = raw[jmapClient.accountId] as
    | { blobId?: string; type?: string; size?: number }
    | undefined;
  if (nested?.blobId) {
    return {
      blobId: nested.blobId,
      size: typeof nested.size === 'number' ? nested.size : bytes.byteLength,
      type: typeof nested.type === 'string' && nested.type ? nested.type : type,
    };
  }
  throw new Error('Upload succeeded but response did not include a blobId');
}

export function getDownloadUrl(
  blobId: string,
  name?: string,
  type?: string,
): string {
  const session = jmapClient.currentSession;
  if (!session) throw new Error('Not connected');

  return session.downloadUrl
    .replace('{accountId}', jmapClient.accountId)
    .replace('{blobId}', blobId)
    .replace('{name}', encodeURIComponent(name ?? 'download'))
    .replace('{type}', encodeURIComponent(type ?? 'application/octet-stream'));
}
