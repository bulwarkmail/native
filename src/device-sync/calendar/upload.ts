/**
 * Device changes → JMAP writes (docs/device-sync.md, "Uploads", "Device-side
 * changes" and "Scheduling messages").
 *
 * A dirty event uploads a patch built per unit from what differs from its
 * baseline, against the current shadow: pointers where Stalwart takes them,
 * a whole map where it needs one (the first participant, alert or override).
 * Exception rows upload only as overrides of their master: a new override
 * carries the master's details (Stalwart stores a bare one as a separate
 * event otherwise) without the properties Stalwart drops from overrides; an
 * existing one is patched one level deep, never deeper, because a deeper
 * pointer becomes a partial override that loses the other attendees.
 *
 * What Android can't represent is never sent: timing and rule of events
 * whose rule needs RSCALE, SKIP or leap months; a truncated description.
 * Stalwart drops local times it can't resolve, so a start in a repeated hour
 * goes out in a fixed-offset zone (single events) or not at all (series:
 * `dstAmbiguous`), and an UNTIL in a skipped or repeated hour moves an hour
 * later.
 */
import type { RecurrenceRule } from '../../api/types';
import { EventStatus, Events } from '../android-columns';
import type { CalendarContext, LocalEvent, LocalEventRow, LocalException } from '../planner';
import type { Row } from '../types';
import type { CalendarEventWire } from '../wire';
import { clone } from '../common/json';
import { ptr, setInPatch, type PatchObject } from '../common/patch';
import { withNewOverrideDetails } from '../../lib/recurrence-instances';
import { userIsOrganizer } from './attendees';
import { isTruncatedBaseline } from './columns';
import { durationTextSeconds, sameDurationLength } from './duration';
import {
  applyAttendeeEdits,
  attendeeEdits,
  descriptionValue,
  locationChanges,
  reminderChanges,
  titleValue,
  type PathChange,
} from './edits';
import { exdateEntryKey } from './exdate';
import {
  FORBIDDEN_OVERRIDE_KEYS,
  instanceOf,
  isExcluded,
  keyToInstanceTime,
  overridesOf,
  withoutForbiddenKeys,
  type Override,
} from './exceptions';
import { eventImage, plainInstanceImage } from './image';
import { isRemovedInstance } from './merge';
import { reminderRows } from './reminders';
import { isRuleRepresentable, partsToRule, ruleToRRule, rruleParts, untilUtc, type RuleZone } from './rrule';
import { NOTIFYING_UNITS, sendsSchedulingMessages } from './scheduling';
import { fixedOffsetTiming, rowTiming, type RowTiming } from './timing';
import {
  EXCEPTION_COLUMN_UNITS,
  MASTER_COLUMN_UNITS,
  baselineOfImage,
  columnUnitDiffers,
  deviceChangedUnit,
  exdateEntries,
  isLossyEditor,
  remindersDiffer,
  sideOfBaseline,
  sideOfRow,
  type Side,
} from './units';
import { argbToCss, availabilityFromDevice, privacyFromDevice, statusFromDevice } from './values';
import {
  canonicalZone,
  classifyLocal,
  formatLocalDateTime,
  parseLocalDateTime,
  resolveWallClock,
  sameLocalDateTime,
  utcToLocal,
  wallFromMs,
  wallMs,
} from './zoned-time';

/** Why an item is not uploaded now (a skip), or why its change was put back (a revert). */
export const SKIP = {
  dstAmbiguous: 'dstAmbiguous',
  ruleNotRepresentable: 'ruleNotRepresentable',
  instanceOnly: 'instanceOnly',
  notOurCalendar: 'notOurCalendar',
  readOnly: 'readOnly',
  /** The user's answer, in a calendar that takes no answers either. */
  rsvpRefused: 'rsvpRefused',
  /** Moved in place to a calendar of another JMAP account: no patch can do that. */
  crossAccountMove: 'crossAccountMove',
  /** Every reminder removed from one occurrence of a series with alerts of its own: the occurrence would show those. */
  remindersNotRepresentable: 'remindersNotRepresentable',
} as const;

