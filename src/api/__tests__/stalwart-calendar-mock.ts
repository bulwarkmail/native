// A mock Stalwart calendar server for tests that run the real calendar api
// (src/api/calendar.ts) against `jmapClient.request`. What differs between
// the versions, as far as these tests go:
// - 1.0 refuses a CalendarEvent/get that asks for `recurrenceOverrides`
//   together with `utcStart`/`utcEnd` (jmap/src/calendar_event/get.rs,
//   ProjectionRequest::new), before reading any id; 0.16 answers any list.
// - 1.0 returns `recurrenceOverrides: null` for a synthetic occurrence id.
// Every method call is recorded with the request it came in.

import type { JMAPMethodCall } from '../types';
import { SYNTHETIC_ID_PROBE } from '../../lib/recurrence-instances';

export type StalwartVersion = '0.16' | '1.0';

/** Stalwart 1.0's answer to a CalendarEvent/get that asks for both. */
export const OVERRIDES_WITH_UTC_ERROR = {
  type: 'invalidArguments',
  description: 'recurrenceOverrides cannot be requested together with utcStart or utcEnd',
} as const;

/** True for a CalendarEvent/get Stalwart 1.0 refuses outright. */
export function asksForOverridesWithUtc(args: Record<string, unknown>): boolean {
  const properties = args.properties;
  if (!Array.isArray(properties)) return false;
  return properties.includes('recurrenceOverrides')
    && (properties.includes('utcStart') || properties.includes('utcEnd'));
}

export interface RecordedCall {
  method: string;
  args: Record<string, unknown>;
  callId: string;
  /** Index of the request the call was part of. */
  request: number;
}

export type MethodAnswer = [string, Record<string, unknown>];

export interface StalwartCalendarMockOptions {
  version: StalwartVersion;
  /** Stored events and tasks, by id. */
  objects?: Record<string, Record<string, unknown>>;
  /** What CalendarEvent/query with expandRecurrences hands out, by synthetic id. */
  occurrences?: Record<string, Record<string, unknown>>;
  /** Calendars Calendar/get lists. */
  calendars?: Record<string, unknown>[];
  /** Whether CalendarEvent/set takes synthetic ids (the probe answers notFound). Default true. */
  syntheticIds?: boolean;
  /** Answer a call yourself; return undefined for the default answer. */
  answer?: (call: RecordedCall) => MethodAnswer | undefined;
}

export interface StalwartCalendarMock {
  /** Stands in for `jmapClient.request`. */
  request: (calls: JMAPMethodCall[], using?: string[]) => Promise<{ methodResponses: [string, Record<string, unknown>, string][] }>;
  calls: RecordedCall[];
  /** Every CalendarEvent/get sent so far. */
  gets(): RecordedCall[];
  queries(): RecordedCall[];
  sets(): RecordedCall[];
  objects: Record<string, Record<string, unknown>>;
}

function project(object: Record<string, unknown>, properties: unknown): Record<string, unknown> {
  if (!Array.isArray(properties)) return { ...object };
  const out: Record<string, unknown> = { id: object.id };
  for (const key of properties as string[]) {
    if (key in object) out[key] = object[key];
  }
  return out;
}

/** The calendar ids an `inCalendar` filter (one, or an OR of them) names; null without one. */
function calendarsOf(filter: Record<string, unknown> | undefined): Set<string> | null {
  if (!filter) return null;
  if (typeof filter.inCalendar === 'string') return new Set([filter.inCalendar]);
  if (Array.isArray(filter.conditions)) {
    const ids = new Set<string>();
    let any = false;
    for (const condition of filter.conditions as Record<string, unknown>[]) {
      const inner = calendarsOf(condition);
      if (!inner) continue;
      any = true;
      for (const id of inner) ids.add(id);
    }
    return any ? ids : null;
  }
  return null;
}

