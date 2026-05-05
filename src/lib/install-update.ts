import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import type { ReleaseAsset } from '../api/updates';
import { Sha256 } from './sha256';

const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
const FLAG_ACTIVITY_NEW_TASK = 0x10000000;

// Bytes per file-read chunk while computing the post-download SHA-256. Larger
// chunks are faster but balloon the JS string buffer (base64 reads on this
// platform). 256 KiB keeps memory bounded while still amortising the bridge.
const HASH_CHUNK_BYTES = 256 * 1024;

export interface InstallProgress {
  phase: 'downloading' | 'verifying' | 'installing';
  /** 0-1 during download; undefined for installing phase */
  progress?: number;
  /** Bytes received during current download */
  bytesWritten?: number;
  /** Total bytes for the download (best-effort, may be 0 if server omits Content-Length) */
  totalBytes?: number;
}

export type InstallProgressListener = (p: InstallProgress) => void;

export interface InstallParams {
  asset: ReleaseAsset;
  /** Optional lower-case hex SHA-256. When present, mismatched downloads abort. */
  expectedSha256?: string | null;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = globalThis.atob ? globalThis.atob(b64) : atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hashFile(uri: string, totalBytes: number, onProgress?: InstallProgressListener): Promise<string> {
  const hasher = new Sha256();
  let offset = 0;
  while (offset < totalBytes || totalBytes === 0) {
    const length = Math.min(HASH_CHUNK_BYTES, totalBytes ? totalBytes - offset : HASH_CHUNK_BYTES);
    const chunkB64 = await FileSystemLegacy.readAsStringAsync(uri, {
      encoding: FileSystemLegacy.EncodingType.Base64,
      position: offset,
      length,
    });
    if (!chunkB64) break;
    const bytes = base64ToBytes(chunkB64);
    if (bytes.length === 0) break;
    hasher.update(bytes);
    offset += bytes.length;
    if (totalBytes > 0) {
      onProgress?.({ phase: 'verifying', progress: offset / totalBytes });
    }
    if (bytes.length < length) break;
  }
  return hasher.digestHex();
}

export async function downloadAndInstallApk(
  params: InstallParams | ReleaseAsset,
  onProgress?: InstallProgressListener,
): Promise<void> {
  // Backwards-compat: callers used to pass the asset directly. Promote to the
  // params shape so the verification path is opt-in by passing a checksum.
  const { asset, expectedSha256 }: InstallParams =
    'asset' in params ? params : { asset: params, expectedSha256: null };

  if (Platform.OS !== 'android') {
    throw new Error('APK install is only supported on Android');
  }

  const dest = new File(Paths.cache, asset.name);
  if (dest.exists) dest.delete();

  onProgress?.({ phase: 'downloading', progress: 0 });

  const download = FileSystemLegacy.createDownloadResumable(
    asset.browser_download_url,
    dest.uri,
    {},
    (state) => {
      const total = state.totalBytesExpectedToWrite ?? 0;
      const progress = total > 0 ? state.totalBytesWritten / total : undefined;
      onProgress?.({
        phase: 'downloading',
        progress,
        bytesWritten: state.totalBytesWritten,
        totalBytes: total,
      });
    },
  );

  const result = await download.downloadAsync();
  if (!result?.uri) {
    throw new Error('APK download failed');
  }

  // Size sanity check. GitHub's `assets[].size` is signed by their TLS cert,
  // so a byte-count mismatch is a strong signal the file was truncated /
  // tampered with in transport. Cheap to compute, fail-fast.
  const info = await FileSystemLegacy.getInfoAsync(result.uri);
  const actualSize = (info as { size?: number }).size ?? 0;
  if (asset.size > 0 && actualSize !== asset.size) {
    await tryDelete(result.uri);
    throw new Error(
      `APK size mismatch: expected ${asset.size} bytes, got ${actualSize}`,
    );
  }

  // SHA-256 verification when the release publishes one. Without it, we still
  // get Android's package-signer check at install time — which rejects an APK
  // signed with a different key — but that fails late (after the user sees a
  // confusing system dialog). Bailing here surfaces the problem cleanly.
  if (expectedSha256) {
    onProgress?.({ phase: 'verifying', progress: 0 });
    const actual = await hashFile(result.uri, actualSize || asset.size, onProgress);
    if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
      await tryDelete(result.uri);
      throw new Error(
        `APK checksum mismatch: expected ${expectedSha256}, got ${actual}`,
      );
    }
  }

  onProgress?.({ phase: 'installing' });

  const contentUri = await FileSystemLegacy.getContentUriAsync(result.uri);

  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    type: 'application/vnd.android.package-archive',
    flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
  });
}

async function tryDelete(uri: string): Promise<void> {
  try {
    await FileSystemLegacy.deleteAsync(uri, { idempotent: true });
  } catch {
    /* best effort */
  }
}

/**
 * Open the system "Install unknown apps" settings page for this app, so the
 * user can grant permission to install APKs from the package installer.
 * Useful as a fallback if the install intent never reaches the installer.
 */
export async function openInstallUnknownAppsSettings(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await IntentLauncher.startActivityAsync(
    'android.settings.MANAGE_UNKNOWN_APP_SOURCES',
    { data: 'package:com.anonymous.bulwarkmobile' },
  );
}
