import { describe, it, expect } from 'vitest';

// A cold start renders the mail view persisted from the last session before
// the session is up, with the JMAP client (the real one here) signed out. On
// Stalwart 1.0 every member of a group sees its folders, so the persisted
// folders hold shared ones, and the sidebar spans them while it renders: the
// app crashed on every such start ("Not authenticated - call connect()
// first").

import type { Email, Mailbox } from '../../api/types';
import { jmapClient } from '../../api/jmap-client';
import {
  accountIdOfRow,
  listRowsOfAccount,
  spannedAccounts,
  useEmailStore,
  viewerParamsForRow,
} from '../email-store';

const folder = (over: Partial<Mailbox>): Mailbox => ({
  id: 'a', name: 'Inbox', role: 'inbox', totalEmails: 1, unreadEmails: 0, totalThreads: 1, unreadThreads: 0,
  myRights: {} as never, isShared: false, ...over,
} as Mailbox);

const own = folder({});
// The group "team" (JMAP account "c" on the test servers) and its Inbox.
const team = folder({ id: 'c:a', originalId: 'a', accountId: 'c', isShared: true });

describe('the persisted mail view before the session is up (Stalwart 1.0 group folders)', () => {
  it('lists the accounts a tag view spans, as the sidebar does while it renders', () => {
    expect(jmapClient.isConnected).toBe(false);
    expect(() => jmapClient.accountId).toThrow('Not authenticated');

    expect(spannedAccounts([own, team])).toEqual([undefined, 'c']);
  });

  it('tells the account of a row of a list spanning accounts, as the viewer does while it opens', () => {
    const row = { id: 'x1', threadId: 't1', jmapAccountId: 'c', receivedAt: '2026-09-20T10:00:00Z' } as Email;
    useEmailStore.setState({ mailboxes: [own, team], emails: [row] });

    expect(accountIdOfRow(row)).toBe('c');
    expect(listRowsOfAccount('c').map((e) => e.id)).toEqual(['x1']);
    expect(viewerParamsForRow(row)).toEqual({ jmapAccountId: 'c', emailIds: ['x1'] });
  });
});
