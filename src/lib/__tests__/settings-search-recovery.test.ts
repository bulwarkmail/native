import { describe, expect, it } from 'vitest';
import { getDictionary, translate } from '../../i18n';
import { buildSettingsSearchIndex, normalizeSettingsQuery, tabMatchesQuery } from '../settings-search';

// Settings search finds the Stalwart 1.0 pages (webmail lib/settings-search)
// by the words people use for them.

const en = getDictionary('en');
const tEn = (key: string) => translate('en', key);
const index = buildSettingsSearchIndex(en, tEn);
const finds = (tab: 'recovery', label: string, q: string) => tabMatchesQuery(index, tab, label, normalizeSettingsQuery(q));

describe('settings search for Recover deleted items', () => {
  it('finds Recover deleted items', () => {
    expect(finds('recovery', 'Recover deleted items', 'undelete')).toBe(true);
    expect(finds('recovery', 'Recover deleted items', 'emptied')).toBe(true);
    expect(finds('recovery', 'Recover deleted items', 'colleague')).toBe(false);
  });
});
