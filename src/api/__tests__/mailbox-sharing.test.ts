import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'own',
    request: vi.fn(),
  },
}));

import { jmapClient } from '../jmap-client';
import { getMailboxShareWith, setMailboxShare } from '../mailbox-sharing';
import { MAILBOX_PRESETS } from '../../lib/delegation/share-rights';
import { canShareMailbox, mailboxShareRef } from '../../lib/mailbox-share';
import type { Mailbox, MailboxRights } from '../types';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getMailboxShareWith', () => {
  it("asks for the folder's shareWith with the mail:share capability", async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Mailbox/get', { list: [{ id: 'mb1', shareWith: { p2: MAILBOX_PRESETS.read } }] }, '0']],
    });
    const shareWith = await getMailboxShareWith('mb1');
    expect(shareWith).toEqual({ p2: MAILBOX_PRESETS.read });
    const [[call], using] = mockRequest.mock.calls[0];
    expect(call).toEqual(['Mailbox/get', { accountId: 'own', ids: ['mb1'], properties: ['id', 'shareWith'] }, '0']);
    expect(using).toContain('urn:ietf:params:jmap:mail:share');
  });

  it('reads a folder of a shared account under its owner', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['Mailbox/get', { list: [{ id: 'x', shareWith: null }] }, '0']] });
    expect(await getMailboxShareWith('x', 'team')).toBeNull();
    expect(mockRequest.mock.calls[0][0][0][1].accountId).toBe('team');
  });

  it('fails when the folder is gone', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['Mailbox/get', { list: [], notFound: ['mb1'] }, '0']] });
    await expect(getMailboxShareWith('mb1')).rejects.toThrow('Folder not found');
  });
});

describe('setMailboxShare', () => {
  it('patches one principal into shareWith, and null takes the access away', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['Mailbox/set', { updated: { mb1: null } }, '0']] });
    await setMailboxShare('mb1', 'p2', MAILBOX_PRESETS.read);
    await setMailboxShare('mb1', 'p2', null, 'team');
    expect(mockRequest.mock.calls[0][0][0][1]).toEqual({ accountId: 'own', update: { mb1: { 'shareWith/p2': MAILBOX_PRESETS.read } } });
    expect(mockRequest.mock.calls[1][0][0][1]).toEqual({ accountId: 'team', update: { mb1: { 'shareWith/p2': null } } });
  });

  it("reports the server's refusal", async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Mailbox/set', { notUpdated: { mb1: { type: 'forbidden', description: 'Not allowed' } } }, '0']],
    });
    await expect(setMailboxShare('mb1', 'p2', MAILBOX_PRESETS.read)).rejects.toThrow('Not allowed');
  });

  it('fails when the server does not confirm the change', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['Mailbox/set', { updated: {} }, '0']] });
    await expect(setMailboxShare('mb1', 'p2', MAILBOX_PRESETS.read)).rejects.toThrow('did not confirm');
  });
});

describe('which folders offer Share', () => {
  const rights = (extra: Record<string, boolean> = {}) => ({ ...MAILBOX_PRESETS.read, ...extra }) as unknown as MailboxRights;

  it("offers it on the user's own folders where the server shares folders", () => {
    expect(canShareMailbox({ isShared: false, myRights: rights() }, true)).toBe(true);
    expect(canShareMailbox({ isShared: false, myRights: rights() }, false)).toBe(false);
  });

  it("offers it on someone else's folder only with their permission to pass it on", () => {
    expect(canShareMailbox({ isShared: true, myRights: rights() }, true)).toBe(false);
    expect(canShareMailbox({ isShared: true, myRights: rights({ mayShare: true }) }, true)).toBe(true);
  });

  it("shares a shared account's folder under its owner, with the owner's id", () => {
    const shared = { id: 'team:5', originalId: '5', isShared: true, accountId: 'team' } as Mailbox;
    expect(mailboxShareRef(shared)).toEqual({ mailboxId: '5', accountId: 'team' });
    expect(mailboxShareRef({ id: 'a', isShared: false, accountId: 'own' } as Mailbox)).toEqual({ mailboxId: 'a', accountId: undefined });
  });
});
