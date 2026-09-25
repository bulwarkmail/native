import { describe, it, expect } from 'vitest';
import { buildFilter } from '../unified-inbox';
import type { Mailbox } from '../types';

function mailbox(id: string, role: string | null): Mailbox {
  return {
    id,
    name: role ?? id,
    role,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {} as Mailbox['myRights'],
  };
}

const MAILBOXES = [mailbox('in', 'inbox'), mailbox('sent', 'sent'), mailbox('projects', null), mailbox('bin', 'trash')];

describe('buildFilter (aggregated views)', () => {
  it('is just the folder without a query', () => {
    expect(buildFilter(MAILBOXES, { role: 'inbox' })).toEqual({ inMailbox: 'in' });
    expect(buildFilter(MAILBOXES, { role: 'archive' })).toBeNull();
  });

  // Stalwart 1.0 reads a value ending in `*` as one prefix over the whole
  // string, so a `*` after every word found nothing for two words (P1-7).
  it('sends a plain query as typed, next to the folder', () => {
    expect(buildFilter(MAILBOXES, { role: 'inbox', query: ' project budget ' })).toEqual({
      operator: 'AND',
      conditions: [{ inMailbox: 'in' }, { text: 'project budget' }],
    });
  });

  it('gives quoted phrases and word* conditions of their own in the same AND', () => {
    expect(buildFilter(MAILBOXES, { view: 'unread', query: '"annual report" budg*' })).toEqual({
      operator: 'AND',
      conditions: [
        { operator: 'OR', conditions: [{ inMailbox: 'in' }, { inMailbox: 'projects' }] },
        { notKeyword: '$seen' },
        { text: '"annual report"' },
        { text: 'budg*' },
      ],
    });
  });
});
