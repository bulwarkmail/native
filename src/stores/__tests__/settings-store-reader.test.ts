import { describe, it, expect, beforeEach } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSettingsStore } from '../settings-store';

// Defaults the reader pass changed. Kept apart from settings-store.test.ts so
// the agents working on settings in parallel don't edit the same test file.

describe('settings defaults (reader pass)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useSettingsStore.getState().resetToDefaults();
  });

  it('keeps sender favicons off until the user turns them on', () => {
    // The app fetches them from icons.duckduckgo.com itself, which tells a
    // third party every sender domain and the device's IP. The webmail
    // proxies them through its own server, so its default doesn't carry over.
    expect(useSettingsStore.getState().senderFavicons).toBe(false);
  });
});
