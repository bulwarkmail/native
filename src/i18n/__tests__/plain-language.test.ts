// Plain language (Settings > Accessibility, webmail i18n/plain-language.ts and
// lib/__tests__/plain-language-strings.test.ts): simpler English and German
// strings laid over the catalog while the setting is on.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US', languageCode: 'en' }] }));
// The setup file's stub plus I18nManager, which the locale store uses.
vi.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 33, select: <T,>(spec: { default?: T; android?: T }) => spec.android ?? spec.default },
  NativeModules: {},
  NativeEventEmitter: class { addListener() { return { remove: () => undefined }; } removeAllListeners() {} },
  Linking: { openURL: async () => undefined },
  Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove: () => undefined }) },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  I18nManager: { isRTL: false, allowRTL: () => {}, forceRTL: () => {} },
}));

import { hasPlainLanguage, translate, SUPPORTED_LOCALES } from '../index';
import { followPlainLanguage, useLocaleStore } from '../../stores/locale-store';
import { mergeWithDefaults } from '../../stores/settings-store';

const LOCALES = join(__dirname, '..', '..', '..', 'locales');

type Tree = Record<string, unknown>;
function leaves(node: unknown, prefix = ''): Array<[string, unknown]> {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    return Object.entries(node as Tree).flatMap(([key, value]) => leaves(value, prefix ? `${prefix}.${key}` : key));
  }
  return [[prefix, node]];
}
const load = (locale: string, file: string): Tree => JSON.parse(readFileSync(join(LOCALES, locale, file), 'utf8'));

// Argument names a message uses: `{name}` and `{count, plural, …}`; the word
// in a plural branch (`one {item}`) is text.
function argumentsOf(message: string): string[] {
  const names = new Set<string>();
  for (const m of message.matchAll(/(?<!\b(?:zero|one|two|few|many|other)\s*|=\d+\s*)\{\s*(\w+)\s*[,}]/g)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

const plainLocales = readdirSync(LOCALES).filter((l) => existsSync(join(LOCALES, l, 'plain.json')));

describe('plain-language strings', () => {
  it('exist for English and German only, each with a loader', () => {
    expect(plainLocales.sort()).toEqual(['de', 'en']);
    expect(SUPPORTED_LOCALES.map((l) => l.code).filter(hasPlainLanguage).sort()).toEqual(['de', 'en']);
  });

  for (const locale of ['en', 'de']) {
    describe(locale, () => {
      const plain = leaves(load(locale, 'plain.json'));
      const common = new Map(leaves(load(locale, 'common.json')));

      it('has strings', () => {
        expect(plain.length).toBeGreaterThan(100);
      });

      it('only overrides keys that exist in common.json', () => {
        expect(plain.map(([key]) => key).filter((key) => !common.has(key))).toEqual([]);
      });

      it('only holds non-empty strings with the placeholders of the string they replace', () => {
        const bad = plain
          .filter(([key, value]) => typeof value !== 'string' || !value.trim()
            || JSON.stringify(argumentsOf(value)) !== JSON.stringify(argumentsOf(String(common.get(key)))))
          .map(([key]) => key);
        expect(bad).toEqual([]);
      });
    });
  }
});

describe('translate with plain language', () => {
  const key = 'login.error.invalid_credentials';

  it('uses the plain string where there is one', () => {
    expect(translate('en', key)).toBe('Invalid email or password. Please check your credentials and try again.');
    expect(translate('en', key, undefined, undefined, true)).toBe('The email address or password is wrong. Check both and try again.');
    const de = translate('de', key, undefined, undefined, true);
    expect(de).not.toBe(translate('de', key));
    expect(de).toBe((load('de', 'plain.json').login as Tree & { error: Tree }).error.invalid_credentials);
  });

  it('keeps the normal string where there is no plain one, and other languages as they are', () => {
    expect(translate('en', 'settings.tabs.account', undefined, undefined, true)).toBe(translate('en', 'settings.tabs.account'));
    expect(translate('fr', key, undefined, undefined, true)).toBe(translate('fr', key));
  });
});

describe('the locale store', () => {
  const key = 'login.error.invalid_credentials';

  it('hands out a new t that speaks plainly while the setting is on', () => {
    useLocaleStore.getState().setOverride('en');
    const normal = useLocaleStore.getState().t;
    useLocaleStore.getState().setPlainLanguage(true);
    const plain = useLocaleStore.getState().t;
    expect(plain).not.toBe(normal);
    expect(plain(key)).toBe('The email address or password is wrong. Check both and try again.');
    // Changing the language keeps the plain wording.
    useLocaleStore.getState().setOverride('de');
    expect(useLocaleStore.getState().t(key)).toBe(translate('de', key, undefined, undefined, true));
    useLocaleStore.getState().setPlainLanguage(false);
    useLocaleStore.getState().setOverride('en');
    expect(useLocaleStore.getState().t(key)).toBe(translate('en', key));
  });

  it('follows the settings store switch', () => {
    let state = { plainLanguage: false };
    const listeners: Array<(s: typeof state) => void> = [];
    followPlainLanguage({ getState: () => state, subscribe: (l) => listeners.push(l) });
    expect(useLocaleStore.getState().plainLanguage).toBe(false);
    state = { plainLanguage: true };
    listeners.forEach((l) => l(state));
    expect(useLocaleStore.getState().plainLanguage).toBe(true);
    state = { plainLanguage: false };
    listeners.forEach((l) => l(state));
    expect(useLocaleStore.getState().plainLanguage).toBe(false);
  });

  it('is off by default and kept when stored', () => {
    expect(mergeWithDefaults({}).plainLanguage).toBe(false);
    expect(mergeWithDefaults({ plainLanguage: true }).plainLanguage).toBe(true);
  });
});
