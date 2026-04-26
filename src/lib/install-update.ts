import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { ReleaseAsset } from '../api/updates';

export async function downloadAndInstallApk(asset: ReleaseAsset): Promise<void> {
  if (Platform.OS !== 'android') {
    throw new Error('APK install is only supported on Android');
  }
  const dest = new File(Paths.cache, asset.name);
  if (dest.exists) dest.delete();
  const downloaded = await File.downloadFileAsync(asset.browser_download_url, dest);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  await Sharing.shareAsync(downloaded.uri, {
    mimeType: 'application/vnd.android.package-archive',
    dialogTitle: 'Install update',
    UTI: 'com.android.package-archive',
  });
}
