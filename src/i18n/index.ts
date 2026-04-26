// Minimal i18n: lookup keys like `settings.tabs.account` against a flat
// dictionary loaded from ./locales/<lang>/common.json. Picks language from
// the user override (locale-store) → device locale → English fallback.
import { getLocales } from 'expo-localization';
import en from '../../locales/en/common.json';
import de from '../../locales/de/common.json';
import cs from '../../locales/cs/common.json';
import es from '../../locales/es/common.json';
import fr from '../../locales/fr/common.json';
import it from '../../locales/it/common.json';
import ja from '../../locales/ja/common.json';
import ko from '../../locales/ko/common.json';
import lv from '../../locales/lv/common.json';
import nl from '../../locales/nl/common.json';
import pl from '../../locales/pl/common.json';
import pt from '../../locales/pt/common.json';
import ru from '../../locales/ru/common.json';
import uk from '../../locales/uk/common.json';
import zh from '../../locales/zh/common.json';

export const SUPPORTED_LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'cs', label: 'Čeština' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
  { code: 'uk', label: 'Українська' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'zh', label: '中文' },
  { code: 'lv', label: 'Latviešu' },
] as const;

export type LocaleCode = typeof SUPPORTED_LOCALES[number]['code'];

const dictionaries: Record<LocaleCode, Record<string, unknown>> = {
  en, cs, de, es, fr, it, nl, pl, pt, ru, uk, ja, ko, zh, lv,
};

export function detectDeviceLocale(): LocaleCode {
  const codes = SUPPORTED_LOCALES.map((l) => l.code) as readonly string[];
  for (const l of getLocales()) {
    const lang = l.languageCode?.toLowerCase();
    if (lang && codes.includes(lang)) return lang as LocaleCode;
  }
  return 'en';
}

function lookup(dict: Record<string, unknown>, key: string): string | undefined {
  let current: unknown = dict;
  for (const part of key.split('.')) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

export function translate(locale: LocaleCode, key: string, fallback?: string): string {
  return lookup(dictionaries[locale], key)
    ?? lookup(dictionaries.en, key)
    ?? fallback
    ?? key;
}
