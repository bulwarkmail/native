import { describe, it, expect } from 'vitest';
import { shareNotificationKind, shareNotificationMessage } from '../share-notification-toast';
import type { ShareNotification } from '../../api/types';

const t = (key: string, fallback?: string, params?: Record<string, string | number>) =>
  (fallback ?? key).replace(/\{(\w+)\}/g, (_m, k) => String(params?.[k] ?? ''));

const n = (over: Partial<ShareNotification> = {}): ShareNotification => ({
  id: 'n1',
  created: '2026-10-01T00:00:00Z',
  changedBy: { name: 'Dana', email: 'dana@x.com', principalId: 'p1' },
  objectType: 'Calendar',
  objectAccountId: 'acc-9',
  objectId: 'cal-1',
  oldRights: { mayReadItems: true },
  newRights: { mayReadItems: true, mayWriteAll: true },
  name: 'Team',
  ...over,
});

describe('shareNotificationKind', () => {
  it('words a first grant as shared, a removal as revoked (warning), anything else as changed', () => {
    expect(shareNotificationKind(n({ oldRights: null }))).toBe('shared');
    expect(shareNotificationKind(n({ oldRights: {} }))).toBe('shared');
    expect(shareNotificationKind(n({ newRights: null }))).toBe('revoked');
    expect(shareNotificationKind(n({ newRights: {} }))).toBe('revoked');
    expect(shareNotificationKind(n())).toBe('changed');

    expect(shareNotificationMessage(n({ oldRights: null }), t as never)).toEqual({
      level: 'info', text: 'Dana shared the calendar "Team" with you',
    });
    expect(shareNotificationMessage(n({ newRights: null, objectType: 'Mailbox' }), t as never)).toEqual({
      level: 'warning', text: 'Dana removed your access to the folder "Team"',
    });
    expect(shareNotificationMessage(n({ objectType: 'AddressBook' }), t as never)).toEqual({
      level: 'info', text: 'Dana changed your access to the address book "Team"',
    });
    expect(shareNotificationMessage(n({ objectType: 'FileNode', oldRights: null }), t as never).text)
      .toBe('Dana shared the file folder "Team" with you');
  });

  it('names the sharer, falling back to email, then "Someone"', () => {
    const by = (name: string, email: string | null) => ({ name, email, principalId: null });
    expect(shareNotificationMessage(n({ changedBy: by('', 'dana@x.com') }), t as never).text)
      .toBe('dana@x.com changed your access to the calendar "Team"');
    expect(shareNotificationMessage(n({ changedBy: by('', null) }), t as never).text)
      .toBe('Someone changed your access to the calendar "Team"');
    expect(shareNotificationMessage(n({ changedBy: undefined as never }), t as never).text)
      .toBe('Someone changed your access to the calendar "Team"');
  });

  it('falls back to the object id and the raw type, and strips control characters from sender text', () => {
    expect(shareNotificationMessage(n({ name: '', objectType: 'Thing' }), t as never).text)
      .toBe('Dana changed your access to the Thing "cal-1"');
    expect(shareNotificationMessage(n({ changedBy: { name: 'Da\u202ena\u0007', email: null, principalId: null } }), t as never).text)
      .toBe('Dana changed your access to the calendar "Team"');
  });
});

describe('sender text stays on one line', () => {
  it.each([
    ['a line feed', 'Dana\nYour account will be suspended'],
    ['an Arabic letter mark', 'Dana\u061cYour account will be suspended'],
    ['a line separator', 'Dana\u2028Your account will be suspended'],
  ])('drops %s from the sharer name and the object name', (_what, value) => {
    const text = shareNotificationMessage(n({
      changedBy: { name: value, email: null, principalId: null },
      name: value,
    }), t as never).text;
    expect(text).not.toMatch(/[\n\r\u061c\u2028\u2029]/);
    expect(text).toContain('Dana');
    expect(text).toContain('Your account will be suspended');
  });
});