export class SkipUpload extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** The zone and all-day flag the series' LocalDateTimes (start, keys, UNTIL) are in, as written to the rows. */
export function seriesZone(local: LocalEventRow, shadow: CalendarEventWire | null, deviceZone: string): RuleZone {
  const allDay = shadow ? !!shadow.showWithoutTime : Number(local.cells[Events.ALL_DAY] ?? 0) === 1;
  if (allDay) return { allDay: true, zone: 'UTC' };
  const zone =
    canonicalZone(shadow?.timeZone) ??
    canonicalZone(local.baseline?.cells[Events.EVENT_TIMEZONE]) ??
    canonicalZone(local.cells[Events.EVENT_TIMEZONE]) ??
    canonicalZone(deviceZone) ??
    'UTC';
  return { allDay: false, zone };
}

/** A wall time Stalwart would drop (skipped or repeated) moved an hour later. */
function safeUntil(until: string, zone: RuleZone): string {
  if (zone.allDay) return until;
  const kind = classifyLocal(until, zone.zone);
  if (kind !== 'gap' && kind !== 'overlap') return until;
  const wall = parseLocalDateTime(until)!;
  return formatLocalDateTime(wallFromMs(wallMs(wall) + 3_600_000));
}

/** Parts Fossify Calendar's rule editor models; others it drops, and they stay. */
const LOSSY_RULE_PARTS = ['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH'];

/**
 * The rule a device RRULE stands for. A lossy editor's rule is applied part
 * by part onto the server's rule: parts it models and changed are taken,
 * parts it dropped stay (docs/device-sync.md, "Lossy calendar editors").
 */
export function deviceRule(
  rrule: unknown,
  baselineRRule: unknown,
  server: RecurrenceRule | null | undefined,
  zone: RuleZone,
  lossy: boolean,
): RecurrenceRule | null {
  const parts = rruleParts(rrule);
  if (!parts) return null;
  let merged = parts;
  if (lossy && server) {
    const before = rruleParts(baselineRRule) ?? new Map<string, string>();
    const serverParts = rruleParts(ruleText(server, zone)) ?? new Map<string, string>();
    merged = new Map(serverParts);
    for (const part of LOSSY_RULE_PARTS) {
      const now = parts.get(part);
      if (now !== undefined && now !== before.get(part)) {
        merged.set(part, now);
        if (part === 'COUNT') merged.delete('UNTIL');
        if (part === 'UNTIL') merged.delete('COUNT');
      }
    }
  }
  const rule = partsToRule(merged, zone);
  if (rule?.until) rule.until = safeUntil(rule.until, zone);
  return rule;
}

/** The server's rule in RRULE parts, so both sides of a lossy merge compare in one dialect. */
function ruleText(rule: RecurrenceRule, zone: RuleZone): string {
  return ruleToRRule(rule, zone) ?? '';
}

// ─── Patches for a dirty event ──────────────────────────

export interface UploadComputation {
  patch: PatchObject;
  /** Master units in the patch. */
  masterUnits: Set<string>;
  /** Exception rows (by id) whose changes are in the patch. */
  exceptionUnits: Map<number, Set<string>>;
  /** Exception rows whose instance is excluded by the patch, or already was. */
  removedExceptions: Set<number>;
  sendSchedulingMessages: boolean;
  /** The patch holds nothing but the user's own answer, to the series or to occurrences (what `mayRSVP` allows). */
  rsvpOnly: boolean;
  /** Units changed on the device that can't be uploaded (reported when nothing else is). */
  dropped: string[];
}

interface OverrideWork {
  /** Whole override values (or null) by recurrence id. */
  whole: Map<string, Override | null>;
  /** One-level properties of existing overrides by recurrence id. */
  props: Map<string, Record<string, unknown>>;
}

/** Sets a raw path in a patch: escaped once, never overlapping a pointer already there. */
export function put(patch: PatchObject, path: string[], value: unknown): void {
  setInPatch(patch, ptr(...path), value);
}

function putAll(patch: PatchObject, root: string[], changes: PathChange[]): void {
  for (const c of changes) put(patch, [...root, ...c.path], c.value);
}

/**
 * The patch for a dirty event with identity (see the header). Throws
 * `SkipUpload` for an item that must not be uploaded now.
 */
