/**
 * Server-side recurrence instances ("synthetic ids"). Port of the webmail's
 * lib/recurrence-instances.ts.
 *
 * `CalendarEvent/query` with `expandRecurrences: true` returns one synthetic
 * id per occurrence in the range instead of the stored base event. Since
 * Stalwart 0.16.20 those ids are also accepted by `CalendarEvent/set`; older
 * servers reject them, in which case the app keeps expanding recurrences on
 * the device (lib/recurrence-expansion.ts) and patches the base event itself.
 *
 * What an expanded occurrence looks like (verified by the webmail against
 * 0.16.19):
 * - `id` is synthetic, `baseEventId` is the stored event's id; a
 *   non-recurring event in the range gets a synthetic id too.
 * - `recurrenceId` / `recurrenceIdTimeZone` are set for occurrences of a
 *   series, `recurrenceRule` / `recurrenceOverrides` are stripped.
 * - all-day occurrences lose `showWithoutTime` and are stamped with the
 *   request time zone.
 * - the ids are positional and reshuffle whenever the series' overrides
 *   change, so the loaded range has to be refetched after mutating one.
 */

import type { CalendarEvent, Participant } from '../api/types';

/**
 * A synthetic id whose event can never exist: expansion 0 of document
 * `u32::MAX` (`Id::from_parts(1, u32::MAX)` in Stalwart's base32 alphabet).
 * A pre-0.16.20 server rejects an update on it as `invalidProperties`
 * before looking anything up; a server that supports synthetic ids answers
 * `notFound`. Either way nothing is written, which makes it a safe probe.
 */
export const SYNTHETIC_ID_PROBE = 'h333333';

/** Base-event properties an expanded occurrence needs back (see `hydrateRecurrenceInstances`). */
export const RECURRENCE_BASE_PROPERTIES = [
  'id',
  'recurrenceRule',
  'excludedRecurrenceRule',
  'recurrenceOverrides',
  'showWithoutTime',
  'timeZone',
  'duration',
] as const;

type EventIdentity = Pick<CalendarEvent, 'id'> & Partial<Pick<CalendarEvent, 'originalId' | 'baseEventId'>>;

/**
 * True for an occurrence handed out by server-side expansion, i.e. an event
 * whose (raw) id is synthetic and differs from its base event's id. A base
 * event fetched directly also carries `baseEventId`, equal to its own id.
 */
export function isServerRecurrenceInstance(event: EventIdentity | null | undefined): boolean {
  if (!event?.baseEventId) return false;
  return event.baseEventId !== (event.originalId ?? event.id);
}

/**
 * The store id under which the base event of `instance` would be addressed.
 * Store ids end with the raw JMAP id (`<accountId>:<raw>` for a shared
 * calendar, or just `<raw>`), so swap the trailing raw synthetic id for the
 * base id and keep whatever namespace prefix is there.
 */
export function baseEventStoreId(instance: EventIdentity): string | null {
  if (!isServerRecurrenceInstance(instance) || !instance.baseEventId) return null;
  const raw = instance.originalId ?? instance.id;
  if (!instance.id.endsWith(raw)) return instance.baseEventId;
  return instance.id.slice(0, instance.id.length - raw.length) + instance.baseEventId;
}

/**
 * The raw JMAP id of the stored event behind a store event: the base event
 * of a server-expanded occurrence, the master of one expanded on the
 * device, else the event's own id.
 */
export function seriesIdOf(event: EventIdentity): string {
  return event.baseEventId || event.originalId || event.id;
}

/**
 * An id for an event or occurrence that survives a refetch: synthetic ids
 * are positional, so a server-expanded occurrence is named by its base
 * event and recurrence id instead.
 */
export function stableOccurrenceKey(
  event: EventIdentity & Partial<Pick<CalendarEvent, 'accountId' | 'recurrenceId'>>,
): string {
  if (!isServerRecurrenceInstance(event)) return event.id;
  return [event.accountId, event.baseEventId, event.recurrenceId].filter(Boolean).join(':');
}

type OverrideMap = NonNullable<CalendarEvent['recurrenceOverrides']>;

/**
 * Given an expanded occurrence, find the key of its entry in the base
 * event's `recurrenceOverrides`. Normally that is `recurrenceId`; a
 * pre-0.16.20 server reports a moved occurrence's *new* start as its
 * recurrenceId, in which case the entry is found by that start instead.
 */
