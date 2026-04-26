import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { detectDeviceLocale, translate, type LocaleCode } from '../i18n';

const STORAGE_KEY = 'webmail:locale:v1';

interface LocaleState {
  locale: LocaleCode;
  override: LocaleCode | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setOverride: (locale: LocaleCode | null) => void;
  t: (key: string, fallback?: string) => string;
}

export const useLocaleStore = create<LocaleState>((set, get) => ({
  locale: detectDeviceLocale(),
  override: null,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const override = raw ? (JSON.parse(raw).override as LocaleCode | null) : null;
      const locale = override ?? detectDeviceLocale();
      set({ override, locale, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  setOverride: (override) => {
    const locale = override ?? detectDeviceLocale();
    set({ override, locale });
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ override })).catch(() => {});
  },

  t: (key, fallback) => translate(get().locale, key, fallback),
}));
