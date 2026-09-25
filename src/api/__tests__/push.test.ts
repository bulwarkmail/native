import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    currentSession: {
      eventSourceUrl: 'https://mail.example.com/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
    },
    authHeader: 'Basic dXNlcjpwYXNz',
    request: vi.fn(),
    hasCapability: vi.fn(() => false),
  },
}));

import { jmapClient } from '../jmap-client';
import {
  createPushSubscription,
  destroyPushSubscription,
  listPushSubscriptions,
  startPolling,
  updatePushSubscription,
  verifyPushSubscription,
} from '../push';
import { isJMAPSetError } from '../jmap-result';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const mockHasCapability = jmapClient.hasCapability as ReturnType<typeof vi.fn>;
const EMAIL_PUSH = 'urn:ietf:params:jmap:emailpush';

describe('push operations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('emailPush read-back', () => {
    const FILTER = {
      filter: { operator: 'AND', conditions: [{ notKeyword: '$junk' }] },
      properties: ['id', 'threadId'],
      urgency: 'high' as const,
    };

    beforeEach(() => {
      mockHasCapability.mockImplementation((urn: string) => urn === EMAIL_PUSH);
    });

    afterEach(() => {
      mockHasCapability.mockImplementation(() => false);
    });

    it('asks for emailPush explicitly under the emailpush capability', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['PushSubscription/get', { list: [{ id: 's1', emailPush: { a: FILTER } }] }, '0']],
      });
      const list = await listPushSubscriptions();
      const [calls, using] = mockRequest.mock.calls[0];
      expect(calls[0][1].properties).toContain('emailPush');
      expect(using).toEqual(['urn:ietf:params:jmap:core', EMAIL_PUSH]);
      expect(list[0].emailPush).toEqual({ a: FILTER });
    });

    it('keeps the default properties on servers without emailpush', async () => {
      mockHasCapability.mockImplementation(() => false);
      mockRequest.mockResolvedValue({ methodResponses: [['PushSubscription/get', { list: [] }, '0']] });
      await listPushSubscriptions();
      const [calls, using] = mockRequest.mock.calls[0];
      expect(calls[0][1]).toEqual({ ids: null });
      expect(using).toEqual(['urn:ietf:params:jmap:core']);
    });

    it('sends the capability with an emailPush create and update', async () => {
      mockRequest.mockResolvedValueOnce({
        methodResponses: [['PushSubscription/set', { created: { new: { id: 's1' } } }, '0']],
      });
      await createPushSubscription({
        deviceClientId: 'd', url: 'https://relay/x', types: ['EmailDelivery'], emailPush: { a: FILTER },
      });
      expect(mockRequest.mock.calls[0][1]).toEqual(['urn:ietf:params:jmap:core', EMAIL_PUSH]);

      mockRequest.mockResolvedValueOnce({
        methodResponses: [['PushSubscription/set', { updated: { s1: null } }, '0']],
      });
      await updatePushSubscription('s1', { expires: '2026-10-01T00:00:00Z' });
      // An update that leaves the filter alone doesn't need the capability.
      expect(mockRequest.mock.calls[1][1]).toEqual(['urn:ietf:params:jmap:core']);
    });

    it('drops emailPush from writes on servers without the capability', async () => {
      mockHasCapability.mockImplementation(() => false);
      mockRequest.mockResolvedValue({
        methodResponses: [['PushSubscription/set', { updated: { s1: null } }, '0']],
      });
      await updatePushSubscription('s1', { expires: '2026-10-01T00:00:00Z', emailPush: { a: FILTER } });
      const [calls, using] = mockRequest.mock.calls[0];
      expect(calls[0][1].update.s1).toEqual({ expires: '2026-10-01T00:00:00Z' });
      expect(using).toEqual(['urn:ietf:params:jmap:core']);
    });
  });

  describe('createPushSubscription', () => {
    const params = {
      deviceClientId: 'd', url: 'https://relay/x', types: ['EmailDelivery'], expires: '2026-12-01T00:00:00Z',
    };

    it('returns the expiry the server clamped the subscription to', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [[
          'PushSubscription/set',
          { created: { new: { id: 's1', keys: null, expires: '2026-10-01T00:00:00Z' } } },
          '0',
        ]],
      });
      await expect(createPushSubscription(params)).resolves.toEqual({ id: 's1', expires: '2026-10-01T00:00:00Z' });
    });

    it('keeps the requested expiry when the server does not echo one', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['PushSubscription/set', { created: { new: { id: 's1' } } }, '0']],
      });
      await expect(createPushSubscription(params)).resolves.toEqual({ id: 's1', expires: '2026-12-01T00:00:00Z' });
    });
  });

  describe('PushSubscription/set refusals', () => {
    const forbidden = {
      type: 'forbidden',
      description: 'No access to one of the accounts in the emailPush map.',
    };

    it('surfaces the SetError type when a create is refused', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['PushSubscription/set', { notCreated: { new: forbidden } }, '0']],
      });
      await expect(
        createPushSubscription({ deviceClientId: 'd', url: 'https://relay/x', types: ['EmailDelivery'] }),
      ).rejects.toMatchObject({ name: 'JMAPMethodError', type: 'forbidden' });
    });

    it('surfaces the SetError type when an update is refused', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['PushSubscription/set', { notUpdated: { s1: forbidden } }, '0']],
      });
      await expect(updatePushSubscription('s1', { expires: '2026-10-01T00:00:00Z' }))
        .rejects.toMatchObject({ type: 'forbidden' });
    });

    it('throws when the verification code is refused', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [[
          'PushSubscription/set',
          { notUpdated: { s1: { type: 'invalidProperties', description: 'Verification code does not match.' } } },
          '0',
        ]],
      });
      await expect(verifyPushSubscription('s1', 'CODE')).rejects.toThrow('Verification code does not match.');
    });

    it('throws when a destroy is refused', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['PushSubscription/set', { notDestroyed: { s1: forbidden } }, '0']],
      });
      await expect(destroyPushSubscription('s1')).rejects.toMatchObject({ type: 'forbidden' });
    });

    it('treats destroying a subscription that is already gone as done', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['PushSubscription/set', { notDestroyed: { s1: { type: 'notFound' } } }, '0']],
      });
      await expect(destroyPushSubscription('s1')).resolves.toBeUndefined();
    });

    it.each([
      ['list', () => listPushSubscriptions()],
      ['create', () => createPushSubscription({ deviceClientId: 'd', url: 'https://relay/x', types: ['EmailDelivery'] })],
      ['update', () => updatePushSubscription('s1', { expires: '2026-10-01T00:00:00Z' })],
      ['verify', () => verifyPushSubscription('s1', 'CODE')],
      ['destroy', () => destroyPushSubscription('s1')],
    ])('%s throws on a method-level error response', async (_name, call) => {
      mockRequest.mockResolvedValue({
        methodResponses: [['error', { type: 'serverFail', description: 'Store unavailable' }, '0']],
      });
      await expect(call()).rejects.toMatchObject({ name: 'JMAPMethodError', type: 'serverFail' });
    });

    it('resolves when the update is applied', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['PushSubscription/set', { updated: { s1: null } }, '0']],
      });
      await expect(updatePushSubscription('s1', { expires: '2026-10-01T00:00:00Z' })).resolves.toBeUndefined();
    });

    // The push setup narrows the emailPush map, or replaces a subscription,
    // only on the server's verdict about the subscription itself.
    const rejection = (call: () => Promise<unknown>) => call().then(() => null, (err: unknown) => err);

    it('throws a refused create as a SetError (Stalwart 0.16.16+ and 1.0)', async () => {
      // As Stalwart answers a map naming a mailbox shared by ACL: no
      // accountId, state or `created` key (jmap-proto method/set.rs).
      mockRequest.mockResolvedValue({
        methodResponses: [['PushSubscription/set', { notCreated: { new: forbidden } }, '0']],
      });
      const err = await rejection(() =>
        createPushSubscription({ deviceClientId: 'd', url: 'https://relay/x', types: ['EmailDelivery'] }));
      expect(isJMAPSetError(err)).toBe(true);
      expect(err).toMatchObject({ type: 'forbidden' });
    });

    it('throws an update of a vanished subscription as a notFound SetError', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['PushSubscription/set', { notUpdated: { s1: { type: 'notFound' } } }, '0']],
      });
      const err = await rejection(() => updatePushSubscription('s1', { expires: '2026-10-01T00:00:00Z' }));
      expect(isJMAPSetError(err)).toBe(true);
      expect(err).toMatchObject({ type: 'notFound' });
    });

    it('throws a refused method call as a plain method error, even when forbidden', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['error', { type: 'forbidden', description: 'Permission denied' }, '0']],
      });
      const create = await rejection(() =>
        createPushSubscription({ deviceClientId: 'd', url: 'https://relay/x', types: ['EmailDelivery'] }));
      const update = await rejection(() => updatePushSubscription('s1', { expires: '2026-10-01T00:00:00Z' }));
      for (const err of [create, update]) {
        expect(err).toMatchObject({ name: 'JMAPMethodError', type: 'forbidden' });
        expect(isJMAPSetError(err)).toBe(false);
      }
    });

    it('does not read an update that is neither applied nor refused as a SetError', async () => {
      mockRequest.mockResolvedValue({ methodResponses: [['PushSubscription/set', {}, '0']] });
      const err = await rejection(() => updatePushSubscription('s1', { expires: '2026-10-01T00:00:00Z' }));
      expect(err).toMatchObject({ name: 'JMAPMethodError' });
      expect(isJMAPSetError(err)).toBe(false);
    });
  });

  describe('startPolling', () => {
    it('should poll at the specified interval', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [
          ['Mailbox/get', { state: 'state-1' }, 'm'],
          ['Email/get', { state: 'state-1' }, 'e'],
        ],
      });

      const handler = vi.fn();
      const stop = startPolling(handler, 1000);

      // First poll
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockRequest).toHaveBeenCalledTimes(1);

      // Second poll with same state - no notification
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).not.toHaveBeenCalled();

      stop();
    });

    it('should notify on state change', async () => {
      let callCount = 0;
      mockRequest.mockImplementation(async () => {
        callCount++;
        return {
          methodResponses: [
            ['Mailbox/get', { state: callCount === 1 ? 'state-1' : 'state-2' }, 'm'],
            ['Email/get', { state: 'state-1' }, 'e'],
          ],
        };
      });

      const handler = vi.fn();
      const stop = startPolling(handler, 1000);

      // First poll (establishes baseline)
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).not.toHaveBeenCalled();

      // Second poll (state changed for Mailbox)
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        '@type': 'StateChange',
        changed: {
          'acc-1': { Mailbox: 'state-2' },
        },
      });

      stop();
    });

    it('should handle errors silently', async () => {
      mockRequest.mockRejectedValue(new Error('Network error'));

      const handler = vi.fn();
      const stop = startPolling(handler, 1000);

      // Should not throw
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).not.toHaveBeenCalled();

      stop();
    });
  });
});
