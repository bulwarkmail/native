import { jmapClient } from './jmap-client';

export async function uploadBlob(
  uri: string,
  type: string,
): Promise<{ blobId: string; size: number; type: string }> {
  const session = jmapClient.currentSession;
  if (!session) throw new Error('Not connected');

  const uploadUrl = session.uploadUrl.replace('{accountId}', jmapClient.accountId);

  // Fetch local file as blob
  const fileResponse = await fetch(uri);
  const blob = await fileResponse.blob();

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': type,
      Authorization: (jmapClient as any).authHeader,
    },
    body: blob,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
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
