import { describe, it, expect, vi } from 'vitest';

vi.mock('expo-localization', () => ({ getLocales: () => [] }));

import { getLocaleDirection, resolveLocaleTag, translate } from '../index';

describe('resolveLocaleTag', () => {
  it('matches on the bare language code', () => {
    expect(resolveLocaleTag({ languageCode: 'de', languageTag: 'de-AT' })).toBe('de');
    expect(resolveLocaleTag({ languageCode: 'pt', languageTag: 'pt-BR' })).toBe('pt');
  });

  it('routes Traditional Chinese to zh-TW', () => {
    expect(resolveLocaleTag({ languageCode: 'zh', languageTag: 'zh-Hant-TW', languageScriptCode: 'Hant', regionCode: 'TW' })).toBe('zh-TW');
    expect(resolveLocaleTag({ languageCode: 'zh', languageTag: 'zh-TW' })).toBe('zh-TW');
    expect(resolveLocaleTag({ languageCode: 'zh', languageTag: 'zh-HK' })).toBe('zh-TW');
    expect(resolveLocaleTag({ languageCode: 'zh', languageTag: 'zh-Hans-CN', languageScriptCode: 'Hans', regionCode: 'CN' })).toBe('zh');
    expect(resolveLocaleTag({ languageCode: 'zh', languageTag: 'zh' })).toBe('zh');
  });

  it('maps Norwegian to nb, and Nynorsk to its own catalog', () => {
    expect(resolveLocaleTag({ languageCode: 'no', languageTag: 'no-NO' })).toBe('nb');
    expect(resolveLocaleTag({ languageCode: 'nb', languageTag: 'nb-NO' })).toBe('nb');
    expect(resolveLocaleTag({ languageCode: 'nn', languageTag: 'nn-NO' })).toBe('nn');
  });

  it('takes Greek, which the webmail has too', () => {
    expect(resolveLocaleTag({ languageCode: 'el', languageTag: 'el-GR' })).toBe('el');
  });

  it('takes Thai and Estonian, which the webmail has too', () => {
    expect(resolveLocaleTag({ languageCode: 'th', languageTag: 'th-TH' })).toBe('th');
    expect(resolveLocaleTag({ languageCode: 'et', languageTag: 'et-EE' })).toBe('et');
  });

  it('returns null for unsupported languages', () => {
    expect(resolveLocaleTag({ languageCode: 'xx', languageTag: 'xx-XX' })).toBeNull();
    expect(resolveLocaleTag({})).toBeNull();
  });
});

describe('getLocaleDirection', () => {
  it('flags Arabic, Hebrew and Persian as RTL', () => {
    expect(getLocaleDirection('ar')).toBe('rtl');
    expect(getLocaleDirection('he')).toBe('rtl');
    expect(getLocaleDirection('fa')).toBe('rtl');
    expect(getLocaleDirection('en')).toBe('ltr');
    expect(getLocaleDirection('de')).toBe('ltr');
  });
});

describe('translate', () => {
  it('reads Greek and Nynorsk from their own catalogs and overlays', () => {
    for (const code of ['el', 'nn'] as const) {
      expect(translate(code, 'settings.title')).not.toBe(translate('en', 'settings.title'));
      expect(translate(code, 'widgets.vacation.title')).not.toBe(translate('en', 'widgets.vacation.title'));
    }
    expect(translate('nn', 'settings.title')).not.toBe(translate('nb', 'settings.title'));
    expect(getLocaleDirection('el')).toBe('ltr');
  });

  it('reads Thai and Estonian from their own catalogs', () => {
    expect(translate('th', 'settings.title')).not.toBe(translate('en', 'settings.title'));
    expect(translate('et', 'settings.title')).not.toBe(translate('en', 'settings.title'));
  });

  it('falls back locale → en → fallback → key', () => {
    expect(translate('de', 'settings.title')).not.toBe('settings.title');
    expect(translate('de', 'nope.missing', 'Fallback')).toBe('Fallback');
    expect(translate('de', 'nope.missing')).toBe('nope.missing');
  });

  it('interpolates params and plurals from the catalog', () => {
    const one = translate('en', 'email_list.batch_actions.selected_messages', undefined, { count: 1 });
    const many = translate('en', 'email_list.batch_actions.selected_messages', undefined, { count: 3 });
    expect(one).toBe('1 email selected');
    expect(many).toBe('3 emails selected');
  });

  it('serves RN-only overlay keys in every locale', () => {
    const french = translate('fr', 'email_list.no_trash_folder');
    expect(french).not.toBe('email_list.no_trash_folder');
    expect(french).not.toBe('');
  });
});

describe('catalog loading', () => {
  it('builds only the catalogs that are used, on first use', async () => {
    vi.resetModules();
    const i18n = await import('../index');
    expect(i18n.loadedLocales()).toEqual([]);

    expect(i18n.translate('de', 'settings.title')).not.toBe('settings.title');
    expect(i18n.loadedLocales().sort()).toEqual(['de']);

    // A key German lacks falls through to English, which is built then.
    i18n.translate('de', 'nope.missing');
    expect(i18n.loadedLocales().sort()).toEqual(['de', 'en']);

    // Switching language loads the new catalog synchronously.
    const title = i18n.translate('ja', 'settings.title');
    expect(i18n.loadedLocales().sort()).toEqual(['de', 'en', 'ja']);
    expect(title).toBe((i18n.getDictionary('ja') as { settings: { title: string } }).settings.title);
  });
});
