import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mailbox } from '../../api/types';
import { accountInboxUnread, inboxUnread } from '../account-inbox-unread';

// The account switcher shows each account's Inbox unread (webmail 2a726c0f4).

const inbox = (unread: number, extra: Partial<Mailbox> = {}): Mailbox =>
  ({ id: `inbox-${unread}`, name: 'Inbox', role: 'inbox', totalEmails: 10, unreadEmails: unread, ...extra }) as unknown as Mailbox;

describe('inboxUnread', () => {
  it("counts the account's own Inbox, not a shared one, and nothing before its folders load", () => {
    expect(inboxUnread([inbox(3, { isShared: true } as Partial<Mailbox>), inbox(5)])).toBe(5);
    expect(inboxUnread([])).toBeUndefined();
    expect(inboxUnread(undefined)).toBeUndefined();
  });

  it('reads the live folders for the account on screen and the cached ones for the others', () => {
    const snapshots = { b: { mailboxes: [inbox(7)] } };
    expect(accountInboxUnread('a', 'a', [inbox(2)], snapshots)).toBe(2);
    expect(accountInboxUnread('b', 'a', [inbox(2)], snapshots)).toBe(7);
    expect(accountInboxUnread('c', 'a', [inbox(2)], snapshots)).toBeUndefined();
  });

  it('is shown in each row of the account switcher', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'components', 'SidebarDrawer.tsx'), 'utf8');
    expect(source).toMatch(/const unread = accountInboxUnread\(acc\.id, shownAccountId, mailboxes, accountSnapshots\);/);
    expect(source).toMatch(/\{unread \? \(\r?\n\s*<Text\r?\n\s*style=\{styles\.countUnread\}/);
  });
});
