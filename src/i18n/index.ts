// Minimal i18n: lookup keys like `settings.tabs.account` against a nested
// dictionary loaded from ../../locales/<lang>/common.json (vendored from the
// webmail via scripts/sync-locales.mjs), overlaid with RN-only keys from
// ../../locales/rn/<lang>.json. Picks language from the user override
// (locale-store) → device locale → English fallback. Messages support the
// ICU subset in ./format (arguments + plural).
import { I18nManager } from 'react-native';
import { getLocales } from 'expo-localization';
import { formatMessage, type MessageParams } from './format';

// English is the fallback for every lookup, so it is loaded eagerly. The other
// catalogs are loaded on first use; see CATALOG_LOADERS below.
import en from '../../locales/en/common.json';

// Keys the native app needs that the webmail catalog does not carry. English
// is complete; a key another language has not translated yet falls through
// to it via the en fallback in translate().
import rnEn from '../../locales/rn/en.json';

export type { MessageParams } from './format';

// Same order and labels as the webmail language switcher
// (components/ui/language-switcher.tsx).
export const SUPPORTED_LOCALES = [
  { code: 'ar', label: 'العربية' },
  { code: 'ca', label: 'Català' },
  { code: 'cs', label: 'Česky' },
  { code: 'sk', label: 'Slovenčina' },
  { code: 'da', label: 'Dansk' },
  { code: 'de', label: 'Deutsch' },
  { code: 'en', label: 'English' },
  { code: 'fa', label: 'فارسی' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'he', label: 'עברית' },
  { code: 'it', label: 'Italiano' },
  { code: 'hu', label: 'Magyar' },
  { code: 'lv', label: 'Latviešu' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'nb', label: 'Norsk bokmål' },
  { code: 'pl', label: 'Polski' },
  { code: 'pt', label: 'Português' },
  { code: 'ro', label: 'Română' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'ru', label: 'Русский' },
  { code: 'uk', label: 'Українська' },
  { code: 'ko', label: '한국어' },
  { code: 'ja', label: '日本語' },
  { code: 'mn', label: 'Монгол' },
  { code: 'zh', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文（台灣）' },
] as const;

export type LocaleCode = typeof SUPPORTED_LOCALES[number]['code'];

type Dictionary = Record<string, unknown>;

function deepMerge(base: Dictionary, overlay: Dictionary): Dictionary {
  const out: Dictionary = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    const existing = out[k];
    if (
      v && typeof v === 'object' && !Array.isArray(v)
      && existing && typeof existing === 'object' && !Array.isArray(existing)
    ) {
      out[k] = deepMerge(existing as Dictionary, v as Dictionary);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// A catalog is a few hundred KB of JSON. Metro only evaluates a module when it
// is first required, so keeping each require inside its loader means startup
// builds English plus the active language instead of all 27, and switching
// language loads the new catalog synchronously on the next t() call. The
// require paths must stay string literals for Metro to bundle them.
const CATALOG_LOADERS: Record<LocaleCode, () => Dictionary> = {
  ar: () => require('../../locales/ar/common.json'),
  ca: () => require('../../locales/ca/common.json'),
  cs: () => require('../../locales/cs/common.json'),
  da: () => require('../../locales/da/common.json'),
  de: () => require('../../locales/de/common.json'),
  en: () => en as Dictionary,
  es: () => require('../../locales/es/common.json'),
  fa: () => require('../../locales/fa/common.json'),
  fr: () => require('../../locales/fr/common.json'),
  he: () => require('../../locales/he/common.json'),
  hu: () => require('../../locales/hu/common.json'),
  it: () => require('../../locales/it/common.json'),
  ja: () => require('../../locales/ja/common.json'),
  ko: () => require('../../locales/ko/common.json'),
  lv: () => require('../../locales/lv/common.json'),
  mn: () => require('../../locales/mn/common.json'),
  nb: () => require('../../locales/nb/common.json'),
  nl: () => require('../../locales/nl/common.json'),
  pl: () => require('../../locales/pl/common.json'),
  pt: () => require('../../locales/pt/common.json'),
  ro: () => require('../../locales/ro/common.json'),
  ru: () => require('../../locales/ru/common.json'),
  sk: () => require('../../locales/sk/common.json'),
  tr: () => require('../../locales/tr/common.json'),
  uk: () => require('../../locales/uk/common.json'),
  zh: () => require('../../locales/zh/common.json'),
  'zh-TW': () => require('../../locales/zh-TW/common.json'),
};

// The RN-only overlays, loaded alongside their catalog.
const OVERLAY_LOADERS: Record<LocaleCode, () => Dictionary> = {
  ar: () => require('../../locales/rn/ar.json'),
  ca: () => require('../../locales/rn/ca.json'),
  cs: () => require('../../locales/rn/cs.json'),
  da: () => require('../../locales/rn/da.json'),
  de: () => require('../../locales/rn/de.json'),
  en: () => rnEn as Dictionary,
  es: () => require('../../locales/rn/es.json'),
  fa: () => require('../../locales/rn/fa.json'),
  fr: () => require('../../locales/rn/fr.json'),
  he: () => require('../../locales/rn/he.json'),
  hu: () => require('../../locales/rn/hu.json'),
  it: () => require('../../locales/rn/it.json'),
  ja: () => require('../../locales/rn/ja.json'),
  ko: () => require('../../locales/rn/ko.json'),
  lv: () => require('../../locales/rn/lv.json'),
  mn: () => require('../../locales/rn/mn.json'),
  nb: () => require('../../locales/rn/nb.json'),
  nl: () => require('../../locales/rn/nl.json'),
  pl: () => require('../../locales/rn/pl.json'),
  pt: () => require('../../locales/rn/pt.json'),
  ro: () => require('../../locales/rn/ro.json'),
  ru: () => require('../../locales/rn/ru.json'),
  sk: () => require('../../locales/rn/sk.json'),
  tr: () => require('../../locales/rn/tr.json'),
  uk: () => require('../../locales/rn/uk.json'),
  zh: () => require('../../locales/rn/zh.json'),
  'zh-TW': () => require('../../locales/rn/zh-TW.json'),
};

const dictionaries: Partial<Record<LocaleCode, Dictionary>> = {};

/** The merged catalog (vendored + RN overlay) for a locale, loaded on first use. */
export function getDictionary(locale: LocaleCode): Dictionary {
  let dict = dictionaries[locale];
  if (!dict) {
    dict = deepMerge(CATALOG_LOADERS[locale](), OVERLAY_LOADERS[locale]());
    dictionaries[locale] = dict;
  }
  return dict;
}

/** Which catalogs have been loaded so far (for tests). */
export function loadedLocales(): LocaleCode[] {
  return Object.keys(dictionaries) as LocaleCode[];
}

export function isSupportedLocale(code: string): code is LocaleCode {
  return (SUPPORTED_LOCALES as readonly { code: string }[]).some((l) => l.code === code);
}

// RTL locales: Arabic, Hebrew and Persian. Mirrors the webmail i18n/direction.ts.
const RTL_LOCALES: ReadonlySet<string> = new Set(['ar', 'he', 'fa']);

export function getLocaleDirection(locale: string): 'ltr' | 'rtl' {
  return RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
}

/**
 * Whether the running app is laid out right-to-left. Gesture code that maps
 * "swipe left/right" to actions should swap sides when this is true - RN
 * mirrors flexbox but not the physical direction of a pan.
 */
export function isLayoutRTL(): boolean {
  const manager = I18nManager as typeof I18nManager | undefined;
  return Boolean(manager?.isRTL);
}

/**
 * Map a device locale to a catalog. Traditional Chinese (any `zh-Hant-*`
 * tag, or Taiwan/Hong Kong/Macau regions) resolves to `zh-TW`; every other
 * language matches on the bare language code.
 */
export function resolveLocaleTag(input: {
  languageTag?: string | null;
  languageCode?: string | null;
  languageScriptCode?: string | null;
  regionCode?: string | null;
}): LocaleCode | null {
  const lang = input.languageCode?.toLowerCase() ?? input.languageTag?.split('-')[0]?.toLowerCase();
  if (!lang) return null;
  if (lang === 'zh') {
    const tag = (input.languageTag ?? '').toLowerCase();
    const script = input.languageScriptCode?.toLowerCase();
    const region = input.regionCode?.toUpperCase();
    const traditional =
      script === 'hant'
      || tag.includes('hant')
      || tag.endsWith('-tw') || tag.endsWith('-hk') || tag.endsWith('-mo')
      || region === 'TW' || region === 'HK' || region === 'MO';
    return traditional ? 'zh-TW' : 'zh';
  }
  // Norwegian devices report `no`/`nn` as often as `nb`.
  if (lang === 'no' || lang === 'nn') return 'nb';
  return isSupportedLocale(lang) ? lang : null;
}

export function detectDeviceLocale(): LocaleCode {
  for (const l of getLocales()) {
    const resolved = resolveLocaleTag(l);
    if (resolved) return resolved;
  }
  return 'en';
}

function lookup(dict: Dictionary, key: string): string | undefined {
  let current: unknown = dict;
  for (const part of key.split('.')) {
    if (current && typeof current === 'object' && part in (current as Dictionary)) {
      current = (current as Dictionary)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

export function translate(
  locale: LocaleCode,
  key: string,
  fallback?: string,
  params?: MessageParams,
): string {
  const message = lookup(getDictionary(locale), key)
    ?? lookup(getDictionary('en'), key)
    ?? fallback
    ?? key;
  return formatMessage(message, params, locale);
}
