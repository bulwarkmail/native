import { describe, it, expect, vi, beforeEach } from 'vitest';

const { emptyMailbox, moveMailboxContents } = vi.hoisted(() => ({
  emptyMailbox: vi.fn(async () => 0),
  moveMailboxContents: vi.fn(async () => ({ moved: 2, failed: 0 })),
}));
vi.mock('../../api/email', () => ({ emptyMailbox, moveMailboxContents }));

import { planEmptyFolder, runEmptyFolder } from '../empty-folder';
import { findTrashMailbox, findJunkMailbox } from '../mailbox-tree';
import type { Mailbox } from '../../api/types';

const rights = {} as Mailbox['myRights'];
const mb = (o: Partial<Mailbox> & { id: string }): Mailbox => ({
  name: o.id, totalEmails: 1, unreadEmails: 0, totalThreads: 1, unreadThreads: 0, myRights: rights, ...o,
});

const own = [
  mb({ id: 'inbox', role: 'inbox' }), mb({ id: 'trash', role: 'trash' }), mb({ id: 'junk', role: 'junk' }),
  mb({ id: 'work' }),
];
const shared = [
  mb({ id: 'g1:inbox', originalId: 'inbox', role: 'inbox', isShared: true, accountId: 'g1' }),
  mb({ id: 'g1:trash', originalId: 'trash', role: 'trash', isShared: true, accountId: 'g1' }),
  mb({ id: 'g1:docs', originalId: 'docs', isShared: true, accountId: 'g1' }),
];
const nogroupTrash = [
  mb({ id: 'g2:docs', originalId: 'docs', isShared: true, accountId: 'g2' }),
];

describe('planEmptyFolder', () => {
  it('moves an ordinary folder to the same account Trash', () => {
    const p = planEmptyFolder([...own, ...shared], own[3], 'trash');
    expect(p).toMatchObject({ kind: 'trash', markRead: false });
    expect(p.kind === 'trash' && p.trash.id).toBe('trash');
  });
  it('a shared folder goes to its own account Trash, never the user\'s', () => {
    const p = planEmptyFolder([...own, ...shared], shared[2], 'trash');
    expect(p.kind === 'trash' && p.trash.id).toBe('g1:trash');
  });
  it('a shared folder with no Trash of its own is refused, not sent to the user\'s Trash', () => {
    expect(planEmptyFolder([...own, ...nogroupTrash], nogroupTrash[0], 'trash').kind).toBe('no-trash');
  });
  it('destroys in Trash and Junk', () => {
    expect(planEmptyFolder(own, own[1], 'trash').kind).toBe('destroy');
    expect(planEmptyFolder(own, own[2], 'trash').kind).toBe('destroy');
    expect(planEmptyFolder(own, mb({ id: 's', role: 'spam' }), 'trash').kind).toBe('destroy');
  });
  it('never moves the Trash folder into itself, even when found by name', () => {
    const bin = mb({ id: 'x', name: 'Deleted Items' });
    expect(planEmptyFolder([bin, own[0]], bin, 'trash').kind).toBe('destroy');
  });
  it('destroys when the user chose permanent deletion', () => {
    expect(planEmptyFolder(own, own[3], 'permanent').kind).toBe('destroy');
  });
  it('marks read with the trash-and-read action', () => {
    expect(planEmptyFolder(own, own[3], 'trash-and-read')).toMatchObject({ kind: 'trash', markRead: true });
  });
});

describe('exact Trash and Junk names', () => {
  const inbox = mb({ id: 'inbox', role: 'inbox' });
  it.each(['Robin', 'Cabinet', 'Binance receipts', 'Combined', 'Undeleted'])('%s is not the Trash: emptied it moves to the real Trash, not destroyed', (name) => {
    const f = mb({ id: 'f', name });
    const p = planEmptyFolder([inbox, f], f, 'trash');
    expect(p.kind).toBe('no-trash');
    const withTrash = [inbox, f, mb({ id: 't', role: 'trash' })];
    expect(planEmptyFolder(withTrash, f, 'trash')).toMatchObject({ kind: 'trash' });
  });
  it.each(['Robin', 'Cabinet', 'Binance receipts', 'Combined', 'Undeleted'])('%s is never picked as the destination', (name) => {
    expect(findTrashMailbox([inbox, mb({ id: 'f', name })])).toBeUndefined();
    expect(findJunkMailbox([inbox, mb({ id: 'f', name: name + ' spam x' })])).toBeUndefined();
  });
  it('Deleted Items and Bin still resolve exactly', () => {
    expect(findTrashMailbox([inbox, mb({ id: 'd', name: ' Deleted Items ' })])?.id).toBe('d');
    expect(findTrashMailbox([inbox, mb({ id: 'b', name: 'Bin' })])?.id).toBe('b');
    expect(findJunkMailbox([inbox, mb({ id: 'j', name: 'Junk Email' })])?.id).toBe('j');
  });
  it('Junk is not matched by a substring', () => {
    expect(findJunkMailbox([inbox, mb({ id: 'x', name: 'Spamalot' }), mb({ id: 'y', name: 'Junkyard' })])).toBeUndefined();
  });
  it('a role-less Trash name is destroyed when emptied (it is the Trash)', () => {
    const bin = mb({ id: 'b', name: 'Bin' });
    expect(planEmptyFolder([inbox, bin], bin, 'trash').kind).toBe('destroy');
  });
});

describe('runEmptyFolder', () => {
  const at = { accountId: 'acc-1', gen: 1 } as never;
  beforeEach(() => { emptyMailbox.mockClear(); moveMailboxContents.mockClear(); });

  it('moves a shared folder in its own account to that account Trash', async () => {
    const plan = planEmptyFolder([...own, ...shared], shared[2], 'trash');
    await runEmptyFolder(plan, shared[2], at);
    expect(moveMailboxContents).toHaveBeenCalledWith('docs', 'trash', expect.objectContaining({ accountId: 'g1' }), false);
  });
  it('destroys with the original id in the shared account', async () => {
    await runEmptyFolder({ kind: 'destroy' }, shared[1], at);
    expect(emptyMailbox).toHaveBeenCalledWith('trash', expect.objectContaining({ accountId: 'g1' }));
  });
  it('throws on no-trash and on a partial failure', async () => {
    await expect(runEmptyFolder({ kind: 'no-trash' }, own[3], at)).rejects.toThrow();
    moveMailboxContents.mockResolvedValueOnce({ moved: 1, failed: 2 });
    await expect(runEmptyFolder({ kind: 'trash', trash: own[1], markRead: false }, own[3], at)).rejects.toThrow(/1 email moved.*2 emails/);
    expect(emptyMailbox).not.toHaveBeenCalled();
  });
  it('tells the user when the account changed mid-run', async () => {
    moveMailboxContents.mockResolvedValueOnce({ moved: 3, failed: 0, interrupted: true } as never);
    await expect(runEmptyFolder({ kind: 'trash', trash: own[1], markRead: false }, own[3], at)).rejects.toThrow(/partly/);
  });
});
