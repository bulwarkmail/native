import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { jmapClient } from '../api/jmap-client';
import { getDownloadUrl } from '../api/blob';

const RFC822 = 'message/rfc822';

function authHeader(): string {
  const h = (jmapClient as unknown as { authHeader?: string }).authHeader;
  if (!h) throw new Error('Not connected');
  return h;
}

export async function fetchRawEmail(blobId: string): Promise<string> {
  const url = getDownloadUrl(blobId, 'email.eml', RFC822);
  const r = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!r.ok) throw new Error(`Download failed: ${r.status}`);
  return r.text();
}

function safeFilename(subject: string | undefined): string {
  const base = (subject ?? 'email').replace(/[^\w\s-]/g, '').trim().slice(0, 60) || 'email';
  return `${base}.eml`;
}

export async function shareEmailEml(blobId: string, subject?: string): Promise<void> {
  const dest = new File(Paths.cache, safeFilename(subject));
  if (dest.exists) dest.delete();
  const url = getDownloadUrl(blobId, dest.name, RFC822);
  const downloaded = await File.downloadFileAsync(url, dest, {
    headers: { Authorization: authHeader() },
  });
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  await Sharing.shareAsync(downloaded.uri, {
    mimeType: RFC822,
    dialogTitle: 'Share email',
    UTI: 'public.email-message',
  });
}
