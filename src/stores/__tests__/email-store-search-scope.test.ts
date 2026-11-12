import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// "Search in" (webmail #1485, e4338ac47): a typed search always spanned the
// folders; the setting lets it look in the open folder only.

vi.mock('../locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
  useLocaleStore: { getState: () => ({ locale: 'en', t: (_k: string, f?: string) => f ?? _k }) },
}));

import { effectiveFolderScope, searchSkipsTrashAndJunk } from '../email-store';
import { useSettingsStore } from '../settings-store';

describe('Search in', () => {
  it('spans the folders by default and looks in the open folder when set so', () => {
    expect(useSettingsStore.getState().searchDefaultScope).toBe('all');
    expect(effectiveFolderScope('invoice', {}, 'inbox')).toBe('all');
    expect(searchSkipsTrashAndJunk('invoice', {}, 'inbox')).toBe(true);

    useSettingsStore.setState({ searchDefaultScope: 'folder' });
    try {
      expect(effectiveFolderScope('invoice', {}, 'inbox')).toBe('current');
      expect(searchSkipsTrashAndJunk('invoice', {}, 'inbox')).toBe(false);
      // A folder picked in the filters still wins, and so does a tag view.
      expect(effectiveFolderScope('invoice', { folder: 'all' }, 'inbox')).toBe('all');
      expect(effectiveFolderScope('', { keyword: '$label:work' }, 'inbox')).toBe('all');
    } finally {
      useSettingsStore.setState({ searchDefaultScope: 'all' });
    }
  });

  it('is a choice in the reading settings, and the list follows it', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');
    expect(read('components/settings/ReadingSettings.tsx')).toMatch(/onChange=\{\(v\) => update\('searchDefaultScope', v === 'folder' \? 'folder' : 'all'\)\}/);
    expect(read('screens/EmailListScreen.tsx').match(/effectiveFolderScope\([^)]*, searchDefaultScope\)/g)).toHaveLength(2);
  });
});
