import { describe, it, expect } from 'vitest';
import { settingsSummary, type SummaryState } from '../settings-summary';
import { formatMessage, type MessageParams } from '../../i18n/format';

const t = (_key: string, fallback: string, params?: MessageParams) => formatMessage(fallback, params, 'en');

const BASE: SummaryState = {
  languageLabel: 'English',
  timeFormat: '24h',
  theme: 'dark',
  themeName: null,
  emailNotificationsEnabled: true,
  calendarNotificationsEnabled: false,
  calendarDefaultView: 'month',
  calendarFirstDayOfWeek: 1,
  offlineCacheEnabled: false,
  offlineCacheDays: 7,
  offlineCacheMaxMB: 50,
  appVersion: '0.1.76',
  update: 'current',
};

describe('settings list summaries', () => {
  it('shows the current values of a pane', () => {
    expect(settingsSummary('language', BASE, t)).toBe('English · 24-hour');
    expect(settingsSummary('language', { ...BASE, timeFormat: '12h' }, t)).toBe('English · 12-hour');
    expect(settingsSummary('appearance', BASE, t)).toBe('Dark · Bulwark');
    expect(settingsSummary('appearance', { ...BASE, theme: 'system', themeName: 'Nord' }, t)).toBe('System · Nord');
    expect(settingsSummary('notifications', BASE, t)).toBe('Mail on · events off');
    expect(settingsSummary('calendar', { ...BASE, calendarDefaultView: 'week', calendarFirstDayOfWeek: 0 }, t))
      .toBe('Week · week starts Sunday');
  });

  it('describes offline mail on Storage & backup', () => {
    expect(settingsSummary('about_data', BASE, t)).toBe('Offline mail off');
    expect(settingsSummary('about_data', { ...BASE, offlineCacheEnabled: true, offlineCacheDays: 1 }, t))
      .toBe('Offline mail on · 1 day, 50 MB');
    expect(settingsSummary('about_data', { ...BASE, offlineCacheEnabled: true, offlineCacheMaxMB: 250 }, t))
      .toBe('Offline mail on · 7 days, 250 MB');
  });

  it('puts the version and update state on About', () => {
    expect(settingsSummary('about', BASE, t)).toBe('Version 0.1.76 · Up to date');
    expect(settingsSummary('about', { ...BASE, update: 'available' }, t)).toBe('Version 0.1.76 · Update available');
    expect(settingsSummary('about', { ...BASE, update: 'security' }, t)).toBe('Version 0.1.76 · Security update available');
    expect(settingsSummary('about', { ...BASE, update: 'none' }, t)).toBe('Version 0.1.76');
  });

  it('falls back to a short description for panes without one value', () => {
    expect(settingsSummary('filters', BASE, t)).toBe('Rules for incoming mail');
    expect(settingsSummary('account', BASE, t)).toBeNull();
  });
});
