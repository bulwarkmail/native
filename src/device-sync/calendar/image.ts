/**
 * A server event as the rows it becomes on the device: the master row's
 * mapped cells, its attendees and reminders, and one exception row per
 * override that is not an exclusion (docs/device-sync.md, "Calendar
 * mapping"). The cells are what CalendarProvider stores after the write:
 * all-day times at UTC midnight, DURATION only on recurring masters, the
 * organizer the provider would fill in, STATUS never NULL. Predicting the
 * provider keeps echo downloads free of writes.
 */
import { Events } from '../android-columns';
import type { CalendarContext } from '../planner';
import type { Row } from '../types';
import type { CalendarEventWire } from '../wire';
import { htmlToPlainText } from '../../lib/compose-html';
import { attendeeRows, hasMailtoParticipants, organizerAddress } from './attendees';
import { truncateUtf8 } from './columns';
import { formatExdate } from './exdate';
import { instanceOf, isExcluded, keyToInstanceTime, overridesOf } from './exceptions';
import { effectiveAlerts, reminderRows } from './reminders';
import { isRuleRepresentable, ruleToRRule } from './rrule';
import { eventZone, timingCells } from './timing';
import {
  availabilityToDevice,
  cssColorToArgb,
  privacyToDevice,
  statusToDevice,
} from './values';
import { parseLocalDateTime } from './zoned-time';

export type ImageContext = Pick<
  CalendarContext,
  'deviceZone' | 'ownerAccount' | 'selfAddresses' | 'reminderOwner' | 'calendar'
>;

export interface RowImage {
  cells: Row;
  attendees: Row[];
  /** Null when Bulwark owns reminders: Reminders rows are then left alone. */
  reminders: Row[] | null;
  /** Whether the event has `mailto:` participants (ORGANIZER is written only then). */
  hasParticipants: boolean;
  truncatedDescription: boolean;
}

export interface ExceptionImage extends RowImage {
  key: string;
}

export interface EventImage {
  master: RowImage;
  /** Exception rows by recurrence id. */
  exceptions: Map<string, ExceptionImage>;
  /** Recurrence ids of `{excluded: true}` overrides (the EXDATE column). */
  excluded: Set<string>;
  zone: string;
  allDay: boolean;
  floating: boolean;
  recurring: boolean;
  /** False when the rule needs RSCALE, SKIP or leap months: shown approximately, timing never uploaded. */
  representable: boolean;
}

/** DESCRIPTION: HTML turned to text (and uploaded as text/plain only when edited), cut at 64 KB. */
export function descriptionCell(event: CalendarEventWire): { text: string | null; truncated: boolean } {
  let text = typeof event.description === 'string' ? event.description : '';
  if (text && String(event.descriptionContentType ?? '').toLowerCase().startsWith('text/html')) text = htmlToPlainText(text);
  if (!text) return { text: null, truncated: false };
  const cut = truncateUtf8(text);
  return { text: cut.text, truncated: cut.truncated };
}

/** The first location's name, in server order. */
export function locationCell(event: CalendarEventWire): string | null {
  const first = Object.values(event.locations ?? {})[0];
  const name = first && typeof first === 'object' ? first.name : undefined;
  return typeof name === 'string' && name ? name : null;
}

function rowImage(
  event: CalendarEventWire,
  timing: Row,
  calendarRowId: number,
  calendarId: string,
  ctx: ImageContext,
): RowImage {
  const description = descriptionCell(event);
  const hasParticipants = hasMailtoParticipants(event.participants);
  const cells: Row = {
    [Events.CALENDAR_ID]: calendarRowId,
    [Events.TITLE]: typeof event.title === 'string' && event.title ? event.title : null,
    [Events.DESCRIPTION]: description.text,
    [Events.EVENT_LOCATION]: locationCell(event),
    [Events.STATUS]: statusToDevice(event.status),
    [Events.AVAILABILITY]: availabilityToDevice(event.freeBusyStatus),
    [Events.ACCESS_LEVEL]: privacyToDevice(event.privacy),
    [Events.EVENT_COLOR]: cssColorToArgb(event.color),
    [Events.ORGANIZER]: (hasParticipants ? organizerAddress(event, ctx) : null) ?? ctx.ownerAccount,
    ...timing,
  };
  const reminders =
    ctx.reminderOwner === 'device'
      ? reminderRows(effectiveAlerts(event, ctx.calendar(calendarId)))
      : null;
  return {
    cells,
    attendees: hasParticipants ? attendeeRows(event, ctx) : [],
    reminders,
    hasParticipants,
    truncatedDescription: description.truncated,
  };
}

