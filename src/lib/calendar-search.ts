import type { CalendarEvent } from '../api/types';
import { getEventEndDate, getEventStartDate } from './calendar-utils';

// Event search in the calendar (webmail components/calendar/calendar-search
// and hooks/use-calendar-event-search): the loaded events answer at once,
// the server's CalendarEvent/query `text` filter adds the rest.

/** The words of a search, lower case; every one has to match. */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map((w) => w.trim()).filter(Boolean);
}

/** The CalendarEvent/query filter for the words: one `text` condition each. */
export function searchFilter(terms: string[]): Record<string, unknown> | null {
  if (terms.length === 0) return null;
  if (terms.length === 1) return { text: terms[0] };
  return { operator: 'AND', conditions: terms.map((text) => ({ text })) };
}

/** What a search looks at: title, description, places and participants. */
function eventFields(event: CalendarEvent): string[] {
  const fields = [event.title ?? '', event.description ?? ''];
  for (const location of Object.values(event.locations ?? {})) if (location?.name) fields.push(location.name);
  for (const p of Object.values(event.participants ?? {})) {
    if (p.name) fields.push(p.name);
    if (p.email) fields.push(p.email);
    if (p.calendarAddress) fields.push(p.calendarAddress.replace(/^mailto:/i, ''));
  }
  return fields.map((f) => f.toLowerCase());
}

/** Whether every word of the search is in one of the event's fields. */
export function eventMatches(event: CalendarEvent, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const fields = eventFields(event);
  return terms.every((term) => fields.some((field) => field.includes(term)));
}

export interface EventSearchResults {
  /** Still to come or going on, soonest first. */
  upcoming: CalendarEvent[];
  /** Over, latest first. */
  past: CalendarEvent[];
}

// One row per event: a series found as loaded occurrences and as the
// server's base event shows once. An occurrence renamed on its own keeps a
// row of its own.
const seriesKey = (event: CalendarEvent) =>
  `${event.accountId ?? ''} ${event.uid || event.originalId || event.id} ${event.title ?? ''}`;

/**
 * The rows of a search: of a series' loaded occurrences the next one to
 * come, else the last; the server's events add what the loaded window
 * lacks. Tasks and events without a start are left out.
 */
export function orderSearchResults(
  local: CalendarEvent[],
  remote: CalendarEvent[],
  now: number,
): EventSearchResults {
  const ends = (event: CalendarEvent) => getEventEndDate(event).getTime();
  const starts = (event: CalendarEvent) => getEventStartDate(event).getTime();
  const bySeries = new Map<string, CalendarEvent>();
  for (const event of local) {
    if (!event.start) continue;
    const key = seriesKey(event);
    const kept = bySeries.get(key);
    if (!kept) {
      bySeries.set(key, event);
      continue;
    }
    const keptUpcoming = ends(kept) >= now;
    const upcoming = ends(event) >= now;
    if (upcoming && (!keptUpcoming || starts(event) < starts(kept))) bySeries.set(key, event);
    else if (!upcoming && !keptUpcoming && starts(event) > starts(kept)) bySeries.set(key, event);
  }
  for (const event of remote) {
    if (!event.start) continue;
    const key = seriesKey(event);
    if (!bySeries.has(key)) bySeries.set(key, event);
  }
  const upcoming: CalendarEvent[] = [];
  const past: CalendarEvent[] = [];
  for (const event of bySeries.values()) {
    if (Number.isNaN(starts(event))) continue;
    (ends(event) >= now ? upcoming : past).push(event);
  }
  upcoming.sort((a, b) => starts(a) - starts(b));
  past.sort((a, b) => starts(b) - starts(a));
  return { upcoming, past };
}
