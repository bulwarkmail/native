import { describe, expect, it, vi } from 'vitest';
import { canRemoveCancelled, planCancellationRemoval, removeCancelledMeeting, type CancellationRemoval } from '../calendar-cancellation';
import type { CalendarEvent } from '../../api/types';

function stored(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'ev-1',
    uid: 'meeting@example.com',
    title: 'Weekly sync',
    start: '2026-11-02T10:00:00',
    timeZone: 'Europe/Berlin',
    duration: 'PT1H',
    sequence: 1,
    recurrenceId: null,
    recurrenceRules: null,
    recurrenceOverrides: null,
    ...overrides,
  } as CalendarEvent;
}

const WEEKLY = [{ '@type': 'RecurrenceRule', frequency: 'weekly' }] as CalendarEvent['recurrenceRules'];

describe('planCancellationRemoval', () => {
  it('deletes every stored event of a cancelled meeting, and nothing else', () => {
    const events = [
      stored({ id: 'ev-1' }),
      stored({ id: 'ev-2', recurrenceId: '2026-11-09T10:00:00' }),
      stored({ id: 'other', uid: 'other@example.com' }),
    ];
    expect(planCancellationRemoval(events, { uid: 'meeting@example.com', sequence: 1 }))
      .toEqual({ kind: 'delete', ids: ['ev-1', 'ev-2'] });
  });

  it('removes nothing when the calendar does not hold the meeting', () => {
    expect(planCancellationRemoval([stored({ uid: 'other@example.com' })], { uid: 'meeting@example.com' }))
      .toEqual({ kind: 'none' });
  });

  it('leaves the meeting when the calendar holds a newer version than the cancellation', () => {
    expect(planCancellationRemoval([stored({ sequence: 3 })], { uid: 'meeting@example.com', sequence: 2 }))
      .toEqual({ kind: 'outdated' });
  });

  it('applies a cancellation with the same sequence, as Stalwart leaves it after marking it cancelled', () => {
    expect(planCancellationRemoval([stored({ sequence: 2, status: 'cancelled' })], { uid: 'meeting@example.com', sequence: 2 }))
      .toEqual({ kind: 'delete', ids: ['ev-1'] });
  });

  it('excludes one cancelled occurrence on the series instead of deleting it', () => {
    const series = stored({ recurrenceRules: WEEKLY, recurrenceOverrides: null });
    expect(planCancellationRemoval([series], {
      uid: 'meeting@example.com',
      recurrenceId: '2026-11-09T10:00:00',
      recurrenceIdTimeZone: 'Europe/Berlin',
      sequence: 1,
    })).toEqual({
      kind: 'exclude',
      id: 'ev-1',
      patch: { recurrenceOverrides: { '2026-11-09T10:00:00': { excluded: true } } },
    });
  });

  it('names the occurrence in the series time zone and keeps the other overrides', () => {
    const series = stored({
      recurrenceRules: WEEKLY,
      recurrenceOverrides: { '2026-11-16T10:00:00': { title: 'Moved sync' } },
    });
    // 09:00 UTC is 10:00 in Berlin on 9 November.
    expect(planCancellationRemoval([series], {
      uid: 'meeting@example.com',
      recurrenceId: '2026-11-09T09:00:00',
      recurrenceIdTimeZone: 'Etc/UTC',
    })).toEqual({
      kind: 'exclude',
      id: 'ev-1',
      patch: { 'recurrenceOverrides/2026-11-09T10:00:00': { excluded: true } },
    });
  });

  it('replaces the override Stalwart wrote for a cancelled occurrence', () => {
    const series = stored({
      recurrenceRules: WEEKLY,
      recurrenceOverrides: { '2026-11-09T10:00:00': { status: 'cancelled', sequence: 1 } },
    });
    expect(planCancellationRemoval([series], {
      uid: 'meeting@example.com',
      recurrenceId: '2026-11-09T10:00:00',
      recurrenceIdTimeZone: 'Europe/Berlin',
      sequence: 1,
    })).toEqual({
      kind: 'exclude',
      id: 'ev-1',
      patch: { 'recurrenceOverrides/2026-11-09T10:00:00': { excluded: true } },
    });
  });

  it('leaves an occurrence that was changed after the cancellation was sent', () => {
    const series = stored({
      recurrenceRules: WEEKLY,
      recurrenceOverrides: { '2026-11-09T10:00:00': { title: 'Back on', sequence: 4 } },
    });
    expect(planCancellationRemoval([series], {
      uid: 'meeting@example.com',
      recurrenceId: '2026-11-09T10:00:00',
      recurrenceIdTimeZone: 'Europe/Berlin',
      sequence: 3,
    })).toEqual({ kind: 'outdated' });
  });

  it('removes nothing for an occurrence already taken out of the series', () => {
    const series = stored({
      recurrenceRules: WEEKLY,
      recurrenceOverrides: { '2026-11-09T10:00:00': { excluded: true } as Partial<CalendarEvent> },
    });
    expect(planCancellationRemoval([series], {
      uid: 'meeting@example.com',
      recurrenceId: '2026-11-09T10:00:00',
      recurrenceIdTimeZone: 'Europe/Berlin',
    })).toEqual({ kind: 'none' });
  });

  it('does not write the whole overrides map when the series was read without it', () => {
    const series = stored({ recurrenceRules: WEEKLY, recurrenceOverrides: undefined });
    expect(planCancellationRemoval([series], {
      uid: 'meeting@example.com',
      recurrenceId: '2026-11-09T10:00:00',
      recurrenceIdTimeZone: 'Europe/Berlin',
    })).toEqual({ kind: 'none' });
  });

  it('deletes an occurrence the calendar holds on its own', () => {
    const occurrence = stored({ id: 'occ', recurrenceId: '2026-11-09T10:00:00', recurrenceIdTimeZone: 'Europe/Berlin' });
    expect(planCancellationRemoval([occurrence], {
      uid: 'meeting@example.com',
      recurrenceId: '2026-11-09T10:00:00',
      recurrenceIdTimeZone: 'Europe/Berlin',
      sequence: 1,
    })).toEqual({ kind: 'delete', ids: ['occ'] });
  });
});