export function computeUpdate(local: LocalEvent, ctx: CalendarContext): UploadComputation {
  const shadow = local.shadow!;
  const calendar = ctx.calendarIdOfRow(local.calendarRowId);
  const calendarId = calendar?.calendarId ?? Object.keys(shadow.calendarIds ?? {})[0] ?? '';
  const image = eventImage(shadow, local.calendarRowId, calendarId, ctx);
  const baseline = local.baseline ?? (image ? baselineOfImage(image.master, false) : null);
  const zone = seriesZone(local, shadow, ctx.deviceZone);
  const lossy = isLossyEditor(local.mutators);
  const patch: PatchObject = {};
  const masterUnits = new Set<string>();
  const exceptionUnits = new Map<number, Set<string>>();
  const removedExceptions = new Set<number>();
  const dropped: string[] = [];
  const overrides: OverrideWork = { whole: new Map(), props: new Map() };
  const representable = isRuleRepresentable(shadow.recurrenceRule) && !shadow.recurrenceId;
  const serverOverrides = overridesOf(shadow);
  let rsvp = false;
  let attendeeOthers = false;
  let overridesChanged = false;
  let ruleRemoved = false;
  let rekey: number | null = null;

  const cur = sideOfRow(local);
  const bl: Side | null = baseline ? sideOfBaseline(baseline) : null;
  const changed = (unit: string) => {
    if (!bl) return false;
    const forced = local.split === 'source' && unit === 'rule';
    return (local.dirty || forced) && deviceChangedUnit(unit, cur, bl);
  };

  for (const unit of MASTER_COLUMN_UNITS) {
    if (!changed(unit)) continue;
    const cells = local.cells;
    switch (unit) {
      case 'title':
        put(patch, ['title'], titleValue(cells));
        break;
      case 'description':
        if (isTruncatedBaseline(baseline!.cells[Events.DESCRIPTION])) {
          dropped.push(unit);
          continue;
        }
        put(patch, ['description'], descriptionValue(cells));
        if (String(shadow.descriptionContentType ?? '').toLowerCase().startsWith('text/html')) {
          put(patch, ['descriptionContentType'], 'text/plain');
        }
        break;
      case 'location':
        putAll(patch, [], locationChanges(shadow, cells[Events.EVENT_LOCATION], ctx.mintKey).changes);
        break;
      case 'status':
        put(patch, ['status'], statusFromDevice(cells[Events.STATUS]));
        break;
      case 'availability':
        put(patch, ['freeBusyStatus'], availabilityFromDevice(cells[Events.AVAILABILITY]));
        break;
      case 'privacy':
        put(patch, ['privacy'], privacyFromDevice(cells[Events.ACCESS_LEVEL]));
        break;
      case 'color':
        put(patch, ['color'], argbToCss(cells[Events.EVENT_COLOR]));
        break;
      case 'calendar': {
        const to = ctx.calendarIdOfRow(Number(cells[Events.CALENDAR_ID]));
        const from = ctx.calendarIdOfRow(Number(baseline!.cells[Events.CALENDAR_ID]));
        if (!to || !from || to.jmapAccountId !== ctx.jmapAccountId || from.jmapAccountId !== ctx.jmapAccountId) {
          dropped.push(unit);
          continue;
        }
        put(patch, ['calendarIds', from.calendarId], null);
        put(patch, ['calendarIds', to.calendarId], true);
        break;
      }
      case 'timing': {
        if (!representable) {
          dropped.push(unit);
          continue;
        }
        const recurring = !!cells[Events.RRULE];
        let t = rowTiming(cells, {
          server: shadow,
          baselineZone: baseline!.cells[Events.EVENT_TIMEZONE] === null ? null : String(baseline!.cells[Events.EVENT_TIMEZONE] ?? ''),
          recurring,
          deviceZone: ctx.deviceZone,
        });
        if (!t) {
          dropped.push(unit);
          continue;
        }
        if (t.ambiguous) {
          if (recurring) throw new SkipUpload(SKIP.dstAmbiguous);
          t = fixedOffsetTiming(t);
        }
        applyTiming(patch, [], t, shadow);
        if (recurring && shadow.recurrenceRule && !sameLocalDateTime(t.start, shadow.start)) {
          rekey = wallMs(parseLocalDateTime(t.start)!) - wallMs(parseLocalDateTime(shadow.start)!);
        }
        break;
      }
      case 'rule': {
        if (!representable) {
          dropped.push(unit);
          continue;
        }
        const ruleZone: RuleZone = { allDay: Number(cells[Events.ALL_DAY] ?? 0) === 1, zone: zone.zone };
        const rule = deviceRule(cells[Events.RRULE], baseline!.cells[Events.RRULE], shadow.recurrenceRule, ruleZone, lossy);
        if (!rule) {
          put(patch, ['recurrenceRule'], null);
          if (Object.keys(serverOverrides).length) put(patch, ['recurrenceOverrides'], null);
          ruleRemoved = true;
          break;
        }
        put(patch, ['recurrenceRule'], rule);
        // "This and following": overrides after the new end go.
        const end = seriesEnd(rule, local, ruleZone);
        if (end !== null) {
          for (const key of Object.keys(serverOverrides)) {
            const at = keyToInstanceTime(key, ruleZone.allDay, ruleZone.zone);
            if (at !== null && at > end) {
              overrides.whole.set(key, null);
              overridesChanged = true;
            }
          }
        }
        break;
      }
    }
    masterUnits.add(unit);
  }

  // EXDATE entries added or removed on the device.
  if (bl && local.dirty && !ruleRemoved) {
    const now = exdateEntries(cur);
    const before = exdateEntries(bl);
    for (const entry of new Set([...now, ...before])) {
      if (now.has(entry) === before.has(entry)) continue;
      const key = exdateEntryKey(entry, zone);
      if (!key) continue;
      if (!zone.allDay && classifyLocal(key, zone.zone) === 'overlap') throw new SkipUpload(SKIP.dstAmbiguous);
      if (now.has(entry) && !isExcluded(serverOverrides[key])) overrides.whole.set(key, { excluded: true });
      else if (!now.has(entry) && isExcluded(serverOverrides[key])) overrides.whole.set(key, null);
      else continue;
      overridesChanged = true;
      masterUnits.add(`exdate:${entry}`);
    }
  }

  // Attendees.
  if (bl && local.dirty) {
    const edits = attendeeEdits(cur.attendees, bl.attendees, ctx, lossy);
    if (edits.length) {
      const result = applyAttendeeEdits(shadow.participants, edits, ctx, ctx.mintKey, lossy);
      if (result.changes.length) {
        if (!Object.keys(shadow.participants ?? {}).length) put(patch, ['participants'], result.participants);
        else putAll(patch, ['participants'], result.changes);
        rsvp = rsvp || result.rsvp;
        attendeeOthers = attendeeOthers || result.others;
        for (const e of edits) masterUnits.add(`attendee:${e.key}`);
      }
    }
  }

  // Reminders, only when the calendar app owns them.
  if (bl && local.dirty && ctx.reminderOwner === 'device' && remindersDiffer(cur, bl)) {
    putAll(patch, [], reminderChanges(shadow, ctx.calendar(calendarId), cur.reminders!, ctx.mintKey).changes);
    masterUnits.add('reminders');
  }

  // Exception rows.
  let answersOnly = true;
  if (!ruleRemoved && shadow.recurrenceRule) {
    for (const x of local.exceptions) {
      const units = exceptionChanges(x, local, shadow, calendarId, zone, overrides, removedExceptions, ctx, lossy);
      if (units.dropped) dropped.push(...units.dropped);
      if (units.units.size) {
        exceptionUnits.set(x.eventId, units.units);
        overridesChanged = true;
        rsvp = rsvp || units.rsvp;
        answersOnly &&= units.rsvp && !units.others && units.units.size === 1 && units.units.has('attendees');
      }
    }
  }

  if (!ruleRemoved) materializeOverrides(patch, shadow, overrides, rekey, zone);

  const notifying = NOTIFYING_UNITS.some((u) => masterUnits.has(u)) || overridesChanged || attendeeOthers;
  const sendSchedulingMessages = sendsSchedulingMessages(shadow, { kind: 'update', notifying, rsvp, addsAttendees: attendeeOthers }, ctx);
  const rsvpOnly = rsvp && answersOnly && !attendeeOthers && [...masterUnits].every((u) => u.startsWith('attendee:'));

  return { patch, masterUnits, exceptionUnits, removedExceptions, sendSchedulingMessages, dropped, rsvpOnly };
}

