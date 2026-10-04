import { describe, it, expect, vi } from 'vitest';
import { writeFollowingSeries } from '../following-series';
import { saveWithSchedulingFallback } from '../scheduling-denied';
import { SchedulingDeniedError } from '../../api/jmap-result';
import type { CalendarEvent, RecurrenceRule } from '../../api/types';

const original: RecurrenceRule[] = [{ frequency: 'weekly' }];
const master = { id: 'm1', recurrenceRules: original } as CalendarEvent;
const occurrence = { id: 'o1', start: '2026-03-10T09:00:00', recurrenceId: '2026-03-10T09:00:00' } as CalendarEvent;

function setup(opts: { createFails?: number; rollbackFails?: boolean } = {}) {
  let creates = 0;
  const updateEvent = vi.fn(async (_id: string, changes: Partial<CalendarEvent>, _opts: { sendSchedulingMessages: boolean | undefined }) => {
    const isRollback = changes.recurrenceRules === original;
    if (isRollback && opts.rollbackFails) throw new Error('rollback failed');
  });
  const createEvent = vi.fn(async () => {
    if (creates++ < (opts.createFails ?? 0)) throw new SchedulingDeniedError('nope');
  });
  const run = (send: boolean | undefined) => writeFollowingSeries({
    master, originalRules: original, occurrence, newSeries: { title: 'n' }, calendarId: 'c1',
    send, api: { updateEvent, createEvent },
  });
  return { updateEvent, createEvent, run };
}

describe('writeFollowingSeries', () => {
  it('retries truncation and rollback without invitations', async () => {
    const { updateEvent, createEvent, run } = setup({ createFails: 1 });
    const outcome = await saveWithSchedulingFallback(run, true, async () => true);
    expect(outcome).toBe('saved_without_invitations');
    const sends = updateEvent.mock.calls.map((c) => c[2]?.sendSchedulingMessages);
    // truncate(true), rollback(true), truncate(false)
    expect(sends).toEqual([true, true, false]);
    expect(createEvent.mock.calls.map((c) => (c as any)[2].sendSchedulingMessages)).toEqual([true, false]);
  });

  it('a failed rollback throws a plain error and is never retried', async () => {
    const { updateEvent, run } = setup({ createFails: 1, rollbackFails: true });
    const confirm = vi.fn(async () => true);
    const err = await saveWithSchedulingFallback(run, true, confirm).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SchedulingDeniedError);
    expect(confirm).not.toHaveBeenCalled();
    expect(updateEvent).toHaveBeenCalledTimes(2); // truncate + failed rollback, no re-truncate
  });

  it('the retry truncates from the original rules', async () => {
    const { updateEvent, run } = setup({ createFails: 1 });
    await saveWithSchedulingFallback(run, true, async () => true);
    const truncations = updateEvent.mock.calls.filter((c) => c[1].recurrenceRules !== original);
    expect(truncations).toHaveLength(2);
    expect(truncations[1][1]).toEqual(truncations[0][1]);
    expect(truncations[1][1].recurrenceRules![0].until).toBe('2026-03-10T08:59:59');
  });
});
