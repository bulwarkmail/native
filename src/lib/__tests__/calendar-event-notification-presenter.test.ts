import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({ refresh: vi.fn(async () => undefined) }));

vi.mock('../../stores/calendar-event-notification-store', async () => {
  const { create } = await import('zustand');
  const store = create<{ pending: unknown[]; acknowledge: (ids: string[]) => Promise<void> }>((set, get) => ({
    pending: [],
    acknowledge: vi.fn(async (ids: string[]) => {
      set({ pending: get().pending.filter((n) => !ids.includes((n as { id: string }).id)) });
    }),
  }));
  return { useCalendarEventNotificationStore: store };
});
vi.mock('../../stores/calendar-store', () => ({ useCalendarStore: { getState: () => ({ refresh: mocks.refresh }) } }));
vi.mock('../../api/jmap-client', () => ({ jmapClient: { accountId: 'acc' } }));
vi.mock('../../navigation/pending-calendar-open', () => ({ setPendingCalendarOpen: vi.fn() }));
vi.mock('../../stores/locale-store', () => ({
  useLocaleStore: {
    getState: () => ({
      t: (_key: string, fallback?: string, params?: Record<string, string | number>) =>
        (fallback ?? '').replace(/\{count, plural, one \{# ([^}]*)\} other \{# ([^}]*)\}\}/, (_m, _one, other) => `${params?.count} ${other}`)
          .replace(/\{(\w+)\}/g, (_m, k) => String(params?.[k] ?? '')),
    }),
  },
}));
vi.mock('../active-client-account', () => ({
  activeAppAccountId: () => 'app-1',
  clientServesActiveAccount: () => true,
}));

import { useCalendarEventNotificationStore } from '../../stores/calendar-event-notification-store';
import { useToastStore, toast } from '../../stores/toast-store';
import { startCalendarEventNotificationToasts } from '../calendar-event-notification-presenter';
import { NOTICE_WAIT_CAP_MS } from '../calendar-event-notification-toast';

const notice = (id: string) => ({
  id, created: '', type: 'updated', isDraft: false, comment: null, calendarEventId: 'ev' + id,
  changedBy: { name: 'Dana', email: null, principalId: null, scheduleId: null },
  event: { title: 'T' + id }, accountId: 'acc', appAccountId: 'app-1',
});
const queue = (...n: ReturnType<typeof notice>[]) => useCalendarEventNotificationStore.setState({ pending: n } as never);
const titles = () => useToastStore.getState().toasts.map((x) => x.title);
const acknowledge = () => useCalendarEventNotificationStore.getState().acknowledge as ReturnType<typeof vi.fn>;

let stop: () => void = () => undefined;
beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.getState().clearToasts();
  useCalendarEventNotificationStore.setState({ pending: [] } as never);
  stop = startCalendarEventNotificationToasts(() => undefined);
});
afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('calendar event notification presenter', () => {
  it('caps a burst at three toasts with a summary', () => {
    queue(notice('1'), notice('2'), notice('3'), notice('4'));
    expect(titles()).toEqual(['2 more calendar updates', 'Dana updated "T3"', 'Dana updated "T4"']);
  });

  it('never evicts the user\'s Undo or error toast, and waits when there is no room', () => {
    toast.success('Moved', { action: { label: 'Undo', onPress: () => undefined } });
    toast.error('Send failed');
    queue(notice('1'), notice('2'));
    expect(titles()).toEqual(['Moved', 'Send failed', '2 more calendar updates']);

    useToastStore.getState().clearToasts();
    toast.success('Moved', { action: { label: 'Undo', onPress: () => undefined } });
    toast.error('Send failed');
    toast.error('Still failing');
    queue(notice('w'));
    expect(titles()).toEqual(['Moved', 'Send failed', 'Still failing']);
    expect(acknowledge()).not.toHaveBeenCalledWith(['w']);
    useToastStore.getState().removeToast(useToastStore.getState().toasts[0].id);
    expect(titles()).toEqual(['Send failed', 'Still failing', 'Dana updated "Tw"']);
    expect(acknowledge()).toHaveBeenCalledWith(['w']);
  });

  const holdThree = () => {
    toast.success('Moved', { action: { label: 'Undo', onPress: () => undefined } });
    toast.error('Send failed');
    toast.error('Still failing');
  };

  it('acknowledges a batch without a toast after waiting a minute, and leaves the undo toast alone', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    holdThree();
    queue(notice('d1'));
    vi.advanceTimersByTime(NOTICE_WAIT_CAP_MS - 1);
    expect(acknowledge()).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(titles()).toEqual(['Moved', 'Send failed', 'Still failing']);
    expect(acknowledge()).toHaveBeenCalledWith(['d1']);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // The clock starts over for the next batch.
    queue(notice('d2'));
    vi.advanceTimersByTime(NOTICE_WAIT_CAP_MS - 1);
    expect(acknowledge()).not.toHaveBeenCalledWith(['d2']);
    vi.advanceTimersByTime(1);
    expect(acknowledge()).toHaveBeenCalledWith(['d2']);
  });

  it('stops waiting once unsubscribed', () => {
    vi.useFakeTimers();
    holdThree();
    queue(notice('s1'));
    stop();
    vi.advanceTimersByTime(NOTICE_WAIT_CAP_MS * 2);
    expect(acknowledge()).not.toHaveBeenCalled();
  });
});
