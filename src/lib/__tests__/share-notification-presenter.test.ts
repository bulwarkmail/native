import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchMailboxes: vi.fn(async () => undefined),
  fetchCalendars: vi.fn(async () => true),
  refreshContacts: vi.fn(async () => undefined),
  active: 'app-1' as string | null,
  serves: true,
  calendar: true,
}));

vi.mock('../../stores/share-notification-store', async () => {
  const { create } = await import('zustand');
  const store = create<{ pending: unknown[]; acknowledge: (ids: string[]) => Promise<void> }>((set, get) => ({
    pending: [],
    acknowledge: vi.fn(async (ids: string[]) => {
      set({ pending: get().pending.filter((n) => !ids.includes((n as { id: string }).id)) });
    }),
  }));
  return { useShareNotificationStore: store };
});
vi.mock('../../stores/email-store', () => ({ useEmailStore: { getState: () => ({ fetchMailboxes: mocks.fetchMailboxes }) } }));
vi.mock('../../stores/calendar-store', () => ({ useCalendarStore: { getState: () => ({ fetchCalendars: mocks.fetchCalendars }) } }));
vi.mock('../../stores/contacts-store', () => ({ useContactsStore: { getState: () => ({ refresh: mocks.refreshContacts }) } }));
vi.mock('../../stores/locale-store', () => ({
  useLocaleStore: {
    getState: () => ({
      t: (_key: string, fallback?: string, params?: Record<string, string | number>) =>
        (fallback ?? '').replace(/\{count, plural, one \{# ([^}]*)\} other \{# ([^}]*)\}\}/, (_m, _one, other) => `${params?.count} ${other}`)
          .replace(/\{(\w+)\}/g, (_m, k) => String(params?.[k] ?? '')),
    }),
  },
}));
vi.mock('../capabilities', () => ({ hasCalendarCapability: () => mocks.calendar }));
vi.mock('../active-client-account', () => ({
  activeAppAccountId: () => mocks.active,
  clientServesActiveAccount: () => mocks.serves,
}));

import { useShareNotificationStore } from '../../stores/share-notification-store';
import { useToastStore, toast } from '../../stores/toast-store';
import { startShareNotificationToasts } from '../share-notification-presenter';

const notice = (id: string, objectType: string, appAccountId = 'app-1') => ({
  id, created: '', changedBy: { name: 'Dana', email: null, principalId: null },
  objectType, objectAccountId: 'o', objectId: 'x' + id, oldRights: null, newRights: { mayRead: true },
  name: 'N' + id, accountId: 'acc', appAccountId,
});
const queue = (...n: ReturnType<typeof notice>[]) => useShareNotificationStore.setState({ pending: n } as never);
const titles = () => useToastStore.getState().toasts.map((x) => x.title);
const acknowledge = () => useShareNotificationStore.getState().acknowledge as ReturnType<typeof vi.fn>;

let stop: () => void = () => undefined;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.active = 'app-1';
  mocks.serves = true;
  mocks.calendar = true;
  useToastStore.getState().clearToasts();
  useShareNotificationStore.setState({ pending: [] } as never);
  stop = startShareNotificationToasts();
});
afterEach(() => stop());

describe('share notification presenter', () => {
  it('shows only the active account\'s notices but acknowledges the whole batch', () => {
    queue(notice('a1', 'Calendar'), notice('b1', 'Mailbox', 'app-2'));
    expect(titles()).toEqual(['Dana shared the calendar "Na1" with you']);
    expect(acknowledge()).toHaveBeenCalledWith(['a1', 'b1']);
    // Only the shown notice's collection is refreshed.
    expect(mocks.fetchCalendars).toHaveBeenCalledTimes(1);
    expect(mocks.fetchMailboxes).not.toHaveBeenCalled();
  });

  it('shows nothing while the client does not serve the active account', () => {
    mocks.serves = false;
    queue(notice('s1', 'Mailbox'));
    expect(titles()).toEqual([]);
    expect(mocks.fetchMailboxes).not.toHaveBeenCalled();
    expect(acknowledge()).toHaveBeenCalledWith(['s1']);
  });

  it('refreshes the collection list each object type belongs to', () => {
    queue(notice('r1', 'Mailbox'), notice('r2', 'AddressBook'), notice('r3', 'FileNode'));
    expect(mocks.fetchMailboxes).toHaveBeenCalledTimes(1);
    expect(mocks.refreshContacts).toHaveBeenCalledTimes(1);
    expect(mocks.fetchCalendars).not.toHaveBeenCalled();
    mocks.calendar = false;
    queue(notice('r4', 'Calendar'));
    expect(mocks.fetchCalendars).not.toHaveBeenCalled();
  });

  it('caps a burst at three toasts with a summary', () => {
    queue(...['1', '2', '3', '4', '5'].map((id) => notice('c' + id, 'Mailbox')));
    expect(titles()).toEqual([
      '3 more sharing changes',
      'Dana shared the folder "Nc4" with you',
      'Dana shared the folder "Nc5" with you',
    ]);
  });

  it('never evicts the user\'s Undo or error toast, and waits when there is no room', () => {
    toast.success('Moved', { action: { label: 'Undo', onPress: () => undefined } });
    toast.error('Send failed');
    queue(...['1', '2', '3', '4'].map((id) => notice('u' + id, 'Mailbox')));
    expect(titles()).toEqual(['Moved', 'Send failed', '4 more sharing changes']);

    useToastStore.getState().clearToasts();
    toast.success('Moved', { action: { label: 'Undo', onPress: () => undefined } });
    toast.error('Send failed');
    toast.error('Still failing');
    queue(notice('w1', 'Mailbox'));
    expect(titles()).toEqual(['Moved', 'Send failed', 'Still failing']);
    expect(acknowledge()).not.toHaveBeenCalledWith(['w1']);
    // A toast leaves: the waiting notice is shown then.
    useToastStore.getState().removeToast(useToastStore.getState().toasts[0].id);
    expect(titles()).toEqual(['Send failed', 'Still failing', 'Dana shared the folder "Nw1" with you']);
    expect(acknowledge()).toHaveBeenCalledWith(['w1']);
  });
});
