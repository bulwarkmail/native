import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Device in New York, calendar in Berlin. At 23:30 UTC on 15 January it is
// still the 15th (18:30) on the device but already the 16th (00:30) on the
// calendar's clock.
vi.hoisted(() => {
  process.env.TZ = 'America/New_York';
});

import { useSettingsStore } from '../../stores/settings-store';
import {
  displayNow,
  displayNowMinutes,
  isDisplayToday,
  isDisplayTomorrow,
} from '../calendar-timezone';
import { buildAgendaDays } from '../calendar-agenda';
import { eventTimeFieldsToSave } from '../event-editor-times';

const NOW = new Date('2026-01-15T23:30:00Z');

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  useSettingsStore.setState({ calendarTimeZone: 'Europe/Berlin' });
});

afterEach(() => {
  vi.useRealTimers();
  useSettingsStore.setState({ calendarTimeZone: 'auto' });
});

describe('today in the calendar time zone', () => {
  it('reads now on a clock in the calendar zone', () => {
    const now = displayNow();
    expect([now.getDate(), now.getHours(), now.getMinutes()]).toEqual([16, 0, 30]);
    expect(displayNowMinutes()).toBe(30);
  });

  it('marks the calendar zone\'s today and tomorrow, not the device\'s', () => {
    expect(isDisplayToday(new Date(2026, 0, 16))).toBe(true);
    expect(isDisplayToday(new Date(2026, 0, 15))).toBe(false);
    expect(isDisplayTomorrow(new Date(2026, 0, 17))).toBe(true);
    expect(isDisplayTomorrow(new Date(2026, 0, 16))).toBe(false);
  });

  it('follows the device again when the calendar does', () => {
    useSettingsStore.setState({ calendarTimeZone: 'auto' });
    expect(displayNow().getDate()).toBe(15);
    expect(displayNowMinutes()).toBe(18 * 60 + 30);
    expect(isDisplayToday(new Date(2026, 0, 15))).toBe(true);
  });

  it('anchors the agenda on the calendar zone\'s today', () => {
    const days = buildAgendaDays(new Map(), { start: new Date(2026, 0, 10), end: new Date(2026, 0, 20) }, displayNow());
    expect(days.map((d) => d.date.getDate())).toEqual([16]);
  });

  it('creates an event from a long press at that hour of the calendar zone', () => {
    // What the grids hand the editor for a long press at 09:00 on the 16th.
    const start = new Date(2026, 0, 16);
    start.setHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60_000);
    expect(eventTimeFieldsToSave({ allDay: false, start, end })).toEqual({
      start: '2026-01-16T09:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
      showWithoutTime: undefined,
    });
  });
});