export function resolveOverrideKey(
  instance: Pick<CalendarEvent, 'start' | 'recurrenceId'>,
  overrides: OverrideMap | null | undefined,
): string | null {
  if (!instance.recurrenceId) return null;
  if (!overrides || instance.recurrenceId in overrides) return instance.recurrenceId;
  for (const [key, override] of Object.entries(overrides)) {
    if (override && override.start === instance.start) return key;
  }
  return instance.recurrenceId;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * An override's participants, each completed from the series participant
 * with the same id or calendar address. The override decides who takes part;
 * the series fills what it leaves out. Stalwart records an attendee's reply to
 * one occurrence as an override naming the organizer under a new id and
 * without a participation status, which would otherwise show the organizer as
 * not having answered their own meeting.
 */
export function mergeOverrideParticipants(
  series: CalendarEvent['participants'],
  override: CalendarEvent['participants'],
): CalendarEvent['participants'] {
  if (!override) return override;
  const address = (p: Participant) => (p.calendarAddress ?? '').toLowerCase();
  const from = series ?? {};
  const merged: Record<string, Participant> = {};
  for (const [id, participant] of Object.entries(override)) {
    const match = id in from
      ? id
      : Object.keys(from).find((key) => address(from[key]) && address(from[key]) === address(participant));
    const defined = Object.fromEntries(Object.entries(participant).filter(([, v]) => v != null));
    merged[match ?? id] = { ...(match ? from[match] : {}), ...defined } as Participant;
  }
  return merged;
}

/**
 * Stalwart lists an occurrence twice under one id - once as the series
 * generates it, once from its override - when the override ranks below the
 * series (no or a lower SEQUENCE). It writes such overrides itself: an
 * attendee's reply to one occurrence becomes, on the organizer's side, an
 * override holding little more than that attendee. Collapse each pair into
 * one occurrence: the fields the override defines (per the base event's
 * overrides map) from the override, the rest from the series.
 */
function collapseDuplicateInstances(
  instances: CalendarEvent[],
  bases: ReadonlyMap<string, Partial<CalendarEvent>>,
): CalendarEvent[] {
  const groups = new Map<string, CalendarEvent[]>();
  for (const instance of instances) {
    const group = groups.get(instance.id);
    if (group) group.push(instance);
    else groups.set(instance.id, [instance]);
  }
  if (groups.size === instances.length) return instances;

  const collapse = (group: CalendarEvent[]): CalendarEvent => {
    const first = group[0];
    const base = first.baseEventId ? bases.get(first.baseEventId) : undefined;
    const key = base ? resolveOverrideKey(first, base.recurrenceOverrides) : null;
    const entry = key ? base?.recurrenceOverrides?.[key] as Record<string, unknown> | undefined : undefined;
    if (!entry) {
      return group.reduce((a, b) => (Object.keys(b).length > Object.keys(a).length ? b : a));
    }
    const overrideKeys = Object.keys(entry).filter((k) => k !== 'updated' && !k.includes('/'));
    const score = (instance: CalendarEvent) => overrideKeys
      .filter((k) => stableJson((instance as unknown as Record<string, unknown>)[k]) === stableJson(entry[k]))
      .length;
    const override = group.reduce((a, b) => (score(b) > score(a) ? b : a));
    const series = group.find((instance) => instance !== override) ?? first;
    const merged: Record<string, unknown> = { ...series };
    for (const k of overrideKeys) {
      merged[k] = k === 'participants'
        ? mergeOverrideParticipants(series.participants, override.participants)
        : (override as unknown as Record<string, unknown>)[k];
    }
    return merged as unknown as CalendarEvent;
  };

  const seen = new Set<string>();
  const result: CalendarEvent[] = [];
  for (const instance of instances) {
    if (seen.has(instance.id)) continue;
    seen.add(instance.id);
    const group = groups.get(instance.id)!;
    result.push(group.length > 1 ? collapse(group) : instance);
  }
  return result;
}

/** An ISO 8601 duration ("PT1H30M", "P1DT2H", "P1W") in seconds; null when unparsable. */
function parseDurationSeconds(duration: string | null | undefined): number | null {
  if (!duration) return null;
  const match = /^-?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(duration);
  if (!match) return null;
  const [, w, d, h, m, s] = match;
  return (Number(w ?? 0) * 7 + Number(d ?? 0)) * 86400
    + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

function shiftIso(from: string | null | undefined, seconds: number): string | null {
  if (!from) return null;
  const ms = Date.parse(from);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + seconds * 1000).toISOString();
}

/**
 * Give expanded occurrences the base-event context the rest of the app
 * expects from an occurrence (and that the device-side expansion copies
 * from the master): the recurrence rules and overrides, the all-day flag,
 * and - for an override that does not set its own duration - the inherited
 * duration (RFC 8984 §4.3.4: an override is a patch on the base event; the
 * server's own computed duration for such overrides has been seen to be
 * wrong). Occurrences whose base event is not in `bases` are returned
 * unchanged.
 */
export function hydrateRecurrenceInstances(
  instances: CalendarEvent[],
  bases: ReadonlyMap<string, Partial<CalendarEvent>>,
): CalendarEvent[] {
  return collapseDuplicateInstances(instances, bases).map((instance) => {
    if (!isServerRecurrenceInstance(instance) || !instance.recurrenceId) return instance;
    const base = instance.baseEventId ? bases.get(instance.baseEventId) : undefined;
    if (!base) return instance;

    const hydrated: CalendarEvent = {
      ...instance,
      recurrenceRules: base.recurrenceRules ?? null,
      excludedRecurrenceRules: base.excludedRecurrenceRules ?? null,
      recurrenceOverrides: base.recurrenceOverrides ?? null,
    };
    if (base.showWithoutTime) {
      hydrated.showWithoutTime = true;
      hydrated.timeZone = base.timeZone ?? null;
    }

    const overrideKey = resolveOverrideKey(instance, base.recurrenceOverrides);
    if (overrideKey) hydrated.recurrenceId = overrideKey;
    const override = overrideKey ? base.recurrenceOverrides?.[overrideKey] : undefined;
    if (override && override.duration == null && base.duration && hydrated.duration !== base.duration) {
      hydrated.duration = base.duration;
      const seconds = parseDurationSeconds(base.duration);
      if (seconds !== null && !hydrated.showWithoutTime) {
        hydrated.utcEnd = shiftIso(hydrated.utcStart, seconds) ?? hydrated.utcEnd;
      }
    }
    return hydrated;
  });
}
