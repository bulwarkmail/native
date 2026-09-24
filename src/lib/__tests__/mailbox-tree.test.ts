import { describe, it, expect } from 'vitest';
import {
  buildMailboxTree,
  findArchiveMailbox,
  flattenVisible,
  mailboxAccountId,
  mailboxesForSiblingOf,
  mailboxesOfAccount,
  mailboxOfEmail,
  ownMailboxes,
  SHARED_ACCOUNT_NODE_PREFIX,
} from '../mailbox-tree';
import type { Mailbox } from '../../api/types';

const RIGHTS: Mailbox['myRights'] = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
};

function own(id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
  return {
    id,
    name,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: RIGHTS,
    accountId: 'acc-1',
    isShared: false,
    ...extra,
  };
}

function shared(
  accountId: string,
  accountName: string,
  rawId: string,
  name: string,
  extra: Partial<Mailbox> = {},
): Mailbox {
  return {
    ...own(`${accountId}:${rawId}`, name, extra),
    originalId: rawId,
    accountId,
    accountName,
    isShared: true,
  };
}

describe('buildMailboxTree with shared accounts', () => {
  it('keeps own folders at the root and groups each shared account under its own node', () => {
    const tree = buildMailboxTree([
      own('inbox', 'Inbox', { role: 'inbox' }),
      own('sent', 'Sent', { role: 'sent' }),
      shared('grp-1', 'Support', 'inbox', 'Inbox', { role: 'inbox', unreadEmails: 3 }),
      shared('grp-1', 'Support', 'arch', 'Archive', { role: 'archive', unreadEmails: 1 }),
    ]);

    expect(tree.map((n) => n.id)).toEqual([
      'inbox',
      'sent',
      `${SHARED_ACCOUNT_NODE_PREFIX}grp-1`,
    ]);

    const accountNode = tree[2];
    expect(accountNode.isAccountNode).toBe(true);
    expect(accountNode.name).toBe('Support');
    // The header rolls up its account's unread so a collapsed section still
    // signals waiting mail.
    expect(accountNode.unreadEmails).toBe(4);
    expect(accountNode.children.map((n) => n.id)).toEqual(['grp-1:inbox', 'grp-1:arch']);
    expect(accountNode.children.every((n) => n.depth === 1)).toBe(true);
  });

  it('nests a shared account\'s subfolders under their own parent, not the user\'s', () => {
    const tree = buildMailboxTree([
      own('inbox', 'Inbox', { role: 'inbox' }),
      shared('grp-1', 'Support', 'inbox', 'Inbox', { role: 'inbox' }),
      shared('grp-1', 'Support', 'sub', 'Escalations', { parentId: 'grp-1:inbox' }),
    ]);

    const accountNode = tree[1];
    expect(accountNode.children).toHaveLength(1);
    expect(accountNode.children[0].children.map((n) => n.name)).toEqual(['Escalations']);
    expect(accountNode.children[0].children[0].depth).toBe(2);
  });

  it('gives each shared account its own node', () => {
    const tree = buildMailboxTree([
      shared('grp-2', 'Sales', 'inbox', 'Inbox', { role: 'inbox' }),
      shared('grp-1', 'Support', 'inbox', 'Inbox', { role: 'inbox' }),
    ]);

    expect(tree.map((n) => n.name)).toEqual(['Sales', 'Support']);
  });

  it('hides a collapsed shared account\'s folders', () => {
    const tree = buildMailboxTree([
      own('inbox', 'Inbox', { role: 'inbox' }),
      shared('grp-1', 'Support', 'inbox', 'Inbox', { role: 'inbox' }),
    ]);

    const collapsed = flattenVisible(tree, new Set());
    expect(collapsed.map((n) => n.id)).toEqual(['inbox', `${SHARED_ACCOUNT_NODE_PREFIX}grp-1`]);

    const expanded = flattenVisible(tree, new Set([`${SHARED_ACCOUNT_NODE_PREFIX}grp-1`]));
    expect(expanded.map((n) => n.id)).toEqual([
      'inbox',
      `${SHARED_ACCOUNT_NODE_PREFIX}grp-1`,
      'grp-1:inbox',
    ]);
  });
});