/**
 * The rows of a server event in the calendar row `calendarRowId` (server
 * calendar `calendarId`, whose default alerts apply). Null when the event's
 * start can't be read.
 */
export function eventImage(
  event: CalendarEventWire,
  calendarRowId: number,
  calendarId: string,
  ctx: ImageContext,
): EventImage | null {
  const { zone, allDay, floating } = eventZone(event, ctx.deviceZone);
  const rule = event.recurrenceRule ?? null;
  const rrule = rule ? ruleToRRule(rule, { allDay, zone }) : null;
  const recurring = rrule !== null;
  const timing = timingCells(event, recurring, ctx.deviceZone);
  if (!timing) return null;
  const overrides = recurring ? overridesOf(event) : {};
  const excluded = new Set<string>();
  const exceptions = new Map<string, ExceptionImage>();
  for (const [key, override] of Object.entries(overrides)) {
    if (!parseLocalDateTime(key) || !override || typeof override !== 'object') continue;
    if (isExcluded(override)) {
      excluded.add(key);
      continue;
    }
    const originalInstanceTime = keyToInstanceTime(key, allDay, zone);
    if (originalInstanceTime === null) continue;
    const instance = instanceOf(event, key, override);
    // An instance keeps the series' kind of time; only its start and length move.
    const instanceTiming = timingCells(
      { ...instance, showWithoutTime: event.showWithoutTime, timeZone: instance.timeZone ?? event.timeZone },
      false,
      ctx.deviceZone,
    );
    if (!instanceTiming) continue;
    const image = rowImage(instance, instanceTiming, calendarRowId, calendarId, ctx);
    image.cells[Events.ORIGINAL_INSTANCE_TIME] = originalInstanceTime;
    image.cells[Events.ORIGINAL_ALL_DAY] = allDay ? 1 : 0;
    exceptions.set(key, { ...image, key });
  }
  const master = rowImage(event, timing, calendarRowId, calendarId, ctx);
  master.cells[Events.RRULE] = rrule;
  master.cells[Events.EXDATE] = recurring ? formatExdate(excluded, { allDay, zone }) : null;
  return {
    master,
    exceptions,
    excluded,
    zone,
    allDay,
    floating,
    recurring,
    representable: isRuleRepresentable(rule),
  };
}

/**
 * The row an instance of the series would have without an exception row:
 * the master at that recurrence id. The baseline of an exception an app
 * creates, and what its changes are measured against.
 */
export function plainInstanceImage(
  master: CalendarEventWire,
  key: string,
  calendarRowId: number,
  calendarId: string,
  ctx: ImageContext,
): ExceptionImage | null {
  const { zone, allDay } = eventZone(master, ctx.deviceZone);
  const override = overridesOf(master)[key];
  const instance = instanceOf(master, key, override && !isExcluded(override) ? override : null);
  const timing = timingCells(
    { ...instance, showWithoutTime: master.showWithoutTime, timeZone: instance.timeZone ?? master.timeZone },
    false,
    ctx.deviceZone,
  );
  const originalInstanceTime = keyToInstanceTime(key, allDay, zone);
  if (!timing || originalInstanceTime === null) return null;
  const image = rowImage(instance, timing, calendarRowId, calendarId, ctx);
  image.cells[Events.ORIGINAL_INSTANCE_TIME] = originalInstanceTime;
  image.cells[Events.ORIGINAL_ALL_DAY] = allDay ? 1 : 0;
  return { ...image, key };
}