/** Point `jmapClient.request` at a mock Stalwart calendar server. */
export function createStalwartCalendarMock(options: StalwartCalendarMockOptions): StalwartCalendarMock {
  const calls: RecordedCall[] = [];
  const objects: Record<string, Record<string, unknown>> = { ...options.objects };
  const occurrences = { ...options.occurrences };
  let requests = 0;
  let created = 0;

  const defaultAnswer = (call: RecordedCall): MethodAnswer => {
    const { method, args } = call;
    if (method === 'Calendar/get') {
      return ['Calendar/get', { accountId: args.accountId, list: options.calendars ?? [{ id: 'cal', name: 'Personal', isDefault: true }], notFound: [] }];
    }
    if (method === 'CalendarEvent/query') {
      const filter = args.filter as Record<string, unknown> | undefined;
      let ids = args.expandRecurrences ? Object.keys(occurrences) : Object.keys(objects);
      if (typeof filter?.uid === 'string') ids = ids.filter((id) => objects[id]?.uid === filter.uid);
      const wanted = calendarsOf(filter);
      if (wanted) {
        const source = args.expandRecurrences ? occurrences : objects;
        ids = ids.filter((id) => Object.keys((source[id]?.calendarIds ?? {}) as object).some((c) => wanted.has(c)));
      }
      const position = (args.position as number | undefined) ?? 0;
      const limit = (args.limit as number | undefined) ?? ids.length;
      return ['CalendarEvent/query', { accountId: args.accountId, ids: ids.slice(position, position + limit), position }];
    }
    if (method === 'CalendarEvent/get') {
      if (options.version === '1.0' && asksForOverridesWithUtc(args)) return ['error', { ...OVERRIDES_WITH_UTC_ERROR }];
      const list: Record<string, unknown>[] = [];
      const notFound: string[] = [];
      for (const id of (args.ids as string[] | null) ?? Object.keys(objects)) {
        const occurrence = occurrences[id];
        const object = occurrence ?? objects[id];
        if (!object) {
          notFound.push(id);
          continue;
        }
        const projected = project(object, args.properties);
        if (options.version === '1.0' && occurrence && Array.isArray(args.properties)
          && (args.properties as string[]).includes('recurrenceOverrides')) {
          projected.recurrenceOverrides = null;
        }
        list.push(projected);
      }
      return ['CalendarEvent/get', { accountId: args.accountId, list, notFound }];
    }
    if (method === 'CalendarEvent/set') {
      const update = args.update as Record<string, Record<string, unknown>> | undefined;
      if (update && SYNTHETIC_ID_PROBE in update) {
        const failure = options.syntheticIds === false
          ? { type: 'invalidProperties', description: 'Updating synthetic ids is not yet supported.', properties: ['id'] }
          : { type: 'notFound' };
        return ['CalendarEvent/set', { notUpdated: { [SYNTHETIC_ID_PROBE]: failure } }];
      }
      const result: Record<string, unknown> = {};
      const create = args.create as Record<string, Record<string, unknown>> | undefined;
      if (create) {
        const createdMap: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(create)) {
          const id = `created-${++created}`;
          objects[id] = { ...value, id };
          createdMap[key] = { id };
        }
        result.created = createdMap;
      }
      if (update) {
        for (const [id, patch] of Object.entries(update)) objects[id] = { ...objects[id], ...patch };
        result.updated = Object.fromEntries(Object.keys(update).map((id) => [id, null]));
      }
      const destroy = args.destroy as string[] | undefined;
      if (destroy) {
        for (const id of destroy) delete objects[id];
        result.destroyed = destroy;
      }
      return ['CalendarEvent/set', result];
    }
    return ['error', { type: 'unknownMethod' }];
  };

  const request = async (methodCalls: JMAPMethodCall[]) => {
    const index = requests++;
    const methodResponses: [string, Record<string, unknown>, string][] = [];
    for (const [method, args, callId] of methodCalls) {
      const call: RecordedCall = { method, args: args as Record<string, unknown>, callId, request: index };
      calls.push(call);
      const [name, body] = options.answer?.(call) ?? defaultAnswer(call);
      methodResponses.push([name, body, callId]);
    }
    return { methodResponses };
  };

  return {
    request,
    calls,
    gets: () => calls.filter((c) => c.method === 'CalendarEvent/get'),
    queries: () => calls.filter((c) => c.method === 'CalendarEvent/query'),
    sets: () => calls.filter((c) => c.method === 'CalendarEvent/set'),
    objects,
  };
}

