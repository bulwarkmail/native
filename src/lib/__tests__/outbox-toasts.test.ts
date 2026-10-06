import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));

import { toast } from '../../stores/toast-store';
import { useSendQueueStore, type QueuedSend } from '../../stores/send-queue-store';
import { startOutboxToasts } from '../outbox-toasts';

const entry = (over: Partial<QueuedSend> = {}): QueuedSend => ({
  id: 'q1', appAccountId: 'A', jmapAccountId: 'jA', identityId: 'i',
  outgoing: { from: [{ email: 'me@a.test' }], to: [], subject: 's', messageId: 'm@a' },
  messageId: 'm@a', createdAt: '2026-10-04T00:00:00.000Z', state: 'queued', ...over,
});
const error = toast.error as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  error.mockClear();
  useSendQueueStore.setState({ entries: {} });
});

describe('startOutboxToasts', () => {
  it('announces a held entry once, as not sent, with Open Outbox', () => {
    const open = vi.fn();
    const stop = startOutboxToasts(open);
    try {
      useSendQueueStore.setState({ entries: { A: [entry()] } });
      expect(error).not.toHaveBeenCalled();
      useSendQueueStore.setState({ entries: { A: [entry({ heldReason: 'no_drafts' })] } });
      useSendQueueStore.setState({ entries: { A: [entry({ heldReason: 'no_drafts' })] } });
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toBe('A message was not sent');
      error.mock.calls[0][1].action.onPress();
      expect(open).toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
