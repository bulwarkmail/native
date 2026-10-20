// Single source of truth for "this feature only exists on some platforms", so
// the UI, the stores and the native bridges all agree on what is reachable.

import { NativeModules, Platform } from 'react-native';

/**
 * Where this Android build is distributed: the product flavor in
 * android/app/build.gradle, read from the BulwarkBuild native module. A build
 * without the module (older native code) is the sideloaded GitHub APK.
 */
export const androidDistribution: 'github' | 'play' =
  Platform.OS === 'android' && NativeModules.BulwarkBuild?.distribution === 'play' ? 'play' : 'github';

/**
 * In-app sideload updates: download the release APK from GitHub and hand it to
 * the system package installer (see `lib/install-update`).
 *
 * Only the GitHub build on Android. App Store Review guideline 2.5.2 forbids an
 * iOS app from downloading and installing executable code, and Google Play
 * forbids an app updating itself outside Play; the Play build also lacks the
 * installer permission. iOS builds are updated through TestFlight or the App
 * Store, the Play build through Play. The whole updater surface (banner,
 * settings pane, launch-time check) is hidden when this is false.
 */
export const supportsSideloadUpdates = Platform.OS === 'android' && androidDistribution === 'github';

/**
 * Device sync: address books and calendars in Android's Contacts and Calendar
 * providers, under an account of the app's own type (#34,
 * docs/device-sync.md).
 *
 * Android only: iOS has no third-party sync-provider API for either. The UI
 * also needs the native module (`isDeviceSyncAvailable()` in
 * `device-sync/native`), so a build without it hides the feature instead of
 * failing.
 */
export const supportsDeviceSync = Platform.OS === 'android';
