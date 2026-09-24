import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { jmapClient } from '../api/jmap-client';
import { getDownloadUrl } from '../api/blob';
import type { Attachment, Email } from '../api/types';
import { useSettingsStore } from '../stores/settings-store';
import {
  attachmentDownloadFilename,
  emailExportFilename,
  type EmailFilenameOptions,
} from './download-filename';
import { getClientCertAlias, secureFetch } from './client-cert';
import { sniffImageMime } from './email-html';

const RFC822 = 'message/rfc822';
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;

// Largest inline image we base64-encode in JS memory. Anything bigger is
// streamed to a cache file and encoded natively so the JS thread doesn't
// freeze on megabytes of string concatenation.
const MAX_IN_MEMORY_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

// Temp files handed to viewers / the share sheet older than this are swept.
const STALE_EXPORT_MS = 24 * 60 * 60 * 1000;

// Read the user's filename template + transform preferences for exports.
function emailFileOptions(): EmailFilenameOptions {
  const s = useSettingsStore.getState();
  return {
    template: s.emailExportTemplate,
    spaceReplacement: s.exportSpaceReplacement,
    lowercase: s.exportLowercase,
    stripDiacritics: s.exportStripDiacritics,
  };
}

function attachmentFileOptions(): EmailFilenameOptions {
  const s = useSettingsStore.getState();
  return {
    template: s.attachmentExportTemplate,
    spaceReplacement: s.exportSpaceReplacement,
    lowercase: s.exportLowercase,
    stripDiacritics: s.exportStripDiacritics,
  };
}

function safeAttachmentName(name: string | undefined, type: string | undefined): string {
  const fallbackExt = type?.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  const cleaned = (name ?? '').replace(/[\\/:*?"<>|]/g, '_').trim();
  if (cleaned) return cleaned.slice(0, 120);
  return `attachment.${fallbackExt}`;
}

// ─── Temp-file housekeeping ─────────────────────────────────────────────

// Every temp file we hand to another app lives in one sub-directory of the
// cache so the sweep below only ever touches our own files.
function exportsDir(): Directory {
  return new Directory(Paths.cache, 'bulwark-exports');
}

function ensureDir(dir: Directory): void {
  try {
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  } catch { /* best effort - the download will surface a real error */ }
}

function deleteQuietly(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch { /* already gone or still in use - the sweep gets it later */ }
}

// Folders the in-app preview downloads into (see cachePreviewFile).
const PREVIEW_DIR_PREFIX = 'preview-';

function deleteStaleFiles(dir: Directory, now: number, maxAgeMs: number): void {
  for (const entry of dir.list()) {
    if (!(entry instanceof File)) continue;
    const modified = (entry as { modificationTime?: number | null }).modificationTime;
    const age = typeof modified === 'number' ? now - modified : Number.POSITIVE_INFINITY;
    if (age > maxAgeMs) deleteQuietly(entry);
  }
}

/**
 * Remove temp files older than a day. Files shared into other apps could not
 * always be deleted right after the share sheet closed (the receiving app may
 * still be reading them), so anything that slipped through is collected here,
 * including preview folders whose file went to another app. Runs once per
 * process, lazily before the first export, and is also safe to call at launch.
 */
let sweptThisProcess = false;
export async function sweepStaleExportFiles(maxAgeMs = STALE_EXPORT_MS): Promise<void> {
  if (sweptThisProcess) return;
  sweptThisProcess = true;
  try {
    const dir = exportsDir();
    if (!dir.exists) return;
    const now = Date.now();
    deleteStaleFiles(dir, now, maxAgeMs);
    for (const entry of dir.list()) {
      if (!(entry instanceof Directory) || !entry.name.startsWith(PREVIEW_DIR_PREFIX)) continue;
      try {
        deleteStaleFiles(entry, now, maxAgeMs);
        if (entry.list().length === 0) entry.delete();
      } catch { /* in use - a later launch gets it */ }
    }
  } catch { /* housekeeping only */ }
}

// Delete a temp file once the share sheet has resolved. iOS copies the file
// for the receiving extension, so it can go immediately; Android hands the
// content URI to the target app, which may still be streaming it, so give it
// a grace period and leave the rest to the sweep.
function scheduleTempCleanup(file: File): void {
  if (Platform.OS === 'android') {
    setTimeout(() => deleteQuietly(file), 60_000);
  } else {
    deleteQuietly(file);
  }
}

// expo-sharing only accepts `file://` URLs and rejects `content://` with
// "Only local file URLs are supported". On Android it then wraps the file
// itself with its bundled SharingFileProvider before launching the share
// intent, so every `Sharing.shareAsync` below gets `downloaded.uri` and must
// NOT be pre-translated to `downloaded.contentUri`. `openWithViewer` is the
// one exception: it assembles the intent itself, so there it's the reverse —
// only a content URI is grantable to another app.

// Android-only: hand the file to whichever app owns the type (PDF viewer,
// gallery, video player, ...) rather than to the share sheet. Returns false
// when the handoff didn't happen so the caller can fall back to sharing —
// most often because no installed app handles the MIME type, in which case
// startActivityAsync rejects with ActivityNotFoundException.
async function openWithViewer(file: File, mimeType: string): Promise<boolean> {
  try {
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      // Read-only grant, scoped to the receiving app for the life of the
      // intent. Deliberately no FLAG_ACTIVITY_NEW_TASK: expo-intent-launcher
      // uses startActivityForResult, and a new task cancels that result.
      data: file.contentUri,
      type: mimeType,
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
    return true;
  } catch (e) {
    console.warn('[attachments] no viewer for', mimeType, '- falling back to share:', e);
    return false;
  }
}

function isUnauthorizedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b401\b|unauthori[sz]ed/i.test(msg);
}

// Routes the download via the client-cert-aware native module when the user
// has picked a cert, and via expo-file-system's native streaming downloader
// otherwise. The streaming path scales to large attachments without buffering
// in JS, so we keep using it as the default.
//
// Both paths bypass the JMAP client's fetch wrapper, so the OAuth token has to
// be refreshed here: proactively before the header is captured, and once
// reactively when the server still answers 401 (a token that expired between
// the check and the request).
async function downloadInto(
  url: string,
  dest: File,
  parent: Directory,
): Promise<File> {
  await jmapClient.ensureFreshToken();
  const alias = await getClientCertAlias();
  ensureDir(parent);
  const attempt = async (): Promise<File> => {
    if (!alias) {
      // The static returns a separately-typed `FileSystemFile`; we already
      // have a fully-typed `File` referencing the same uri, so we ignore the
      // return value and re-use our `dest` reference for downstream code.
      await File.downloadFileAsync(url, dest, {
        headers: { Authorization: jmapClient.authHeader },
        idempotent: true,
      });
      return dest;
    }
    const response = await secureFetch(url, {
      headers: { Authorization: jmapClient.authHeader },
    });
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }
    if (dest.exists) dest.delete();
    const buffer = await response.arrayBuffer();
    dest.create();
    dest.write(new Uint8Array(buffer));
    return dest;
  };
  try {
    return await attempt();
  } catch (err) {
    if (isUnauthorizedError(err) && (await jmapClient.forceRefreshToken())) {
      return attempt();
    }
    throw err;
  }
}

