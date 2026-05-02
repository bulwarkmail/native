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

  return response.json();
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
