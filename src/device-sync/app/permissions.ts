/**
 * Runtime permissions device sync needs (docs/device-sync.md, "Settings
 * sections"): read and write access to contacts or calendars. Without them
 * Android fails every sync before our code runs, so the settings check them
 * themselves.
 */
import { Linking, PermissionsAndroid } from 'react-native';
import { CALENDAR_AUTHORITY, CONTACTS_AUTHORITY, type Authority } from '../types';

type Permission = Parameters<typeof PermissionsAndroid.check>[0];

export const SYNC_PERMISSIONS: Record<Authority, readonly Permission[]> = {
  [CONTACTS_AUTHORITY]: ['android.permission.READ_CONTACTS', 'android.permission.WRITE_CONTACTS'],
  [CALENDAR_AUTHORITY]: ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR'],
};

/**
 * `granted`: both permissions held. `denied`: the user said no; asking again
 * shows the dialog again. `blocked`: Android no longer asks ("don't ask
 * again", or denied twice), only the app's system settings can grant them.
 */
export type PermissionOutcome = 'granted' | 'denied' | 'blocked';

export async function hasSyncPermissions(authority: Authority): Promise<boolean> {
  try {
    const held = await Promise.all(SYNC_PERMISSIONS[authority].map((p) => PermissionsAndroid.check(p)));
    return held.every(Boolean);
  } catch {
    return false;
  }
}

export async function requestSyncPermissions(authority: Authority): Promise<PermissionOutcome> {
  if (await hasSyncPermissions(authority)) return 'granted';
  const wanted = SYNC_PERMISSIONS[authority];
  try {
    const results = (await PermissionsAndroid.requestMultiple([...wanted])) as Record<string, string | undefined>;
    const answers = wanted.map((p) => results[p]);
    if (answers.every((a) => a === 'granted')) return 'granted';
    if (answers.some((a) => a === 'never_ask_again')) return 'blocked';
    return 'denied';
  } catch {
    return 'denied';
  }
}

/** The app's page in Android's settings, where blocked permissions are granted. */
export async function openAppSystemSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch {
    // Nothing else to offer.
  }
}
