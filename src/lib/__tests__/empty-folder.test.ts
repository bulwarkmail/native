import { describe, it, expect } from 'vitest';
import { planEmptyFolder } from '../empty-folder';
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
