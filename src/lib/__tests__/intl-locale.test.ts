import { describe, it, expect, vi, beforeEach } from 'vitest';

type DeviceLocale = { languageTag: string; languageCode: string; regionCode?: string };
const device = vi.hoisted(() => ({ locales: [] as DeviceLocale[] }));
vi.mock('expo-localization', () => ({
  getLocales: () => device.locales,
  getCalendars: () => [{ timeZone: 'UTC', firstWeekday: 1 }],
}));

import { intlLocale } from '../intl-locale';
import { registerDeviceLocales } from '../../i18n';
import { formatCalendarDate, formatListDate } from '../date-format';
import { formatHeaderDate } from '../email-date';

function setDevice(...tags: string[]) {
  device.locales = tags.map((t) => ({ languageTag: t, languageCode: t.split('-')[0] }));
  registerDeviceLocales();
}

describe('intlLocale', () => {
  beforeEach(() => setDevice());

  it('uses the device region for the app language (#75)', () => {
    setDevice('en-AU', 'en-US');
    expect(intlLocale('en')).toBe('en-AU');
    setDevice('de-CH');
    expect(intlLocale('de')).toBe('de-CH');
  });

  it('picks the first device locale in the app language', () => {
    setDevice('de-DE', 'en-GB');
    expect(intlLocale('en')).toBe('en-GB');
  });

  it('falls back to en-US and the bare subtag without a matching device locale', () => {
    setDevice('de-DE');
    expect(intlLocale('en')).toBe('en-US');
    expect(intlLocale(undefined)).toBe('en-US');
    expect(intlLocale('fr')).toBe('fr');
  });

  it('drops Android regional-preference extensions', () => {
    setDevice('en-AU-u-fw-mon-mu-celsius');
    expect(intlLocale('en')).toBe('en-AU');
  });

  it('keeps a locale that already names a region', () => {
    setDevice('zh-Hant-HK');
    expect(intlLocale('zh-TW')).toBe('zh-TW');
  });

  it('maps a Norwegian device to the nb catalog', () => {
    setDevice('no-NO');
    expect(intlLocale('nb')).toBe('no-NO');
  });
});

describe('date formatters with an en-AU device', () => {
  beforeEach(() => setDevice('en-AU', 'en-US'));

  it('writes the day first in the mail list', () => {
    const old = new Date(Date.now() - 400 * 86400000);
    const out = formatListDate(old, { dateFormat: 'smart', timeFormat: '24h', locale: 'en' });
    const expected = new Intl.DateTimeFormat('en-AU', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(old);
    expect(out).toBe(expected);
    expect(out).toMatch(new RegExp(`^${String(old.getDate()).padStart(2, '0')}/`));
  });

  it('writes the day before the month in calendar and header dates', () => {
    const d = new Date(2026, 9, 15, 12);
    expect(formatCalendarDate(d, 'en', 'weekdayMonthDay')).toMatch(/15 Oct/);
    expect(formatHeaderDate(d.toISOString(), 'en')).toMatch(/15 Oct/);
  });
});
