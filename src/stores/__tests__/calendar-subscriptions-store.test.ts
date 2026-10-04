import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const authState = vi.hoisted(() => ({ serverUrl: 'https://Mail.example.com/' as string | null, username: 'Alice' as string | null }));
const importEvents = vi.hoisted(() => vi.fn());
const calState = vi.hoisted(() => ({ calendars: [] as { id: string; originalId?: string; name: string }[] }));
vi.mock('../../api/calendar', () => ({
  createCalendar: vi.fn(),
  deleteCalendar: vi.fn(),
  parseCalendarBlob: vi.fn(),
  queryEvents: vi.fn(),
  getEvents: vi.fn(),
  deleteEvents: vi.fn(),
  updateEvent: vi.fn(),
  updateCalendar: vi.fn(),
}));
vi.mock('../../api/blob', () => ({ uploadBytes: vi.fn() }));
vi.mock('../../api/jmap-client', () => ({
  jmapClient: { accountId: 'acc-1', isConnected: true, serverUrl: 'https://Mail.example.com/', username: 'Alice' },
}));
vi.mock('../calendar-store', () => ({
  useCalendarStore: {
    getState: () => ({
      get calendars() { return calState.calendars; },
      fetchCalendars: vi.fn(),
      refresh: vi.fn(),
      importEvents,
    }),
  },
}));
vi.mock('./../auth-store', () => ({ useAuthStore: { getState: () => authState } }));
const accountState = vi.hoisted(() => ({ accounts: [{ id: 'app-1' }] as { id: string }[] }));
vi.mock('../account-store', () => ({ useAccountStore: { getState: () => accountState } }));
vi.mock('react', () => ({ default: {} }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  normalizeFeedUrl,
  selectAccountSubscriptions,
  subscriptionOwner,
  ownerFromAuth,
  useCalendarSubscriptionsStore,
  type CalendarSubscription,
} from '../calendar-subscriptions-store';

describe('normalizeFeedUrl', () => {
  it('maps webcal:// and webcals:// to https://', () => {
    expect(normalizeFeedUrl('webcal://example.com/feed.ics').url).toBe('https://example.com/feed.ics');
    expect(normalizeFeedUrl('WEBCALS://example.com/feed.ics').url).toBe('https://example.com/feed.ics');
    expect(normalizeFeedUrl('https://example.com/feed.ics').headers).toEqual({});
  });

  it('moves URL credentials into a basic-auth header (#275)', () => {
    const { url, headers } = normalizeFeedUrl('https://user:p%40ss@example.com/private.ics');
    expect(url).toBe('https://example.com/private.ics');
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('user:p@ss', 'utf8').toString('base64')}`);
  });
});

const ALICE = subscriptionOwner('https://mail.example.com', 'alice');
const BOB = subscriptionOwner('https://mail.example.com', 'bob');
const sub = (o: Partial<CalendarSubscription>): CalendarSubscription => ({
  id: 'x', name: 'N', url: 'u', calendarId: 'c1', lastSyncAt: null, lastError: null, ...o,
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  authState.serverUrl = 'https://Mail.example.com/';
  authState.username = 'Alice';
  calState.calendars = [];
  useCalendarSubscriptionsStore.setState({ subscriptions: [], syncing: {} });
});

describe('subscriptionOwner', () => {
  it('ignores case and trailing slashes', () => {
    expect(subscriptionOwner('https://Mail.example.com//', 'Alice')).toBe('https://mail.example.com|alice');
  });
});

describe('ownerFromAuth', () => {
  it('is null when either field is missing and otherwise matches subscriptionOwner', () => {
    expect(ownerFromAuth({ serverUrl: null, username: 'a' })).toBeNull();
    expect(ownerFromAuth({ serverUrl: 'https://x', username: null })).toBeNull();
    expect(ownerFromAuth({ serverUrl: 'https://Mail.example.com/', username: 'Alice' })).toBe(ALICE);
  });
});

describe('selectAccountSubscriptions', () => {
  it('still lists the login\'s subscriptions when not connected (owner from auth)', () => {
    const owner = ownerFromAuth({ serverUrl: 'https://mail.example.com', username: 'alice' });
    expect(selectAccountSubscriptions([sub({ id: 'a', owner: ALICE })], owner, null, []).map((s) => s.id)).toEqual(['a']);
  });

  it('does not adopt a legacy subscription without an accountId on an id match alone', () => {
    const legacy = sub({ id: 'l', calendarId: 'c9', name: 'Old' });
    expect(selectAccountSubscriptions([legacy], ALICE, 'acc-1', [{ id: 'c9', name: 'New' }])).toEqual([]);
    expect(selectAccountSubscriptions([legacy], ALICE, 'acc-1', [{ id: 'c9', name: 'Old' }]).map((s) => s.id)).toEqual(['l']);
  });

  it('adopts a legacy subscription whose calendar was renamed', () => {
    const legacy = sub({ id: 'l', calendarId: 'c9', name: 'Old', accountId: 'acc-1' });
    expect(selectAccountSubscriptions([legacy], ALICE, 'acc-1', [{ id: 'c9', name: 'New' }]).map((s) => s.id)).toEqual(['l']);
    expect(selectAccountSubscriptions([legacy], ALICE, 'acc-2', [{ id: 'c9', name: 'New' }])).toEqual([]);
  });

  it('shows a subscription only to its owner', () => {
    const subs = [sub({ id: 'a', owner: ALICE }), sub({ id: 'b', owner: BOB })];
    expect(selectAccountSubscriptions(subs, ALICE, 'acc-1', []).map((s) => s.id)).toEqual(['a']);
    expect(selectAccountSubscriptions(subs, BOB, 'acc-1', []).map((s) => s.id)).toEqual(['b']);
    expect(selectAccountSubscriptions(subs, null, 'acc-1', [])).toEqual([]);
  });

  it('with several accounts signed in, adopts a legacy subscription only when the name matches too', () => {
    // Account ids are unique only per server: another server's calendar can share the id.
    accountState.accounts = [{ id: 'app-1' }, { id: 'app-2' }];
    try {
      const legacy = sub({ id: 'l', calendarId: 'c9', name: 'Old', accountId: 'acc-1' });
      expect(selectAccountSubscriptions([legacy], ALICE, 'acc-1', [{ id: 'c9', name: 'Other' }])).toEqual([]);
      expect(selectAccountSubscriptions([legacy], ALICE, 'acc-1', [{ id: 'c9', name: 'Old' }]).map((s) => s.id)).toEqual(['l']);
    } finally {
      accountState.accounts = [{ id: 'app-1' }];
    }
  });

  it('adopts a legacy subscription only for the login whose calendars contain it', () => {
    const legacy = sub({ id: 'l', calendarId: 'c9', name: 'Feed', accountId: 'acc-1' });
    const mine = [{ id: 'acc-1:c9', originalId: 'c9', name: 'Feed' }];
    expect(selectAccountSubscriptions([legacy], ALICE, 'acc-1', mine).map((s) => s.id)).toEqual(['l']);
    // No calendar at all, or a different account: not claimed.
    expect(selectAccountSubscriptions([legacy], BOB, 'acc-1', [])).toEqual([]);
    expect(selectAccountSubscriptions([legacy], BOB, 'acc-2', mine)).toEqual([]);
  });
});

describe('subscription store', () => {
  it('stamps the owner on a new subscription', async () => {
    const { createCalendar } = await import('../../api/calendar');
    vi.mocked(createCalendar).mockResolvedValue({ id: 'c1', name: 'N' } as never);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(useCalendarSubscriptionsStore.getState().addSubscription({ name: 'N', url: 'https://x/f.ics' })).rejects.toThrow();
    // The sync failed so nothing was kept; assert the stamp via a successful path instead.
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true, headers: { get: () => '0' }, text: async () => 'BEGIN:VCALENDAR',
    } as never);
    const { uploadBytes } = await import('../../api/blob');
    const { parseCalendarBlob, queryEvents } = await import('../../api/calendar');
    vi.mocked(uploadBytes).mockResolvedValue({ blobId: 'b' } as never);
    vi.mocked(parseCalendarBlob).mockResolvedValue([]);
    vi.mocked(queryEvents).mockResolvedValue([]);
    const added = await useCalendarSubscriptionsStore.getState().addSubscription({ name: 'N', url: 'https://x/f.ics' });
    expect(added.owner).toBe(ALICE);
    expect(useCalendarSubscriptionsStore.getState().subscriptions[0].owner).toBe(ALICE);
  });

  it("does not refresh another login's subscription", async () => {
    const { queryEvents } = await import('../../api/calendar');
    vi.mocked(queryEvents).mockClear();
    useCalendarSubscriptionsStore.setState({ subscriptions: [sub({ id: 'b', owner: BOB })] });
    await useCalendarSubscriptionsStore.getState().syncSubscription('b');
    await useCalendarSubscriptionsStore.getState().syncAll();
    expect(queryEvents).not.toHaveBeenCalled();
    expect(useCalendarSubscriptionsStore.getState().subscriptions[0].lastSyncAt).toBeNull();
  });

  describe('account switch mid-sync', () => {
    const syncWithFeed = async (switchAccount: () => void) => {
      const api = await import('../../api/calendar');
      const { uploadBytes } = await import('../../api/blob');
      vi.mocked(uploadBytes).mockResolvedValue({ blobId: 'b' } as never);
      vi.mocked(api.parseCalendarBlob).mockResolvedValue([]);
      vi.mocked(api.queryEvents).mockResolvedValue(['e1']);
      vi.mocked(api.getEvents).mockResolvedValue([{ id: 'e1', uid: 'gone', calendarIds: { c1: true } }] as never);
      vi.mocked(api.deleteEvents).mockClear();
      vi.mocked(api.updateEvent).mockClear();
      importEvents.mockClear();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        switchAccount();
        return { ok: true, headers: { get: () => '0' }, text: async () => 'BEGIN:VCALENDAR' } as never;
      });
      useCalendarSubscriptionsStore.setState({ subscriptions: [sub({ id: 'a', owner: ALICE, url: 'https://x/f.ics' })] });
      await useCalendarSubscriptionsStore.getState().syncSubscription('a');
      return api;
    };

    it('stops before deleting events when the account switched mid-sync', async () => {
      const api = await syncWithFeed(() => { authState.username = 'Bob'; });
      expect(api.deleteEvents).not.toHaveBeenCalled();
      expect(api.updateEvent).not.toHaveBeenCalled();
      expect(importEvents).not.toHaveBeenCalled();
      expect(useCalendarSubscriptionsStore.getState().subscriptions[0].lastSyncAt).toBeNull();
    });

    it('a sync with no switch still deletes and imports', async () => {
      const api = await syncWithFeed(() => {});
      expect(api.deleteEvents).toHaveBeenCalledWith(['e1']);
      expect(importEvents).toHaveBeenCalled();
      expect(useCalendarSubscriptionsStore.getState().subscriptions[0].lastSyncAt).not.toBeNull();
    });
  });

  it('forgetSubscriptions removes only that owner\'s subscriptions', () => {
    useCalendarSubscriptionsStore.setState({
      subscriptions: [sub({ id: 'a', owner: ALICE }), sub({ id: 'b', owner: BOB }), sub({ id: 'l' })],
    });
    useCalendarSubscriptionsStore.getState().forgetSubscriptions(ALICE);
    expect(useCalendarSubscriptionsStore.getState().subscriptions.map((s) => s.id)).toEqual(['b', 'l']);
  });

  it('adoptSubscriptions persists the owner on claimed entries only', () => {
    useCalendarSubscriptionsStore.setState({
      subscriptions: [sub({ id: 'l', calendarId: 'c9', name: 'Feed' }), sub({ id: 'm', calendarId: 'c8', name: 'Gone' })],
    });
    useCalendarSubscriptionsStore.getState().adoptSubscriptions(ALICE, 'acc-1', [{ id: 'c9', name: 'Feed' }]);
    expect(useCalendarSubscriptionsStore.getState().subscriptions.map((s) => s.owner)).toEqual([ALICE, undefined]);
  });

  it('adoptSubscriptions refreshes the name from a renamed calendar', () => {
    useCalendarSubscriptionsStore.setState({ subscriptions: [sub({ id: 'l', calendarId: 'c9', name: 'Old', accountId: 'acc-1' })] });
    useCalendarSubscriptionsStore.getState().adoptSubscriptions(ALICE, 'acc-1', [{ id: 'c9', name: 'New' }]);
    expect(useCalendarSubscriptionsStore.getState().subscriptions[0]).toMatchObject({ owner: ALICE, name: 'New' });
  });

  it('adoptSubscriptions leaves a differently named calendar alone when several accounts are signed in', () => {
    accountState.accounts = [{ id: 'app-1' }, { id: 'app-2' }];
    try {
      useCalendarSubscriptionsStore.setState({ subscriptions: [sub({ id: 'l', calendarId: 'c9', name: 'Old', accountId: 'acc-1' })] });
      useCalendarSubscriptionsStore.getState().adoptSubscriptions(ALICE, 'acc-1', [{ id: 'c9', name: 'Other' }]);
      const [kept] = useCalendarSubscriptionsStore.getState().subscriptions;
      expect(kept.owner).toBeUndefined();
      expect(kept.name).toBe('Old');
    } finally {
      accountState.accounts = [{ id: 'app-1' }];
    }
  });

  it('migrates version 0 state without dropping subscriptions', () => {
    const opts = (useCalendarSubscriptionsStore as unknown as {
      persist: { getOptions: () => { version: number; migrate: (s: unknown, v: number) => unknown } };
    }).persist.getOptions();
    const v0 = { subscriptions: [sub({ id: 'l', accountId: 'acc-1' })] };
    expect(opts.version).toBe(1);
    expect(opts.migrate(v0, 0)).toEqual(v0);
  });
});
