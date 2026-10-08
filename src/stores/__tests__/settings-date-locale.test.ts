import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../api/identity', () => ({ getIdentities: vi.fn(async () => []) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSettingsStore, mergeWithDefaults, toExportShape, fromExportShape } from '../settings-store';

describe('dateLocale setting', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useSettingsStore.getState().resetToDefaults();
  });

  it('defaults to following the language', () => {
    expect(useSettingsStore.getState().dateLocale).toBe('auto');
  });

  it('keeps the four webmail values and drops anything else', () => {
    for (const v of ['auto', 'iso', 'en-GB', 'en-US'] as const) {
      expect(mergeWithDefaults({ dateLocale: v }).dateLocale).toBe(v);
    }
    for (const bad of ['de-DE', 'ISO', '', 3, null]) {
      expect(mergeWithDefaults({ dateLocale: bad as never }).dateLocale).toBe('auto');
    }
  });

  it('syncs under the webmail name', () => {
    useSettingsStore.setState({ dateLocale: 'en-GB' });
    expect(toExportShape(useSettingsStore.getState()).dateLocale).toBe('en-GB');
    expect(fromExportShape({ dateLocale: 'iso' }).dateLocale).toBe('iso');
  });

  it('keeps the time zone under its stored key and the webmail name', () => {
    useSettingsStore.setState({ calendarTimeZone: 'Asia/Tokyo' });
    expect(toExportShape(useSettingsStore.getState()).timeZone).toBe('Asia/Tokyo');
    expect(fromExportShape({ timeZone: 'Europe/Riga' }).calendarTimeZone).toBe('Europe/Riga');
  });
});
