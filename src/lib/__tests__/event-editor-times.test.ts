import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The device is in New York, the calendar is set to Berlin: every time the
// editors show is a Berlin wall clock held in a New York Date.
vi.hoisted(() => {
  process.env.TZ = 'America/New_York';
});

import { useSettingsStore } from '../../stores/settings-store';
import {
  displayNow,
  fromDisplayDate,
  getDeviceTimeZone,
  localDateTimeToInstant,
  toDisplayDate,
} from '../calendar-timezone';
import { getEventStartDate, getTaskDueDate, getTaskDueDisplayDate } from '../calendar-utils';
import {
  durationBetween,
  editorTimesFromEvent,
  eventTimeFieldsToSave,
  type EditorTimes,
} from '../event-editor-times';
import { buildTaskEditorChanges, taskEditorFromTask } from '../task-editor';
import type { CalendarEvent } from '../../api/types';

function ev(partial: Partial<CalendarEvent>): CalendarEvent {
  return { id: 'e1', uid: 'u', title: 'Standup', calendarIds: { c: true }, ...partial } as CalendarEvent;
}

function shift(times: EditorTimes, part: 'start' | 'end' | 'both', minutes: number): EditorTimes {
  const move = (d: Date) => new Date(d.getTime() + minutes * 60_000);
  return {
    ...times,
    start: part === 'end' ? times.start : move(times.start),
    end: part === 'start' ? times.end : move(times.end),
  };
}

beforeEach(() => {
  useSettingsStore.setState({ calendarTimeZone: 'Europe/Berlin' });
});

afterEach(() => {
  useSettingsStore.setState({ calendarTimeZone: 'auto' });
});

describe('display dates', () => {
  it('runs on a device zone other than the calendar zone', () => {
    expect(getDeviceTimeZone()).toBe('America/New_York');
  });

  it('shows an instant as the wall clock in the calendar zone and converts it back', () => {
    const instant = new Date('2026-01-15T08:00:00Z'); // 09:00 Berlin, 03:00 New York
    const shown = toDisplayDate(instant);
    expect([shown.getDate(), shown.getHours(), shown.getMinutes()]).toEqual([15, 9, 0]);
    expect(fromDisplayDate(shown).toISOString()).toBe('2026-01-15T08:00:00.000Z');
    expect(displayNow().getTime()).not.toBe(Number.NaN);
  });

  it('is the identity when the calendar follows the device', () => {
    useSettingsStore.setState({ calendarTimeZone: 'auto' });
    const instant = new Date('2026-01-15T08:00:00Z');
    expect(toDisplayDate(instant)).toBe(instant);
  });

  it('reads a wall clock the device skips (its own DST gap) from the digits', () => {
    // 02:30 on 8 March 2026 does not exist in New York; in Berlin it does.
    expect(localDateTimeToInstant('2026-03-08T02:30:00', 'Europe/Berlin')?.toISOString())
      .toBe('2026-03-08T01:30:00.000Z');
  });

  it('places events and task dues in the calendar zone, reminders at the instant', () => {
    const start = getEventStartDate(ev({ start: '2026-01-15T09:00:00', timeZone: 'America/Los_Angeles', utcStart: '2026-01-15T17:00:00Z' }));
    expect([start.getDate(), start.getHours()]).toEqual([15, 18]);
    // Without utcStart the start is converted from its own zone.
    const noUtc = getEventStartDate(ev({ start: '2026-01-15T09:00:00', timeZone: 'America/Los_Angeles' }));
    expect(noUtc.getHours()).toBe(18);

    const task = { due: '2026-07-01T17:00:00', timeZone: 'America/Los_Angeles' };
    expect(getTaskDueDate(task)?.toISOString()).toBe('2026-07-02T00:00:00.000Z');
    const shown = getTaskDueDisplayDate(task)!;
    expect([shown.getDate(), shown.getHours()]).toEqual([2, 2]);
  });
});

