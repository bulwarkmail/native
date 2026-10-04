import type { CalendarEvent, RecurrenceRule } from '../api/types';
import { truncateRecurrenceRules } from './recurrence-overrides';

type SendOpts = { sendSchedulingMessages: boolean | undefined };

export interface FollowingSeriesApi {
  updateEvent: (id: string, changes: Partial<CalendarEvent>, opts: SendOpts) => Promise<unknown>;
  createEvent: (data: Partial<CalendarEvent>, calendarId: string, opts: SendOpts) => Promise<unknown>;
}

/**
 * "This and following" write: end the master at the occurrence, then create
 * the new series. `master` and `originalRules` are captured once by the caller
 * and reused on a retry - re-reading the master after a truncation would hand
 * back the truncated rules. Truncation and rollback use the same `send` as the
 * create, so a retry without invitations is not refused again.
 */
export async function writeFollowingSeries(args: {
  master: CalendarEvent;
  originalRules: RecurrenceRule[] | null;
  occurrence: CalendarEvent;
  newSeries: Partial<CalendarEvent>;
  calendarId: string;
  send: boolean | undefined;
  api: FollowingSeriesApi;
}): Promise<void> {
  const { master, originalRules, occurrence, newSeries, calendarId, send, api } = args;
  const opts = { sendSchedulingMessages: send };
  await api.updateEvent(
    master.id,
    { recurrenceRules: truncateRecurrenceRules(master.recurrenceRules, occurrence) },
    opts,
  );
  try {
    await api.createEvent(newSeries, calendarId, opts);
  } catch (createError) {
    // Roll back the truncation so the series isn't left cut short.
    try {
      await api.updateEvent(master.id, { recurrenceRules: originalRules ?? [] }, opts);
    } catch {
      // The series is half-written: fail with a plain error so the scheduling
      // fallback never retries on top of it.
      throw new Error(createError instanceof Error ? createError.message : String(createError));
    }
    throw createError;
  }
}
