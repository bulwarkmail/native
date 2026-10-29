import { describe, it, expect } from 'vitest';
import {
  parseDuration,
  parseLocalDateTime,
  eventTimeRange,
  eventsOnDay,
  normalizeAllDayDuration,
  buildAllDayDuration,
  changedCalendarFields,
  getCalendarColor,
  getEventStartDate,
  getEventEndDate,
  getTaskDueDate,
  timePattern,
  layoutOverlappingEvents,
  CALENDAR_COLOR_PALETTE,
  reopenedEdit,
  getTimedEventBoundsForDay,
} from '../calendar-utils';
import type { CalendarEvent } from '../../api/types';
import { useSettingsStore } from '../../stores/settings-store';

function ev(partial: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'e',
    uid: 'u',
    title: 't',
    start: '2026-04-20T09:00:00',
    calendarIds: { 'cal-1': true },
    ...partial,
  } as CalendarEvent;
}

describe('parseDuration', () => {
  it('parses hours and minutes', () => {
    expect(parseDuration('PT1H30M')).toBe((60 + 30) * 60 * 1000);
  });
  it('parses days', () => {
    expect(parseDuration('P2D')).toBe(2 * 24 * 60 * 60 * 1000);
  });
  it('parses minutes only', () => {
    expect(parseDuration('PT45M')).toBe(45 * 60 * 1000);
  });
  it('returns 0 for undefined', () => {
    expect(parseDuration(undefined)).toBe(0);
  });
  it('returns 0 for malformed', () => {
    expect(parseDuration('not-a-duration')).toBe(0);
  });
});

describe('parseLocalDateTime', () => {
  it('parses floating local time without applying timezone shift', () => {
    const d = parseLocalDateTime('2026-04-20T09:00:00');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3);
    expect(d.getDate()).toBe(20);
    expect(d.getHours()).toBe(9);
  });
});

describe('getEventStartDate / getEventEndDate malformed utc fallback', () => {
  // Mirrors webmail (#316): a malformed utcStart/utcEnd must fall back to the
  // floating `start` + duration instead of producing an Invalid Date, which
  // would silently drop the event from the day index and every view.
  it('falls back to start when utcStart is unparseable', () => {
    const d = getEventStartDate(ev({ utcStart: 'garbage' }));
    expect(isNaN(d.getTime())).toBe(false);
    expect(d.getHours()).toBe(9);
  });

  it('falls back to start + duration when utcEnd is unparseable', () => {
    const end = getEventEndDate(ev({ utcEnd: 'garbage', duration: 'PT1H' }));
    expect(isNaN(end.getTime())).toBe(false);
    const start = getEventStartDate(ev({}));
    expect(end.getTime() - start.getTime()).toBe(60 * 60 * 1000);
  });
});

describe('getTaskDueDate', () => {
  it('reads a timed due as wall time in the task zone', () => {
    const d = getTaskDueDate({ due: '2026-07-01T17:00:00', timeZone: 'Europe/Berlin' });
    expect(d?.toISOString()).toBe('2026-07-01T15:00:00.000Z');
    const winter = getTaskDueDate({ due: '2026-01-15T17:00:00', timeZone: 'Europe/Berlin' });
    expect(winter?.toISOString()).toBe('2026-01-15T16:00:00.000Z');
  });

  it('reads a floating due in the calendar time zone, like a floating event', () => {
    // Default setting: the device zone.
    expect(getTaskDueDate({ due: '2026-07-01T17:00:00' })?.getTime())
      .toBe(new Date('2026-07-01T17:00:00').getTime());
    useSettingsStore.setState({ calendarTimeZone: 'America/New_York' });
    try {
      expect(getTaskDueDate({ due: '2026-07-01T17:00:00' })?.toISOString())
        .toBe('2026-07-01T21:00:00.000Z');
      expect(getTaskDueDate({ due: '2026-07-01T17:00:00', timeZone: null })?.toISOString())
        .toBe('2026-07-01T21:00:00.000Z');
      // A due with its own zone keeps it.
      expect(getTaskDueDate({ due: '2026-07-01T17:00:00', timeZone: 'Europe/Berlin' })?.toISOString())
        .toBe('2026-07-01T15:00:00.000Z');
      // Dates stay dates.
      expect(getTaskDueDate({ due: '2026-07-01T00:00:00', showWithoutTime: true })?.getTime())
        .toBe(new Date('2026-07-01T00:00:00').getTime());
    } finally {
      useSettingsStore.setState({ calendarTimeZone: 'auto' });
    }
  });

  it('keeps date-only and all-day dues as calendar dates', () => {
    expect(getTaskDueDate({ due: '2026-07-01', timeZone: 'Europe/Berlin' })?.getTime())
      .toBe(new Date('2026-07-01T00:00:00').getTime());
    expect(getTaskDueDate({ due: '2026-07-01T00:00:00', timeZone: 'Europe/Berlin', showWithoutTime: true })?.getTime())
      .toBe(new Date('2026-07-01T00:00:00').getTime());
  });

  it('falls back to wall time for an unknown zone and returns null without a valid due', () => {
    expect(getTaskDueDate({ due: '2026-07-01T17:00:00', timeZone: 'Mars/Olympus' })?.getTime())
      .toBe(new Date('2026-07-01T17:00:00').getTime());
    expect(getTaskDueDate({ due: null })).toBeNull();
    expect(getTaskDueDate({ due: 'garbage', timeZone: 'Europe/Berlin' })).toBeNull();
  });
});