/** Stalwart 1.0's refusal of an expanded range longer than maxExpandedQueryDuration. */
export const EXPAND_DURATION_TOO_LARGE = {
  type: 'expandDurationTooLarge',
  description: "The time span between 'after' and 'before' exceeds maxExpandedQueryDuration",
} as const;

/** Both versions' refusal of a query that expands to more occurrences than allowed. */
export function tooManyOccurrences(version: StalwartVersion) {
  const description = 'The number of expanded recurrences exceeds the server limit';
  return version === '1.0'
    ? { type: 'cannotCalculateOccurrences', description }
    : { type: 'invalidArguments', description };
}

/** An occurrence of a series: a LocalDateTime start and a length in seconds. */
export interface RangeOccurrence {
  id: string;
  start: string;
  seconds: number;
}

/** A LocalDateTime read as seconds (the mock has no time zones). */
export function localSeconds(value: string): number {
  return Date.parse(`${value}Z`) / 1000;
}

/** Occurrence objects of the series `seriesId`, for `occurrences` of the mock. */
export function occurrenceObjects(seriesId: string, occurrences: RangeOccurrence[]) {
  return Object.fromEntries(occurrences.map((o) => [o.id, {
    id: o.id, '@type': 'Event', baseEventId: seriesId, uid: `${seriesId}@example.com`, title: 'Standup',
    start: o.start, duration: `PT${o.seconds}S`, recurrenceId: o.start, calendarIds: { cal: true },
  }]));
}

/**
 * Answers CalendarEvent/query the way Stalwart expands a range: occurrences
 * that overlap (after, before) strictly, paged. 1.0 refuses a span over
 * `maxSpanSeconds` (0.16 never checks it), and both refuse a query that
 * expands to more than `maxInstances` occurrences. A query without
 * expansion finds the series itself.
 */
export function expandingQueryAnswer(
  version: StalwartVersion,
  options: { seriesId: string; occurrences: RangeOccurrence[]; maxSpanSeconds?: number; maxInstances?: number },
) {
  return (call: RecordedCall): MethodAnswer | undefined => {
    if (call.method !== 'CalendarEvent/query') return undefined;
    const { args } = call;
    if (!args.expandRecurrences) return ['CalendarEvent/query', { ids: [options.seriesId], position: 0 }];
    const filter = args.filter as { after: string; before: string };
    const after = localSeconds(filter.after);
    const before = localSeconds(filter.before);
    if (version === '1.0' && before - after > (options.maxSpanSeconds ?? 365 * 86_400)) {
      return ['error', { ...EXPAND_DURATION_TOO_LARGE }];
    }
    const hits = options.occurrences.filter((o) => {
      const start = localSeconds(o.start);
      return start < before && start + o.seconds > after;
    });
    if (hits.length > (options.maxInstances ?? 3000)) return ['error', tooManyOccurrences(version)];
    const position = (args.position as number | undefined) ?? 0;
    const limit = (args.limit as number | undefined) ?? hits.length;
    return ['CalendarEvent/query', { ids: hits.slice(position, position + limit).map((o) => o.id), position }];
  };
}

/** The calendars account capability both versions advertise (0.16 hardcodes 365 days and never enforces it). */
export function calendarAccountCapability(
  version: StalwartVersion,
  maxExpandedQueryDuration: string | null = 'P52W1D',
): Record<string, unknown> {
  const capability: Record<string, unknown> = {
    maxCalendarsPerEvent: version === '1.0' ? 10 : null,
    minDateTime: '0001-01-01T00:00:00Z',
    maxDateTime: '9999-12-31T23:59:59Z',
    maxParticipantsPerEvent: 20,
    mayCreateCalendar: true,
  };
  if (maxExpandedQueryDuration !== null) capability.maxExpandedQueryDuration = maxExpandedQueryDuration;
  return capability;
}
