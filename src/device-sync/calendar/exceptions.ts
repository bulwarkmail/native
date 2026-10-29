/**
 * Recurrence overrides and the exception rows they become
 * (docs/device-sync.md, "Recurrence").
 *
 * An override value is a PatchObject against the master (RFC 8984 §4.3.4),
 * so an exception row shows master ⊕ override, applied pointer by pointer
 * (the app's own expansion shallow-merges and turns
 * `participants/p1/participationStatus` into a junk key, R3 B10). Stalwart
 * drops a handful of properties from every override it stores; they are
 * never sent in one.
 */
import type { CalendarEventWire } from '../wire';
import { applyPatch, ptrSegments } from '../common/patch';
import { clone } from '../common/json';
import { dateToUtcMidnight, localToUtc, utcMidnightToDate, utcToLocal } from './zoned-time';

/** Properties calcard removes from an override (`remove_forbidden_override_patches`). */
export const FORBIDDEN_OVERRIDE_KEYS = [
  '@type',
  'method',
  'organizerCalendarAddress',
  'privacy',
  'prodId',
  'recurrenceId',
  'recurrenceIdTimeZone',
  'sentBy',
  'uid',
  'recurrenceRule',
  'recurrenceOverrides',
] as const;

const FORBIDDEN = new Set<string>(FORBIDDEN_OVERRIDE_KEYS);

/** Properties of the master that never belong to an instance. */
const SERIES_ONLY = ['recurrenceRule', 'recurrenceRules', 'recurrenceOverrides', 'excludedRecurrenceRule', 'excludedRecurrenceRules'];

export type Override = Record<string, unknown>;

export function isExcluded(override: unknown): boolean {
  return !!override && typeof override === 'object' && (override as Override).excluded === true;
}

/** An override without what Stalwart would drop from it (top-level and pointer keys alike). */
export function withoutForbiddenKeys(override: Override): Override {
  const out: Override = {};
  for (const [key, value] of Object.entries(override)) {
    if (FORBIDDEN.has(ptrSegments(key)[0])) continue;
    out[key] = value;
  }
  return out;
}

/**
 * One instance of a series: the master without its recurrence, patched with
 * the override (pointer by pointer; a pointer whose parent is missing is
 * skipped rather than failing the instance), starting at the recurrence id
 * unless the override moves it.
 */
export function instanceOf(master: CalendarEventWire, key: string, override?: Override | null): CalendarEventWire {
  let instance = clone(master) as Record<string, unknown>;
  for (const name of SERIES_ONLY) delete instance[name];
  instance.start = key;
  for (const [pointer, value] of Object.entries(override ?? {})) {
    if (pointer === 'excluded' || pointer === 'updated') continue;
    if (FORBIDDEN.has(ptrSegments(pointer)[0])) continue;
    const patched = applyPatch(instance, { [pointer]: value });
    if (patched) instance = patched;
  }
  return instance as CalendarEventWire;
}

/** ORIGINAL_INSTANCE_TIME of a recurrence id: its instant in the master's zone, UTC midnight for all-day series. */
export function keyToInstanceTime(key: string, allDay: boolean, zone: string): number | null {
  return allDay ? dateToUtcMidnight(key) : localToUtc(key, zone);
}

/** The recurrence id of an ORIGINAL_INSTANCE_TIME (the inverse of `keyToInstanceTime`). */
export function instanceTimeToKey(originalInstanceTime: number, allDay: boolean, zone: string): string {
  return allDay ? utcMidnightToDate(originalInstanceTime) : utcToLocal(originalInstanceTime, zone);
}

/** The overrides of an event as a plain map (Stalwart omits the property when there are none). */
export function overridesOf(event: CalendarEventWire | null | undefined): Record<string, Override> {
  const map = event?.recurrenceOverrides;
  return map && typeof map === 'object' ? (map as Record<string, Override>) : {};
}
