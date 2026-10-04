import { describe, it, expect } from 'vitest';
import { defaultSearchScopeFor, exclusionFilter, trashAndJunkIds } from '../search-scope';
import type { Mailbox } from '../../api/types';

function mb(id: string, role: string | null, accountId: string, shared = false): Mailbox {
  return {
    id: shared ? `${accountId}:${id}` : id,
    ...(shared ? { originalId: id, isShared: true } : { isShared: false }),
    name: role ?? id,
    role,
    accountId,
    totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: {} as Mailbox['myRights'],
  };
}

const MAILBOXES: Mailbox[] = [
  mb('inbox', 'inbox', 'c'), mb('junk', 'junk', 'c'), mb('trash', 'trash', 'c'),
  mb('t-inbox', 'inbox', 'team', true), mb('t-trash', 'trash', 'team', true), mb('t-junk', 'junk', 'team', true),
];

describe('trashAndJunkIds', () => {
  it('returns the own account\'s Trash and Junk ids, Trash first', () => {
    expect(trashAndJunkIds(MAILBOXES, 'c')).toEqual(['trash', 'junk']);
  });

  it('returns a shared account\'s raw (unprefixed) ids', () => {
    expect(trashAndJunkIds(MAILBOXES, 'team')).toEqual(['t-trash', 't-junk']);
  });

  it('returns only the folders the account has', () => {
    expect(trashAndJunkIds(MAILBOXES.filter((m) => m.role !== 'junk'), 'c')).toEqual(['trash']);
    expect(trashAndJunkIds(MAILBOXES, 'other')).toEqual([]);
  });
});

describe('exclusionFilter', () => {
  it('leaves the ids out', () => {
    expect(exclusionFilter(['trash', 'junk'])).toEqual({ inMailboxOtherThan: ['trash', 'junk'] });
  });

  it('is null when there is nothing to leave out', () => {
    expect(exclusionFilter([])).toBeNull();
  });
});

describe('defaultSearchScopeFor', () => {
  it('searches Trash and Spam themselves', () => {
    expect(defaultSearchScopeFor(mb('trash', 'trash', 'c'))).toBe('current');
    expect(defaultSearchScopeFor(mb('junk', 'junk', 'c'))).toBe('current');
    expect(defaultSearchScopeFor(mb('t-trash', 'trash', 'team', true))).toBe('current');
  });

  it('searches all folders from any other folder, or none', () => {
    expect(defaultSearchScopeFor(mb('inbox', 'inbox', 'c'))).toBe('all');
    expect(defaultSearchScopeFor(mb('projects', null, 'c'))).toBe('all');
    expect(defaultSearchScopeFor(undefined)).toBe('all');
  });
});
