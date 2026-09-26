import type { CalendarEvent } from '../api/types';

// The scope edits themselves ("this", "this and following", "all") are in
// lib/recurrence-scope-edit.ts.

/** Identity / whole-series keys that must never go into a single-occurrence override. */
export const RECURRENCE_OVERRIDE_IMMUTABLE_KEYS = [
  'id',
  'uid',
  '@type',
  'calendarIds',
  'recurrenceRules',
  'recurrenceOverrides',
  'excludedRecurrenceRules',
] as const;

/**
 * A recurring series member is a master (has recurrenceRules) or an expanded
 * occurrence (has recurrenceId) — those get the this/future/all scope dialog.
 * Note: `originalId` alone is not a signal, shared/group events carry it for
 * id-namespacing even when they aren't recurring.
 */
export function isRecurringSeriesMember(
  event: Pick<CalendarEvent, 'recurrenceRules' | 'recurrenceId'>,
): boolean {
  return !!event.recurrenceRules?.length || !!event.recurrenceId;
}
