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
    setPendingMailFolder({ ref: 'inbox', appAccountId: 'A', fromMailboxId: null });
    expect(usePendingMailFolder.getState().consume()).toEqual({ ref: 'inbox', appAccountId: 'A', fromMailboxId: null });
    expect(usePendingMailFolder.getState().consume()).toBeNull();
  });
});

describe('planMailFolderOpen', () => {
  const view = { shownAccountId: 'A', mailboxes, synced: true, currentMailboxId: null as string | null };

  it('opens a folder by role, path or id in its own account', () => {
    expect(planMailFolderOpen({ ref: 'inbox', appAccountId: 'A', fromMailboxId: null }, view)).toEqual({ action: 'open', mailboxId: 'a' });
    expect(planMailFolderOpen({ ref: 'Projects', appAccountId: 'A', fromMailboxId: null }, view)).toEqual({ action: 'open', mailboxId: 'c' });
    expect(planMailFolderOpen({ ref: 'c', appAccountId: 'A', fromMailboxId: null }, view)).toEqual({ action: 'open', mailboxId: 'c' });
    expect(planMailFolderOpen({ ref: 'team:x', appAccountId: 'A', fromMailboxId: null }, view)).toEqual({ action: 'open', mailboxId: 'team:x' });
  });

  it('drops a target once the user opened another folder since the link', () => {
    const target = { ref: 'c', appAccountId: 'A', fromMailboxId: 'a' };
    expect(planMailFolderOpen(target, { ...view, currentMailboxId: 'team:x' })).toEqual({ action: 'drop' });
    expect(planMailFolderOpen(target, { ...view, currentMailboxId: 'a' })).toEqual({ action: 'open', mailboxId: 'c' });
  });

  it('lets the Inbox picked on a cold start stand in for no folder', () => {
    // Parked with nothing open: whatever the list opened meanwhile is not a choice.
    expect(planMailFolderOpen({ ref: 'c', appAccountId: 'A', fromMailboxId: null }, { ...view, currentMailboxId: 'a' }))
      .toEqual({ action: 'open', mailboxId: 'c' });
  });

  it('does nothing for a folder already open', () => {
    expect(planMailFolderOpen({ ref: 'Projects', appAccountId: 'A', fromMailboxId: 'c' }, { ...view, currentMailboxId: 'c' }))
      .toEqual({ action: 'already_open' });
  });

  it('drops a target parked for another account, even when its id exists here', () => {
    expect(planMailFolderOpen({ ref: 'c', appAccountId: 'B', fromMailboxId: null }, view)).toEqual({ action: 'drop' });
  });

  it('waits while the account or its folders are not shown yet', () => {
    expect(planMailFolderOpen({ ref: 'c', appAccountId: 'A', fromMailboxId: null }, { ...view, shownAccountId: null })).toEqual({ action: 'wait' });
    expect(planMailFolderOpen({ ref: 'c', appAccountId: 'A', fromMailboxId: null }, { ...view, mailboxes: [] })).toEqual({ action: 'wait' });
  });

  it('waits for the server folder list before calling a folder missing', () => {
    const cached = { ...view, synced: false };
    expect(planMailFolderOpen({ ref: 'zzz', appAccountId: 'A', fromMailboxId: null }, cached)).toEqual({ action: 'wait' });
    // A folder the cached list already has opens without waiting.
    expect(planMailFolderOpen({ ref: 'c', appAccountId: 'A', fromMailboxId: null }, cached)).toEqual({ action: 'open', mailboxId: 'c' });
  });

  it('says the folder is gone once the list is synced', () => {
    expect(planMailFolderOpen({ ref: 'zzz', appAccountId: 'A', fromMailboxId: null }, view))
      .toEqual({ action: 'not_found', toast: 'deep_link.folder_not_found' });
    expect(planMailFolderOpen({ ref: 'x', appAccountId: 'A', fromMailboxId: null }, view))
      .toEqual({ action: 'not_found', toast: 'deep_link.folder_not_found' });
  });
});
