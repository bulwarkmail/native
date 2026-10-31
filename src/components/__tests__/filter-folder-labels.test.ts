// The filter rule's "Move to folder" picker listed the server's folder names
// ("Sent Items", "Junk Mail", "Deleted Items") where the rest of the app
// shows the localized role names (localizeMailboxName).
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('expo-localization', () => ({ getLocales: () => [] }));

import { translate } from '../../i18n';
import { buildMailboxTargets } from '../../lib/sieve/rule-actions';
import { folderOptionLabel, mailboxesByTargetId } from '../filters/folder-option-label';
import type { Mailbox } from '../../api/types';

const mb = (id: string, name: string, role: string | null, parentId: string | null = null): Mailbox => ({
  id, name, role, parentId, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
  myRights: {} as Mailbox['myRights'], isSubscribed: true,
} as unknown as Mailbox);

const mailboxes = [
  mb('i', 'Inbox', 'inbox'),
  mb('s', 'Sent Items', 'sent'),
  mb('j', 'Junk Mail', 'junk'),
  mb('d', 'Deleted Items', 'trash'),
  mb('p', 'Projects', null),
  mb('a', 'Alpha', null, 'p'),
];

function labels(locale: 'en' | 'de') {
  const t = (key: string, fallback?: string) => translate(locale, key, fallback);
  const byId = mailboxesByTargetId(mailboxes);
  return Object.fromEntries(buildMailboxTargets(mailboxes).map((target) => [target.id, folderOptionLabel(target, byId.get(target.id), t)]));
}

describe('filter rule folder picker labels', () => {
  it('names system folders by role, like the sidebar', () => {
    const en = labels('en');
    expect(en.s).toBe(translate('en', 'sidebar.mailboxes.sent'));
    expect(en.j).toBe(translate('en', 'sidebar.mailboxes.spam'));
    expect(en.d).toBe(translate('en', 'sidebar.mailboxes.trash'));
    expect(en.s).not.toBe('Sent Items');
    expect(labels('de').d).toBe(translate('de', 'sidebar.mailboxes.trash'));
  });

  it('keeps user folders and their indent', () => {
    const en = labels('en');
    expect(en.p).toBe('Projects');
    expect(en.a).toBe('   Alpha');
  });

  it('is what the rule editor lists', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../filters/FilterRuleModal.tsx'), 'utf8');
    expect(source).toContain('label: folderOptionLabel(target, mailboxById.get(target.id), t)');
  });
});
