// Bridge to the native BulwarkWindow module: screen-content protection and the
// system bar icon colours. Android only; every call is a no-op elsewhere or
// when the module is missing from the build.
//
// The module also saves the protection flags, so MainActivity applies them on
// a cold start before the first frame, before the settings hydrate.

import { NativeModules, Platform } from 'react-native';

type Native = {
  setSecure(enabled: boolean): void;
  setRecentsHidden(enabled: boolean): void;
  setSystemBarsAppearance(lightBackground: boolean): void;
  getConstants?: () => { supportsRecentsHiding?: boolean };
  supportsRecentsHiding?: boolean;
};

function getNative(): Native | null {
  if (Platform.OS !== 'android') return null;
  return (NativeModules.BulwarkWindow as Native | undefined) ?? null;
}

/** Whether this build can protect the screen at all. */
export function supportsScreenPrivacy(): boolean {
  return getNative() != null;
}

/**
 * Whether the recent-apps preview can be hidden on its own, without blocking
 * screenshots. The platform call exists from Android 13 (API 33).
 */
export function supportsRecentsHiding(): boolean {
  const native = getNative();
  if (!native) return false;
  const constants = native.getConstants?.() ?? native;
  return constants.supportsRecentsHiding === true;
}

/** Block screenshots, recordings and the recents preview (FLAG_SECURE). */
export function setScreenshotsBlocked(enabled: boolean): void {
  getNative()?.setSecure(enabled);
}

/** Blank only the recent-apps preview. Does nothing below API 33. */
export function setHiddenInRecents(enabled: boolean): void {
  getNative()?.setRecentsHidden(enabled);
}

/** Dark status and navigation bar icons for a light app background. */
export function setSystemBarsLight(lightBackground: boolean): void {
  getNative()?.setSystemBarsAppearance(lightBackground);
}
