import { describe, it, expect } from 'vitest';
import type { Mailbox } from '../../api/types';
import { inboxBackTarget, listBackStep } from '../list-back';

function mailbox(id: string, role: string | null, isShared = false, accountId = isShared ? 'team' : undefined): Mailbox {
  return { id, name: id, role, isShared, accountId, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0 } as Mailbox;
}

describe('listBackStep', () => {
  it('ends selection mode first', () => {
    expect(listBackStep({ selecting: true, searching: true, outsideInbox: true })).toBe('clear-selection');
  });

  it('clears an open search instead of leaving the app', () => {
    expect(listBackStep({ selecting: false, searching: true, outsideInbox: true })).toBe('clear-search');
  });

  it('goes from another folder to the Inbox before leaving', () => {
    expect(listBackStep({ selecting: false, searching: false, outsideInbox: true })).toBe('open-inbox');
  });

  it('leaves only from a plain list', () => {
    expect(listBackStep({ selecting: false, searching: false })).toBe('leave');
    expect(listBackStep({ selecting: false, searching: false, outsideInbox: false })).toBe('leave');
  });
});

describe('inboxBackTarget', () => {
  const mailboxes = [
    mailbox('in', 'inbox'),
    mailbox('arch', 'archive'),
    mailbox('custom', null),
    mailbox('team:in', 'inbox', true),
    mailbox('team:docs', null, true),
  ];

  it('leads from another folder to the Inbox', () => {
    expect(inboxBackTarget(mailboxes, 'arch')).toBe('in');
    expect(inboxBackTarget(mailboxes, 'custom')).toBe('in');
  });

  it('leads from a shared account\'s folder to that account\'s Inbox', () => {
    expect(inboxBackTarget(mailboxes, 'team:docs')).toBe('team:in');
  });

  it('leads from a shared account\'s Inbox to the user\'s own', () => {
    expect(inboxBackTarget(mailboxes, 'team:in')).toBe('in');
  });

  it('leads from a shared account without an Inbox to the user\'s own', () => {
    const noInbox = [mailbox('in', 'inbox'), mailbox('team:docs', null, true)];
    expect(inboxBackTarget(noInbox, 'team:docs')).toBe('in');
  });

  it('stays inside the shared account that is open', () => {
    const two = [...mailboxes, mailbox('other:in', 'inbox', true, 'other')];
    expect(inboxBackTarget(two, 'team:docs')).toBe('team:in');
  });

  it('has nowhere to go from the Inbox', () => {
    expect(inboxBackTarget(mailboxes, 'in')).toBeNull();
  });

  it('has nowhere to go without an Inbox or an open folder', () => {
    expect(inboxBackTarget([mailbox('arch', 'archive')], 'arch')).toBeNull();
    expect(inboxBackTarget(mailboxes, null)).toBeNull();
    expect(inboxBackTarget([], null)).toBeNull();
  });
});
