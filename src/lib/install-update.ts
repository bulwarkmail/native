import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import type { ReleaseAsset } from '../api/updates';

const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
const FLAG_ACTIVITY_NEW_TASK = 0x10000000;

export async function downloadAndInstallApk(asset: ReleaseAsset): Promise<void> {
  if (Platform.OS !== 'android') {
    throw new Error('APK install is only supported on Android');
  }

  const dest = new File(Paths.cache, asset.name);
  if (dest.exists) dest.delete();
  const downloaded = await File.downloadFileAsync(asset.browser_download_url, dest);

  const contentUri = await FileSystemLegacy.getContentUriAsync(downloaded.uri);

  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    type: 'application/vnd.android.package-archive',
    flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
  });
}
