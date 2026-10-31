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

  // Quick reply could not be turned off (webmail #1370). On by default like
  // the webmail, under the webmail's key so export and import carry it.
  it('keeps the quick reply on by default and lets it be turned off', async () => {
    expect(useSettingsStore.getState().quickReplyEnabled).toBe(true);
    const { mergeWithDefaults, toExportShape } = await import('../settings-store');
    expect(mergeWithDefaults({ quickReplyEnabled: false }).quickReplyEnabled).toBe(false);
    expect(toExportShape(useSettingsStore.getState())).toHaveProperty('quickReplyEnabled', true);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const screen = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailThreadScreen.tsx'), 'utf8');
    expect(screen).toMatch(/\{quickReplyEnabled && newest && newestLoaded && \(/);
  });
});
