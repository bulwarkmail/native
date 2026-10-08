import { describe, it, expect } from 'vitest';
import type { Mailbox } from '../../api/types';
import { resolveFolderRef, virtualFolderTarget } from '../folder-ref';

const rights = {
  mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true,
  mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
};
function mb(id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
  return { id, name, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, myRights: rights, ...extra };
}

const own = [
  mb('a', 'Inbox', { role: 'inbox' }),
  mb('b', 'Sent', { role: 'sent' }),
  mb('c', 'Projects'),
  mb('d', '2026', { parentId: 'c' }),
  mb('inbox', 'Odd id'),
];
const shared = [
  mb('team:a', 'Inbox', { role: 'inbox', isShared: true, originalId: 'a', accountId: 'team' }),
  mb('team:x', 'Shared notes', { isShared: true, originalId: 'x', accountId: 'team' }),
];

describe('resolveFolderRef', () => {
  it('takes an exact id before an alias', () => {
    expect(resolveFolderRef('inbox', own)).toBe('inbox');
    expect(resolveFolderRef('c', own)).toBe('c');
  });

  it('resolves a role to the own folder over a shared copy', () => {
    const list = [...shared, ...own.filter((m) => m.id !== 'inbox')];
    expect(resolveFolderRef('inbox', list)).toBe('a');
    expect(resolveFolderRef('sent', list)).toBe('b');
  });

  it('falls back to a shared folder with the role when the account has none of its own', () => {
    expect(resolveFolderRef('inbox', shared)).toBe('team:a');
  });

  it('resolves a folder path over the own folders', () => {
    expect(resolveFolderRef('Projects', own)).toBe('c');
    expect(resolveFolderRef('Projects/2026', own)).toBe('d');
    expect(resolveFolderRef('Projects/2027', own)).toBeNull();
    expect(resolveFolderRef('2026', own)).toBeNull();
    // A shared folder is named by its namespaced id, never by its name.
    expect(resolveFolderRef('Shared notes', [...own, ...shared])).toBeNull();
  });

  it('names a shared folder by its namespaced id only', () => {
    const list = [...own, ...shared];
    expect(resolveFolderRef('team:x', list)).toBe('team:x');
    expect(resolveFolderRef('x', list)).toBeNull();
    expect(resolveFolderRef('team:a', list)).toBe('team:a');
  });

  it('is null for a folder this list does not have', () => {
    expect(resolveFolderRef('zzz', own)).toBeNull();
    expect(resolveFolderRef('junk', own)).toBeNull();
    expect(resolveFolderRef('', own)).toBeNull();
    expect(resolveFolderRef('a', [])).toBeNull();
  });
});

describe('virtualFolderTarget', () => {
  it('maps the webmail virtual aliases to native views', () => {
    expect(virtualFolderTarget('scheduled')).toEqual({ kind: 'scheduled' });
    expect(virtualFolderTarget('unified-inbox')).toEqual({ kind: 'unified', role: 'inbox' });
    expect(virtualFolderTarget('unified-junk')).toEqual({ kind: 'unified', role: 'junk' });
    expect(virtualFolderTarget('cross-unread')).toEqual({ kind: 'unified', view: 'unread' });
    expect(virtualFolderTarget('cross-starred')).toEqual({ kind: 'unified', view: 'starred' });
    expect(virtualFolderTarget('cross-all')).toEqual({ kind: 'unified', view: 'all' });
  });

  it('is null for anything else', () => {
    expect(virtualFolderTarget('inbox')).toBeNull();
    expect(virtualFolderTarget('unified-foo')).toBeNull();
    expect(virtualFolderTarget('constructor')).toBeNull();
  });
});
