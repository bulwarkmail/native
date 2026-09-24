import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
  },
}));

import { jmapClient } from '../jmap-client';
import { createMailbox } from '../email';

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
