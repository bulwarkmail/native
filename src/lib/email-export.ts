import { Platform } from 'react-native';
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

function safeAttachmentName(name: string | undefined, type: string | undefined): string {
  const fallbackExt = type?.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  const cleaned = (name ?? '').replace(/[\\/:*?"<>|]/g, '_').trim();
  if (cleaned) return cleaned.slice(0, 120);
  return `attachment.${fallbackExt}`;
}

// On Android, sharing a `file://` URI from the cache directory throws a
// FileUriExposedException on modern OS versions; the system requires a
// FileProvider-backed `content://` URI instead. expo-file-system exposes that
// via `file.contentUri`, which is the only field iOS doesn't expose.
function shareableUri(file: { uri: string; contentUri?: string }): string {
  if (Platform.OS === 'android' && file.contentUri) return file.contentUri;
  return file.uri;
}

export async function shareAttachment(
  blobId: string,
  name: string | undefined,
  type: string | undefined,
): Promise<void> {
  const filename = safeAttachmentName(name, type);
  const mimeType = type || 'application/octet-stream';
  const dest = new File(Paths.cache, filename);
  const url = getDownloadUrl(blobId, filename, mimeType);
  const downloaded = await File.downloadFileAsync(url, dest, {
    headers: { Authorization: authHeader() },
    idempotent: true,
  });
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  await Sharing.shareAsync(shareableUri(downloaded), {
    mimeType,
    dialogTitle: filename,
  });
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
  const url = getDownloadUrl(blobId, dest.name, RFC822);
  const downloaded = await File.downloadFileAsync(url, dest, {
    headers: { Authorization: authHeader() },
    idempotent: true,
  });
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  await Sharing.shareAsync(shareableUri(downloaded), {
    mimeType: RFC822,
    dialogTitle: 'Share email',
    UTI: 'public.email-message',
  });
}
