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

describe('inbox-only push filter', () => {
  const mailboxes = [
    { id: 'inbox', role: 'inbox', accountId: 'jmap-primary' },
    { id: 'junk', role: 'junk', accountId: 'jmap-primary' },
    { id: 'team:t-inbox', originalId: 't-inbox', role: 'inbox', accountId: 'team', isShared: true },
    { id: 'team:t-junk', originalId: 't-junk', role: 'junk', accountId: 'team', isShared: true },
    { id: 'shared:only', originalId: 'only', role: null, accountId: 'shared', isShared: true },
  ] as never;

  beforeEach(() => {
    provideLoadedMailboxes(async () => mailboxes);
  });

  it('the default filter is unchanged', async () => {
    const expected = (junk: string) => ({
      filter: {
        operator: 'AND',
        conditions: [{ notKeyword: '$junk' }, { inMailboxOtherThan: [junk] }],
      },
      properties: expect.any(Array),
      urgency: 'high',
    });
    const before = await buildEmailPushConfig();
    expect(before['jmap-primary']).toEqual(expected('junk'));
    expect(before.team).toEqual(expected('t-junk'));
    // No Junk folder, no Inbox lookup: keyword-only, as today.
    expect(before.shared.filter).toEqual({ operator: 'AND', conditions: [{ notKeyword: '$junk' }] });
    // The argument defaults to false: passing it changes nothing.
    expect(await buildEmailPushConfig(false)).toEqual(before);
  });

  it('inbox only filters to the Inbox', async () => {
    const config = await buildEmailPushConfig(true);
    expect(config['jmap-primary'].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailbox: 'inbox' }],
    });
  });

  it('an account without an Inbox never matches', async () => {
    const config = await buildEmailPushConfig(true);
    expect(config.shared.filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { hasKeyword: '$junk' }],
    });
  });

  it('shared accounts use raw ids', async () => {
    const config = await buildEmailPushConfig(true);
    expect(config.team.filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailbox: 't-inbox' }],
    });
  });

  it('keeps each account on its own Inbox id', async () => {
    const config = await buildEmailPushConfig(true);
    expect(JSON.stringify(config['jmap-primary'])).not.toContain('t-inbox');
    expect(JSON.stringify(config.team)).not.toContain('"inbox"');
  });
});
