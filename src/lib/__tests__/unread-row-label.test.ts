import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('expo-localization', () => ({ getLocales: () => [] }));

import { translate } from '../../i18n';
import { unreadRowLabel } from '../unread-row-label';

const tEn = (key: string, fallback?: string, params?: Record<string, string | number>) => translate('en', key, fallback, params);

describe('unreadRowLabel', () => {
  it('says the unread count after the name', () => {
    expect(unreadRowLabel('All inboxes', 9, tEn)).toBe('All inboxes, 9 unread');
    expect(unreadRowLabel('All inboxes', 0, tEn)).toBe('All inboxes');
  });
});

describe('the sidebar Unified Inbox row', () => {
  // TalkBack read it as "All inboxes, /, 9": no label, so the row's texts
  // (the name and RowCounts' unread / total) one by one.
  it('is a button named by its label and unread count', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../components/SidebarDrawer.tsx'), 'utf8');
    const start = source.indexOf('{showUnified && (');
    const row = source.slice(start, source.indexOf('</Pressable>', start));
    expect(row).toContain("navigation.navigate('UnifiedInbox', { role: 'inbox' })");
    expect(row).toMatch(/accessibilityRole="button"/);
    expect(row).toMatch(/accessibilityLabel=\{unreadRowLabel\(unifiedInboxLabel, unifiedCounts\.inbox\.unread, t\)\}/);
  });
});