describe('timePattern', () => {
  it('maps 12h to an am/pm pattern and 24h (or undefined) to HH:mm', () => {
    expect(timePattern('12h')).toBe('h:mm a');
    expect(timePattern('24h')).toBe('HH:mm');
    expect(timePattern(undefined)).toBe('HH:mm');
  });
});

describe('eventTimeRange', () => {
  it('returns start, end, allDay for a timed event with utcStart/utcEnd', () => {
    const range = eventTimeRange(ev({
      utcStart: '2026-04-20T09:00:00Z',
      utcEnd: '2026-04-20T10:00:00Z',
      duration: 'PT1H',
    }));
    expect(range.allDay).toBe(false);
    expect(range.end.getTime() - range.start.getTime()).toBe(60 * 60 * 1000);
  });

  it('falls back to start + duration when utcEnd missing', () => {
    const range = eventTimeRange(ev({ duration: 'PT2H' }));
    expect(range.end.getTime() - range.start.getTime()).toBe(2 * 60 * 60 * 1000);
  });

  it('marks allDay when showWithoutTime', () => {
    const range = eventTimeRange(ev({ showWithoutTime: true, duration: 'P1D' }));
    expect(range.allDay).toBe(true);
  });
});

describe('eventsOnDay', () => {
  it('returns events that start on the given day', () => {
    const day = new Date(2026, 3, 20);
    const events = [
      ev({ id: 'a', start: '2026-04-20T09:00:00', duration: 'PT1H' }),
      ev({ id: 'b', start: '2026-04-21T09:00:00', duration: 'PT1H' }),
    ];
    const result = eventsOnDay(events, day);
    expect(result.map((e) => e.id)).toEqual(['a']);
  });

  it('returns multi-day events overlapping the given day', () => {
    const day = new Date(2026, 3, 21);
    const events = [
      ev({
        id: 'multi',
        start: '2026-04-20T00:00:00',
        showWithoutTime: true,
        duration: 'P3D',
      }),
    ];
    const result = eventsOnDay(events, day);
    expect(result.map((e) => e.id)).toEqual(['multi']);
  });

  it('does not return events that start exactly at midnight of the next day', () => {
    const day = new Date(2026, 3, 20);
    const events = [
      ev({
        id: 'edge',
        start: '2026-04-21T00:00:00',
        duration: 'PT1H',
      }),
    ];
    expect(eventsOnDay(events, day)).toHaveLength(0);
  });
});

describe('normalizeAllDayDuration', () => {
  it('rounds up to whole days', () => {
    expect(normalizeAllDayDuration('PT25H')).toBe('P2D');
  });
  it('returns at least P1D', () => {
    expect(normalizeAllDayDuration('PT1H')).toBe('P1D');
  });
  it('returns undefined when input undefined', () => {
    expect(normalizeAllDayDuration(undefined)).toBe(undefined);
  });
});

describe('buildAllDayDuration', () => {
  it('builds a one-day duration when same day', () => {
    const start = new Date(2026, 3, 20);
    expect(buildAllDayDuration(start, start)).toBe('P1D');
  });
  it('builds a multi-day duration inclusive of end', () => {
    const start = new Date(2026, 3, 20);
    const end = new Date(2026, 3, 22);
    expect(buildAllDayDuration(start, end)).toBe('P3D');
  });
});

describe('getCalendarColor', () => {
  it('uses provided color when present', () => {
    expect(getCalendarColor({ id: 'x', color: '#ff0000' })).toBe('#ff0000');
  });

  it('falls back to a deterministic palette color', () => {
    const a = getCalendarColor({ id: 'cal-1' });
    const b = getCalendarColor({ id: 'cal-1' });
    expect(a).toBe(b);
    expect(CALENDAR_COLOR_PALETTE).toContain(a);
  });

  it('returns the first palette color when undefined', () => {
    expect(getCalendarColor(undefined)).toBe(CALENDAR_COLOR_PALETTE[0]);
  });
});

