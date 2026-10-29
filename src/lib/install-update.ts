import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Crypto from 'expo-crypto';
import type { ReleaseAsset } from '../api/updates';
import { Sha256 } from './sha256';

const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
const FLAG_ACTIVITY_NEW_TASK = 0x10000000;

export interface InstallProgress {
  phase: 'downloading' | 'verifying' | 'installing';
  /** 0-1 during download; undefined while verifying and installing */
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

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256 of a downloaded file. The bytes are read and hashed natively:
 * hashing base64 chunks in JS took longer than the download itself and
 * looked like a second, slower download. The JS hasher stays as a fallback
 * for a build without expo-crypto's digest.
 */
export async function hashFile(uri: string): Promise<string> {
  const bytes = await new File(uri).bytes();
  try {
    return toHex(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes));
  } catch {
    const hasher = new Sha256();
    hasher.update(bytes);
    return hasher.digestHex();
  }
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
    onProgress?.({ phase: 'verifying' });
    const actual = await hashFile(result.uri);
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
