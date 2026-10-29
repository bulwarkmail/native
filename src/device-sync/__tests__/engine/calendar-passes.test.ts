// The calendar passes that need no server writes (device zone change,
// reminder owner change) and the local checks before an upload (a series
// split through CONTENT_EXCEPTION_URI).

import { describe, expect, it, vi } from 'vitest';
import { Events } from '../../android-columns';
import type { CalendarPlanner } from '../../planner';
import { ANDROID_ACCOUNT, CALENDAR_AUTHORITY, createHarness, type Harness } from './harness';
import { toyCalendarPlanner } from './toy-planners';

function withPlanner(h: Harness, overrides: Partial<CalendarPlanner>): CalendarPlanner {
  const planner = { ...toyCalendarPlanner, ...overrides } as CalendarPlanner;
  h.deps.planners = { ...h.deps.planners, calendar: planner };
  return planner;
}

function addServerEvent(h: Harness, title: string): string {
  return h.server.addEvent('a', { uid: `uid-${title}`, title, start: '2026-09-28T09:00:00', duration: 'PT1H', calendarIds: { [h.calendar]: true } });
}

describe('device sync engine: calendar passes', () => {
  it('rewrites clean events for a new device zone, and stores the zone with the last chunk', async () => {
    const h = createHarness({ tuning: { chunkSize: 2 } });
    for (const title of ['A', 'B', 'C']) addServerEvent(h, title);
    await h.run(CALENDAR_AUTHORITY);
    const planZoneChange = vi.fn((local, previousZone: string, ctx) => ({
      ref: String(local.syncId),
      ops: [{ op: 'update' as const, table: 'events' as const, id: local.eventId, values: { eventTimezone: ctx.deviceZone } }],
      previousZone,
    }));
    withPlanner(h, { planZoneChange });
    h.deps.deviceZone = () => 'America/New_York';

    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report.outcome).toBe('ok');
    expect(planZoneChange).toHaveBeenCalledTimes(3);
    expect(planZoneChange.mock.calls.every(([, previous]) => previous === 'Europe/Berlin')).toBe(true);
    expect(h.events().map((e) => e[Events.EVENT_TIMEZONE])).toEqual(['America/New_York', 'America/New_York', 'America/New_York']);
    expect(h.state(CALENDAR_AUTHORITY)).toMatchObject({ deviceZone: 'America/New_York', deviceZonePending: null });
  });

  it('finishes an interrupted zone pass in the next run', async () => {
    const h = createHarness({ tuning: { chunkSize: 1 } });
    for (const title of ['A', 'B', 'C']) addServerEvent(h, title);
    await h.run(CALENDAR_AUTHORITY);
    const planZoneChange = vi.fn((local: { eventId: number; syncId: string | null }) => ({
      ref: String(local.syncId),
      ops: [{ op: 'update' as const, table: 'events' as const, id: local.eventId, values: { eventTimezone: 'America/New_York' } }],
    }));
    withPlanner(h, { planZoneChange });
    h.deps.deviceZone = () => 'America/New_York';
    let zoneChunks = 0;
    h.checkpoints.onCheckpoint = () => {
      if (planZoneChange.mock.calls.length > 0 && ++zoneChunks === 2) h.checkpoints.crashAt = h.checkpoints.count;
    };

    await h.run(CALENDAR_AUTHORITY);
    expect(h.state(CALENDAR_AUTHORITY)).toMatchObject({ deviceZone: 'Europe/Berlin', deviceZonePending: 'America/New_York' });

    h.checkpoints.crashAt = null;
    h.checkpoints.onCheckpoint = undefined;
    await h.run(CALENDAR_AUTHORITY);
    expect(h.state(CALENDAR_AUTHORITY)).toMatchObject({ deviceZone: 'America/New_York', deviceZonePending: null });
    expect(h.events().every((e) => e[Events.EVENT_TIMEZONE] === 'America/New_York')).toBe(true);
  });

  it('uploads with the old reminder owner, then rewrites the reminders and the calendar rows for the new one', async () => {
    const h = createHarness();
    addServerEvent(h, 'Standup');
    await h.run(CALENDAR_AUTHORITY);
    expect(h.device.rows('calendars')[0]).toMatchObject({ maxReminders: 5 });
    const owners: string[] = [];
    const planReminderOwnerChange = vi.fn((local: { eventId: number; syncId: string | null }, ctx: { reminderOwner: string }) => {
      owners.push(ctx.reminderOwner);
      return { ref: String(local.syncId), ops: [{ op: 'delete' as const, table: 'reminders' as const, where: 'event_id = ?', args: [local.eventId] }] };
    });
    const planUpload = vi.fn(toyCalendarPlanner.planUpload);
    withPlanner(h, { planReminderOwnerChange, planUpload });
    h.device.user.setReminders(Number(h.events()[0]._id), [{ minutes: 10 }]);
    h.device.user.updateEvent(Number(h.events()[0]._id), { title: 'Daily standup' });
    h.prefs.reminderOwner = 'bulwark';

    await h.run(CALENDAR_AUTHORITY);

    expect(planUpload.mock.calls.map(([, ctx]) => ctx.reminderOwner)).toEqual(['device']);
    expect(owners).toEqual(['bulwark']);
    expect(h.device.rows('reminders')).toEqual([]);
    expect(h.device.rows('calendars')[0]).toMatchObject({ maxReminders: 0 });
    expect(h.state(CALENDAR_AUTHORITY)?.reminderOwner).toBe('bulwark');
  });

  it('uploads the clone of a CONTENT_EXCEPTION_URI split as a new event after its source', async () => {
    const h = createHarness();
    const series = addServerEvent(h, 'Series');
    await h.run(CALENDAR_AUTHORITY);
    const master = h.events()[0];
    // A recurring master, as a calendar app sees it.
    await h.device.port(ANDROID_ACCOUNT, CALENDAR_AUTHORITY).applyBatch([
      { op: 'update', table: 'events', id: Number(master._id), values: { rrule: 'FREQ=DAILY', duration: 'P3600S', dtend: null } },
    ]);
    const planUpload = vi.fn(toyCalendarPlanner.planUpload);
    withPlanner(h, { planUpload });
    const clone = h.device.user.splitViaUri(Number(master._id), Date.UTC(2026, 9, 1, 9), '20260930T235959Z', { title: 'Series (later)' });

    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report.outcome).toBe('ok');
    // The source was planned while the split was visible, before its clone was claimed.
    const splits = planUpload.mock.calls.map(([local]) => local.split);
    expect(splits.indexOf('source')).toBeLessThan(splits.indexOf('clone'));
    const events = h.server.all('CalendarEvent', 'a');
    expect(events.map((e) => e.title).sort()).toEqual(['Series', 'Series (later)']);
    const cloneRow = h.events().find((e) => Number(e._id) === clone)!;
    expect(cloneRow._sync_id).not.toBe(`a/${series}`);
    expect(cloneRow._sync_id).toMatch(/^a\//);
    expect(new Set(h.events().map((e) => e._sync_id)).size).toBe(2);
  });
});