describe('event editor round trip', () => {
  it('saves an untouched event exactly as stored', () => {
    const events = [
      ev({ start: '2026-01-15T09:00:00', timeZone: 'Europe/Berlin', duration: 'PT1H', utcStart: '2026-01-15T08:00:00Z', utcEnd: '2026-01-15T09:00:00Z' }),
      ev({ start: '2026-01-15T09:00:00', timeZone: 'America/Los_Angeles', duration: 'PT45M', utcStart: '2026-01-15T17:00:00Z', utcEnd: '2026-01-15T17:45:00Z' }),
      ev({ start: '2026-01-15T09:00:00', timeZone: null, duration: 'PT1H', utcStart: '2026-01-15T08:00:00Z', utcEnd: '2026-01-15T09:00:00Z' }),
      ev({ start: '2026-03-29T00:00:00', showWithoutTime: true, timeZone: null, duration: 'P1D' }),
      ev({ start: '2026-03-27T00:00:00', showWithoutTime: true, timeZone: null, duration: 'P3D' }),
    ];
    for (const event of events) {
      expect(eventTimeFieldsToSave(editorTimesFromEvent(event), event)).toEqual({
        start: event.start,
        duration: event.duration,
        timeZone: event.showWithoutTime ? null : event.timeZone,
        showWithoutTime: !!event.showWithoutTime,
      });
    }
  });

  it('shows an event from another zone in the calendar zone and keeps it in its own zone', () => {
    const event = ev({
      start: '2026-01-15T09:00:00', timeZone: 'America/Los_Angeles', duration: 'PT1H',
      utcStart: '2026-01-15T17:00:00Z', utcEnd: '2026-01-15T18:00:00Z',
    });
    const times = editorTimesFromEvent(event);
    expect(times.start.getHours()).toBe(18);

    expect(eventTimeFieldsToSave(shift(times, 'both', 60), event)).toEqual({
      start: '2026-01-15T10:00:00',
      duration: 'PT1H',
      timeZone: 'America/Los_Angeles',
      showWithoutTime: false,
    });
  });

  it('keeps a floating start floating unless the start itself changes', () => {
    const event = ev({
      start: '2026-01-15T09:00:00', timeZone: null, duration: 'PT1H',
      utcStart: '2026-01-15T08:00:00Z', utcEnd: '2026-01-15T09:00:00Z',
    });
    const times = editorTimesFromEvent(event);
    expect(times.start.getHours()).toBe(9);

    expect(eventTimeFieldsToSave(shift(times, 'end', 30), event)).toEqual({
      start: '2026-01-15T09:00:00', duration: 'PT1H30M', timeZone: null, showWithoutTime: false,
    });
    // A moved start is labelled with the zone it was entered in.
    expect(eventTimeFieldsToSave(shift(times, 'both', 60), event)).toEqual({
      start: '2026-01-15T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false,
    });
  });

  it('keeps all-day events on their dates', () => {
    const event = ev({ start: '2026-03-29T00:00:00', showWithoutTime: true, timeZone: null, duration: 'P1D' });
    const times = editorTimesFromEvent(event);
    expect([times.start.getDate(), times.end.getDate()]).toEqual([29, 29]);

    const longer = { ...times, end: new Date(2026, 2, 30) };
    expect(eventTimeFieldsToSave(longer, event)).toEqual({
      start: '2026-03-29T00:00:00', duration: 'P2D', timeZone: null, showWithoutTime: true,
    });
  });

  it('keeps the real length across a DST change in the calendar zone', () => {
    // 01:30 CET -> 03:30 CEST on 29 March 2026 in Berlin: one hour, though
    // the wall clocks (and the display dates) are two hours apart.
    const event = ev({
      start: '2026-03-29T01:30:00', timeZone: 'Europe/Berlin', duration: 'PT1H',
      utcStart: '2026-03-29T00:30:00Z', utcEnd: '2026-03-29T01:30:00Z',
    });
    const times = editorTimesFromEvent(event);
    expect([times.start.getHours(), times.end.getHours()]).toEqual([1, 3]);

    expect(eventTimeFieldsToSave(times, event).duration).toBe('PT1H');
    // Starting half an hour earlier keeps the end where it was.
    expect(eventTimeFieldsToSave(shift(times, 'start', -30), event)).toEqual({
      start: '2026-03-29T01:00:00', duration: 'PT1H30M', timeZone: 'Europe/Berlin', showWithoutTime: false,
    });
  });

  it('never moves an event whose calendar-zone time does not exist on the device', () => {
    // 02:30 Berlin on 8 March 2026 falls into New York's spring-forward gap,
    // so its display date reads 03:30.
    const event = ev({
      start: '2026-03-08T02:30:00', timeZone: 'Europe/Berlin', duration: 'PT1H',
      utcStart: '2026-03-08T01:30:00Z', utcEnd: '2026-03-08T02:30:00Z',
    });
    const times = editorTimesFromEvent(event);
    expect(times.start.getHours()).toBe(3);

    expect(eventTimeFieldsToSave(times, event)).toMatchObject({ start: '2026-03-08T02:30:00', duration: 'PT1H' });
    // Only the end moved: the start stays as stored, the length is exact.
    expect(eventTimeFieldsToSave(shift(times, 'end', 60), event)).toEqual({
      start: '2026-03-08T02:30:00', duration: 'PT2H', timeZone: 'Europe/Berlin', showWithoutTime: false,
    });
  });

  it('saves a new event in the calendar zone', () => {
    const times = { allDay: false, start: new Date(2026, 0, 15, 9, 0), end: new Date(2026, 0, 15, 10, 30) };
    expect(eventTimeFieldsToSave(times)).toEqual({
      start: '2026-01-15T09:00:00', duration: 'PT1H30M', timeZone: 'Europe/Berlin', showWithoutTime: undefined,
    });
  });

  it('counts whole days as calendar days in the event zone', () => {
    const at = (value: string) => localDateTimeToInstant(value, 'Europe/Berlin')!;
    // 47 hours across the change, but two calendar days.
    expect(durationBetween(at('2026-03-28T10:00:00'), at('2026-03-30T10:00:00'), 'Europe/Berlin')).toBe('P2D');
    expect(durationBetween(at('2026-03-28T10:00:00'), at('2026-03-29T12:00:00'), 'Europe/Berlin')).toBe('P1DT2H');
    expect(durationBetween(at('2026-01-15T09:00:00'), at('2026-01-15T09:45:00'), 'Europe/Berlin')).toBe('PT45M');
  });
});