describe('layoutOverlappingEvents', () => {
  it('packs non-overlapping events into the same column', () => {
    const day = new Date(2026, 3, 20);
    const events = [
      ev({
        id: 'a', start: '2026-04-20T09:00:00',
        utcStart: '2026-04-20T09:00:00Z', utcEnd: '2026-04-20T10:00:00Z',
        duration: 'PT1H',
      }),
      ev({
        id: 'b', start: '2026-04-20T10:00:00',
        utcStart: '2026-04-20T10:00:00Z', utcEnd: '2026-04-20T11:00:00Z',
        duration: 'PT1H',
      }),
    ];
    const layout = layoutOverlappingEvents(events, day);
    expect(layout).toHaveLength(2);
    expect(layout[0].column).toBe(0);
    expect(layout[1].column).toBe(0);
    expect(layout[0].totalColumns).toBe(1);
  });

  it('places overlapping events into separate columns', () => {
    const day = new Date(2026, 3, 20);
    const events = [
      ev({
        id: 'a', start: '2026-04-20T09:00:00',
        utcStart: '2026-04-20T09:00:00Z', utcEnd: '2026-04-20T11:00:00Z',
        duration: 'PT2H',
      }),
      ev({
        id: 'b', start: '2026-04-20T10:00:00',
        utcStart: '2026-04-20T10:00:00Z', utcEnd: '2026-04-20T12:00:00Z',
        duration: 'PT2H',
      }),
    ];
    const layout = layoutOverlappingEvents(events, day);
    expect(layout).toHaveLength(2);
    const cols = layout.map((l) => l.column).sort();
    expect(cols).toEqual([0, 1]);
    expect(layout[0].totalColumns).toBe(2);
  });

  it('skips all-day events', () => {
    const day = new Date(2026, 3, 20);
    const events = [
      ev({ id: 'all', showWithoutTime: true, duration: 'P1D' }),
    ];
    expect(layoutOverlappingEvents(events, day)).toHaveLength(0);
  });
});

// Stalwart 1.0 accepts a calendar colour only as #rgb, #rrggbb or a CSS name
// (groupware/src/calendar/color.rs). The edit sheet sent the colour with
// every rename, so a calendar another client coloured with Apple's 8-digit
// hex could not be renamed.
describe('changedCalendarFields', () => {
  const apple = { id: 'c1', name: 'Home', color: '#FF2968FF', description: 'Family' };

  it('sends only the new name of a calendar whose colour came from another client', () => {
    expect(changedCalendarFields(apple, { name: 'House', color: '#FF2968FF', description: 'Family' })).toEqual({ name: 'House' });
  });

  it('sends a colour the user picked, and clears an emptied description', () => {
    expect(changedCalendarFields(apple, { name: 'Home', color: '#3b82f6', description: '' })).toEqual({
      color: '#3b82f6',
      description: null,
    });
  });

  it('compares with the colour the editor showed for a calendar without one', () => {
    const plain = { id: 'c2', name: 'Work' };
    expect(changedCalendarFields(plain, { name: 'Work', color: getCalendarColor(plain).toUpperCase(), description: '' })).toEqual({});
  });
});

describe('reopenedEdit', () => {
  it('puts the unsaved edits over the event and drops cleared fields', () => {
    const event = {
      id: 'e1', title: 'Team sync', start: '2026-10-19T10:00:00', duration: 'PT30M',
      locations: { l: { '@type': 'Location', name: 'Room 2' } },
    } as unknown as CalendarEvent;
    const reopened = reopenedEdit(event, { title: 'Team sync (moved)', start: '2026-10-19T11:00:00', locations: null });
    expect(reopened.id).toBe('e1');
    expect(reopened.title).toBe('Team sync (moved)');
    expect(reopened.start).toBe('2026-10-19T11:00:00');
    expect(reopened.duration).toBe('PT30M');
    expect('locations' in reopened).toBe(false);
  });
});

describe('getTimedEventBoundsForDay on DST change days', () => {
  it('places events by wall-clock time, not elapsed time since midnight', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'Europe/Berlin';
    try {
      // 2026-10-25 has 25 hours in Berlin; 12:51 CET is 13h51m after midnight.
      const fallBack = ev({
        start: '2026-10-25T12:51:00',
        timeZone: 'Europe/Berlin',
        utcStart: '2026-10-25T11:51:00Z',
        utcEnd: '2026-10-25T12:16:00Z',
        duration: 'PT25M',
      });
      expect(getTimedEventBoundsForDay(fallBack, new Date(2026, 9, 25))).toMatchObject({
        startMinutes: 12 * 60 + 51,
        endMinutes: 13 * 60 + 16,
      });

      // 2026-03-29 has 23 hours; 09:00 CEST is 8h after midnight.
      const springForward = ev({
        start: '2026-03-29T09:00:00',
        timeZone: 'Europe/Berlin',
        utcStart: '2026-03-29T07:00:00Z',
        utcEnd: '2026-03-29T08:00:00Z',
        duration: 'PT1H',
      });
      expect(getTimedEventBoundsForDay(springForward, new Date(2026, 2, 29))).toMatchObject({
        startMinutes: 9 * 60,
        endMinutes: 10 * 60,
      });
    } finally {
      process.env.TZ = tz;
    }
  });
});

describe('getEventEndDate', () => {
  // #837: Stalwart stores a DTEND equal to DTSTART as no duration and ends
  // the event at 23:59:59 of its day.
  it('ends a timed event without a duration at its start, whatever utcEnd says', () => {
    const zero = ev({ start: '2026-03-02T09:00:00', utcStart: '2026-03-02T09:00:00Z', utcEnd: '2026-03-02T23:59:59Z' });
    delete (zero as Partial<CalendarEvent>).duration;
    expect(getEventEndDate(zero).getTime()).toBe(getEventStartDate(zero).getTime());
  });
});
