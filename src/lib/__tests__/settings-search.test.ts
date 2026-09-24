import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDictionary, translate } from '../../i18n';
import {
  type SettingsTabId,
  type SubResultKeys,
  SETTINGS_SEARCH_PATHS,
  buildSettingsSearchIndex,
  collectSubResultKeys,
  collectTabKeys,
  getByPath,
  normalizeSettingsQuery,
  subResultsForQuery,
  tabMatchesQuery,
} from '../settings-search';

const en = getDictionary('en');
const tEn = (key: string) => translate('en', key);

function labelsFor(tab: SettingsTabId): string[] {
  return (buildSettingsSearchIndex(en, tEn).subResults[tab] ?? []).map((r) => r.label);
}

describe('collectSubResultKeys', () => {
  it('emits label/description objects, *_label keys and foo/foo_desc pairs', () => {
    const list: SubResultKeys[] = [];
    collectSubResultKeys(
      {
        name_label: 'Name',
        free_scroll: 'Free scrolling',
        free_scroll_desc: 'Scroll continuously',
        hover_preview_off: 'Disabled',
        nested: { label: 'Theme', description: 'Pick one', dark: 'Dark' },
      },
      'x',
      list,
    );
    expect(list).toEqual([
      { label: 'x.name_label', description: undefined },
      { label: 'x.free_scroll', description: 'x.free_scroll_desc' },
      { label: 'x.nested.label', description: 'x.nested.description' },
    ]);
  });

  it('prefers the mobile label and description the native panes render', () => {
    const list: SubResultKeys[] = [];
    collectSubResultKeys(
      {
        swipe: { label: 'Swipe (mobile)', label_mobile: 'Swipe', description: 'Web', description_mobile: 'Phone' },
        show_avatars: 'Show avatars',
        show_avatars_description: 'Load logos',
        week_numbers: 'Week numbers',
        week_numbers_desc: 'Web',
        week_numbers_mobile_desc: 'Phone',
      },
      'x',
      list,
    );
    expect(list).toEqual([
      { label: 'x.show_avatars', description: 'x.show_avatars_description' },
      { label: 'x.week_numbers', description: 'x.week_numbers_mobile_desc' },
      { label: 'x.swipe.label_mobile', description: 'x.swipe.description_mobile' },
    ]);
  });
});

describe('settings search index (English catalog)', () => {
  it('every pane path resolves to a translation', () => {
    const missing = Object.values(SETTINGS_SEARCH_PATHS)
      .flat()
      .filter((path) => getByPath(en, path) === undefined);
    expect(missing).toEqual([]);
  });

  // Panes whose sub-result labels must be the keys the pane renders, so a
  // result never points at a setting the phone does not have. Panes that
  // still render literal English are left out.
  const PANE_FILES: Partial<Record<SettingsTabId, string>> = {
    account: 'AccountSettings.tsx',
    language: 'LanguageSettings.tsx',
    notifications: 'NotificationSettings.tsx',
    appearance: 'AppearanceSettings.tsx',
    layout: 'LayoutSettings.tsx',
    reading: 'ReadingSettings.tsx',
    composing: 'ComposingSettings.tsx',
    identities: 'IdentitySettings.tsx',
    vacation: 'VacationSettings.tsx',
    filters: 'FilterSettings.tsx',
    templates: 'TemplateSettings.tsx',
    folders: 'FolderSettings.tsx',
    keywords: 'KeywordSettings.tsx',
    downloads: 'DownloadsSettings.tsx',
    security: 'AccountSecuritySettings.tsx',
    calendar: 'CalendarSettings.tsx',
    files: 'FilesSettings.tsx',
    sidebar_apps: 'SidebarAppsSettings.tsx',
    about_data: 'AboutDataSettings.tsx',
    updates: 'UpdatesSettings.tsx',
  };

  for (const [tab, file] of Object.entries(PANE_FILES) as [SettingsTabId, string][]) {
    it(`${tab}: every result is a setting ${file} renders`, () => {
      const source = readFileSync(join(__dirname, '..', '..', 'components', 'settings', file), 'utf8');
      const notRendered = collectTabKeys(en, tab).subResults
        .map((r) => r.label)
        .filter((key) => !source.includes(`'${key}'`));
      expect(notRendered).toEqual([]);
    });
  }

  it('lists settings where the native app shows them', () => {
    expect(labelsFor('appearance')).toContain('Font Size');
    expect(labelsFor('layout')).toContain('Message list order');
    expect(labelsFor('notifications')).toContain('Parse email invitations');
    expect(labelsFor('calendar')).toContain('Show week numbers');
    expect(labelsFor('reading')).toContain('Clear search when switching folders');
    expect(labelsFor('notifications')).toContain('Unread count on app icon');
    // Webmail-only settings are not offered.
    expect(labelsFor('calendar')).not.toContain('Free scrolling');
    expect(labelsFor('notifications')).not.toContain('Notification sound');
  });
});

describe('buildSettingsSearchIndex', () => {
  it('translates labels through t() for the current locale', () => {
    const index = buildSettingsSearchIndex(en, (key) => translate('de', key));
    const fontSize = translate('de', 'settings.appearance.font_size.label');
    expect(index.subResults.appearance?.map((r) => r.label)).toContain(fontSize);
    expect(index.haystacks.appearance).toContain(fontSize.toLowerCase());
  });

  it('adds extra sub-results to the pane and its haystack', () => {
    const index = buildSettingsSearchIndex(en, tEn, {
      themes: [{ label: 'Nord', description: 'Arctic palette' }],
    });
    expect(index.subResults.themes).toEqual([{ label: 'Nord', description: 'Arctic palette' }]);
    expect(index.haystacks.themes).toContain('arctic');
  });

  it('drops duplicate labels within a pane', () => {
    const index = buildSettingsSearchIndex(en, () => 'Same');
    expect(index.subResults.appearance).toEqual([{ label: 'Same', description: 'Same' }]);
  });
});

describe('matching', () => {
  const index = buildSettingsSearchIndex(en, tEn);

  it('normalizes the query', () => {
    expect(normalizeSettingsQuery('  Font SIZE ')).toBe('font size');
  });

  it('matches a pane by name, rendered text or keyword', () => {
    expect(tabMatchesQuery(index, 'appearance', 'Appearance', '')).toBe(true);
    expect(tabMatchesQuery(index, 'appearance', 'Appearance', 'appear')).toBe(true);
    expect(tabMatchesQuery(index, 'appearance', 'Appearance', 'font size')).toBe(true);
    expect(tabMatchesQuery(index, 'filters', 'Filters & Rules', 'sieve')).toBe(true);
    expect(tabMatchesQuery(index, 'vacation', 'Vacation Responder', 'out of office')).toBe(true);
    expect(tabMatchesQuery(index, 'appearance', 'Appearance', 'sieve')).toBe(false);
  });

  it('returns the matching settings of a pane, by label or description', () => {
    expect(subResultsForQuery(index, 'appearance', 'font')).toEqual([
      { label: 'Font Size', description: 'Adjust text size for better readability' },
    ]);
    expect(subResultsForQuery(index, 'appearance', 'readability').map((r) => r.label)).toEqual(['Font Size']);
    expect(subResultsForQuery(index, 'appearance', '')).toEqual([]);
  });

  it('caps the settings listed under one pane', () => {
    expect(subResultsForQuery(index, 'reading', 'e')).toHaveLength(6);
    expect(subResultsForQuery(index, 'reading', 'e', 2)).toHaveLength(2);
  });
});