/** Download a blob into the exports cache directory (caller cleans up). */
export async function cacheBlobFile(
  blobId: string,
  filename: string,
  mimeType: string,
  accountId?: string,
): Promise<File> {
  void sweepStaleExportFiles();
  const dir = exportsDir();
  const dest = new File(dir, filename);
  const url = getDownloadUrl(blobId, filename, mimeType, accountId);
  return downloadInto(url, dest, dir);
}

export async function shareAttachment(
  blobId: string,
  name: string | undefined,
  type: string | undefined,
  email?: Email | null,
  // Owning account for blobs shared by another principal (Files app).
  accountId?: string,
): Promise<void> {
  const filename = email
    ? attachmentDownloadFilename(email, { name, type }, attachmentFileOptions())
    : safeAttachmentName(name, type);
  const mimeType = type || 'application/octet-stream';
  const downloaded = await cacheBlobFile(blobId, filename, mimeType, accountId);

  if (Platform.OS === 'android' && (await openWithViewer(downloaded, mimeType))) {
    // The viewer may keep reading the content URI after the activity result;
    // the daily sweep removes the file.
    return;
  }
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  try {
    await Sharing.shareAsync(downloaded.uri, {
      mimeType,
      dialogTitle: filename,
    });
  } finally {
    scheduleTempCleanup(downloaded);
  }
}

