import { format, parseISO } from 'date-fns';
import type { CalendarEvent, RecurrenceRule } from '../api/types';

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
 * Build the "This event only" override patch for a recurring master.
 *
 * Why one pointer: a JMAP nested pointer can't create a missing intermediate,
 * so the override object has to be set whole at `recurrenceOverrides/<id>`, not
 * field-by-field (#774). Mirrors webmail's lib/recurrence-overrides.ts.
 */
export function buildRecurrenceOverridePatch(
  updates: Partial<CalendarEvent>,
  recurrenceId: string,
): Record<string, unknown> {
  const immutable = new Set<string>(RECURRENCE_OVERRIDE_IMMUTABLE_KEYS);
  const override: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (immutable.has(key)) continue;
    if (key === 'recurrenceId') continue;
    override[key] = value;
  }
  return { [`recurrenceOverrides/${recurrenceId}`]: override };
}

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

/** The original slot of an occurrence as a local wall-clock Date. */
export function occurrenceSlotDate(
  event: Pick<CalendarEvent, 'recurrenceId' | 'start'>,
): Date {
  // recurrenceId is either "yyyy-MM-dd" (all-day) or the occurrence instant
  // as UTC ISO; parseISO treats a date-only value as local midnight, which is
  // what the RRULE `until` below needs. `new Date("yyyy-MM-dd")` would read
  // it as UTC and shift the day in any non-UTC zone.
  return parseISO(event.recurrenceId || event.start);
}

/**
 * "This and following": end the master's rules one second before the chosen
 * occurrence. `count` is dropped so the truncated rule is bounded by `until`
 * alone (a rule can't carry both). Mirrors webmail's truncateRecurrenceAtEvent.
 */
export function truncateRecurrenceRules(
  rules: RecurrenceRule[] | undefined | null,
  occurrence: Pick<CalendarEvent, 'recurrenceId' | 'start'>,
): RecurrenceRule[] {
  const untilDate = occurrenceSlotDate(occurrence);
  untilDate.setSeconds(untilDate.getSeconds() - 1);
  const until = format(untilDate, "yyyy-MM-dd'T'HH:mm:ss");
  return (rules || []).map((rule) => {
    const { count: _count, ...rest } = rule;
    return { ...rest, until };
  });
}

/**
 * Updates for the "All events" scope. The editor seeds its date fields from
 * the tapped occurrence, so an unchanged `start` must not be written to the
 * master (that would move the whole series onto the occurrence's date and
 * make the earlier occurrences vanish). When the user did move the occurrence,
 * the same delta is applied to the master's start instead.
 */
export function buildAllScopeUpdates(
  updates: Partial<CalendarEvent>,
  occurrence: Pick<CalendarEvent, 'start' | 'recurrenceId'>,
  master: Pick<CalendarEvent, 'start'>,
): Partial<CalendarEvent> {
  const out: Partial<CalendarEvent> = { ...updates };
  delete (out as Record<string, unknown>).recurrenceId;
  if (!out.start) return out;
  if (!occurrence.recurrenceId) return out; // editing the master itself
  const nextStart = parseISO(out.start);
  const occurrenceStart = parseISO(occurrence.start);
  const masterStart = parseISO(master.start);
  if (
    isNaN(nextStart.getTime()) ||
    isNaN(occurrenceStart.getTime()) ||
    isNaN(masterStart.getTime())
  ) {
    delete out.start;
    return out;
  }
  const delta = nextStart.getTime() - occurrenceStart.getTime();
  if (delta === 0) {
    delete out.start;
    return out;
  }
  const shifted = new Date(masterStart.getTime() + delta);
  out.start = format(shifted, "yyyy-MM-dd'T'HH:mm:ss");
  return out;
}

/**
 * The new series created for "This and following": the master's series-level
 * fields, the original (untruncated) rules, the user's edits on top, and the
 * occurrence's slot as the start unless the user moved it.
 */
export function buildFutureSeriesData(
  master: CalendarEvent,
  originalRules: RecurrenceRule[] | null,
  occurrence: Pick<CalendarEvent, 'start' | 'recurrenceId'>,
  updates: Partial<CalendarEvent>,
): Partial<CalendarEvent> {
  const occurrenceStart = occurrence.start;
  const data: Partial<CalendarEvent> = {
    title: master.title,
    description: master.description,
    duration: master.duration,
    timeZone: master.timeZone,
    calendarIds: { ...master.calendarIds },
    status: master.status,
    freeBusyStatus: master.freeBusyStatus,
    showWithoutTime: master.showWithoutTime,
    participants: master.participants,
    organizerCalendarAddress: master.organizerCalendarAddress,
    alerts: master.alerts,
    useDefaultAlerts: master.useDefaultAlerts,
    locations: master.locations,
    virtualLocations: master.virtualLocations,
    recurrenceRules: originalRules ?? undefined,
    ...updates,
    start: updates.start || occurrenceStart,
  };
  const raw = data as Record<string, unknown>;
  delete raw.id;
  delete raw.uid;
  delete raw.recurrenceId;
  delete raw.recurrenceOverrides;
  delete raw.excludedRecurrenceRules;
  delete raw.utcStart;
  delete raw.utcEnd;
  delete raw.originalId;
  delete raw.baseEventId;
  delete raw.recurrenceIdTimeZone;
  delete raw.originalCalendarIds;
  delete raw.accountId;
  delete raw.isShared;
  for (const key of Object.keys(raw)) {
    if (raw[key] === undefined) delete raw[key];
  }
  return data;
}
