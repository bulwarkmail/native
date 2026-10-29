import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '../../api/types';
import { feedChanged, feedFields } from '../calendar-feed-diff';

// What CalendarEvent/parse gives for a feed, and what Stalwart 0.16 and 1.0
// give back for the same events once imported (the webmail's
// calendar-subscription-refresh test, from both servers).
const PARSED: Partial<CalendarEvent>[] = [
  { uid: 'e1', title: 'Timed Berlin', description: 'Line one\nLine two', start: '2026-11-10T09:00:00', duration: 'PT1H30M', timeZone: 'Europe/Berlin', status: 'confirmed', locations: { '5960afaa': { '@type': 'Location', name: 'Room 1' } } as never },
  { uid: 'e3', title: 'All day', start: '2026-11-12T00:00:00', duration: 'P1D', showWithoutTime: true },
  {
    uid: 'e5', title: 'Weekly', start: '2026-11-02T08:00:00', duration: 'PT45M', timeZone: 'Europe/Berlin',
    recurrenceRules: [{ frequency: 'weekly', count: 6, byDay: [{ day: 'mo' }] }] as never,
    recurrenceOverrides: {
      '2026-11-09T08:00:00': { excluded: true },
      '2026-11-16T08:00:00': { start: '2026-11-16T10:00:00', updated: '2026-10-20T10:00:00Z', duration: 'PT45M', title: 'Weekly moved' },
    } as never,
  },
  { uid: 'e7', title: 'Zero length', description: 'Zero', start: '2026-11-19T12:00:00', timeZone: 'Etc/UTC' },
];

function stored(version: '0.16' | '1.0'): Partial<CalendarEvent>[] {
  return PARSED.map((p) => {
    const event = { ...p, id: `id-${p.uid}`, calendarIds: { sub: true }, useDefaultAlerts: false } as Partial<CalendarEvent>;
    if (p.uid === 'e7') event.duration = 'PT0S';
    if (p.uid === 'e5') {
      event.recurrenceRules = [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 6, interval: 1, byDay: [{ '@type': 'NDay', day: 'mo' }] }] as never;
      event.recurrenceOverrides = (version === '0.16'
        // 0.16: its own `updated`, keys in another order.
        ? { '2026-11-09T08:00:00': { excluded: true }, '2026-11-16T08:00:00': { title: 'Weekly moved', updated: '2026-10-26T13:31:01Z', duration: 'PT45M', start: '2026-11-16T10:00:00' } }
        // 1.0: only what differs from the series.
        : { '2026-11-09T08:00:00': { excluded: true }, '2026-11-16T08:00:00': { start: '2026-11-16T10:00:00', title: 'Weekly moved' } }) as never;
    }
    return event;
  });
}

describe('feedChanged', () => {
  it.each(['0.16', '1.0'] as const)('finds nothing changed in a feed imported unchanged (%s)', (version) => {
    const back = stored(version);
    PARSED.forEach((p, i) => expect(feedChanged(p, back[i]), p.uid).toBe(false));
  });

  it.each(['0.16', '1.0'] as const)('sees a moved event, a new place, a longer series and a moved occurrence (%s)', (version) => {
    const back = stored(version);
    expect(feedChanged({ ...PARSED[0], start: '2026-11-10T11:00:00' }, back[0])).toBe(true);
    expect(feedChanged({ ...PARSED[0], locations: { x: { '@type': 'Location', name: 'Room 2' } } as never }, back[0])).toBe(true);
    expect(feedChanged({ ...PARSED[2], recurrenceRules: [{ frequency: 'weekly', count: 8, byDay: [{ day: 'mo' }] }] as never }, back[2])).toBe(true);
    expect(feedChanged({
      ...PARSED[2],
      recurrenceOverrides: { ...PARSED[2].recurrenceOverrides, '2026-11-16T08:00:00': { start: '2026-11-16T10:00:00', title: 'Weekly moved again' } } as never,
    }, back[2])).toBe(true);
    expect(feedChanged({ ...PARSED[1], title: 'All day renamed' }, back[1])).toBe(true);
  });
});

describe('feedFields', () => {
  it('writes what the feed decides and leaves the alerts alone', () => {
    const fields = feedFields({ ...PARSED[3], alerts: { a: { '@type': 'Alert' } } as never });
    expect(fields).toMatchObject({ title: 'Zero length', duration: 'PT0S', timeZone: 'Etc/UTC', status: 'confirmed', locations: null });
    expect(fields).not.toHaveProperty('alerts');
    expect(fields).not.toHaveProperty('excludedRecurrenceRules');
    expect(feedFields(PARSED[1])).toMatchObject({ start: '2026-11-12T00:00:00', duration: 'P1D', timeZone: null, showWithoutTime: true });
  });
});
