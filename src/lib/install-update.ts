import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import type { ReleaseAsset } from '../api/updates';

const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
const FLAG_ACTIVITY_NEW_TASK = 0x10000000;

export interface InstallProgress {
  phase: 'downloading' | 'installing';
  /** 0-1 during download; undefined for installing phase */
  progress?: number;
  /** Bytes received during current download */
  bytesWritten?: number;
  /** Total bytes for the download (best-effort, may be 0 if server omits Content-Length) */
  totalBytes?: number;
}

export type InstallProgressListener = (p: InstallProgress) => void;

export async function downloadAndInstallApk(
  asset: ReleaseAsset,
  onProgress?: InstallProgressListener,
): Promise<void> {
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

  onProgress?.({ phase: 'installing' });

  const contentUri = await FileSystemLegacy.getContentUriAsync(result.uri);

  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    type: 'application/vnd.android.package-archive',
    flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
  });
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
