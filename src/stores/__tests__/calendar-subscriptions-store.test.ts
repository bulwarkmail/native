import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/calendar', () => ({
  createCalendar: vi.fn(),
  deleteCalendar: vi.fn(),
  getCalendarName: vi.fn(),
  parseCalendarBlob: vi.fn(),
  queryEvents: vi.fn(),
  getEventIdentities: vi.fn(),
  deleteEvents: vi.fn(),
  updateEvent: vi.fn(),
  updateCalendar: vi.fn(),
}));
vi.mock('../../api/blob', () => ({ uploadBytes: vi.fn(async () => ({ blobId: 'feed-blob' })) }));
vi.mock('../../api/jmap-client', () => ({
  jmapClient: { accountId: 'acc-1', isConnected: true, username: 'user', serverUrl: 'https://mail.example.org' },
}));
const calendarStore = vi.hoisted(() => ({
  importEvents: vi.fn(async () => ({ created: 1, updated: 0 })),
  fetchCalendars: vi.fn(async () => undefined),
  refresh: vi.fn(async () => undefined),
}));
vi.mock('../calendar-store', () => ({
  useCalendarStore: { getState: () => calendarStore },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

import * as calendarApi from '../../api/calendar';
import {
  normalizeFeedUrl,
  selectAccountSubscriptions,
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

describe('selectAccountSubscriptions', () => {
  const subs: CalendarSubscription[] = [
    { id: 'a', name: 'A', url: 'x', calendarId: 'c1', accountId: 'acc-1', lastSyncAt: null, lastError: null },
    { id: 'b', name: 'B', url: 'y', calendarId: 'c2', accountId: 'acc-2', lastSyncAt: null, lastError: null },
    { id: 'legacy', name: 'L', url: 'z', calendarId: 'c3', lastSyncAt: null, lastError: null },
  ];

  it('hides subscriptions that belong to another account, keeping legacy ones', () => {
    expect(selectAccountSubscriptions(subs, 'acc-1').map((s) => s.id)).toEqual(['a', 'legacy']);
    expect(selectAccountSubscriptions(subs, 'acc-2').map((s) => s.id)).toEqual(['b', 'legacy']);
  });

  it('tells apart accounts on two servers that gave them the same JMAP id', () => {
    const both: CalendarSubscription[] = [
      { id: 'x', name: 'X', url: 'x', calendarId: 'c1', accountId: 'b', localAccountId: 'ann@one.example', lastSyncAt: null, lastError: null },
      { id: 'y', name: 'Y', url: 'y', calendarId: 'c1', accountId: 'b', localAccountId: 'bob@two.example', lastSyncAt: null, lastError: null },
    ];
    expect(selectAccountSubscriptions(both, 'b', 'ann@one.example').map((s) => s.id)).toEqual(['x']);
    expect(selectAccountSubscriptions(both, 'b', 'bob@two.example').map((s) => s.id)).toEqual(['y']);
  });
});

describe('updateSubscription', () => {
  it('renames the mirror calendar without re-sending a colour Stalwart 1.0 refuses', async () => {
    const update = calendarApi.updateCalendar as ReturnType<typeof vi.fn>;
    update.mockResolvedValue(undefined);
    vi.mocked(calendarApi.getCalendarName).mockResolvedValue('Feed');
    useCalendarSubscriptionsStore.setState({
      subscriptions: [{ id: 's', name: 'Feed', url: 'https://example.com/f.ics', color: '#FF2968FF', calendarId: 'c9', lastSyncAt: null, lastError: null }],
    });

    await useCalendarSubscriptionsStore.getState().updateSubscription('s', { name: 'Holidays', color: '#FF2968FF' });

    expect(update).toHaveBeenCalledWith('c9', { name: 'Holidays' });
    expect(useCalendarSubscriptionsStore.getState().subscriptions[0].name).toBe('Holidays');
  });
});

describe('subscriptions of a server that was replaced (0.16.23 to 1.0)', () => {
  const ME = 'user@mail.example.org';
  const OTHER = 'user@other.example.org';
  const mine = (over: Partial<CalendarSubscription> = {}): CalendarSubscription => ({
    id: 'mine', name: 'Holidays', url: 'https://feeds.example/holidays.ics', color: '#ff0000',
    calendarId: 'c', accountId: 'acc-1', localAccountId: ME, refreshIntervalMinutes: 360,
    lastSyncAt: 5, lastError: null, ...over,
  });
  const only = () => useCalendarSubscriptionsStore.getState().subscriptions[0];

  beforeEach(() => {
    vi.clearAllMocks();
    useCalendarSubscriptionsStore.setState({ syncing: {} });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
    })) as unknown as typeof fetch;
    vi.mocked(calendarApi.parseCalendarBlob).mockResolvedValue([{ uid: 'e1', title: 'New year', start: '2027-01-01T00:00:00' }]);
    vi.mocked(calendarApi.queryEvents).mockResolvedValue([]);
    vi.mocked(calendarApi.getEventIdentities).mockResolvedValue([]);
    vi.mocked(calendarApi.createCalendar).mockResolvedValue({ id: 'n1', name: 'Holidays' } as never);
  });

  it('keeps the feed, name, colour and interval of the account\'s subscriptions and drops their mirror calendar', async () => {
    useCalendarSubscriptionsStore.setState({
      subscriptions: [
        mine({ lastError: 'Feed moved' }),
        // Made before subscriptions recorded their account: found by JMAP id.
        { id: 'legacy', name: 'Moon', url: 'https://feeds.example/moon.ics', calendarId: 'd', accountId: 'acc-1', lastSyncAt: 5, lastError: null },
        { id: 'theirs', name: 'Sports', url: 'https://feeds.example/sports.ics', calendarId: 'c', accountId: 'acc-1', localAccountId: OTHER, lastSyncAt: 5, lastError: null },
      ],
    });

    await useCalendarSubscriptionsStore.getState().unlinkAccount(ME, { previous: 'acc-1', next: 'acc-9' });

    const [first, legacy, theirs] = useCalendarSubscriptionsStore.getState().subscriptions;
    expect(first).toEqual({
      id: 'mine', name: 'Holidays', url: 'https://feeds.example/holidays.ics', color: '#ff0000',
      calendarId: null, accountId: 'acc-9', localAccountId: ME, refreshIntervalMinutes: 360,
      lastSyncAt: null, lastError: null,
    });
    expect(legacy).toMatchObject({ calendarId: null, accountId: 'acc-9', localAccountId: ME, url: 'https://feeds.example/moon.ics' });
    expect(theirs).toMatchObject({ calendarId: 'c', accountId: 'acc-1', localAccountId: OTHER, lastSyncAt: 5 });
  });

  it('makes an unlinked subscription a new mirror calendar on its next sync, as adding one does', async () => {
    vi.mocked(calendarApi.getCalendarName).mockResolvedValue('Holidays');
    useCalendarSubscriptionsStore.setState({ subscriptions: [mine({ calendarId: null, lastSyncAt: null })] });

    await useCalendarSubscriptionsStore.getState().syncSubscription('mine');

    expect(calendarApi.createCalendar).toHaveBeenCalledWith('Holidays', '#ff0000');
    expect(calendarStore.importEvents).toHaveBeenCalledWith([expect.objectContaining({ uid: 'e1' })], 'n1');
    expect(only()).toMatchObject({ calendarId: 'n1', accountId: 'acc-1', localAccountId: ME, lastError: null });
    expect(only().lastSyncAt).not.toBeNull();
    expect(calendarStore.refresh).toHaveBeenCalled();
  });

  it('keeps the new mirror when the feed fails, so the next sync makes no second one', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => '' })) as unknown as typeof fetch;
    useCalendarSubscriptionsStore.setState({ subscriptions: [mine({ calendarId: null, lastSyncAt: null })] });

    await useCalendarSubscriptionsStore.getState().syncSubscription('mine');
    await useCalendarSubscriptionsStore.getState().syncSubscription('mine');

    expect(calendarApi.createCalendar).toHaveBeenCalledTimes(1);
    expect(only().calendarId).toBe('n1');
    expect(only().lastError).toContain('503');
  });

  it('leaves the unlinked subscription of another signed-in account alone', async () => {
    useCalendarSubscriptionsStore.setState({ subscriptions: [mine({ calendarId: null, localAccountId: OTHER })] });

    await useCalendarSubscriptionsStore.getState().syncSubscription('mine');

    expect(calendarApi.createCalendar).not.toHaveBeenCalled();
    expect(only().calendarId).toBeNull();
  });

  it('touches no calendar when an unlinked subscription is renamed or removed', async () => {
    useCalendarSubscriptionsStore.setState({ subscriptions: [mine({ calendarId: null })] });

    await useCalendarSubscriptionsStore.getState().updateSubscription('mine', { name: 'Public holidays', color: '#00ff00' });
    expect(only()).toMatchObject({ name: 'Public holidays', color: '#00ff00', calendarId: null });
    await useCalendarSubscriptionsStore.getState().removeSubscription('mine');

    expect(calendarApi.getCalendarName).not.toHaveBeenCalled();
    expect(calendarApi.updateCalendar).not.toHaveBeenCalled();
    expect(calendarApi.deleteCalendar).not.toHaveBeenCalled();
    expect(useCalendarSubscriptionsStore.getState().subscriptions).toEqual([]);
  });

  it('drops no events from a calendar under the recorded id that carries another name', async () => {
    // The reinstalled server gave "c" to the user's own calendar.
    vi.mocked(calendarApi.getCalendarName).mockResolvedValue('Personal');
    vi.mocked(calendarApi.queryEvents).mockResolvedValue(['p1']);
    vi.mocked(calendarApi.getEventIdentities).mockResolvedValue([{ id: 'p1', uid: 'dentist', calendarIds: { c: true } }] as never);
    useCalendarSubscriptionsStore.setState({ subscriptions: [mine()] });

    await useCalendarSubscriptionsStore.getState().syncSubscription('mine');

    expect(calendarApi.getCalendarName).toHaveBeenCalledWith('c');
    expect(calendarApi.queryEvents).not.toHaveBeenCalled();
    expect(calendarApi.deleteEvents).not.toHaveBeenCalled();
    expect(calendarApi.updateEvent).not.toHaveBeenCalled();
  });

  it('still drops events that left the feed from its own mirror calendar', async () => {
    vi.mocked(calendarApi.getCalendarName).mockResolvedValue('Holidays');
    vi.mocked(calendarApi.queryEvents).mockResolvedValue(['x1', 'x2']);
    vi.mocked(calendarApi.getEventIdentities).mockResolvedValue([
      { id: 'x1', uid: 'gone', calendarIds: { c: true } },
      { id: 'x2', uid: 'e1', calendarIds: { c: true } },
    ] as never);
    useCalendarSubscriptionsStore.setState({ subscriptions: [mine()] });

    await useCalendarSubscriptionsStore.getState().syncSubscription('mine');

    expect(calendarApi.deleteEvents).toHaveBeenCalledWith(['x1']);
  });

  it('destroys only a calendar that carries the subscription name on remove', async () => {
    vi.mocked(calendarApi.getCalendarName).mockResolvedValueOnce('Personal').mockResolvedValueOnce('Holidays');
    useCalendarSubscriptionsStore.setState({ subscriptions: [mine(), mine({ id: 'mine-2' })] });

    await useCalendarSubscriptionsStore.getState().removeSubscription('mine');
    expect(calendarApi.deleteCalendar).not.toHaveBeenCalled();
    await useCalendarSubscriptionsStore.getState().removeSubscription('mine-2');
    expect(calendarApi.deleteCalendar).toHaveBeenCalledWith('c');
  });

  it('renames only a calendar that carries the subscription name', async () => {
    vi.mocked(calendarApi.getCalendarName).mockResolvedValue('Personal');
    useCalendarSubscriptionsStore.setState({ subscriptions: [mine()] });

    await useCalendarSubscriptionsStore.getState().updateSubscription('mine', { name: 'Public holidays' });

    expect(calendarApi.updateCalendar).not.toHaveBeenCalled();
    expect(only().name).toBe('Public holidays');
  });
});
