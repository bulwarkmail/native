import { fromDisplayDate } from './calendar-timezone';

// Free/busy of invited attendees (Principal/getAvailability), the parts
// that need no server. Ported from the webmail's
// components/calendar/participant-availability.tsx and lib/jmap/free-busy.ts.

/** One busy period of a Principal/getAvailability answer. */
export interface BusyPeriod {
  utcStart: string;
  utcEnd: string;
  busyStatus: 'confirmed' | 'tentative' | 'unavailable' | null;
}

/** A principal's busy periods, or the error type its lookup was refused with. */
export type PrincipalAvailability = { periods: BusyPeriod[] } | { error: string };

/**
 * `unknown`: the address is not a user in a complete directory listing.
 * `no_busy_times`: the server returned no busy time for the attendee's day.
 * It says the same when the user may not see that person's free/busy.
 * `error`: the lookup failed or was rate-limited, so nothing is known.
 */
export type AvailabilityStatus =
  | 'free'
  | 'busy'
  | 'tentative'
  | 'no_busy_times'
  | 'unknown'
  | 'error'
  | 'checking';

/**
 * The status of one attendee for the window, given their busy periods:
 * any confirmed/unavailable overlap wins over a tentative one.
 */
export function availabilityFor(periods: BusyPeriod[], start: Date, end: Date): 'free' | 'busy' | 'tentative' {
  let status: 'free' | 'busy' | 'tentative' = 'free';
  for (const p of periods) {
    const pStart = new Date(p.utcStart).getTime();
    const pEnd = new Date(p.utcEnd).getTime();
    if (pStart < end.getTime() && pEnd > start.getTime()) {
      if (p.busyStatus === 'tentative') {
        if (status === 'free') status = 'tentative';
      } else {
        return 'busy';
      }
    }
  }
  return status;
}

/** The answer for one attendee: an empty list doesn't mean available. */
export function statusFromAnswer(periods: BusyPeriod[], start: Date, end: Date): AvailabilityStatus {
  return periods.length === 0 ? 'no_busy_times' : availabilityFor(periods, start, end);
}

/**
 * The window a lookup asks the server for: the local days from `start` to
 * `end`, so that moving an event within its day is answered from the cache.
 */
export function availabilityWindow(start: Date, end: Date): { start: Date; end: Date } {
  const from = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const to = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  if (to.getTime() < end.getTime()) to.setDate(to.getDate() + 1);
  return { start: from, end: to };
}

/**
 * The event window the attendees' free/busy is checked against, as real
 * instants, from the editor's display dates (wall clocks in the calendar's
 * time zone). An all-day event spans its whole days, `end` being its
 * inclusive last day. Null while the window is empty or backwards.
 */
export function editorAvailabilityWindow(
  times: { allDay: boolean; start: Date; end: Date },
): { start: Date; end: Date } | null {
  let start = times.start;
  let end = times.end;
  if (times.allDay) {
    start = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0);
    end = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59);
  }
  const from = fromDisplayDate(start);
  const to = fromDisplayDate(end);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to.getTime() <= from.getTime()) return null;
  return { start: from, end: to };
}

/** The distinct, trimmed, lower-cased addresses of the attendees. */
export function attendeeEmails(attendees: { email: string }[]): string[] {
  return Array.from(new Set(attendees.map((a) => a.email.trim().toLowerCase()).filter(Boolean)));
}