/** Timing properties that differ from the server's. */
function applyTiming(patch: PatchObject, root: string[], t: RowTiming, server: { start?: string; duration?: string; timeZone?: string | null; showWithoutTime?: boolean | null }): void {
  if (!sameLocalDateTime(t.start, server.start)) put(patch, [...root, 'start'], t.start);
  if (!sameDurationLength(t.duration, server.duration ?? 'PT0S')) put(patch, [...root, 'duration'], t.duration);
  if (root.length === 0 && (t.timeZone ?? null) !== (server.timeZone ?? null)) put(patch, ['timeZone'], t.timeZone);
  if (root.length === 0 && !!t.showWithoutTime !== !!server.showWithoutTime) put(patch, ['showWithoutTime'], t.showWithoutTime);
}

/**
 * Where the capped series ends: the UNTIL instant, or for a COUNT the start
 * of the last instance as CalendarProvider computed it (LAST_DATE minus the
 * duration). Null when unknown or unbounded.
 */
function seriesEnd(rule: RecurrenceRule, local: LocalEventRow, zone: RuleZone): number | null {
  if (rule.until && !rule.count) return untilUtc(rule, zone);
  if (!rule.count) return null;
  const lastDate = num(local.cells[Events.LAST_DATE]);
  const seconds = durationTextSeconds(local.cells[Events.DURATION]);
  if (lastDate === null || seconds === null) return null;
  return lastDate - seconds * 1000;
}