describe('canRemoveCancelled', () => {
  const removal: CancellationRemoval = { kind: 'delete', ids: ['ev-1'] };
  const base = { isCancellation: true, userIsSender: false, trustLevel: 'trusted', removal };

  it('offers removal for a trusted cancellation of a meeting the calendar holds', () => {
    expect(canRemoveCancelled(base)).toBe(true);
    expect(canRemoveCancelled({ ...base, trustLevel: 'caution' })).toBe(true);
    expect(canRemoveCancelled({ ...base, removal: { kind: 'exclude', id: 'ev-1', patch: {} } })).toBe(true);
  });

  it('does not let a cancellation that fails the trust check, or the user\'s own, remove anything', () => {
    expect(canRemoveCancelled({ ...base, trustLevel: 'warning' })).toBe(false);
    expect(canRemoveCancelled({ ...base, userIsSender: true })).toBe(false);
    expect(canRemoveCancelled({ ...base, isCancellation: false })).toBe(false);
  });

  it('offers nothing for an outdated cancellation or one with nothing left to remove', () => {
    expect(canRemoveCancelled({ ...base, removal: { kind: 'outdated' } })).toBe(false);
    expect(canRemoveCancelled({ ...base, removal: { kind: 'none' } })).toBe(false);
    expect(canRemoveCancelled({ ...base, removal: null })).toBe(false);
  });
});

describe('removeCancelledMeeting', () => {
  it('deletes the stored events without telling anyone, planned on the events as they are now', async () => {
    const deleteEvent = vi.fn().mockResolvedValue(undefined);
    const updateEvent = vi.fn().mockResolvedValue(undefined);
    const findEventsByUid = vi.fn().mockResolvedValue([stored({ id: 'ev-1' }), stored({ id: 'ev-2', recurrenceId: '2026-11-09T10:00:00' })]);
    const done = await removeCancelledMeeting({ uid: 'meeting@example.com', sequence: 1 }, { findEventsByUid, deleteEvent, updateEvent });
    expect(done).toEqual({ kind: 'delete', ids: ['ev-1', 'ev-2'] });
    expect(findEventsByUid).toHaveBeenCalledWith('meeting@example.com');
    expect(deleteEvent.mock.calls).toEqual([
      ['ev-1', { sendSchedulingMessages: false }],
      ['ev-2', { sendSchedulingMessages: false }],
    ]);
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('excludes one occurrence on the series', async () => {
    const deleteEvent = vi.fn();
    const updateEvent = vi.fn().mockResolvedValue(undefined);
    const findEventsByUid = vi.fn().mockResolvedValue([stored({ recurrenceRules: WEEKLY })]);
    await removeCancelledMeeting(
      { uid: 'meeting@example.com', recurrenceId: '2026-11-09T10:00:00', recurrenceIdTimeZone: 'Europe/Berlin' },
      { findEventsByUid, deleteEvent, updateEvent },
    );
    expect(updateEvent).toHaveBeenCalledWith(
      'ev-1',
      { recurrenceOverrides: { '2026-11-09T10:00:00': { excluded: true } } },
      { sendSchedulingMessages: false },
    );
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it('changes nothing when the calendar has a newer version by now', async () => {
    const deleteEvent = vi.fn();
    const updateEvent = vi.fn();
    const findEventsByUid = vi.fn().mockResolvedValue([stored({ sequence: 5 })]);
    expect(await removeCancelledMeeting({ uid: 'meeting@example.com', sequence: 2 }, { findEventsByUid, deleteEvent, updateEvent }))
      .toEqual({ kind: 'outdated' });
    expect(deleteEvent).not.toHaveBeenCalled();
    expect(updateEvent).not.toHaveBeenCalled();
  });
});
