import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false, allowRTL: () => {}, forceRTL: () => {} },
}));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US', languageCode: 'en' }] }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => JSON.stringify({ override: 'de' })),
    setItem: vi.fn(async () => undefined),
  },
}));

import { useLocaleStore } from '../locale-store';

describe('locale store', () => {
  it('hands out a new t once the saved language loads, so screens re-render in it', async () => {
    const before = useLocaleStore.getState().t;
    expect(before('sidebar.settings', 'Settings')).toBe('Settings');

    await useLocaleStore.getState().hydrate();

    const after = useLocaleStore.getState().t;
    expect(after).not.toBe(before);
    expect(after('sidebar.settings', 'Settings')).toBe('Einstellungen');
  });
});