function exceptionChanges(
  x: LocalException,
  master: LocalEvent,
  shadow: CalendarEventWire,
  calendarId: string,
  zone: RuleZone,
  work: OverrideWork,
  removed: Set<number>,
  ctx: CalendarContext,
  lossy: boolean,
): { units: Set<string>; rsvp: boolean; others?: boolean; dropped?: string[] } {
  const units = new Set<string>();
  const key = x.recurrenceId;
  if (!key) return { units, rsvp: false };
  const ours = typeof x.cells[Events.SYNC_DATA2] === 'string' && !!x.cells[Events.SYNC_DATA2];
  if (!ours && !zone.allDay && classifyLocal(key, zone.zone) === 'overlap') throw new SkipUpload(SKIP.dstAmbiguous);
  const server = overridesOf(shadow)[key];
  const cancelled = Number(x.cells[Events.STATUS]) === EventStatus.CANCELED;
  if (isRemovedInstance(x) || (cancelled && isExcluded(server))) {
    removed.add(x.eventId);
    if (!isExcluded(server)) {
      work.whole.set(key, { excluded: true });
      units.add('removed');
    }
    return { units, rsvp: false };
  }
  if (!x.dirty) return { units, rsvp: false };
  const plain = plainInstanceImage(shadow, key, master.calendarRowId, calendarId, ctx);
  if (!plain) return { units, rsvp: false };
  const existing = !!server && !isExcluded(server);
  const instance = instanceOf(shadow, key, existing ? server : null);
  // An existing override changes against what device sync last wrote; a new one against the plain instance.
  const reference: Side = existing && x.baseline ? sideOfBaseline(x.baseline) : { cells: plain.cells, attendees: plain.attendees, reminders: plain.reminders };
  const cur = sideOfRow(x);
  const values: Record<string, unknown> = {};
  let rsvp = false;
  let others = false;
  const organizer = userIsOrganizer(shadow, ctx);

  for (const unit of EXCEPTION_COLUMN_UNITS) {
    if (unit === 'privacy') continue; // Stalwart drops privacy from overrides.
    // Etar answers one instance with STATUS_CONFIRMED on it; an attendee may not change an event's status.
    if (unit === 'status' && !organizer) continue;
    if (unit !== 'timing' && !deviceChangedUnit(unit, cur, reference)) continue;
    // A new exception row holds what its app copied: an empty value there is one it did not model, not a deletion.
    if (!existing && INHERITED_WHEN_EMPTY.has(unit) && isEmptyUnit(unit, x.cells)) continue;
    const cells = x.cells;
    switch (unit) {
      case 'title':
        values.title = titleValue(cells);
        break;
      case 'description':
        if (x.baseline && isTruncatedBaseline(x.baseline.cells[Events.DESCRIPTION])) continue;
        values.description = descriptionValue(cells) ?? clearedInOverride('description', instance, shadow);
        break;
      case 'location':
        values.locations = locationChanges(instance, cells[Events.EVENT_LOCATION], ctx.mintKey).locations ?? clearedInOverride('location', instance, shadow);
        break;
      case 'status':
        values.status = statusFromDevice(cells[Events.STATUS]);
        break;
      case 'availability':
        values.freeBusyStatus = availabilityFromDevice(cells[Events.AVAILABILITY]);
        break;
      case 'color':
        values.color = argbToCss(cells[Events.EVENT_COLOR]) ?? clearedInOverride('color', instance, shadow);
        break;
      case 'timing': {
        const moved = columnUnitDiffers('timing', cur, reference);
        if (existing && !moved) continue;
        let t = rowTiming(cells, {
          server: { ...instance, showWithoutTime: shadow.showWithoutTime, timeZone: instance.timeZone ?? shadow.timeZone },
          baselineZone: String(reference.cells[Events.EVENT_TIMEZONE] ?? ''),
          recurring: false,
          deviceZone: ctx.deviceZone,
        });
        if (!t) continue;
        if (t.ambiguous) throw new SkipUpload(SKIP.dstAmbiguous);
        if (t.showWithoutTime !== !!shadow.showWithoutTime) t = { ...t, showWithoutTime: !!shadow.showWithoutTime };
        if (existing) {
          if (!sameLocalDateTime(t.start, instance.start)) values.start = t.start;
          if (!sameDurationLength(t.duration, instance.duration ?? 'PT0S')) values.duration = t.duration;
          if (!('start' in values) && !('duration' in values)) continue;
        } else {
          // A new override pins its start and length, as the app's own occurrence edits do.
          values.start = t.start;
          values.duration = t.duration;
          if (!moved) continue;
        }
        break;
      }
    }
    units.add(unit);
  }

  // A new exception row without attendees or reminders did not copy them: the series' apply.
  const edits = existing || cur.attendees.length ? attendeeEdits(cur.attendees, reference.attendees, ctx, lossy) : [];
  if (edits.length) {
    const result = applyAttendeeEdits(instance.participants, edits, ctx, ctx.mintKey, lossy);
    if (result.changes.length) {
      values.participants = result.participants;
      rsvp = result.rsvp;
      others = result.others;
      units.add('attendees');
    }
  }
  let dropped: string[] | undefined;
  if (ctx.reminderOwner === 'device' && (existing || cur.reminders!.length) && remindersDiffer(cur, reference)) {
    const alerts = reminderChanges(instance, ctx.calendar(calendarId), cur.reminders!, ctx.mintKey).alerts;
    if (!Object.keys(alerts).length && reminderRows(shadow.alerts).length) {
      // An override is stored as a VEVENT of its own and an empty map writes no VALARM, so an override without
      // alerts shows the series' again: none at all can't be stored while the series has alerts of its own.
      dropped = ['reminders'];
    } else {
      values.alerts = alerts;
      // An occurrence on the calendar's defaults ignores its own alerts: it leaves them, as a series does
      // (Stalwart keeps the override's `useDefaultAlerts` as a JSPROP; the series stays on the defaults).
      if (instance.useDefaultAlerts) values.useDefaultAlerts = false;
      units.add('reminders');
    }
  }

  if (existing) {
    if (units.size) work.props.set(key, { ...(work.props.get(key) ?? {}), ...values });
    return { units, rsvp, others, dropped };
  }
  // A new override: nothing but its pinned time is still an override (an app saving the instance unchanged).
  if (!units.size) units.add('new');
  work.whole.set(key, newOverride(shadow, key, values));
  return { units, rsvp, others, dropped };
}

