import { describe, it, expect, vi, beforeEach } from 'vitest';

// The push filter needs the Junk folders. It used to send its own full
// Mailbox/get (and the shared accounts') on every sign-in and start, next to
// the mail store's identical load (PF7).

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    username: 'user@example.com',
    serverUrl: 'https://mail.example.com',
    accountId: 'jmap-primary',
    currentSession: { capabilities: {} },
  },
}));

vi.mock('../../api/email', () => ({
  getMailboxes: vi.fn(async () => [{ id: 'junk-own', role: 'junk', accountId: 'jmap-primary' }]),
  getSharedMailboxes: vi.fn(async () => []),
}));

import { getMailboxes, getSharedMailboxes } from '../../api/email';
import { EMPTY_NOTIFICATION_MUTES, type NotificationMutes } from '../notification-mutes';
import { buildEmailPushConfig } from '../push-notifications';
import { provideLoadedMailboxes } from '../mailbox-source';
import { generateAccountId } from '../account-utils';

const ACCOUNT_ID = generateAccountId('user@example.com', 'https://mail.example.com');

beforeEach(() => {
  vi.clearAllMocks();
  provideLoadedMailboxes(null);
});

describe('push filter folders', () => {
  it('takes the Junk folders from the mail store instead of fetching them', async () => {
    const provider = vi.fn(async () => [
      { id: 'junk', role: 'junk', accountId: 'jmap-primary' },
      { id: 'team:j', originalId: 'j', role: 'junk', accountId: 'team', isShared: true },
    ] as never);
    provideLoadedMailboxes(provider);

    const config = await buildEmailPushConfig();

    expect(provider).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(getMailboxes).not.toHaveBeenCalled();
    expect(getSharedMailboxes).not.toHaveBeenCalled();
    expect(config['jmap-primary'].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailboxOtherThan: ['junk'] }],
    });
    expect(config.team.filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailboxOtherThan: ['j'] }],
    });
  });

  it('fetches them itself when the store has none for this account', async () => {
    provideLoadedMailboxes(async () => null);

    const config = await buildEmailPushConfig();

    expect(getMailboxes).toHaveBeenCalledTimes(1);
    expect(config['jmap-primary'].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailboxOtherThan: ['junk-own'] }],
    });
  });
});

// Muted accounts and folders (#78) are left out by the server-side filter.
describe('push filter with muted folders and accounts (#78)', () => {
  const folders = [
    { id: 'inbox', role: 'inbox', accountId: 'jmap-primary' },
    { id: 'junk', role: 'junk', accountId: 'jmap-primary' },
    { id: 'renovate', accountId: 'jmap-primary' },
    { id: 'team:in', originalId: 'in', role: 'inbox', accountId: 'team', isShared: true },
    { id: 'team:j', originalId: 'j', role: 'junk', accountId: 'team', isShared: true },
  ];
  const mutes = (accounts: string[], mailboxes: Record<string, boolean> = {}): NotificationMutes => ({ accounts, mailboxes });
  const junkOnly = (ids: string[]) => ({ operator: 'AND', conditions: [{ notKeyword: '$junk' }, { inMailboxOtherThan: ids }] });

  beforeEach(() => {
    provideLoadedMailboxes(async () => folders as never);
  });

  it('changes nothing without mutes', async () => {
    const config = await buildEmailPushConfig(EMPTY_NOTIFICATION_MUTES);
    expect(config['jmap-primary'].filter).toEqual(junkOnly(['junk']));
    expect(config.team.filter).toEqual(junkOnly(['j']));
  });

  it('adds a muted folder to the excluded mailboxes next to Junk', async () => {
    const config = await buildEmailPushConfig(mutes([], { 'jmap-primary/renovate': true, 'jmap-primary/gone': true }));
    expect(config['jmap-primary'].filter).toEqual(junkOnly(['junk', 'renovate']));
    // Another account's folders are untouched.
    expect(config.team.filter).toEqual(junkOnly(['j']));
  });

  it('silences a muted account entirely', async () => {
    const config = await buildEmailPushConfig(mutes(['team']));
    expect(config.team.filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { hasKeyword: '$junk' }],
    });
    expect(config['jmap-primary'].filter).toEqual(junkOnly(['junk']));
  });

  it('lets a muted account notify for the folders unmuted again', async () => {
    const one = await buildEmailPushConfig(mutes(['jmap-primary'], { 'jmap-primary/renovate': false }));
    expect(one['jmap-primary'].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailbox: 'renovate' }],
    });

    const two = await buildEmailPushConfig(mutes(['jmap-primary'], {
      'jmap-primary/renovate': false,
      'jmap-primary/inbox': false,
      // Gone from the server: must not end up in the filter.
      'jmap-primary/deleted': false,
      // Unmuting Junk does not bring spam back.
      'jmap-primary/junk': false,
    }));
    expect(two['jmap-primary'].filter).toEqual({
      operator: 'AND',
      conditions: [
        { notKeyword: '$junk' },
        { operator: 'OR', conditions: [{ inMailbox: 'inbox' }, { inMailbox: 'renovate' }] },
      ],
    });
  });

  it('fails instead of dropping the mutes when the folders cannot be read', async () => {
    provideLoadedMailboxes(async () => null);
    vi.mocked(getMailboxes).mockRejectedValueOnce(new Error('JMAP down'));
    await expect(buildEmailPushConfig(mutes(['jmap-primary']))).rejects.toThrow(/JMAP down/);
  });
});
