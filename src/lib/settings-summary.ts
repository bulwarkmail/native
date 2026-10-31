// The second line of each row in the Settings list: the current value where a
// pane has one worth showing ("Dark · Bulwark", "English · 24-hour"), and a
// short description of what's inside otherwise. Kept free of React so it can
// be unit-tested; SettingsScreen passes in the state.

import type { SettingsTabId } from './settings-search';
import type { MessageParams } from '../i18n/format';

type T = (key: string, fallback: string, params?: MessageParams) => string;

export interface SummaryState {
  languageLabel: string;
  timeFormat: '12h' | '24h';
  theme: 'light' | 'dark' | 'system';
  /** Display name of the active built-in theme, or null for the default. */
  themeName: string | null;
  emailNotificationsEnabled: boolean;
  calendarNotificationsEnabled: boolean;
  calendarDefaultView: 'month' | 'week' | 'day' | 'agenda';
  calendarFirstDayOfWeek: 0 | 1 | 6;
  offlineCacheEnabled: boolean;
  offlineCacheDays: number;
  offlineCacheMaxMB: number;
  appVersion: string;
  /** 'none' when no check has run yet. */
  update: 'none' | 'current' | 'available' | 'security';
}

const WEEKDAY: Record<0 | 1 | 6, [string, string]> = {
  0: ['calendar.days.sunday', 'Sunday'],
  1: ['calendar.days.monday', 'Monday'],
  6: ['calendar.days.saturday', 'Saturday'],
};

const STATIC: Partial<Record<SettingsTabId, [string, string]>> = {
  accessibility: ['settings.summary.accessibility', 'Text size, motion, confirmations'],
  layout: ['settings.summary.layout', 'Quick actions, swipes, list order'],
  reading: ['settings.summary.reading', 'Read status, delete, attachments'],
  composing: ['settings.summary.composing', 'Signature, send delay, drafts'],
  identities: ['settings.summary.identities', 'Addresses you send from'],
  vacation: ['settings.summary.vacation', 'Automatic reply while away'],
  filters: ['settings.summary.filters', 'Rules for incoming mail'],
  templates: ['settings.summary.templates', 'Reusable messages'],
  folders: ['settings.summary.folders', 'Create, rename, roles'],
  keywords: ['settings.summary.keywords', 'Tag names and colours'],
  downloads: ['settings.summary.downloads', 'File names for saved mail'],
  security: ['settings.summary.security', 'Password, two-factor, app passwords'],
  content_senders: ['settings.summary.content_senders', 'Remote images, trusted senders'],
  contacts: ['settings.summary.contacts', 'Address books, sorting'],
  files: ['settings.summary.files', 'View, sorting, thumbnails'],
  sidebar_apps: ['settings.summary.sidebar_apps', 'Web apps in the side menu'],
  updates: ['settings.summary.updates', 'Install new versions'],
};

export function settingsSummary(tab: SettingsTabId, s: SummaryState, t: T): string | null {
  switch (tab) {
    case 'language':
      return [
        s.languageLabel,
        t(`settings.language_region.time_format.${s.timeFormat}`, s.timeFormat === '12h' ? '12-hour' : '24-hour'),
      ].join(' · ');
    case 'notifications':
      return [
        s.emailNotificationsEnabled
          ? t('settings.summary.mail_on', 'Mail on')
          : t('settings.summary.mail_off', 'Mail off'),
        s.calendarNotificationsEnabled
          ? t('settings.summary.events_on', 'events on')
          : t('settings.summary.events_off', 'events off'),
      ].join(' · ');
    case 'appearance':
      return [
        t(`settings.appearance.theme.${s.theme}`, s.theme[0].toUpperCase() + s.theme.slice(1)),
        s.themeName ?? t('settings.themes.default_name', 'Bulwark'),
      ].join(' · ');
    case 'themes':
      return s.themeName ?? t('settings.themes.default_name', 'Bulwark');
    case 'calendar': {
      const [dayKey, dayFallback] = WEEKDAY[s.calendarFirstDayOfWeek] ?? WEEKDAY[1];
      const view = s.calendarDefaultView;
      return [
        t(`calendar.views.${view}`, view[0].toUpperCase() + view.slice(1)),
        t('settings.summary.week_starts', 'week starts {day}', { day: t(dayKey, dayFallback) }),
      ].join(' · ');
    }
    case 'about_data':
      return s.offlineCacheEnabled
        ? t('settings.summary.offline_on', 'Offline mail on · {days, plural, one {# day} other {# days}}, {mb} MB', {
          days: s.offlineCacheDays, mb: s.offlineCacheMaxMB,
        })
        : t('settings.summary.offline_off', 'Offline mail off');
    case 'about': {
      const version = t('settings.summary.version', 'Version {version}', { version: s.appVersion });
      if (s.update === 'current') return `${version} · ${t('settings.about.up_to_date', 'Up to date')}`;
      if (s.update === 'available') return `${version} · ${t('updates.available', 'Update available')}`;
      if (s.update === 'security') return `${version} · ${t('updates.banner.security_title', 'Security update available')}`;
      return version;
    }
    default: {
      const entry = STATIC[tab];
      return entry ? t(entry[0], entry[1]) : null;
    }
  }
}