/** Units a new exception row inherits from its series when it leaves them empty. */
const INHERITED_WHEN_EMPTY = new Set(['title', 'description', 'location', 'color']);

function isEmptyUnit(unit: string, cells: Row): boolean {
  const column = { title: Events.TITLE, description: Events.DESCRIPTION, location: Events.EVENT_LOCATION, color: Events.EVENT_COLOR }[unit];
  const v = column ? cells[column] : null;
  return v === null || v === undefined || v === '';
}

/**
 * A description, location or colour cleared on an existing override. An
 * override without one of its own shows the series' again, so while the
 * series has one the override gets the empty value Stalwart keeps: the empty
 * text or colour (an empty DESCRIPTION or COLOR; an empty colour is none, the
 * calendar's, on the device), or a location without a name (an empty map
 * writes no LOCATION line and reads back as none of its own). Null, a clean
 * removal, when nothing would come back.
 */
function clearedInOverride(unit: 'description' | 'location' | 'color', instance: CalendarEventWire, master: CalendarEventWire): unknown {
  if (unit === 'description') return typeof master.description === 'string' && master.description ? '' : null;
  if (unit === 'color') return typeof master.color === 'string' && master.color ? '' : null;
  const series = Object.keys(master.locations ?? {});
  if (!series.length) return null;
  const key = Object.keys(instance.locations ?? {})[0] ?? series[0];
  return { [key]: { '@type': 'Location', name: '' } };
}

