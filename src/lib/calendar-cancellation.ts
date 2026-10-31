import type { CalendarEvent } from '../api/types';
import { buildFallbackExcludePatch } from './recurrence-instances';
import { formatWallClock, isValidTimeZone, localDateTimeToInstant } from './calendar-timezone';

// Ported from the webmail's lib/calendar-cancellation.ts (#1425).

/**
 * `b`'s recurrence id as a local date-time in the zone of `a`'s, each read in
 * its own zone (`recurrenceIdTimeZone`, else the event's `timeZone`). Without
 * a usable zone on either side it is taken as it is.
 */
function recurrenceIdInZoneOf(a: Partial<CalendarEvent>, b: Partial<CalendarEvent>): string | null {
  if (!b.recurrenceId) return null;
  const zoneA = a.recurrenceIdTimeZone ?? a.timeZone ?? null;
  const zoneB = b.recurrenceIdTimeZone ?? b.timeZone ?? null;
  const local = b.recurrenceId.slice(0, 19);
  if (!zoneA || !zoneB || !isValidTimeZone(zoneA) || !isValidTimeZone(zoneB)) return local;
  const instant = localDateTimeToInstant(local, zoneB);
  return instant ? formatWallClock(instant, zoneA) : local;
}

/** Whether two events name the same occurrence: their recurrence ids at the same moment, each in its own zone. */
export function sameRecurrenceId(a: Partial<CalendarEvent>, b: Partial<CalendarEvent>): boolean {
  if (!a.recurrenceId || !b.recurrenceId) return false;
  return a.recurrenceId.slice(0, 19) === recurrenceIdInZoneOf(a, b);
}

/**
 * What removing a cancelled meeting from the calendar takes:
 * - `delete`: destroy these stored events (the series, or an occurrence
 *   stored on its own).
 * - `exclude`: write `patch` on the series `id`, taking one occurrence out.
 * - `outdated`: the calendar holds a newer version than the cancellation.
 * - `none`: nothing in the calendar to remove.
 */
export type CancellationRemoval =
  | { kind: 'delete'; ids: string[] }
  | { kind: 'exclude'; id: string; patch: Record<string, unknown> }
  | { kind: 'outdated' }
  | { kind: 'none' };

/**
 * How to remove what an iTIP CANCEL (RFC 5546 3.2.5) names from `stored`,
 * the events stored with its uid. Stalwart applies a cancellation itself but
 * only marks the event, or the occurrence, STATUS:CANCELLED and keeps it.
 * A cancellation without a recurrence id is for the whole meeting; one with
 * a recurrence id is for that occurrence only. A cancellation with a lower
 * SEQUENCE than the event it names is older than the event and is not
 * applied, as Stalwart does not apply it either.
 */
export function planCancellationRemoval(
  stored: CalendarEvent[],
  cancel: Partial<CalendarEvent>,
): CancellationRemoval {
  if (!cancel.uid) return { kind: 'none' };
  const sameUid = stored.filter((event) => event.uid === cancel.uid);
  const cancelSequence = cancel.sequence ?? 0;
  const isNewer = (sequence: number | null | undefined) => (sequence ?? 0) > cancelSequence;

  if (!cancel.recurrenceId) {
    if (sameUid.length === 0) return { kind: 'none' };
    if (sameUid.some((event) => isNewer(event.sequence))) return { kind: 'outdated' };
    return { kind: 'delete', ids: sameUid.map((event) => event.id) };
  }

  const ownEvent = sameUid.find((event) => sameRecurrenceId(event, cancel));
  if (ownEvent) {
    return isNewer(ownEvent.sequence) ? { kind: 'outdated' } : { kind: 'delete', ids: [ownEvent.id] };
  }

  const series = sameUid.find((event) => !event.recurrenceId && (event.recurrenceRules?.length ?? 0) > 0);
  // Overrides not read: a whole-map write would drop the ones there are.
  if (!series || series.recurrenceOverrides === undefined) return { kind: 'none' };
  const key = recurrenceIdInZoneOf(series, cancel);
  if (!key) return { kind: 'none' };
  const override = series.recurrenceOverrides?.[key] as (Partial<CalendarEvent> & { excluded?: boolean }) | undefined;
  if (override?.excluded) return { kind: 'none' };
  if (override && isNewer(override.sequence)) return { kind: 'outdated' };
  const patch = buildFallbackExcludePatch({
    id: series.id,
    start: '',
    recurrenceId: key,
    recurrenceOverrides: series.recurrenceOverrides,
  });
  return patch ? { kind: 'exclude', id: series.id, patch } : { kind: 'none' };
}

/**
 * Whether the banner offers "Remove from calendar": a cancellation the user
 * didn't send, that doesn't fail the invitation trust check (authentication,
 * sender not the organizer), for a meeting the calendar still holds.
 */
export function canRemoveCancelled(input: {
  isCancellation: boolean;
  userIsSender: boolean;
  trustLevel: string | null | undefined;
  removal: CancellationRemoval | null;
}): boolean {
  return input.isCancellation
    && !input.userIsSender
    && input.trustLevel !== 'warning'
    && (input.removal?.kind === 'delete' || input.removal?.kind === 'exclude');
}

export interface CancellationActions {
  findEventsByUid: (uid: string) => Promise<CalendarEvent[]>;
  deleteEvent: (id: string, options: { sendSchedulingMessages: boolean }) => Promise<void>;
  updateEvent: (id: string, patch: Record<string, unknown>, options: { sendSchedulingMessages: boolean }) => Promise<void>;
}

/**
 * Remove what `cancel` names from the calendar, planned again on the events
 * as they are now: the calendar may have changed since the mail was opened.
 * No scheduling messages: the organizer cancelled it, there is no one to
 * tell. Returns the plan it carried out (`none`/`outdated`: nothing done).
 */
export async function removeCancelledMeeting(
  cancel: Partial<CalendarEvent>,
  actions: CancellationActions,
): Promise<CancellationRemoval> {
  if (!cancel.uid) return { kind: 'none' };
  const removal = planCancellationRemoval(await actions.findEventsByUid(cancel.uid), cancel);
  if (removal.kind === 'delete') {
    for (const id of removal.ids) await actions.deleteEvent(id, { sendSchedulingMessages: false });
  } else if (removal.kind === 'exclude') {
    await actions.updateEvent(removal.id, removal.patch, { sendSchedulingMessages: false });
  }
  return removal;
}
