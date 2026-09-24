import { describe, it, expect } from 'vitest';
import { SUPPORTED_LOCALES } from '../../i18n';
import { getDateFnsLocale } from '../calendar-locale';

// date-fns names a few locales differently from the UI language codes.
const EXPECTED_CODE: Record<string, string> = {
  en: 'en-US',
  fa: 'fa-IR',
  zh: 'zh-CN',
  'zh-TW': 'zh-TW',
};

describe('getDateFnsLocale', () => {
  it('loads the matching date-fns locale for every UI language', () => {
    for (const { code } of SUPPORTED_LOCALES) {
      const locale = getDateFnsLocale(code);
      expect(locale.code, code).toBe(EXPECTED_CODE[code] ?? code);
      expect(typeof locale.localize?.month, code).toBe('function');
      // Loaded once, then served from the cache.
      expect(getDateFnsLocale(code)).toBe(locale);
    }
  });

  it('falls back to en-US for unknown or missing codes', () => {
    expect(getDateFnsLocale('xx').code).toBe('en-US');
    expect(getDateFnsLocale('toString').code).toBe('en-US');
    expect(getDateFnsLocale(null).code).toBe('en-US');
    expect(getDateFnsLocale(undefined).code).toBe('en-US');
  });
});