// Save-to-disk variant. iOS doesn't expose a user-visible "Downloads" folder,
// so on both platforms we land the file in the document directory and hand it
// to the share sheet — which on iOS surfaces "Save to Files" and on Android
// surfaces the system save dialog. Unlike the 'preview' counterpart
// (shareAttachment), this one keeps the share sheet on Android as well: "save
// a copy" is a share-sheet destination, not something a viewer app handles.
export async function downloadAttachment(
  blobId: string,
  name: string | undefined,
  type: string | undefined,
  email?: Email | null,
  // Owning account for blobs shared by another principal (Files app).
  accountId?: string,
): Promise<void> {
  const filename = email
    ? attachmentDownloadFilename(email, { name, type }, attachmentFileOptions())
    : safeAttachmentName(name, type);
  const mimeType = type || 'application/octet-stream';
  const dest = new File(Paths.document, filename);
  const url = getDownloadUrl(blobId, filename, mimeType, accountId);
  const downloaded = await downloadInto(url, dest, Paths.document);
  await offerSavedFile(downloaded, filename, mimeType);
}

async function offerSavedFile(file: File, filename: string, mimeType: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  await Sharing.shareAsync(file.uri, {
    mimeType,
    dialogTitle: filename,
  });
}

/**
 * {@link downloadAttachment} for a file already on the device (an open
 * preview): copy it into the document directory and offer it through the
 * share sheet, without downloading it again.
 */
export async function saveLocalFileCopy(file: File, mimeType: string, filename = file.name): Promise<void> {
  const name = safeAttachmentName(filename, mimeType);
  const dest = new File(Paths.document, name);
  if (dest.exists) dest.delete();
  file.copy(dest);
  await offerSavedFile(dest, name, mimeType);
}

// ─── In-app preview files ───────────────────────────────────────────────

let previewSeq = 0;

/**
 * Download a blob for the in-app preview. Every preview gets its own folder
 * in the exports cache, so the file keeps its real name for Share and Open
 * with while its path stays unique: React Native's Image caches decoded
 * images by URI, and two files both called "photo.jpg" must not show the same
 * picture. Remove it with {@link discardPreviewFile} when the preview closes;
 * once it went to another app, leave it to the stale-file sweep instead.
 */
export async function cachePreviewFile(
  blobId: string,
  name: string | undefined,
  type: string | undefined,
  // Owning account for blobs shared by another principal (Files app).
  accountId?: string,
): Promise<File> {
  void sweepStaleExportFiles();
  previewSeq += 1;
  const dir = new Directory(exportsDir(), `${PREVIEW_DIR_PREFIX}${Date.now().toString(36)}-${previewSeq.toString(36)}`);
  const filename = safeAttachmentName(name, type);
  const url = getDownloadUrl(blobId, filename, type || 'application/octet-stream', accountId);
  try {
    return await downloadInto(url, new File(dir, filename), dir);
  } catch (err) {
    try {
      if (dir.exists) dir.delete();
    } catch { /* the sweep gets it */ }
    throw err;
  }
}

/** Delete a file from {@link cachePreviewFile} together with its folder. */
export function discardPreviewFile(file: File): void {
  try {
    const dir = file.parentDirectory;
    if (dir.name.startsWith(PREVIEW_DIR_PREFIX)) {
      if (dir.exists) dir.delete();
      return;
    }
  } catch { /* fall back to the file alone */ }
  deleteQuietly(file);
}

/** Write bytes into the exports cache (caller shares / previews / cleans up). */
export function writeTempFile(bytes: Uint8Array, filename: string, mimeType?: string): File {
  void sweepStaleExportFiles();
  const dir = exportsDir();
  ensureDir(dir);
  const file = new File(dir, safeAttachmentName(filename, mimeType));
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  return file;
}

/**
 * Share an already-materialised local file (zip bundles, extracted parts).
 * `forceSheet` skips the Android viewer handoff and always shows the share
 * sheet - the explicit "Share" action, as opposed to "Open". `keep` leaves the
 * file in place afterwards, for a caller that still shows it (an open
 * preview) and removes it itself.
 */
export async function shareLocalFile(
  file: File,
  mimeType: string,
  dialogTitle?: string,
  opts: { forceSheet?: boolean; keep?: boolean } = {},
): Promise<void> {
  if (!opts.forceSheet && Platform.OS === 'android' && (await openWithViewer(file, mimeType))) return;
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  try {
    await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: dialogTitle ?? file.name });
  } finally {
    if (!opts.keep) scheduleTempCleanup(file);
  }
}

