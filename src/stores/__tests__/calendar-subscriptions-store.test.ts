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

import {
  normalizeFeedUrl,
  selectAccountSubscriptions,
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
