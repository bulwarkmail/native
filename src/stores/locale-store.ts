import { create } from 'zustand';
import { I18nManager } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  detectDeviceLocale,
  getLocaleDirection,
  isSupportedLocale,
  translate,
  type LocaleCode,
  type MessageParams,
} from '../i18n';

const STORAGE_KEY = 'webmail:locale:v1';

export type TranslateFn = (key: string, fallback?: string, params?: MessageParams) => string;

interface LocaleState {
  locale: LocaleCode;
  override: LocaleCode | null;
  hydrated: boolean;
  /**
   * True when the layout direction the current locale needs differs from
   * what the running app was laid out with. RN only applies forceRTL on the
   * next launch, so the language pane shows a "restart to apply" hint.
   */
  directionChangePending: boolean;
  /**
   * Plain language (Settings > Accessibility): simpler wording where the
   * language has it (English, German). Mirrors the settings store's
   * plainLanguage, which is where the user's choice is kept.
   */
  plainLanguage: boolean;
  hydrate: () => Promise<void>;
  setOverride: (locale: LocaleCode | null) => void;
  setPlainLanguage: (on: boolean) => void;
  t: TranslateFn;
}

/**
 * Ask RN to mirror layouts for RTL locales (ar/he/fa). The device locale is
 * handled by the OS (`android:supportsRtl`), but an in-app override needs an
 * explicit forceRTL, which only takes effect after a restart. Returns true
 * when the running layout does not match the requested direction yet.
 */
function applyLayoutDirection(locale: LocaleCode): boolean {
  const rtl = getLocaleDirection(locale) === 'rtl';
  const manager = I18nManager as typeof I18nManager | undefined;
  if (!manager || typeof manager.forceRTL !== 'function') return false;
  try {
    manager.allowRTL(rtl);
    manager.forceRTL(rtl);
  } catch {
    return false;
  }
  return manager.isRTL !== rtl;
}

// A new `t` per locale: most components select only `t`, and a function
// that never changed identity left them in the device language after the
// saved one loaded on a cold start (tab labels, the folder title).
function translatorFor(locale: LocaleCode, plain = false): TranslateFn {
  return (key, fallback, params) => translate(locale, key, fallback, params, plain);
}

export const useLocaleStore = create<LocaleState>((set, get) => ({
  locale: detectDeviceLocale(),
  override: null,
  hydrated: false,
  directionChangePending: false,
  plainLanguage: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const stored = raw ? (JSON.parse(raw).override as string | null) : null;
      const override = stored && isSupportedLocale(stored) ? stored : null;
      const locale = override ?? detectDeviceLocale();
      const directionChangePending = applyLayoutDirection(locale);
      set({ override, locale, hydrated: true, directionChangePending, t: translatorFor(locale, get().plainLanguage) });
    } catch {
      set({ hydrated: true });
    }
  },

  setOverride: (override) => {
    const locale = override ?? detectDeviceLocale();
    const directionChangePending = applyLayoutDirection(locale);
    set({ override, locale, directionChangePending, t: translatorFor(locale, get().plainLanguage) });
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ override })).catch(() => {});
  },

  // A new `t` here too, so every component that selects it re-renders.
  setPlainLanguage: (on) => {
    if (get().plainLanguage === on) return;
    set({ plainLanguage: on, t: translatorFor(get().locale, on) });
  },

  t: translatorFor(detectDeviceLocale()),
}));

interface PlainLanguageSource {
  getState: () => { plainLanguage?: boolean };
  subscribe: (listener: (state: { plainLanguage?: boolean }) => void) => unknown;
}

/** Keeps the wording in step with the settings store's Plain language switch. */
export function followPlainLanguage(settings: PlainLanguageSource): void {
  useLocaleStore.getState().setPlainLanguage(!!settings.getState().plainLanguage);
  settings.subscribe((state) => {
    useLocaleStore.getState().setPlainLanguage(!!state.plainLanguage);
  });
}

// Required, not imported: the settings store loads the API client, which
// tests of this store's users mock piecemeal; without it (a test) the
// wording stays normal.
try {
  followPlainLanguage((require('./settings-store') as typeof import('./settings-store')).useSettingsStore);
} catch {
  // No settings store: normal wording.
}

// Non-hook accessor for code outside React (background tasks, stores).
export function t(key: string, fallback?: string, params?: MessageParams): string {
  return useLocaleStore.getState().t(key, fallback, params);
}
