import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
  },
}));

import { jmapClient } from '../jmap-client';
import { createMailbox, setMailboxSortOrders } from '../email';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockRequest.mockResolvedValue({
    methodResponses: [['Mailbox/set', { created: { 'new-mailbox': { id: 'mb-new' } } }, '0']],
  });
});

describe('createMailbox', () => {
  it('subscribes the new folder so IMAP clients list it (#951)', async () => {
    const id = await createMailbox({ name: 'Projects' });

    expect(id).toBe('mb-new');
    const [[call]] = mockRequest.mock.calls[0];
    expect(call[0]).toBe('Mailbox/set');
    expect(call[1]).toEqual({
      accountId: 'acc-1',
      create: { 'new-mailbox': { name: 'Projects', parentId: null, isSubscribed: true } },
    });
  });

  it('subscribes subfolders created in another account', async () => {
    await createMailbox({ name: 'Child', parentId: 'parent-id' }, 'shared-account');

    const [[call]] = mockRequest.mock.calls[0];
    expect(call[1].accountId).toBe('shared-account');
    expect(call[1].create['new-mailbox']).toEqual({
      name: 'Child',
      parentId: 'parent-id',
      isSubscribed: true,
    });
  });
});

describe('setMailboxSortOrders', () => {
  it('sends every new sortOrder in one Mailbox/set on the given scope', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Mailbox/set', { updated: { a: null, b: null } }, '0']],
    });
    await setMailboxSortOrders([{ id: 'a', sortOrder: 1 }, { id: 'b', sortOrder: 2 }], { gen: 3, accountId: 'acc-1' });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const [[call]] = mockRequest.mock.calls[0];
    expect(call[0]).toBe('Mailbox/set');
    expect(call[1]).toEqual({ accountId: 'acc-1', update: { a: { sortOrder: 1 }, b: { sortOrder: 2 } } });
    expect(mockRequest.mock.calls[0][2]).toEqual({ gen: 3 });
  });

  it('throws when the server refuses any folder', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Mailbox/set', { updated: { a: null }, notUpdated: { b: { type: 'forbidden' } } }, '0']],
    });
    await expect(
      setMailboxSortOrders([{ id: 'a', sortOrder: 1 }, { id: 'b', sortOrder: 2 }], { gen: 3, accountId: 'acc-1' }),
    ).rejects.toThrow(/b/);
  });

  it('sends nothing when no folder changes', async () => {
    await setMailboxSortOrders([], { gen: 3, accountId: 'acc-1' });
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
