import { searchEventsAcrossAccounts, type CalendarEventSearch } from '../../../api/calendar';
import { jmapClient } from '../../../api/jmap-client';
import { CAPABILITIES, type Calendar, type CalendarEvent } from '../../../api/types';
import { useCalendarStore } from '../../../stores/calendar-store';
import { matchesTerms, type ParsedQuery } from '../query-parser';
import type { CalendarHit, SearchAccount, SearchProvider } from '../types';
import { interleaveByOwner, isShownAndServed, searchShown, shownCacheAccount } from './shown';

// Events of the shown account only (no detached read path for calendars).
// Store events of shared calendars are namespaced `${owner}:${id}` with the
// raw id in `originalId`; server results keep the raw id and carry their
// owner in `accountId`. A hit carries the raw id and the owner either way.

function eventFields(event: CalendarEvent): string[] {
  const fields: string[] = [event.title, event.description ?? ''];
  for (const location of Object.values(event.locations ?? {})) if (location?.name) fields.push(location.name);
  for (const participant of Object.values(event.participants ?? {})) {
    if (participant?.name) fields.push(participant.name);
    if (participant?.email) fields.push(participant.email);
  }
  return fields;
}

function firstLocation(event: CalendarEvent): string {
  for (const location of Object.values(event.locations ?? {})) if (location?.name) return location.name;
  return '';
}

export function isRecurringEvent(event: CalendarEvent): boolean {
  return Boolean(event.recurrenceId) || (Array.isArray(event.recurrenceRules) && event.recurrenceRules.length > 0);
}

function toHit(
  event: CalendarEvent,
  account: SearchAccount,
  ownJmapId: string,
  calendarName: string,
  source: 'local' | 'remote',
): CalendarHit {
  return {
    kind: 'calendar',
    serverUrl: account.serverUrl,
    appAccountId: account.appAccountId,
    jmapAccountId: event.accountId ?? ownJmapId,
    id: event.originalId ?? event.id,
    accountLabel: account.label,
    title: event.title || '',
    subtitle: [calendarName, firstLocation(event)].filter(Boolean).join(' · '),
    date: event.start || null,
    source,
    event,
    isRecurring: isRecurringEvent(event),
  };
}

/** Name of a store event's calendar (its `calendarIds` are store ids). */
function storeCalendarName(event: CalendarEvent, calendars: Calendar[]): string {
  for (const id of Object.keys(event.calendarIds ?? {})) {
    const name = calendars.find((c) => c.id === id)?.name;
    if (name) return name;
  }
  return '';
}

/**
 * Name of a server event's calendar: raw calendar ids, so matched with their
 * owner. The store's own calendars carry no `accountId` (getCalendars), but a
 * stamped one names the own account just the same.
 */
function serverCalendarName(event: CalendarEvent, calendars: Calendar[], ownJmapId: string): string {
  const owner = event.accountId ?? ownJmapId;
  for (const id of Object.keys(event.calendarIds ?? {})) {
    const name = calendars.find((c) => (c.originalId ?? c.id) === id && (c.accountId ?? ownJmapId) === owner)?.name;
    if (name) return name;
  }
  return '';
}

/**
 * `after:`/`before:` are calendar days; the server compares LocalDateTime
 * bounds in the user's zone (the query's `timeZone`), like the calendar's
 * own range loads.
 */
export function calendarFilterFor(parsed: ParsedQuery): CalendarEventSearch {
  const filter: CalendarEventSearch = { text: parsed.text };
  if (parsed.after) filter.after = `${parsed.after}T00:00:00`;
  if (parsed.before) filter.before = `${parsed.before}T23:59:59`;
  return filter;
}

export const calendarProvider: SearchProvider = {
  kind: 'calendar',

  supports: (account) => isShownAndServed(account.appAccountId) && jmapClient.hasCapability(CAPABILITIES.CALENDARS),

  local: (parsed, accounts, limit) => {
    const account = shownCacheAccount(accounts);
    if (!account) return [];
    const { events, calendars } = useCalendarStore.getState();
    const ownJmapId = jmapClient.accountId;
    const hits: CalendarHit[] = [];
    // The store holds expanded occurrences; a matching series is listed
    // once, not once per occurrence in the loaded window.
    const seenSeries = new Set<string>();
    for (const event of events) {
      if (!matchesTerms(parsed.terms, eventFields(event))) continue;
      const day = event.start?.slice(0, 10);
      if (parsed.after && day && day < parsed.after) continue;
      if (parsed.before && day && day > parsed.before) continue;
      if (event.uid) {
        const seriesKey = `${event.accountId ?? ''} ${event.uid}`;
        if (seenSeries.has(seriesKey)) continue;
        seenSeries.add(seriesKey);
      }
      hits.push(toHit(event, account, ownJmapId, storeCalendarName(event, calendars), 'local'));
      if (hits.length >= limit) break;
    }
    return hits;
  },

  remote: (parsed, account, { limit, signal }) => searchShown(account, signal, async (at) => {
    // One more than asked from each account, to know whether there is more.
    const events = interleaveByOwner(
      await searchEventsAcrossAccounts(calendarFilterFor(parsed), limit + 1, at),
      (e) => e.accountId ?? '',
    );
    const { calendars } = useCalendarStore.getState();
    const hits = events.slice(0, limit).map((event) =>
      toHit(event, account, at.accountId, serverCalendarName(event, calendars, at.accountId), 'remote'));
    return { hits, hasMore: events.length > limit };
  }),
};
