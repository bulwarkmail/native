import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchMailboxes: vi.fn(async () => undefined),
  fetchCalendars: vi.fn(async () => true),
  refreshContacts: vi.fn(async () => undefined),
  active: 'app-1' as string | null,
  serves: true,
  calendar: true,
  knownAccounts: ['acc', 'o'] as string[],
  refreshSessionFor: vi.fn(async (_id: string) => true),
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
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({
      session: { accounts: Object.fromEntries(mocks.knownAccounts.map((id) => [id, {}])) },
      refreshSessionFor: mocks.refreshSessionFor,
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
import { NOTICE_WAIT_CAP_MS } from '../calendar-event-notification-toast';

const notice = (id: string, objectType: string, appAccountId = 'app-1', objectAccountId = 'o') => ({
  id, created: '', changedBy: { name: 'Dana', email: null, principalId: null },
  objectType, objectAccountId, objectId: 'x' + id, oldRights: null, newRights: { mayRead: true },
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
  mocks.knownAccounts = ['acc', 'o'];
  mocks.refreshSessionFor.mockImplementation(async () => true);
  useToastStore.getState().clearToasts();
  useShareNotificationStore.setState({ pending: [] } as never);
  stop = startShareNotificationToasts();
});
afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  it('refreshes the session first when a share comes from an account the session lacks', async () => {
    let release!: (ok: boolean) => void;
    mocks.refreshSessionFor.mockImplementation(() => new Promise<boolean>((res) => { release = res; }));
    queue(notice('n1', 'Mailbox', 'app-1', 'newOwner'));
    expect(titles()).toEqual(['Dana shared the folder "Nn1" with you']);
    expect(mocks.refreshSessionFor).toHaveBeenCalledWith('app-1');
    // The folder list is fetched once the session names the new account.
    expect(mocks.fetchMailboxes).not.toHaveBeenCalled();
    release(true);
    await vi.waitFor(() => expect(mocks.fetchMailboxes).toHaveBeenCalledTimes(1));
    expect(acknowledge()).toHaveBeenCalledWith(['n1']);
  });

  it('still fetches the touched lists when the session refresh fails', async () => {
    mocks.refreshSessionFor.mockImplementation(async () => { throw new Error('offline'); });
    queue(notice('f1', 'Calendar', 'app-1', 'newOwner'));
    await vi.waitFor(() => expect(mocks.fetchCalendars).toHaveBeenCalledTimes(1));
  });

  it('never refreshes the session for a notice of another account', () => {
    queue(notice('x1', 'Mailbox', 'app-2', 'newOwner'));
    expect(mocks.refreshSessionFor).not.toHaveBeenCalled();
  });

  it('does not refresh the session for a share the session already lists', () => {
    queue(notice('k1', 'Mailbox'));
    expect(mocks.refreshSessionFor).not.toHaveBeenCalled();
    expect(mocks.fetchMailboxes).toHaveBeenCalledTimes(1);
  });

  it('acknowledges a batch without a toast after waiting a minute, and leaves the undo toast alone', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    toast.success('Moved', { action: { label: 'Undo', onPress: () => undefined } });
    toast.error('Send failed');
    toast.error('Still failing');
    queue(notice('d1', 'Mailbox'));
    vi.advanceTimersByTime(NOTICE_WAIT_CAP_MS - 1);
    expect(acknowledge()).not.toHaveBeenCalled();
    expect(mocks.fetchMailboxes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(titles()).toEqual(['Moved', 'Send failed', 'Still failing']);
    expect(acknowledge()).toHaveBeenCalledWith(['d1']);
    expect(mocks.fetchMailboxes).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stops waiting once unsubscribed', () => {
    vi.useFakeTimers();
    toast.success('Moved', { action: { label: 'Undo', onPress: () => undefined } });
    toast.error('Send failed');
    toast.error('Still failing');
    queue(notice('s1', 'Mailbox'));
    stop();
    vi.advanceTimersByTime(NOTICE_WAIT_CAP_MS * 2);
    expect(acknowledge()).not.toHaveBeenCalled();
  });
});
