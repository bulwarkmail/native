import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1090: a message From a group identity is created, submitted and filed in
// the group's account. Stalwart lists the group's send-as identity among the
// member's own too, so the member's list alone sent it through the member's
// account and filed the Sent copy there.

const { client } = vi.hoisted(() => ({
  client: {
    accountId: 'me',
    serverUrl: 'https://mail.example.com',
    username: 'me@example.com',
    request: vi.fn(),
    getSubmissionAccountIds: vi.fn(() => ['me', 'team']),
    currentSession: { accounts: { me: { name: 'me@example.com' }, team: { name: 'Team' } } } as Record<string, unknown>,
    getAccountName: vi.fn((id: string) => id),
    hasAccountCapability: vi.fn(() => false),
    getMaxCallsInRequest: vi.fn(() => 16),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
  },
}));
vi.mock('../jmap-client', () => ({ jmapClient: client }));

import { resetSendIdentities, resolveSendAccountId, sendIdentityIn } from '../identity';
import { saveDraftVersion, sendEmail } from '../email';
import { sendTargetFor } from '../../lib/compose-send-account';
import type { Identity, Mailbox } from '../types';

const ME = { id: 'i-me', name: 'Me', email: 'me@example.com', mayDelete: false } as Identity;
// The member's list mirrors the group's identity, with the member's id for it.
const MIRRORED = { id: 'i-me-team', name: 'Team', email: 'team@example.com', mayDelete: false } as Identity;
const TEAM = { id: 'i-team', name: 'Team', email: 'team@example.com', mayDelete: false } as Identity;

function identitiesAnswer(calls: Array<[string, { accountId: string }, string]>) {
  return {
    methodResponses: calls.map(([name, args, callId]) => {
      if (name !== 'Identity/get') throw new Error(`unexpected ${name}`);
      const list = args.accountId === 'team' ? [TEAM] : [ME, MIRRORED];
      return ['Identity/get', { accountId: args.accountId, list }, callId];
    }),
  };
}

function mailbox(role: string, id: string, accountId?: string): Mailbox {
  return {
    id: accountId ? `${accountId}:${id}` : id, originalId: accountId ? id : undefined, role, name: role,
    accountId, isShared: !!accountId,
  } as Mailbox;
}
const MAILBOXES = [
  mailbox('drafts', 'own-drafts'), mailbox('sent', 'own-sent'),
  mailbox('drafts', 'team-drafts', 'team'), mailbox('sent', 'team-sent', 'team'),
];

beforeEach(() => {
  vi.clearAllMocks();
  resetSendIdentities();
  client.getSubmissionAccountIds.mockReturnValue(['me', 'team']);
  client.request.mockImplementation(async (calls) => identitiesAnswer(calls));
});

describe('resolveSendAccountId', () => {
  it("sends a group identity's message from the group account, not the member's mirror", async () => {
    await expect(resolveSendAccountId('team@example.com')).resolves.toBe('team');
    await expect(resolveSendAccountId('Team@Example.com')).resolves.toBe('team');
  });

  it('keeps the own address, and a sub-address of it, in the own account', async () => {
    await expect(resolveSendAccountId('me@example.com')).resolves.toBe('me');
    await expect(resolveSendAccountId('me+news@example.com')).resolves.toBe('me');
  });

  it('takes a sub-address of the group address for the group', async () => {
    await expect(resolveSendAccountId('team+sales@example.com')).resolves.toBe('team');
  });

  it('asks nothing when there is no group or shared account', async () => {
    client.getSubmissionAccountIds.mockReturnValue(['me']);
    await expect(resolveSendAccountId('team@example.com')).resolves.toBe('me');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('reads the identities once for a burst of saves', async () => {
    await resolveSendAccountId('team@example.com');
    await resolveSendAccountId('team@example.com');
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("names the group account's own identity for the address", async () => {
    await expect(sendIdentityIn('team', 'team@example.com')).resolves.toMatchObject({ id: 'i-team' });
  });
});

describe('sendTargetFor', () => {
  it("submits a group identity's message through the group's identity and files it in the group's folders", async () => {
    await expect(sendTargetFor(MIRRORED, 'team@example.com', MAILBOXES)).resolves.toEqual({
      accountId: 'team', identityId: 'i-team', draftsMailboxId: 'team-drafts', sentMailboxId: 'team-sent',
    });
  });

  it("sends from the own account when the group's identities can't be read", async () => {
    const accounts = client.currentSession.accounts as Record<string, { name: string }>;
    accounts.team.name = 'team@example.com';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    client.request.mockRejectedValue(new Error('Network request failed'));
    try {
      await expect(sendTargetFor(MIRRORED, 'team@example.com', MAILBOXES)).resolves.toEqual({
        identityId: 'i-me-team', draftsMailboxId: 'own-drafts', sentMailboxId: 'own-sent',
      });
    } finally {
      accounts.team.name = 'Team';
    }
  });

  it('keeps an own message in the own folders', async () => {
    await expect(sendTargetFor(ME, 'me@example.com', MAILBOXES)).resolves.toEqual({
      identityId: 'i-me', draftsMailboxId: 'own-drafts', sentMailboxId: 'own-sent',
    });
  });
});

describe('a draft that moves between accounts', () => {
  const OUTGOING = { from: [{ email: 'team@example.com' }], to: [{ email: 'you@example.net' }], subject: 'Hi', textBody: 'Hi' };

  it("destroys the previous version in the account it was saved in, never one with the same id in the new one", async () => {
    client.request.mockReset();
    client.request
      .mockResolvedValueOnce({
        methodResponses: [
          ['Email/set', { created: { draft: { id: 'd7' } } }, '0'],
          ['Email/get', { list: [{ id: 'd7', attachments: [] }] }, '1'],
        ],
      })
      .mockResolvedValueOnce({ methodResponses: [['Email/set', { destroyed: ['d7'] }, '0']] });

    // The own Drafts held version d7; the From is now the group's, whose
    // account has a message d7 of its own.
    await saveDraftVersion(OUTGOING, 'team-drafts', 'd7', 'team', 'me');

    const [create] = client.request.mock.calls[0][0];
    expect(create[1].accountId).toBe('team');
    const [destroy] = client.request.mock.calls[1][0];
    expect(destroy[1]).toMatchObject({ accountId: 'me', destroy: ['d7'] });
  });

  it('removes the old draft from its own account once the group send went out', async () => {
    client.request.mockReset();
    client.request
      .mockResolvedValueOnce({
        methodResponses: [
          ['Email/set', { created: { draft: { id: 'e1' } } }, '0'],
          ['EmailSubmission/set', { created: { 'sub-1': { id: 's1' } } }, '1'],
        ],
      })
      .mockResolvedValueOnce({ methodResponses: [['Email/set', { destroyed: ['d7'] }, '0']] });

    await sendEmail(OUTGOING, 'i-team', 'team-sent', undefined, {
      draftsMailboxId: 'team-drafts', draftId: 'd7', draftAccountId: 'me', accountId: 'team',
    });

    expect(client.request.mock.calls[0][0][0][1].accountId).toBe('team');
    expect(client.request.mock.calls[0][0][1][1].accountId).toBe('team');
    expect(client.request.mock.calls[1][0][0][1]).toMatchObject({ accountId: 'me', destroy: ['d7'] });
  });
});
