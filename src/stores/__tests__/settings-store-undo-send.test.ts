import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { mergeWithDefaults, useSettingsStore } from '../settings-store';

// Undo send is on by default with 5 seconds, and 5 is a choice (webmail
// 1.21, stores/settings-store.ts). A webmail settings file with 5 fell back
// to Off.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('undo send default', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useSettingsStore.getState().resetToDefaults();
  });

  it('is on with 5 seconds', () => {
    expect(useSettingsStore.getState().sendDelaySeconds).toBe(5);
  });

  it('keeps 5 from a webmail settings file and Off when picked', () => {
    expect(mergeWithDefaults({ sendDelaySeconds: 5 }).sendDelaySeconds).toBe(5);
    expect(mergeWithDefaults({ sendDelaySeconds: 0 }).sendDelaySeconds).toBe(0);
    useSettingsStore.getState().updateSetting('sendDelaySeconds', 0);
    expect(useSettingsStore.getState().importSettings(JSON.stringify({ sendDelaySeconds: 5 }))).toBe(true);
    expect(useSettingsStore.getState().sendDelaySeconds).toBe(5);
  });

  it('offers 5 seconds under Settings > Composing', () => {
    const src = read('components/settings/ComposingSettings.tsx');
    expect(src).toMatch(/\{ seconds: 5 \}\), value: 5 \}/);
  });
});