describe('task editor round trip', () => {
  const task = (partial: Partial<CalendarEvent>) =>
    ({ id: 't1', title: 'Pay rent', calendarIds: { c: true }, ...partial }) as CalendarEvent;

  it('sends no due for an untouched task', () => {
    for (const t of [
      task({ due: '2026-07-01T17:00:00', timeZone: 'America/Los_Angeles' }),
      task({ due: '2026-07-01T17:00:00' }),
      task({ due: '2026-07-01' }),
      task({ due: '2026-07-01T00:00:00', showWithoutTime: true }),
      task({ due: '2026-03-08T02:30:00', timeZone: 'Europe/Berlin' }),
    ]) {
      const changes = buildTaskEditorChanges(taskEditorFromTask(t, 'c'), t);
      expect(changes).not.toHaveProperty('due');
      expect(changes).not.toHaveProperty('timeZone');
      expect(changes).not.toHaveProperty('showWithoutTime');
    }
  });

  it('shows a due in the calendar zone and saves a change in the task\'s own zone', () => {
    const t = task({ due: '2026-07-01T17:00:00', timeZone: 'America/Los_Angeles' });
    const editor = taskEditorFromTask(t, 'c');
    expect([editor.due!.getDate(), editor.due!.getHours()]).toEqual([2, 2]);

    const later = { ...editor, due: new Date(editor.due!.getTime() + 60 * 60_000) };
    expect(buildTaskEditorChanges(later, t)).toMatchObject({
      due: '2026-07-01T18:00:00', timeZone: 'America/Los_Angeles', showWithoutTime: false,
    });
  });

  it('labels a changed floating due with the calendar zone', () => {
    const t = task({ due: '2026-07-01T17:00:00' });
    const editor = taskEditorFromTask(t, 'c');
    expect(editor.due!.getHours()).toBe(17);

    const later = { ...editor, due: new Date(editor.due!.getTime() + 60 * 60_000) };
    expect(buildTaskEditorChanges(later, t)).toMatchObject({
      due: '2026-07-01T18:00:00', timeZone: 'Europe/Berlin', showWithoutTime: false,
    });
  });

  it('keeps a date-only due a date', () => {
    const t = task({ due: '2026-07-01' });
    const editor = taskEditorFromTask(t, 'c');
    expect(editor.withTime).toBe(false);

    expect(buildTaskEditorChanges({ ...editor, due: new Date(2026, 6, 2) }, t)).toMatchObject({
      due: '2026-07-02T00:00:00', showWithoutTime: true, timeZone: null,
    });
  });
});