/** Write bytes to the exports cache and hand them to a viewer / the share sheet. */
export async function shareBytes(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  opts: { forceSheet?: boolean } = {},
): Promise<void> {
  const file = writeTempFile(bytes, filename, mimeType);
  await shareLocalFile(file, mimeType, filename, opts);
}

/** Share a blob through the share sheet only (no viewer handoff). */
export async function shareAttachmentViaSheet(
  blobId: string,
  name: string | undefined,
  type: string | undefined,
  email?: Email | null,
  accountId?: string,
): Promise<void> {
  const filename = email
    ? attachmentDownloadFilename(email, { name, type }, attachmentFileOptions())
    : safeAttachmentName(name, type);
  const mimeType = type || 'application/octet-stream';
  const downloaded = await cacheBlobFile(blobId, filename, mimeType, accountId);
  await shareLocalFile(downloaded, mimeType, filename, { forceSheet: true });
}

async function authedBlobFetch(url: string): Promise<Response> {
  await jmapClient.ensureFreshToken();
  let r = await secureFetch(url, { headers: { Authorization: jmapClient.authHeader } });
  if (r.status === 401 && (await jmapClient.forceRefreshToken())) {
    r = await secureFetch(url, { headers: { Authorization: jmapClient.authHeader } });
  }
  if (!r.ok) throw new Error(`Download failed: ${r.status}`);
  return r;
}

export async function fetchRawEmail(blobId: string, accountId?: string): Promise<string> {
  const url = getDownloadUrl(blobId, 'email.eml', RFC822, accountId);
  const r = await authedBlobFetch(url);
  return r.text();
}

/** Fetch a blob's bytes with the same auth/refresh handling as the downloads. */
export async function fetchBlobBytes(
  blobId: string,
  name: string | undefined,
  type: string | undefined,
  accountId?: string,
): Promise<Uint8Array> {
  const url = getDownloadUrl(blobId, name ?? 'blob', type ?? 'application/octet-stream', accountId);
  const r = await authedBlobFetch(url);
  return new Uint8Array(await r.arrayBuffer());
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return global.btoa ? global.btoa(binary) : btoa(binary);
}

function base64PrefixBytes(b64: string, count: number): Uint8Array {
  const slice = b64.slice(0, Math.ceil(count / 3) * 4);
  try {
    const bin = global.atob ? global.atob(slice) : atob(slice);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * Resolve an inline (cid) image part to a `data:` URI for the body WebView.
 * Small parts are fetched into memory; larger ones are streamed to a cache
 * file and base64-encoded natively (the JS thread would otherwise stall for
 * seconds on a multi-megabyte photo). The MIME is sniffed from the bytes so
 * `application/octet-stream` image parts still render (#543).
 */
export async function fetchInlineImageDataUri(
  att: Pick<Attachment, 'blobId' | 'name' | 'type' | 'size'>,
  accountId?: string,
): Promise<string | null> {
  if (!att.blobId) return null;
  if (!att.size || att.size <= MAX_IN_MEMORY_INLINE_IMAGE_BYTES) {
    const buf = await jmapClient.fetchBlobArrayBuffer(att.blobId, att.name, att.type, accountId);
    const bytes = new Uint8Array(buf);
    const mime = sniffImageMime(bytes, att.type);
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
  }
  const file = await cacheBlobFile(
    att.blobId,
    `inline-${att.blobId.replace(/[^a-z0-9]/gi, '_')}`,
    att.type || 'application/octet-stream',
    accountId,
  );
  try {
    const b64 = await file.base64();
    const mime = sniffImageMime(base64PrefixBytes(b64, 16), att.type);
    return `data:${mime};base64,${b64}`;
  } finally {
    deleteQuietly(file);
  }
}

function safeFilename(subject: string | undefined): string {
  const base = (subject ?? 'email').replace(/[^\w\s-]/g, '').trim().slice(0, 60) || 'email';
  return `${base}.eml`;
}

export async function shareEmailEml(
  blobId: string,
  email?: Email | null,
  subjectFallback?: string,
  // Owning account when the message lives in a shared/group mailbox.
  accountId?: string,
): Promise<void> {
  const filename = email
    ? emailExportFilename(email, emailFileOptions())
    : safeFilename(subjectFallback);
  const downloaded = await cacheBlobFile(blobId, filename, RFC822, accountId);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  try {
    await Sharing.shareAsync(downloaded.uri, {
      mimeType: RFC822,
      dialogTitle: 'Share email',
      UTI: 'public.email-message',
    });
  } finally {
    scheduleTempCleanup(downloaded);
  }
}
