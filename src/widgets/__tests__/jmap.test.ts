import { describe, expect, it } from 'vitest';
import type { Email, Mailbox } from '../../api/types';
import { folderCounts, rankPeople, toMailItem } from '../jmap';

function email(id: string, from: string, name: string, seen: boolean, receivedAt = '2026-09-28T08:00:00Z'): Email {
  return {
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords: seen ? { $seen: true } : {},
    receivedAt,
    from: [{ email: from, name }],
    subject: `Subject ${id}`,
    preview: '  line one\n  line two ',
    hasAttachment: false,
    size: 1,
  } as Email;
}

describe('toMailItem', () => {
  it('maps a list email to what the widgets draw', () => {
    const item = toMailItem(email('1', 'sofia.russo@example.com', 'Sofia Russo', false), 'acc', { threadSize: 2 });
    expect(item).toMatchObject({
      id: '1',
      accountId: 'acc',
      fromName: 'Sofia Russo',
      initials: 'SR',
      unread: true,
      threadSize: 2,
      preview: 'line one line two',
    });
    // Same hue as the webmail's Avatar for this name.
    expect(item.color).toBe('#6826d9');
  });
});

describe('rankPeople', () => {
  it('ranks senders by volume, skips the user and no-reply senders, and counts unread', () => {
    const people = rankPeople([
      email('1', 'ada@example.com', 'Ada', false),
      email('2', 'ada@example.com', 'Ada', true),
      email('3', 'bob@example.com', 'Bob', false),
      email('4', 'me@example.com', 'Me', false),
      email('5', 'noreply@shop.example', 'Shop', false),
    ], ['Me@example.com']);
    expect(people.map((p) => [p.email, p.unread])).toEqual([['ada@example.com', 1], ['bob@example.com', 1]]);
  });
});

describe('folderCounts', () => {
  it('orders the roles like the sidebar and finds junk by role or name', () => {
    const boxes = [
      { id: 'j', name: 'Spam', role: 'junk', unreadEmails: 3, totalEmails: 3 },
      { id: 'i', name: 'Inbox', role: 'inbox', unreadEmails: 10, totalEmails: 23 },
      { id: 'd', name: 'Drafts', role: 'drafts', unreadEmails: 0, totalEmails: 2 },
    ] as Mailbox[];
    expect(folderCounts(boxes).map((f) => [f.role, f.unread, f.total])).toEqual([
      ['inbox', 10, 23],
      ['drafts', 0, 2],
      ['junk', 3, 3],
    ]);
  });
});
