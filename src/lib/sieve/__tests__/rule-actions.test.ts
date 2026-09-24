import { describe, it, expect } from 'vitest';
import type { Mailbox } from '../../../api/types';
import {
  buildMailboxTargets,
  mailboxIdFor,
  selectMailboxTarget,
  updateFilterAction,
  withMailboxTarget,
} from '../rule-actions';

const RIGHTS = {
  mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true,
  mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
};

function mailbox(id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
  return {
    id, name, parentId: null, role: null, sortOrder: 0,
    totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: RIGHTS, ...extra,
  };
}

const MAILBOXES = [
  mailbox('m1', 'Posteingang', { role: 'inbox' }),
  mailbox('m2', 'Finance'),
  mailbox('m3', 'Invoices 2026', { parentId: 'm2' }),
];
const targets = buildMailboxTargets(MAILBOXES);

describe('buildMailboxTargets', () => {
  it('lists folders with their JMAP id and Sieve path', () => {
    expect(targets.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: 'm1', path: 'INBOX' },
      { id: 'm2', path: 'Finance' },
      { id: 'm3', path: 'Finance/Invoices 2026' },
    ]);
  });

  it('uses the raw JMAP id of a shared account\'s folders', () => {
    const shared = buildMailboxTargets([
      mailbox('team:x1', 'Support', { originalId: 'x1', accountId: 'team' }),
    ]);
    expect(shared[0]).toMatchObject({ id: 'x1', path: 'Support' });
  });
});

describe('folder targets of move and copy actions', () => {
  it('resolves rules saved before folder ids were stored by their path', () => {
    expect(mailboxIdFor({ type: 'move', value: 'Finance/Invoices 2026' }, targets)).toBe('m3');
    expect(mailboxIdFor({ type: 'move', value: 'Gone' }, targets)).toBe('');
    expect(mailboxIdFor({ type: 'move', value: 'Finance', mailboxId: 'm9' }, targets)).toBe('m9');
  });

  it('stores the id on save and refreshes the path of a renamed folder', () => {
    expect(withMailboxTarget({ type: 'move', value: 'Finance' }, targets))
      .toEqual({ type: 'move', value: 'Finance', mailboxId: 'm2' });
    expect(withMailboxTarget({ type: 'copy', value: 'Old name', mailboxId: 'm3' }, targets))
      .toEqual({ type: 'copy', value: 'Finance/Invoices 2026', mailboxId: 'm3' });
  });

  it('keeps a target it cannot find as it is', () => {
    const unknown = { type: 'move' as const, value: 'Elsewhere', mailboxId: 'm99' };
    expect(withMailboxTarget(unknown, targets)).toEqual(unknown);
    expect(withMailboxTarget({ type: 'move', value: 'Nowhere' }, targets)).toEqual({ type: 'move', value: 'Nowhere' });
    expect(withMailboxTarget({ type: 'forward', value: 'a@b.c' }, targets)).toEqual({ type: 'forward', value: 'a@b.c' });
  });

  it('picks a folder by id and keeps the path in step', () => {
    const moved = selectMailboxTarget({ type: 'move', value: 'Finance', mailboxId: 'm2' }, 'm3', targets);
    expect(moved).toEqual({ type: 'move', value: 'Finance/Invoices 2026', mailboxId: 'm3' });
  });

  it('leaves an unlisted folder alone when it is picked again', () => {
    const unknown = { type: 'move' as const, value: 'Elsewhere', mailboxId: 'm99' };
    expect(selectMailboxTarget(unknown, 'm99', targets)).toBe(unknown);
  });
});

describe('updateFilterAction', () => {
  it('drops the folder id and the copy flag when the type changes', () => {
    expect(updateFilterAction({ type: 'move', value: 'Finance', mailboxId: 'm2' }, { type: 'star' }, targets))
      .toEqual({ type: 'star' });
    expect(updateFilterAction({ type: 'forward', value: 'a@b.c', keepCopy: true }, { type: 'reject' }, targets))
      .toEqual({ type: 'reject', value: 'a@b.c' });
  });

  it('keeps the folder when switching between move and copy', () => {
    expect(updateFilterAction({ type: 'move', value: 'Finance', mailboxId: 'm2' }, { type: 'copy' }, targets))
      .toEqual({ type: 'copy', value: 'Finance', mailboxId: 'm2' });
  });

  it('starts a new move on the first folder', () => {
    expect(updateFilterAction({ type: 'star' }, { type: 'move' }, targets))
      .toEqual({ type: 'move', value: 'INBOX', mailboxId: 'm1' });
  });

  it('drops the folder id when the path is typed by hand', () => {
    expect(updateFilterAction({ type: 'move', value: 'Finance', mailboxId: 'm2' }, { value: 'Typed', mailboxId: undefined }, []))
      .toEqual({ type: 'move', value: 'Typed' });
  });

  it('toggles keeping a copy of forwarded mail', () => {
    const on = updateFilterAction({ type: 'forward', value: 'a@b.c' }, { keepCopy: true }, targets);
    expect(on).toEqual({ type: 'forward', value: 'a@b.c', keepCopy: true });
    expect(updateFilterAction(on, { keepCopy: undefined }, targets)).toEqual({ type: 'forward', value: 'a@b.c' });
  });
});