/**
 * A new override: the changes plus the details Stalwart needs on it (title,
 * locations, participants, sequence, …; `withNewOverrideDetails`), minus what
 * Stalwart drops from overrides. The master's own alerts are not copied
 * while it uses the calendar's defaults: they are not in force.
 */
export function newOverride(master: CalendarEventWire, key: string, values: Record<string, unknown>): Override {
  const occurrence = {
    ...(master as unknown as Record<string, unknown>),
    recurrenceId: key,
    recurrenceOverrides: master.recurrenceOverrides ?? {},
    start: undefined,
    baseEventId: undefined,
  };
  const withDetails = withNewOverrideDetails(occurrence as never, values as never) as Record<string, unknown>;
  if (master.useDefaultAlerts && !('alerts' in values)) delete withDetails.alerts;
  const out = withoutForbiddenKeys(withDetails);
  for (const name of FORBIDDEN_OVERRIDE_KEYS) delete out[name];
  return out;
}

function materializeOverrides(patch: PatchObject, shadow: CalendarEventWire, work: OverrideWork, rekey: number | null, zone: RuleZone): void {
  const server = overridesOf(shadow);
  if (rekey !== null && Object.keys(server).length) {
    // "All events" moved the series: every recurrence id moves by the same wall-clock offset.
    const map: Record<string, Override> = clone(server);
    for (const [key, value] of work.whole) {
      if (value === null) delete map[key];
      else map[key] = value;
    }
    for (const [key, props] of work.props) if (map[key]) map[key] = { ...map[key], ...props };
    const shifted: Record<string, Override> = {};
    for (const [key, value] of Object.entries(map)) {
      const moved = shiftLocal(key, rekey, zone);
      const next = clone(value);
      if (!isExcluded(next) && typeof next.start === 'string' && sameLocalDateTime(next.start, key)) next.start = shiftLocal(next.start, rekey, zone);
      shifted[moved] = next;
    }
    put(patch, ['recurrenceOverrides'], Object.keys(shifted).length ? shifted : null);
    return;
  }
  if (!Object.keys(server).length) {
    // The first override: a pointer below a missing map fails, so the whole map goes.
    const whole: Record<string, Override> = {};
    for (const [key, value] of work.whole) if (value) whole[key] = value;
    if (Object.keys(whole).length) put(patch, ['recurrenceOverrides'], whole);
    return;
  }
  for (const [key, value] of work.whole) put(patch, ['recurrenceOverrides', key], value);
  for (const [key, props] of work.props) for (const [name, value] of Object.entries(props)) put(patch, ['recurrenceOverrides', key, name], value);
}

/** A LocalDateTime moved by wall-clock milliseconds; a result in a skipped hour moves forward like the instance does. */
function shiftLocal(value: string, deltaMs: number, zone: RuleZone): string {
  const wall = parseLocalDateTime(value);
  if (!wall) return value;
  const moved = wallFromMs(wallMs(wall) + deltaMs);
  const text = formatLocalDateTime(moved);
  if (zone.allDay) return text;
  const kind = classifyLocal(text, zone.zone);
  if (kind === 'overlap') throw new SkipUpload(SKIP.dstAmbiguous);
  if (kind === 'gap') return utcToLocal(resolveWallClock(moved, canonicalZone(zone.zone) ?? 'UTC').utc, zone.zone);
  return text;
}

