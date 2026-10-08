import { describe, it, expect, vi } from 'vitest';

vi.mock('../../api/jmap-client', () => ({ jmapClient: { accountId: 'own', connectionGen: 3 } }));

import { mailboxShareScope } from '../mailbox-share';
import type { Mailbox } from '../../api/types';

const RIGHTS = {
  mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true,
  mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
};

function mailbox(over: Partial<Mailbox>): Mailbox {
  return {
    id: '5', name: 'Projects', totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: RIGHTS, ...over,
  };
}

describe('mailboxShareScope', () => {
  const at = { gen: 3, accountId: 'own' };

  it('shares an own folder by its id on the scope it was given', () => {
    expect(mailboxShareScope(mailbox({ id: '5', accountId: 'own', isShared: false }), at))
      .toEqual({ at, id: '5' });
  });

  it('shares a folder shared with the user on its owner account, by its raw id', () => {
    expect(mailboxShareScope(mailbox({ id: 'c:5', originalId: '5', accountId: 'c', isShared: true }), at))
      .toEqual({ at: { gen: 3, accountId: 'c' }, id: '5' });
  });

  it('splits the namespaced id when the raw id was not kept', () => {
    expect(mailboxShareScope(mailbox({ id: 'c:5', accountId: 'c', isShared: true }), at))
      .toEqual({ at: { gen: 3, accountId: 'c' }, id: '5' });
  });
});
