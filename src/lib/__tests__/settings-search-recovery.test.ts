import { describe, expect, it } from 'vitest';
import { getDictionary, translate } from '../../i18n';
import { buildSettingsSearchIndex, normalizeSettingsQuery, tabMatchesQuery } from '../settings-search';

// Settings search finds the two Stalwart 1.0 pages (webmail lib/settings-search
// `sharing` and `recovery`) by the words people use for them.

const en = getDictionary('en');
const tEn = (key: string) => translate('en', key);
const index = buildSettingsSearchIndex(en, tEn);
const finds = (tab: 'sharing' | 'recovery', label: string, q: string) => tabMatchesQuery(index, tab, label, normalizeSettingsQuery(q));

describe('settings search for Delegates and Recover deleted items', () => {
  it('finds Delegates under Sharing', () => {
    expect(finds('sharing', 'Sharing', 'delegate')).toBe(true);
    expect(finds('sharing', 'Sharing', 'Delegates')).toBe(true);
    expect(finds('sharing', 'Sharing', 'undelete')).toBe(false);
  });

  it('finds Recover deleted items', () => {
    expect(finds('recovery', 'Recover deleted items', 'undelete')).toBe(true);
    expect(finds('recovery', 'Recover deleted items', 'emptied')).toBe(true);
    expect(finds('recovery', 'Recover deleted items', 'colleague')).toBe(false);
  });
});
