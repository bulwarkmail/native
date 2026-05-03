import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { jmapClient } from '../api/jmap-client';
import { getDownloadUrl } from '../api/blob';
import { getClientCertAlias, secureFetch } from './client-cert';

const RFC822 = 'message/rfc822';

function authHeader(): string {
  return jmapClient.authHeader;
}

function safeAttachmentName(name: string | undefined, type: string | undefined): string {
  const fallbackExt = type?.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  const cleaned = (name ?? '').replace(/[\\/:*?"<>|]/g, '_').trim();
  if (cleaned) return cleaned.slice(0, 120);
  return `attachment.${fallbackExt}`;
}

// expo-sharing only accepts `file://` URLs and rejects `content://` with
// "Only local file URLs are supported". On Android it then wraps the file
// itself with its bundled SharingFileProvider before launching the share
// intent, so we must NOT pre-translate to `file.contentUri`.

// Routes the download via the client-cert-aware native module when the user
// has picked a cert, and via expo-file-system's native streaming downloader
// otherwise. The streaming path scales to large attachments without buffering
// in JS, so we keep using it as the default.
async function downloadInto(
  url: string,
  dest: File,
  parent: Directory,
): Promise<File> {
  const alias = await getClientCertAlias();
  if (!alias) {
    // The static returns a separately-typed `FileSystemFile`; we already
    // have a fully-typed `File` referencing the same uri, so we ignore the
    // return value and re-use our `dest` reference for downstream code.
    await File.downloadFileAsync(url, dest, {
      headers: { Authorization: authHeader() },
      idempotent: true,
    });
    return dest;
  }
  const response = await secureFetch(url, {
    headers: { Authorization: authHeader() },
  });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }
  if (!parent.exists) parent.create({ intermediates: true, idempotent: true });
  if (dest.exists) dest.delete();
  const buffer = await response.arrayBuffer();
  dest.create();
  dest.write(new Uint8Array(buffer));
  return dest;
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
  const downloaded = await downloadInto(url, dest, Paths.cache);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  await Sharing.shareAsync(downloaded.uri, {
    mimeType,
    dialogTitle: filename,
  });
}

// Save-to-disk variant. iOS doesn't expose a user-visible "Downloads" folder,
// so on both platforms we land the file in the document directory and hand it
// to the share sheet — which on iOS surfaces "Save to Files" and on Android
// surfaces the system save dialog. The 'preview' counterpart (shareAttachment)
// uses cache + share, which on most viewers opens directly without prompting.
export async function downloadAttachment(
  blobId: string,
  name: string | undefined,
  type: string | undefined,
): Promise<void> {
  const filename = safeAttachmentName(name, type);
  const mimeType = type || 'application/octet-stream';
  const dest = new File(Paths.document, filename);
  const url = getDownloadUrl(blobId, filename, mimeType);
  const downloaded = await downloadInto(url, dest, Paths.document);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  await Sharing.shareAsync(downloaded.uri, {
    mimeType,
    dialogTitle: filename,
  });
}

export async function fetchRawEmail(blobId: string): Promise<string> {
  const url = getDownloadUrl(blobId, 'email.eml', RFC822);
  const r = await secureFetch(url, { headers: { Authorization: authHeader() } });
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
  const downloaded = await downloadInto(url, dest, Paths.cache);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  await Sharing.shareAsync(downloaded.uri, {
    mimeType: RFC822,
    dialogTitle: 'Share email',
    UTI: 'public.email-message',
  });
}
