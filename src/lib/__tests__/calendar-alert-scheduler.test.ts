import { describe, it, expect } from 'vitest';
import type { Calendar, CalendarEvent } from '../../api/types';
import {
  computeFireTime,
  computeTaskFireTime,
  getEffectiveAlerts,
  getUpcomingAlerts,
  parseAlertOffset,
} from '../calendar-alert-scheduler';

const now = new Date('2026-03-01T08:00:00Z').getTime();
const HOUR = 3600_000;

const event: CalendarEvent = {
  id: 'ev1',
  uid: 'u1',
  title: 'Standup',
  calendarIds: { 'cal-1': true },
  start: '2026-03-01T10:00:00',
  utcStart: '2026-03-01T09:00:00Z',
  utcEnd: '2026-03-01T09:30:00Z',
  duration: 'PT30M',
  alerts: {
    a1: { trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' }, action: 'display' },
    a2: { trigger: { '@type': 'OffsetTrigger', offset: '-PT5M', relativeTo: 'end' }, action: 'display' },
    a3: { trigger: { '@type': 'AbsoluteTrigger', when: '2026-03-01T08:30:00Z' }, action: 'email' },
  },
};

describe('parseAlertOffset / computeFireTime', () => {
  it('parses signed durations', () => {
    expect(parseAlertOffset('-PT15M')).toBe(-15 * 60_000);
    expect(parseAlertOffset('P1D')).toBe(24 * HOUR);
    expect(parseAlertOffset('PT0S')).toBe(0);
    expect(parseAlertOffset('nope')).toBeNull();
  });

  it('fires relative to utcStart, utcEnd or an absolute instant', () => {
    expect(computeFireTime(event, event.alerts!.a1.trigger)).toBe(new Date('2026-03-01T08:45:00Z').getTime());
    expect(computeFireTime(event, event.alerts!.a2.trigger)).toBe(new Date('2026-03-01T09:25:00Z').getTime());
    expect(computeFireTime(event, event.alerts!.a3.trigger)).toBe(new Date('2026-03-01T08:30:00Z').getTime());
  });

  it('computes an end-relative alert from start + duration when utcEnd is missing', () => {
    const noUtc = { ...event, utcStart: undefined, utcEnd: undefined };
    const startLocal = new Date('2026-03-01T10:00:00').getTime();
    expect(computeFireTime(noUtc, { '@type': 'OffsetTrigger', offset: '-PT5M', relativeTo: 'end' })).toBe(
      startLocal + 30 * 60_000 - 5 * 60_000,
    );
  });

  it('fires task alerts relative to due', () => {
    const task = { ...event, due: '2026-03-02T09:00:00', alerts: undefined };
    expect(computeTaskFireTime(task, { '@type': 'OffsetTrigger', offset: '-PT1H' })).toBe(
      new Date('2026-03-02T09:00:00').getTime() - HOUR,
    );
    expect(computeTaskFireTime({ ...task, due: null }, { '@type': 'OffsetTrigger', offset: '-PT1H' })).toBeNull();
  });

  it('reads a zoned task due in its own time zone', () => {
    const task = { ...event, due: '2026-07-01T17:00:00', timeZone: 'Europe/Berlin', alerts: undefined };
    expect(computeTaskFireTime(task, { '@type': 'OffsetTrigger', offset: '-PT1H' })).toBe(
      new Date('2026-07-01T14:00:00Z').getTime(),
    );
  });
});

describe('getEffectiveAlerts', () => {
  const calendars: Calendar[] = [{
    id: 'cal-1',
    name: 'Personal',
    defaultAlertsWithTime: { d1: { trigger: { '@type': 'OffsetTrigger', offset: '-PT10M' }, action: 'display' } },
    defaultAlertsWithoutTime: { d2: { trigger: { '@type': 'OffsetTrigger', offset: '-PT9H' }, action: 'display' } },
  }];

  it('uses the calendar defaults for useDefaultAlerts events', () => {
    expect(Object.keys(getEffectiveAlerts({ ...event, useDefaultAlerts: true, alerts: undefined }, calendars) ?? {})).toEqual(['d1']);
    expect(Object.keys(getEffectiveAlerts({ ...event, useDefaultAlerts: true, showWithoutTime: true }, calendars) ?? {})).toEqual(['d2']);
    expect(Object.keys(getEffectiveAlerts(event, calendars) ?? {})).toEqual(['a1', 'a2', 'a3']);
  });
});

describe('getUpcomingAlerts', () => {
  it('lists display alerts inside the window, soonest first, skipping cancelled and acknowledged', () => {
    const cancelled = { ...event, id: 'ev2', status: 'cancelled' };
    const acknowledged = {
      ...event,
      id: 'ev3',
      alerts: { a1: { trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' }, action: 'display', acknowledged: '2026-03-01T00:00:00Z' } },
    };
    const task = {
      ...event,
      id: 't1',
      due: '2026-03-01T12:00:00Z',
      alerts: { x: { trigger: { '@type': 'OffsetTrigger', offset: 'PT0S' }, action: 'display' } },
    };
    const doneTask = { ...task, id: 't2', progress: 'completed' };

    const alerts = getUpcomingAlerts([event, cancelled, acknowledged], [task, doneTask], [], { now, horizonMs: 24 * HOUR });
    expect(alerts.map((a) => a.eventId + '/' + a.alertId)).toEqual(['ev1/a1', 'ev1/a2', 't1/x']);
    expect(alerts[0].key).toBe(`ev1:a1:${new Date('2026-03-01T08:45:00Z').getTime()}`);
    expect(alerts[0].body).toBe('Starts in 15 minutes');
    expect(alerts[2].kind).toBe('task');
    expect(alerts[2].body).toBe('Task due');
  });

  it('words the reminders through the translator it is given', () => {
    const untitled = { ...event, title: '' };
    const task = {
      ...untitled,
      id: 't1',
      due: '2026-03-01T12:00:00Z',
      alerts: { x: { trigger: { '@type': 'OffsetTrigger' as const, offset: 'PT0S' }, action: 'display' as const } },
    };
    const t = (key: string, _fallback: string, params?: Record<string, unknown>) =>
      params ? `${key}(${params.count})` : key;
    const [first, , due] = getUpcomingAlerts([untitled], [task], [], { now, horizonMs: 24 * HOUR }, t);
    expect(first.title).toBe('calendar.events.no_title');
    expect(first.body).toBe('calendar.notifications.starts_in_minutes(15)');
    expect(due.title).toBe('calendar.tasks.no_title');
    expect(due.body).toBe('calendar.notifications.task_due');
  });

  it('drops alerts already in the past or beyond the horizon and honours the limit', () => {
    const past = { ...event, id: 'p', utcStart: '2026-03-01T07:00:00Z', utcEnd: '2026-03-01T07:30:00Z' };
    const far = { ...event, id: 'f', utcStart: '2026-03-05T09:00:00Z', utcEnd: '2026-03-05T09:30:00Z' };
    const alerts = getUpcomingAlerts([past, far, event], [], [], { now, horizonMs: 24 * HOUR, limit: 1 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].eventId).toBe('ev1');
  });
});
