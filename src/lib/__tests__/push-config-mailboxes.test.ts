import { describe, it, expect, vi, beforeEach } from 'vitest';

// The push filter needs the Junk folders. It used to send its own full
// Mailbox/get (and the shared accounts') on every sign-in and start, next to
// the mail store's identical load (PF7).

// A group the user belongs to lists emailpush on 0.16.16+ and 1.0; a mailbox
// shared by ACL does on 0.16.16-0.16.23 only.
const { EMAIL_PUSH } = vi.hoisted(() => ({
  EMAIL_PUSH: { 'urn:ietf:params:jmap:emailpush': {} },
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    username: 'user@example.com',
    serverUrl: 'https://mail.example.com',
    accountId: 'jmap-primary',
    currentSession: {
      capabilities: EMAIL_PUSH,
      accounts: {
        'jmap-primary': { name: 'user', isPersonal: true, isReadOnly: false, accountCapabilities: EMAIL_PUSH },
        team: { name: 'team', isPersonal: false, isReadOnly: false, accountCapabilities: EMAIL_PUSH },
        'acl-b': { name: 'userb', isPersonal: false, isReadOnly: true, accountCapabilities: {} },
      },
    },
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

  it('leaves out an account that does not list emailpush (a mailbox shared by ACL on Stalwart 1.0)', async () => {
    provideLoadedMailboxes(async () => [
      { id: 'junk', role: 'junk', accountId: 'jmap-primary' },
      { id: 'team:j', originalId: 'j', role: 'junk', accountId: 'team', isShared: true },
      { id: 'acl-b:inbox', originalId: 'inbox', role: 'inbox', accountId: 'acl-b', isShared: true },
    ] as never);

    const config = await buildEmailPushConfig();

    expect(Object.keys(config).sort()).toEqual(['jmap-primary', 'team']);
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
