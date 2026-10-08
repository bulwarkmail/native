import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'own',
    request: vi.fn(),
  },
}));
vi.mock('../../stores/locale-store', () => ({ t: (_k: string, f?: string) => f ?? _k }));

import { jmapClient } from '../jmap-client';
import { getMailboxShareWith, setMailboxShare } from '../email';
import { CAPABILITIES } from '../types';
import type { MailboxRights } from '../types';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

const READ: MailboxRights = {
  mayReadItems: true, mayAddItems: false, mayRemoveItems: false, maySetSeen: true,
  maySetKeywords: false, mayCreateChild: false, mayRename: false, mayDelete: false,
  maySubmit: false, mayShare: false,
};

function lastCall() {
  const [[call], using, opts] = mockRequest.mock.calls[mockRequest.mock.calls.length - 1];
  return { call, using, opts };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getMailboxShareWith', () => {
  it('reads shareWith on demand with the mail:share capability, on the scope it was given', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Mailbox/get', { list: [{ id: 'c', shareWith: { d: READ } }] }, '0']],
    });

    const shares = await getMailboxShareWith('c', { gen: 4, accountId: 'shared-1' });

    const { call, using, opts } = lastCall();
    expect(call).toEqual(['Mailbox/get', { accountId: 'shared-1', ids: ['c'], properties: ['id', 'shareWith'] }, '0']);
    expect(using).toEqual([CAPABILITIES.CORE, CAPABILITIES.MAIL, CAPABILITIES.MAIL_SHARE]);
    expect(opts).toEqual({ gen: 4 });
    expect(shares).toEqual({ d: READ });
  });

  it('gives null for a folder shared with nobody', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Mailbox/get', { list: [{ id: 'c', shareWith: null }] }, '0']],
    });
    await expect(getMailboxShareWith('c', { gen: 1, accountId: 'own' })).resolves.toBeNull();
  });

  it('throws when the folder is not listed', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Mailbox/get', { list: [], notFound: ['c'] }, '0']],
    });
    await expect(getMailboxShareWith('c', { gen: 1, accountId: 'own' })).rejects.toThrow('This folder is no longer available.');
  });

  it('throws on a method error', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['error', { type: 'accountNotFound' }, '0']],
    });
    await expect(getMailboxShareWith('c', { gen: 1, accountId: 'own' })).rejects.toThrow();
  });
});

describe('setMailboxShare', () => {
  it('grants with a shareWith/<principal> patch and revokes with null', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Mailbox/set', { updated: { c: null } }, '0']],
    });

    await setMailboxShare('c', 'd', READ, { gen: 7, accountId: 'shared-1' });
    let { call, using, opts } = lastCall();
    expect(call).toEqual(['Mailbox/set', {
      accountId: 'shared-1',
      update: { c: { 'shareWith/d': READ } },
    }, '0']);
    expect(using).toEqual([CAPABILITIES.CORE, CAPABILITIES.MAIL, CAPABILITIES.MAIL_SHARE]);
    expect(opts).toEqual({ gen: 7 });

    await setMailboxShare('c', 'd', null, { gen: 7, accountId: 'shared-1' });
    ({ call } = lastCall());
    expect(call[1].update).toEqual({ c: { 'shareWith/d': null } });
  });

  it('explains a forbidden refusal without the server\'s text', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Mailbox/set', { notUpdated: { c: { type: 'forbidden', description: 'You are not allowed to modify this mailbox.' } } }, '0']],
    });
    await expect(setMailboxShare('c', 'd', READ, { gen: 1, accountId: 'own' }))
      .rejects.toThrow("You don't have permission to share this folder");
  });

  it('gives the generic failure for any other refusal', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Mailbox/set', { notUpdated: { c: { type: 'invalidProperties', description: 'raw server text' } } }, '0']],
    });
    const err = await setMailboxShare('c', 'd', READ, { gen: 1, accountId: 'own' }).catch((e: Error) => e);
    expect((err as Error).message).toBe('Failed to update sharing');
  });

  it('throws when the server does not confirm the update', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Mailbox/set', { updated: {} }, '0']],
    });
    await expect(setMailboxShare('c', 'd', READ, { gen: 1, accountId: 'own' })).rejects.toThrow();
  });
});
