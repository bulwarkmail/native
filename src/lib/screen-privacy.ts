import { Platform } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';
import { useSettingsStore } from '../stores/settings-store';

// "Block screenshots" (Settings > Security, blockScreenshots). On Android
// preventScreenCaptureAsync sets FLAG_SECURE, which also leaves the recent-
// apps thumbnail blank. iOS blocks screenshots and recordings the same way
// but needs the blur overlay for the app switcher on top.
const CAPTURE_KEY = 'bulwark-block-screenshots';
const SWITCHER_BLUR = 1;

// Nothing is blocked when the app starts, so "off" needs no native call.
let applied = false;

export async function applyScreenPrivacy(block: boolean): Promise<void> {
  if (applied === block) return;
  applied = block;
  try {
    if (block) {
      await ScreenCapture.preventScreenCaptureAsync(CAPTURE_KEY);
      if (Platform.OS === 'ios') await ScreenCapture.enableAppSwitcherProtectionAsync(SWITCHER_BLUR);
    } else {
      await ScreenCapture.allowScreenCaptureAsync(CAPTURE_KEY);
      if (Platform.OS === 'ios') await ScreenCapture.disableAppSwitcherProtectionAsync();
    }
  } catch (err) {
    // Try again on the next change rather than believing the flag is set.
    applied = !block;
    console.warn('[screen-privacy] could not change screen capture', err);
  }
}

/** Follow the setting from launch on, including the value hydrate loads. */
export function startScreenPrivacySync(): () => void {
  void applyScreenPrivacy(useSettingsStore.getState().blockScreenshots);
  return useSettingsStore.subscribe((state, prev) => {
    if (state.blockScreenshots !== prev.blockScreenshots) void applyScreenPrivacy(state.blockScreenshots);
  });
}

/** For tests: forget what was applied. */
export function resetScreenPrivacyForTests(): void {
  applied = false;
}
