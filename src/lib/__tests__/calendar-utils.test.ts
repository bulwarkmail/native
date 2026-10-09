import { describe, it, expect } from 'vitest';
import {
  parseDuration,
  parseLocalDateTime,
  eventTimeRange,
  eventsOnDay,
  normalizeAllDayDuration,
  buildAllDayDuration,
  getCalendarColor,
  getEventStartDate,
  getEventEndDate,
  getTaskDueDate,
  timePattern,
  layoutOverlappingEvents,
  CALENDAR_COLOR_PALETTE,
  applySharedCalendarColors,
  legacySharedCalendarColorKey,
  missingSharedCalendarColors,
  resetSharedCalendarColor,
  sharedCalendarColorFor,
  calendarColorAccount,
  sharedCalendarColorKey,
  claimLegacyCalendarColors,
  legacyCalendarColorClaim,
} from '../calendar-utils';
import type { Calendar, CalendarEvent } from '../../api/types';
import {
  withoutAccountCalendarColors,
  exportableCalendarColors,
  importedCalendarColors,
  isLegacyCalendarColorKey,
  readsLegacyCalendarColors,
  withoutLegacyCalendarColors,
} from '../calendar-color-keys';
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

describe('shared calendar colours', () => {
  // JMAP ids repeat across app accounts: the same `team|c1` can be two
  // different calendars on two servers, so the key names the app account.
  const cal = { id: 'team:c1', originalId: 'c1', accountId: 'team', isShared: true, name: 'T' } as Calendar;

  it('keys an override by app account, JMAP account and the raw calendar id', () => {
    expect(sharedCalendarColorKey('A', cal)).toBe('A|team|c1');
    expect(legacySharedCalendarColorKey(cal)).toBe('team|c1');
  });

  it('keeps two app accounts\' overrides for the same JMAP calendar apart', () => {
    const overrides = { [sharedCalendarColorKey('A', cal)]: '#ff0000' };
    expect(applySharedCalendarColors([cal], overrides, 'A', false)[0].color).toBe('#ff0000');
    expect(applySharedCalendarColors([cal], overrides, 'B', false)[0].color).toBeUndefined();
  });

  it('still shows an override stored under the old key to an account allowed to read it', () => {
    expect(sharedCalendarColorFor({ 'team|c1': '#00ff00' }, 'A', cal, true)).toBe('#00ff00');
    const [shown] = applySharedCalendarColors([cal], { 'team|c1': '#00ff00' }, 'A', true);
    expect(shown.color).toBe('#00ff00');
    expect(shown.colorIsLocalOverride).toBe(true);
  });

  it('prefers the per-account override over the old key', () => {
    const overrides = { 'team|c1': '#00ff00', 'A|team|c1': '#0000ff' };
    expect(sharedCalendarColorFor(overrides, 'A', cal, true)).toBe('#0000ff');
  });

  it('applies no per-account override when no account is shown', () => {
    expect(sharedCalendarColorFor({ 'A|team|c1': '#ff0000' }, '', cal, true)).toBeUndefined();
  });

  it('a reset shadows the old key for that account only, leaving it for the others still allowed to read it', () => {
    const overrides: Record<string, string> = { 'team|c1': '#00ff00' };
    const { key, color } = resetSharedCalendarColor([cal], overrides, 'A', cal);
    expect(key).toBe('A|team|c1');
    // A fresh colour, not the one it had (so it never reverts to it).
    expect(color.toLowerCase()).not.toBe('#00ff00');
    const after = { ...overrides, [key]: color };
    expect(after['team|c1']).toBe('#00ff00');
    expect(sharedCalendarColorFor(after, 'A', cal, true)).toBe(color);
    expect(sharedCalendarColorFor(after, 'B', cal, true)).toBe('#00ff00');
  });

  it('forgets one app account\'s overrides, keeping the others\' and the old keys', () => {
    const overrides = { 'team|c1': '#000001', 'A|team|c1': '#000002', 'A|x|y': '#000003', 'AB|team|c1': '#000004', 'B|team|c1': '#000005' };
    expect(withoutAccountCalendarColors(overrides, 'A'))
      .toEqual({ 'team|c1': '#000001', 'AB|team|c1': '#000004', 'B|team|c1': '#000005' });
    // An old key whose JMAP account id happens to be the app account's stays.
    expect(withoutAccountCalendarColors({ 'A|c1': '#000006' }, 'A')).toEqual({ 'A|c1': '#000006' });
    expect(withoutAccountCalendarColors(overrides, '')).toBe(overrides);
  });

  it('exports the shown account\'s overrides under the old key, and no other account\'s', () => {
    const overrides = { 'team|c1': '#000001', 'team|c2': '#000002', 'A|team|c1': '#000003', 'B|team|c9': '#000004' };
    expect(exportableCalendarColors(overrides, 'A')).toEqual({ 'team|c1': '#000003', 'team|c2': '#000002' });
    expect(exportableCalendarColors(overrides, null)).toEqual({ 'team|c1': '#000001', 'team|c2': '#000002' });
  });

  // During a switch the list is still the previous account's: the shown
  // account's overrides would paint other calendars with the same ids.
  it('paints per-account overrides only on the shown account\'s own list', () => {
    expect(calendarColorAccount('A', 'A')).toBe('A');
    expect(calendarColorAccount('B', 'A')).toBe('');
    expect(calendarColorAccount(null, 'A')).toBe('');
    expect(calendarColorAccount('A', null)).toBe('');
    const [shown] = applySharedCalendarColors([cal], { 'A|team|c1': '#ff0000', 'team|c1': '#00ff00' }, calendarColorAccount('B', 'A'), true);
    expect(shown.color).toBeUndefined();
  });

  it('a reset picks a colour not already on screen', () => {
    const own = { id: 'p', name: 'P', color: '#111111' } as Calendar;
    const { color } = resetSharedCalendarColor([own, cal], { 'A|team|c1': '#222222' }, 'A', cal);
    expect(['#111111', '#222222']).not.toContain(color.toLowerCase());
  });

  it('assigns a colour, under the shown account\'s key, only to shared calendars without one', () => {
    const other = { ...cal, id: 'team:c2', originalId: 'c2' };
    const legacy = { ...cal, id: 'team:c3', originalId: 'c3' };
    const own = { id: 'p', name: 'P', color: '#111111' } as Calendar;
    const overrides = { 'A|team|c1': '#ff0000', 'team|c3': '#00ff00', 'B|team|c2': '#0000ff' };
    const assigned = missingSharedCalendarColors([cal, other, legacy, own], 'A', overrides, 'A', true);
    expect(Object.keys(assigned)).toEqual(['A|team|c2']);
    expect(['#111111', '#ff0000', '#00ff00', '#0000ff']).not.toContain(assigned['A|team|c2'].toLowerCase());
  });

  it('assigns nothing while no account is shown', () => {
    expect(missingSharedCalendarColors([cal], null, {}, '', false)).toEqual({});
  });

  it('assigns nothing while the list still holds another account\'s calendars, then under the new one', () => {
    // A switch shows B at once; the store holds A's list until B's loads.
    expect(missingSharedCalendarColors([cal], 'A', {}, 'B', false)).toEqual({});
    expect(missingSharedCalendarColors([cal], null, {}, 'B', false)).toEqual({});
    expect(Object.keys(missingSharedCalendarColors([cal], 'B', {}, 'B', false))).toEqual(['B|team|c1']);
  });

  it('gives two new shared calendars different colours', () => {
    const other = { ...cal, id: 'team:c2', originalId: 'c2' };
    const assigned = Object.values(missingSharedCalendarColors([cal, other], 'A', {}, 'A', false));
    expect(assigned).toHaveLength(2);
    expect(new Set(assigned.map((c) => c.toLowerCase())).size).toBe(2);
  });

  it('leaves personal calendars alone', () => {
    const own = { ...cal, isShared: false, color: '#123456' };
    expect(applySharedCalendarColors([own], { 'A|team|c1': '#ff0000' }, 'A', false)[0]).toBe(own);
  });

  // The old key names no app account: two servers' shared calendars collide
  // on it. Only the accounts registered at the upgrade read it, until each
  // has claimed it at a full load of its own calendars.
  it('reads the legacy key only for an account still allowed to', () => {
    expect(sharedCalendarColorFor({ 'team|c1': '#00ff00' }, 'A', cal, true)).toBe('#00ff00');
    expect(sharedCalendarColorFor({ 'team|c1': '#00ff00' }, 'B', cal, false)).toBeUndefined();
    expect(sharedCalendarColorFor({ 'team|c1': '#00ff00' }, '', cal, true)).toBeUndefined();
    expect(applySharedCalendarColors([cal], { 'team|c1': '#00ff00' }, 'B', false)[0].color).toBeUndefined();
  });

  it('assigns a fresh colour to a calendar whose only override is a legacy one it may not read', () => {
    const assigned = missingSharedCalendarColors([cal], 'B', { 'team|c1': '#00ff00' }, 'B', false);
    expect(Object.keys(assigned)).toEqual(['B|team|c1']);
    expect(missingSharedCalendarColors([cal], 'A', { 'team|c1': '#00ff00' }, 'A', true)).toEqual({});
  });

  it('claims legacy colours for the account\'s own shared calendars, never over its own key', () => {
    expect(claimLegacyCalendarColors([cal], { 'team|c1': '#00ff00' }, 'A')).toEqual({ 'A|team|c1': '#00ff00' });
    expect(claimLegacyCalendarColors([cal], { 'team|c1': '#00ff00', 'A|team|c1': '#111111' }, 'A')).toEqual({});
  });

  it('claims nothing for personal calendars, calendars without a legacy colour, or no account', () => {
    const own = { id: 'c1', name: 'P', color: '#123456' } as Calendar;
    const other = { ...cal, id: 'team:c2', originalId: 'c2' };
    expect(claimLegacyCalendarColors([own, other], { 'team|c1': '#00ff00', '|c1': '#00ff00' }, 'A')).toEqual({});
    expect(claimLegacyCalendarColors([cal], { 'team|c1': '#00ff00' }, '')).toEqual({});
  });

  // The claim takes the colours for good: run on a list that is not the
  // shown account's own full load, it would hand that account another
  // account's colours, or drop the ones its own list would have claimed.
  it('claims only from the shown account\'s own loaded list', () => {
    const legacy = { 'team|c1': '#00ff00' };
    // The list is still another account's (a switch, or its load went stale).
    expect(legacyCalendarColorClaim([cal], 'B', legacy, 'A', true)).toBeNull();
    // No list loaded for any account yet (reset, or the load failed).
    expect(legacyCalendarColorClaim([cal], null, legacy, 'A', true)).toBeNull();
    // No account shown.
    expect(legacyCalendarColorClaim([cal], 'A', legacy, '', true)).toBeNull();
    // Already claimed, or never allowed to.
    expect(legacyCalendarColorClaim([cal], 'A', legacy, 'A', false)).toBeNull();
    expect(legacyCalendarColorClaim([cal], 'A', legacy, 'A', true)).toEqual({ 'A|team|c1': '#00ff00' });
    // Nothing to claim still finishes the account (so it stops reading them).
    expect(legacyCalendarColorClaim([], 'A', legacy, 'A', true)).toEqual({});
  });
});