describe('account scoping helpers', () => {
  const all = [
    own('inbox', 'Inbox', { role: 'inbox' }),
    own('trash', 'Trash', { role: 'trash' }),
    shared('grp-1', 'Support', 'inbox', 'Inbox', { role: 'inbox' }),
    shared('grp-1', 'Support', 'trash', 'Trash', { role: 'trash' }),
    shared('grp-2', 'Sales', 'inbox', 'Inbox', { role: 'inbox' }),
  ];

  it('ownMailboxes drops every shared folder', () => {
    expect(ownMailboxes(all).map((m) => m.id)).toEqual(['inbox', 'trash']);
  });

  it('scopes to the owning shared account when the current folder is shared', () => {
    expect(mailboxesForSiblingOf(all, 'grp-1:inbox').map((m) => m.id))
      .toEqual(['grp-1:inbox', 'grp-1:trash']);
  });

  it('scopes to the user\'s own folders for an own or unknown folder', () => {
    expect(mailboxesForSiblingOf(all, 'inbox').map((m) => m.id)).toEqual(['inbox', 'trash']);
    expect(mailboxesForSiblingOf(all, 'gone').map((m) => m.id)).toEqual(['inbox', 'trash']);
    expect(mailboxesForSiblingOf(all, null).map((m) => m.id)).toEqual(['inbox', 'trash']);
  });

  it('names a folder\'s account: the owner when shared, none for the user\'s own', () => {
    expect(mailboxAccountId(all, 'grp-1:inbox')).toBe('grp-1');
    expect(mailboxAccountId(all, 'inbox')).toBeUndefined();
    expect(mailboxAccountId(all, null)).toBeUndefined();
  });

  it('scopes to a message\'s account whatever folder is open (B3)', () => {
    expect(mailboxesOfAccount(all, undefined).map((m) => m.id)).toEqual(['inbox', 'trash']);
    expect(mailboxesOfAccount(all, 'grp-1').map((m) => m.id)).toEqual(['grp-1:inbox', 'grp-1:trash']);
    // An account whose folders are not loaded has none: nothing to guess from.
    expect(mailboxesOfAccount(all, 'grp-9')).toEqual([]);
  });

  it('finds the folder a message is filed in, preferring the one it was opened from', () => {
    const grp = mailboxesOfAccount(all, 'grp-1');
    // Raw ids: the team's "inbox" is not the user's own inbox.
    expect(mailboxOfEmail(grp, { inbox: true })?.id).toBe('grp-1:inbox');
    expect(mailboxOfEmail(grp, { inbox: true, trash: true }, 'grp-1:trash')?.id).toBe('grp-1:trash');
    expect(mailboxOfEmail(grp, { inbox: true }, 'inbox')?.id).toBe('grp-1:inbox');
    expect(mailboxOfEmail(grp, { elsewhere: true })).toBeUndefined();
    expect(mailboxOfEmail(grp, undefined)).toBeUndefined();
  });
});

describe('role-folder deduplication (#771)', () => {
  it('keeps user folders whose name merely contains a role folder name', () => {
    const tree = buildMailboxTree([
      own('inbox', 'Inbox', { role: 'inbox' }),
      own('sent', 'Sent', { role: 'sent' }),
      own('archive', 'Archive', { role: 'archive' }),
      own('old-inbox', 'Old Inbox'),
      own('arch-2025', '2025 Archive'),
      own('sent-acc', 'Sent to Accounting'),
      own('in', 'In'),
    ]);
    expect(tree.map((n) => n.id)).toEqual([
      'inbox', 'sent', 'archive', 'arch-2025', 'in', 'old-inbox', 'sent-acc',
    ]);
  });

  it('drops only an exact (trimmed, case-insensitive) duplicate of a role folder', () => {
    const tree = buildMailboxTree([
      own('sent', 'Sent', { role: 'sent' }),
      own('sent-dup', ' sent '),
      own('sent-mail', 'Sent Mail'),
    ]);
    expect(tree.map((n) => n.id)).toEqual(['sent', 'sent-mail']);
  });

  it('never drops a nested folder or a duplicate that has children', () => {
    const tree = buildMailboxTree([
      own('inbox', 'Inbox', { role: 'inbox' }),
      own('sent', 'Sent', { role: 'sent' }),
      own('proj', 'Projects'),
      own('proj-sent', 'Sent', { parentId: 'proj' }),
      own('inbox-dup', 'Inbox'),
      own('inbox-dup-child', 'Child', { parentId: 'inbox-dup' }),
    ]);
    expect(tree.map((n) => n.id)).toEqual(['inbox', 'sent', 'inbox-dup', 'proj']);
    expect(tree.find((n) => n.id === 'proj')?.children.map((n) => n.id)).toEqual(['proj-sent']);
  });
});

describe('findArchiveMailbox (#578)', () => {
  it('prefers the archive role over a folder named Archive', () => {
    const found = findArchiveMailbox([
      own('named', 'Archive'),
      own('role', 'Old mail', { role: 'archive' }),
    ]);
    expect(found?.id).toBe('role');
  });

  it('falls back to a role-less folder named exactly "Archive", any case', () => {
    expect(findArchiveMailbox([own('inbox', 'Inbox', { role: 'inbox' }), own('a', 'ARCHIVE')])?.id)
      .toBe('a');
  });

  it('does not treat "Archives" or folders merely containing "archive" as the Archive', () => {
    // The store's archive actions only file into a folder this resolver
    // returns; a looser match here offered an archive that did nothing.
    expect(findArchiveMailbox([
      own('plural', 'Archives'),
      own('past', 'Archived'),
      own('proj', 'Project archive 2019'),
    ])).toBeUndefined();
  });
});
