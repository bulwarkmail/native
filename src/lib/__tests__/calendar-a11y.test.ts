import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.TZ = 'Europe/Berlin';
});

import { enUS } from 'date-fns/locale';
import type { CalendarEvent } from '../../api/types';
import { formatMessage } from '../../i18n/format';
import { dayCellAccessibilityLabel, eventAccessibilityLabel } from '../calendar-a11y';
import { useSettingsStore } from '../../stores/settings-store';

const t = (_key: string, fallback?: string, params?: Record<string, string | number>) =>
  formatMessage(fallback ?? '', params, 'en');

useSettingsStore.setState({ calendarTimeZone: 'auto' } as never);

const event = (extra: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'e1', uid: 'u1', title: 'Standup', calendarIds: { work: true },
  start: '2026-11-02T09:00:00', duration: 'PT15M', timeZone: 'Europe/Berlin',
  ...extra,
} as CalendarEvent);

describe('dayCellAccessibilityLabel', () => {
  it('reads a month day cell as its full date and how many events it has', () => {
    const day = new Date(2026, 10, 2);
    expect(dayCellAccessibilityLabel(day, 3, t, enUS)).toMatch(/^Monday, Nov(ember)? 2, 2026, 3 events$/);
    expect(dayCellAccessibilityLabel(day, 1, t, enUS)).toMatch(/, 1 event$/);
    expect(dayCellAccessibilityLabel(day, 0, t, enUS)).toMatch(/^Monday, Nov(ember)? 2, 2026$/);
  });
});

describe('eventAccessibilityLabel', () => {
  const calendars = [{ id: 'work', name: 'Work' }];

  it('reads an event block as title, date, time and calendar', () => {
    expect(eventAccessibilityLabel(event({}), { t, locale: enUS, timeFormat: '24h', calendars }))
      .toMatch(/^Standup, Monday, Nov(ember)? 2, 2026, 09:00 – 09:15, Work$/);
  });

  it('says all day for an all-day event and names a cancelled one', () => {
    const allDay = event({ start: '2026-11-02T00:00:00', duration: 'P1D', showWithoutTime: true, timeZone: null as never });
    expect(eventAccessibilityLabel(allDay, { t, locale: enUS, timeFormat: '24h' }))
      .toMatch(/^Standup, Monday, Nov(ember)? 2, 2026, All day$/);
    expect(eventAccessibilityLabel(event({ status: 'cancelled', title: '' }), { t, locale: enUS, timeFormat: '12h' }))
      .toMatch(/^\(No title\), Monday, Nov(ember)? 2, 2026, 9:00 AM – 9:15 AM, Cancelled$/);
  });
});