describe('legacy calendar colour keys', () => {
  it('tells the old two-part keys from per-account ones', () => {
    expect(isLegacyCalendarColorKey('team|c1')).toBe(true);
    expect(isLegacyCalendarColorKey('c1')).toBe(true);
    expect(isLegacyCalendarColorKey('A|team|c1')).toBe(false);
  });

  it('lets an account read them only while it is a reader, or before the readers are seeded', () => {
    expect(readsLegacyCalendarColors(null, 'A')).toBe(true);
    expect(readsLegacyCalendarColors(['A'], 'A')).toBe(true);
    expect(readsLegacyCalendarColors(['A'], 'B')).toBe(false);
    expect(readsLegacyCalendarColors([], 'A')).toBe(false);
    expect(readsLegacyCalendarColors(null, '')).toBe(false);
    expect(readsLegacyCalendarColors([''], '')).toBe(false);
  });

  it('drops only the legacy keys', () => {
    expect(withoutLegacyCalendarColors({ 'team|c1': '#1', 'A|team|c1': '#2' })).toEqual({ 'A|team|c1': '#2' });
  });

  it('imports a file\'s old-shape colours as the shown account\'s, over its own, keeping the rest', () => {
    const current = { 'A|team|c1': '#000001', 'B|team|c1': '#000002', 'team|c9': '#000009' };
    const file = { 'team|c1': '#00ff00', 'team|c2': '#0000ff', 'X|team|c3': '#ff0000' };
    expect(importedCalendarColors(current, file, 'A')).toEqual({
      'A|team|c1': '#00ff00', 'A|team|c2': '#0000ff', 'B|team|c1': '#000002', 'team|c9': '#000009',
    });
    expect(importedCalendarColors(current, file, null)).toBe(current);
    expect(importedCalendarColors(current, file, '')).toBe(current);
  });
});
