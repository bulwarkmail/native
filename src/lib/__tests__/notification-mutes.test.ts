import { describe, expect, it } from 'vitest';
import {
  EMPTY_NOTIFICATION_MUTES,
  isMailboxMuted,
  mailboxOverridesForAccount,
  normalizeNotificationMutes,
  resetMailboxMutes,
  setAccountMuted,
  setMailboxMuted,
} from '../notification-mutes';

describe('notification mutes (#78)', () => {
  it('lets a folder follow its account until it has its own setting', () => {
    const accountMuted = setAccountMuted(EMPTY_NOTIFICATION_MUTES, 'a', true);
    expect(isMailboxMuted(accountMuted, 'a', 'reports')).toBe(true);
    expect(isMailboxMuted(accountMuted, 'b', 'reports')).toBe(false);

    const unmutedFolder = setMailboxMuted(accountMuted, 'a', 'inbox', false);
    expect(isMailboxMuted(unmutedFolder, 'a', 'inbox')).toBe(false);
    expect(isMailboxMuted(unmutedFolder, 'a', 'reports')).toBe(true);

    // The folder's own setting wins over the account in both directions.
    const accountBack = setAccountMuted(unmutedFolder, 'a', false);
    const mutedFolder = setMailboxMuted(accountBack, 'a', 'renovate', true);
    expect(isMailboxMuted(mutedFolder, 'a', 'renovate')).toBe(true);
    expect(isMailboxMuted(mutedFolder, 'a', 'reports')).toBe(false);
  });

  it('drops the folder setting when it is set back to what the account says', () => {
    const muted = setMailboxMuted(EMPTY_NOTIFICATION_MUTES, 'a', 'renovate', true);
    const unmuted = setMailboxMuted(muted, 'a', 'renovate', false);
    expect(unmuted.mailboxes).toEqual({});

    // So muting the account later reaches this folder too.
    expect(isMailboxMuted(setAccountMuted(unmuted, 'a', true), 'a', 'renovate')).toBe(true);
  });

  it('resets the folder settings of one account only', () => {
    let mutes = setMailboxMuted(EMPTY_NOTIFICATION_MUTES, 'a', 'x', true);
    mutes = setMailboxMuted(mutes, 'ab', 'y', true);
    mutes = resetMailboxMutes(mutes, 'a');
    expect(mailboxOverridesForAccount(mutes, 'a')).toEqual({ muted: [], unmuted: [] });
    // An account id that merely starts with "a" keeps its settings.
    expect(mailboxOverridesForAccount(mutes, 'ab')).toEqual({ muted: ['y'], unmuted: [] });
  });

  it('repairs malformed stored values', () => {
    expect(normalizeNotificationMutes(null)).toEqual(EMPTY_NOTIFICATION_MUTES);
    expect(normalizeNotificationMutes(['a'])).toEqual(EMPTY_NOTIFICATION_MUTES);
    expect(normalizeNotificationMutes({ accounts: ['a', 3, ''], mailboxes: { 'a/x': true, 'a/y': 'yes' } }))
      .toEqual({ accounts: ['a'], mailboxes: { 'a/x': true } });
  });
});
