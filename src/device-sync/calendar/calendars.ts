/**
 * JMAP calendars ↔ CalendarContract.Calendars rows (docs/device-sync.md,
 * "Calendar rows").
 *
 * Every column CalendarProvider and the calendar apps need is written:
 * SYNC_EVENTS=1 (the default 0 hides every instance), a non-null
 * OWNER_ACCOUNT (Etar crashes on NULL), CAN_PARTIALLY_UPDATE=0 (else the
 * provider keeps LAST_SYNCED copies), MAX_REMINDERS by who owns reminders.
 * VISIBLE is written on insert only: afterwards it is the user's. CAL_SYNC1
 * stays empty because the provider sends it as the `feed` extra of the sync
 * it requests for such calendars. A row is updated only where it differs.
 */
import { CalendarAccess, Calendars } from '../android-columns';
import type { CalendarContext, LocalCalendar, OpGroup } from '../planner';
import type { Row, WriteRow } from '../types';
import type { CalendarLike } from '../wire';
import { collectionKey, parseCollectionKey } from '../common/ids';
import { deepEqual, parseJsonColumn } from '../common/json';
import { BIRTHDAY_CALENDAR_ID } from '../../lib/birthday-calendar';
import { colors } from '../../theme/tokens';
import { isSelfAddress } from './attendees';
import { CAN_PARTIALLY_UPDATE } from './columns';
import { cssColorToArgb } from './values';
import { canonicalZone } from './zoned-time';

export interface SelectedCalendar {
  jmapAccountId: string;
  calendar: CalendarLike;
  readOnly: boolean;
  /** The JMAP account's name, appended to calendars of shared accounts. */
  accountName: string;
}

type CalendarsContext = Omit<CalendarContext, 'jmapAccountId'>;

/** The app's palette colour for a calendar without one (`getCalendarColor` in lib/calendar-utils.ts). */
const PALETTE = [
  colors.calendar.blue,
  colors.calendar.green,
  colors.calendar.purple,
  colors.calendar.orange,
  colors.calendar.red,
  colors.calendar.pink,
  colors.calendar.teal,
  colors.calendar.indigo,
];

function paletteColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/**
 * CALENDAR_ACCESS_LEVEL from `myRights`: write all → OWNER, write own →
 * CONTRIBUTOR (Etar's threshold for editing), RSVP → RESPOND, else READ. A
 * read-only calendar whose rights allow writing is a subscribed feed: READ.
 */
export function accessLevel(calendar: CalendarLike, readOnly: boolean): { level: number; reason: 'rights' | 'subscription' | null } {
  const rights = calendar.myRights;
  const writable = !rights || !!rights.mayWriteAll || !!rights.mayWriteOwn;
  if (readOnly && writable) return { level: CalendarAccess.READ, reason: 'subscription' };
  const level = !rights || rights.mayWriteAll
    ? CalendarAccess.OWNER
    : rights.mayWriteOwn
      ? CalendarAccess.CONTRIBUTOR
      : rights.mayRSVP
        ? CalendarAccess.RESPOND
        : CalendarAccess.READ;
  return { level: readOnly && level >= CalendarAccess.CONTRIBUTOR ? CalendarAccess.RESPOND : level, reason: readOnly ? 'rights' : null };
}

/** The columns device sync keeps on a calendar row (VISIBLE aside). */
export function calendarValues(selected: SelectedCalendar, ctx: CalendarsContext): WriteRow {
  const { calendar } = selected;
  const shared = !!selected.accountName && !isSelfAddress(selected.accountName, ctx);
  const name = calendar.name || calendar.id;
  const access = accessLevel(calendar, selected.readOnly);
  const flags = access.reason ? { readOnly: access.reason } : {};
  return {
    [Calendars._SYNC_ID]: collectionKey(selected.jmapAccountId, calendar.id),
    [Calendars.NAME]: name,
    [Calendars.CALENDAR_DISPLAY_NAME]: shared ? `${name} (${selected.accountName})` : name,
    [Calendars.CALENDAR_COLOR]: cssColorToArgb(calendar.color) ?? cssColorToArgb(paletteColor(calendar.id))!,
    [Calendars.CALENDAR_ACCESS_LEVEL]: access.level,
    [Calendars.OWNER_ACCOUNT]: ctx.ownerAccount,
    [Calendars.SYNC_EVENTS]: 1,
    [Calendars.CALENDAR_TIME_ZONE]: canonicalZone(calendar.timeZone) ?? ctx.deviceZone,
    [Calendars.ALLOWED_REMINDERS]: '1,2',
    [Calendars.ALLOWED_AVAILABILITY]: '0,1',
    [Calendars.ALLOWED_ATTENDEE_TYPES]: '0,1,2,3',
    [Calendars.MAX_REMINDERS]: ctx.reminderOwner === 'bulwark' ? 0 : 5,
    [Calendars.CAN_ORGANIZER_RESPOND]: 0,
    [CAN_PARTIALLY_UPDATE]: 0,
    [Calendars.CAL_SYNC2]: JSON.stringify(calendar),
    [Calendars.CAL_SYNC3]: JSON.stringify(flags),
  };
}

const JSON_COLUMNS = new Set<string>([Calendars.CAL_SYNC2, Calendars.CAL_SYNC3]);

function differs(column: string, have: Row[string] | undefined, want: WriteRow[string]): boolean {
  if (JSON_COLUMNS.has(column)) return !deepEqual(parseJsonColumn(have), parseJsonColumn(want));
  if (typeof want === 'number') return Number(have) !== want || have === null || have === undefined;
  return (have ?? null) !== (want ?? null);
}

export function planCalendars(
  selected: SelectedCalendar[],
  local: LocalCalendar[],
  ctx: CalendarsContext,
): { groups: OpGroup[]; deleteCalendarRows: number[] } {
  const groups: OpGroup[] = [];
  const rows = new Map<string, LocalCalendar>();
  for (const row of local) if (row.syncId && !rows.has(row.syncId)) rows.set(row.syncId, row);
  const wanted = new Set<string>();
  for (const s of selected) {
    // The birthday calendar is the app's own, generated from contacts.
    if (s.calendar.id === BIRTHDAY_CALENDAR_ID) continue;
    const key = collectionKey(s.jmapAccountId, s.calendar.id);
    wanted.add(key);
    const values = calendarValues(s, ctx);
    const row = rows.get(key);
    if (!row) {
      // DIRTY is NULL after a sync-adapter insert unless written.
      groups.push({ ref: key, ops: [{ op: 'insert', table: 'calendars', values: { ...values, [Calendars.VISIBLE]: 1, [Calendars.DIRTY]: 0 } }] });
      continue;
    }
    const changes: WriteRow = {};
    for (const [column, want] of Object.entries(values)) {
      if (differs(column, row.cells[column], want)) changes[column] = want;
    }
    if (Object.keys(changes).length) {
      groups.push({ ref: key, ops: [{ op: 'update', table: 'calendars', id: row.calendarRowId, values: changes, expectCount: 1 }] });
    }
  }
  const deleteCalendarRows = local
    .filter((row) => row.syncId && parseCollectionKey(row.syncId) && !wanted.has(row.syncId))
    .map((row) => row.calendarRowId);
  return { groups, deleteCalendarRows };
}
