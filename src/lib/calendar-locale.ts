import type { Locale } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { useLocaleStore, type TranslateFn } from '../stores/locale-store';
import type { LocaleCode } from '../i18n';

// date-fns locale for each UI language so month/day names, "EEE, MMM d"
// headers and the like render in the user's language (the webmail localizes
// them through next-intl / useFormatEventDate).
//
// Each locale is required from its own module on first use: importing from
// the `date-fns/locale` barrel bundled and evaluated all ~100 date-fns
// locales at startup. The require paths must stay string literals for Metro
// to bundle them.
const DATE_FNS_LOCALE_LOADERS: Record<LocaleCode, () => Locale> = {
  en: () => enUS,
  ar: () => require('date-fns/locale/ar').ar,
  ca: () => require('date-fns/locale/ca').ca,
  cs: () => require('date-fns/locale/cs').cs,
  da: () => require('date-fns/locale/da').da,
  de: () => require('date-fns/locale/de').de,
  es: () => require('date-fns/locale/es').es,
  fa: () => require('date-fns/locale/fa-IR').faIR,
  fr: () => require('date-fns/locale/fr').fr,
  he: () => require('date-fns/locale/he').he,
  hu: () => require('date-fns/locale/hu').hu,
  it: () => require('date-fns/locale/it').it,
  ja: () => require('date-fns/locale/ja').ja,
  ko: () => require('date-fns/locale/ko').ko,
  lv: () => require('date-fns/locale/lv').lv,
  mn: () => require('date-fns/locale/mn').mn,
  nb: () => require('date-fns/locale/nb').nb,
  nl: () => require('date-fns/locale/nl').nl,
  pl: () => require('date-fns/locale/pl').pl,
  pt: () => require('date-fns/locale/pt').pt,
  ro: () => require('date-fns/locale/ro').ro,
  ru: () => require('date-fns/locale/ru').ru,
  sk: () => require('date-fns/locale/sk').sk,
  tr: () => require('date-fns/locale/tr').tr,
  uk: () => require('date-fns/locale/uk').uk,
  zh: () => require('date-fns/locale/zh-CN').zhCN,
  'zh-TW': () => require('date-fns/locale/zh-TW').zhTW,
};

const loaded = new Map<string, Locale>();

export function getDateFnsLocale(code: LocaleCode | string | null | undefined): Locale {
  if (!code || !Object.prototype.hasOwnProperty.call(DATE_FNS_LOCALE_LOADERS, code)) return enUS;
  let locale = loaded.get(code);
  if (!locale) {
    locale = DATE_FNS_LOCALE_LOADERS[code as LocaleCode]();
    loaded.set(code, locale);
  }
  return locale;
}

/** `{ locale }` options for date-fns `format()` plus the translate function. */
export function useCalendarLocale(): { locale: Locale; t: TranslateFn } {
  const code = useLocaleStore((s) => s.locale);
  const t = useLocaleStore((s) => s.t);
  return { locale: getDateFnsLocale(code), t };
}
