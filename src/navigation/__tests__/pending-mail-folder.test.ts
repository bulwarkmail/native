import { beforeEach, describe, it, expect } from 'vitest';
import type { Mailbox } from '../../api/types';
import { planMailFolderOpen, setPendingMailFolder, usePendingMailFolder } from '../pending-mail-folder';

const rights = {
  mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true,
  mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
};
function mb(id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
  return { id, name, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, myRights: rights, ...extra };
}
const mailboxes = [
  mb('a', 'Inbox', { role: 'inbox' }),
  mb('c', 'Projects'),
  mb('team:x', 'Notes', { isShared: true, originalId: 'x', accountId: 'team' }),
];

describe('pending mail folder', () => {
  beforeEach(() => usePendingMailFolder.setState({ target: null }));

  it('is consumed once', () => {
    setPendingMailFolder({ ref: 'inbox', appAccountId: 'A' });
    expect(usePendingMailFolder.getState().consume()).toEqual({ ref: 'inbox', appAccountId: 'A' });
    expect(usePendingMailFolder.getState().consume()).toBeNull();
  });
});

describe('planMailFolderOpen', () => {
  const view = { shownAccountId: 'A', mailboxes, synced: true };

  it('opens a folder by role, path or id in its own account', () => {
    expect(planMailFolderOpen({ ref: 'inbox', appAccountId: 'A' }, view)).toEqual({ action: 'open', mailboxId: 'a' });
    expect(planMailFolderOpen({ ref: 'Projects', appAccountId: 'A' }, view)).toEqual({ action: 'open', mailboxId: 'c' });
    expect(planMailFolderOpen({ ref: 'c', appAccountId: 'A' }, view)).toEqual({ action: 'open', mailboxId: 'c' });
    expect(planMailFolderOpen({ ref: 'team:x', appAccountId: 'A' }, view)).toEqual({ action: 'open', mailboxId: 'team:x' });
  });

  it('drops a target parked for another account, even when its id exists here', () => {
    expect(planMailFolderOpen({ ref: 'c', appAccountId: 'B' }, view)).toEqual({ action: 'drop' });
  });

  it('waits while the account or its folders are not shown yet', () => {
    expect(planMailFolderOpen({ ref: 'c', appAccountId: 'A' }, { ...view, shownAccountId: null })).toEqual({ action: 'wait' });
    expect(planMailFolderOpen({ ref: 'c', appAccountId: 'A' }, { ...view, mailboxes: [] })).toEqual({ action: 'wait' });
  });

  it('waits for the server folder list before calling a folder missing', () => {
    const cached = { ...view, synced: false };
    expect(planMailFolderOpen({ ref: 'zzz', appAccountId: 'A' }, cached)).toEqual({ action: 'wait' });
    // A folder the cached list already has opens without waiting.
    expect(planMailFolderOpen({ ref: 'c', appAccountId: 'A' }, cached)).toEqual({ action: 'open', mailboxId: 'c' });
  });

  it('says the folder is gone once the list is synced', () => {
    expect(planMailFolderOpen({ ref: 'zzz', appAccountId: 'A' }, view))
      .toEqual({ action: 'not_found', toast: 'deep_link.folder_not_found' });
    expect(planMailFolderOpen({ ref: 'x', appAccountId: 'A' }, view))
      .toEqual({ action: 'not_found', toast: 'deep_link.folder_not_found' });
  });
});
