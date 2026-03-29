import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    currentSession: {
      eventSourceUrl: 'https://mail.example.com/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
    },
    authHeader: 'Basic dXNlcjpwYXNz',
    request: vi.fn(),
  },
}));

import { jmapClient } from '../jmap-client';
import { startPolling } from '../push';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

describe('push operations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
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
