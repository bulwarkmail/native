import { describe, it, expect, vi } from 'vitest';

vi.mock('../../api/calendar', () => ({
  createCalendar: vi.fn(),
  deleteCalendar: vi.fn(),
  parseCalendarBlob: vi.fn(),
  queryEvents: vi.fn(),
  getEventIdentities: vi.fn(),
  deleteEvents: vi.fn(),
  updateEvent: vi.fn(),
  updateCalendar: vi.fn(),
}));
vi.mock('../../api/blob', () => ({ uploadBytes: vi.fn() }));
vi.mock('../../api/jmap-client', () => ({
  jmapClient: { accountId: 'acc-1', isConnected: true },
}));
vi.mock('../calendar-store', () => ({
  useCalendarStore: { getState: () => ({}) },
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
});

describe('updateSubscription', () => {
  it('renames the mirror calendar without re-sending a colour Stalwart 1.0 refuses', async () => {
    const update = calendarApi.updateCalendar as ReturnType<typeof vi.fn>;
    update.mockResolvedValue(undefined);
    useCalendarSubscriptionsStore.setState({
      subscriptions: [{ id: 's', name: 'Feed', url: 'https://example.com/f.ics', color: '#FF2968FF', calendarId: 'c9', lastSyncAt: null, lastError: null }],
    });

    await useCalendarSubscriptionsStore.getState().updateSubscription('s', { name: 'Holidays', color: '#FF2968FF' });

    expect(update).toHaveBeenCalledWith('c9', { name: 'Holidays' });
    expect(useCalendarSubscriptionsStore.getState().subscriptions[0].name).toBe('Holidays');
  });
});
