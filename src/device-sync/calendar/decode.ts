/**
 * Provider rows → the planner's view of local events and calendars
 * (docs/device-sync.md, "Device data model"). Every sync column is read
 * defensively: another app could have written anything there, and a value
 * that doesn't parse counts as absent.
 *
 * Exception rows are grouped under their master by ORIGINAL_ID, else by
 * ORIGINAL_SYNC_ID. Two masters sharing a `_SYNC_ID` are a
 * CONTENT_EXCEPTION_URI split (the provider clones `_SYNC_ID`, SYNC_DATA*
 * and UID_2445 and caps the old rule without DIRTY): the newer row is marked
 * `clone`, the older `source`. A new master whose UID_2445 another row
 * already carries is marked `clone` too, so its create gets a fresh uid
 * instead of adopting the other row's server object.
 */
import { Attendees, Calendars, Events, Reminders } from '../android-columns';
import type { LocalAttendee, LocalCalendar, LocalEvent, LocalEventRow, LocalException, LocalReminder, PendingCreate, PoisonMarker } from '../planner';
import type { Row } from '../types';
import type { CalendarEventWire, CalendarLike } from '../wire';
import { parseJsonColumn } from '../common/json';
import { parseObjectRef, pendingUidOf } from '../common/ids';
import { decodeBaseline } from './columns';
import { instanceTimeToKey } from './exceptions';
import { canonicalZone, parseLocalDateTime } from './zoned-time';

const has = (v: unknown) => v !== null && v !== undefined && v !== '';
const num = (v: unknown) => (has(v) && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);

export function decodePending(text: unknown): PendingCreate | null {
  const p = parseJsonColumn<Record<string, unknown>>(text);
  if (!p || typeof p.uid !== 'string' || !p.uid || typeof p.target !== 'string' || !p.target) return null;
  return { uid: p.uid, target: p.target };
}

export function decodePoison(text: unknown): PoisonMarker | null {
  const p = parseJsonColumn<Record<string, unknown>>(text);
  if (!p || typeof p.fp !== 'string' || typeof p.type !== 'string') return null;
  const n = Number(p.n);
  const until = Number(p.until);
  return {
    fp: p.fp,
    type: p.type,
    ...(typeof p.description === 'string' ? { description: p.description } : {}),
    n: Number.isFinite(n) ? n : 1,
    until: Number.isFinite(until) ? until : 0,
  };
}

export function decodeShadow(text: unknown): CalendarEventWire | null {
  const e = parseJsonColumn<CalendarEventWire>(text);
  return e && typeof e === 'object' && !Array.isArray(e) && typeof e.id === 'string' ? e : null;
}

/** Whether a row is an exception (ORIGINAL_ID or ORIGINAL_SYNC_ID set): it never uploads as an event of its own. */
export function isExceptionRow(cells: Row): boolean {
  return has(cells[Events.ORIGINAL_ID]) || has(cells[Events.ORIGINAL_SYNC_ID]);
}

function decodeRow(row: Row, attendees: LocalAttendee[], reminders: LocalReminder[]): LocalEventRow {
  const cells: Row = { ...row };
  for (const c of [Events.SYNC_DATA1, Events.SYNC_DATA3, Events.SYNC_DATA4, Events.SYNC_DATA5]) delete cells[c];
  return {
    eventId: Number(row[Events._ID]),
    calendarRowId: Number(row[Events.CALENDAR_ID]),
    syncId: str(row[Events._SYNC_ID]),
    dirty: Number(row[Events.DIRTY] ?? 0) === 1,
    deleted: Number(row[Events.DELETED] ?? 0) === 1,
    cells,
    attendees,
    reminders,
    baseline: decodeBaseline(row[Events.SYNC_DATA4]),
    pending: decodePending(row[Events.SYNC_DATA3]),
    poison: decodePoison(row[Events.SYNC_DATA5]),
    mutators: str(row[Events.MUTATORS]),
  };
}

/** The recurrence id of an exception row: SYNC_DATA2 on our rows, else ORIGINAL_INSTANCE_TIME in the master's zone. */
export function exceptionKey(row: LocalEventRow, master: LocalEventRow | null): string | null {
  const stored = row.cells[Events.SYNC_DATA2];
  if (typeof stored === 'string' && parseLocalDateTime(stored)) return stored;
  const oit = num(row.cells[Events.ORIGINAL_INSTANCE_TIME]);
  if (oit === null) return null;
  const source = master ?? row;
  const allDay = Number(source.cells[Events.ALL_DAY] ?? row.cells[Events.ORIGINAL_ALL_DAY] ?? 0) === 1;
  const zone = canonicalZone(source.cells[Events.EVENT_TIMEZONE]) ?? 'UTC';
  return instanceTimeToKey(oit, allDay, allDay ? 'UTC' : zone);
}

export function decodeEvents(events: Row[], attendees: Row[], reminders: Row[]): LocalEvent[] {
  const attendeesOf = new Map<number, LocalAttendee[]>();
  for (const a of attendees) {
    const id = Number(a[Attendees.EVENT_ID]);
    const list = attendeesOf.get(id) ?? [];
    const cells: Row = { ...a };
    delete cells[Attendees._ID];
    delete cells[Attendees.EVENT_ID];
    list.push({ id: Number(a[Attendees._ID]), cells });
    attendeesOf.set(id, list);
  }
  const remindersOf = new Map<number, LocalReminder[]>();
  for (const r of reminders) {
    const id = Number(r[Reminders.EVENT_ID]);
    const list = remindersOf.get(id) ?? [];
    const cells: Row = { ...r };
    delete cells[Reminders._ID];
    delete cells[Reminders.EVENT_ID];
    list.push({ id: Number(r[Reminders._ID]), cells });
    remindersOf.set(id, list);
  }

  const masters: LocalEvent[] = [];
  const exceptionRows: LocalEventRow[] = [];
  for (const row of [...events].sort((a, b) => Number(a[Events._ID]) - Number(b[Events._ID]))) {
    const id = Number(row[Events._ID]);
    const decoded = decodeRow(row, attendeesOf.get(id) ?? [], remindersOf.get(id) ?? []);
    if (isExceptionRow(decoded.cells)) {
      exceptionRows.push(decoded);
    } else {
      masters.push({ ...decoded, shadow: decodeShadow(row[Events.SYNC_DATA1]), exceptions: [] });
    }
  }

  const byId = new Map(masters.map((m) => [m.eventId, m]));
  const bySyncId = new Map<string, LocalEvent[]>();
  for (const m of masters) {
    if (!m.syncId) continue;
    const list = bySyncId.get(m.syncId) ?? [];
    list.push(m);
    bySyncId.set(m.syncId, list);
  }

  const orphans: LocalEvent[] = [];
  for (const row of exceptionRows) {
    const originalId = num(row.cells[Events.ORIGINAL_ID]);
    let master = originalId !== null ? byId.get(originalId) : undefined;
    if (!master) {
      const candidates = bySyncId.get(String(row.cells[Events.ORIGINAL_SYNC_ID] ?? '')) ?? [];
      master = candidates.find((m) => m.calendarRowId === row.calendarRowId) ?? candidates[0];
    }
    if (!master) {
      orphans.push({ ...row, shadow: null, exceptions: [] });
      continue;
    }
    const exception: LocalException = {
      ...row,
      recurrenceId: exceptionKey(row, master),
      originalInstanceTime: num(row.cells[Events.ORIGINAL_INSTANCE_TIME]),
    };
    master.exceptions.push(exception);
  }

  // A CONTENT_EXCEPTION_URI split: the oldest row keeps the identity, the others are new events.
  for (const group of bySyncId.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.eventId - b.eventId);
    group[0].split = 'source';
    for (const clone of group.slice(1)) clone.split = 'clone';
  }
  // A new row carrying a uid another row uses: create it under a fresh uid.
  const uidCount = new Map<string, number>();
  const uidsOf = (m: LocalEvent) => {
    const uids = new Set<string>();
    const uid = str(m.cells[Events.UID_2445]);
    if (uid) uids.add(uid);
    const pendingUid = pendingUidOf(m.syncId) ?? m.pending?.uid;
    if (pendingUid) uids.add(pendingUid);
    return uids;
  };
  for (const m of masters) for (const uid of uidsOf(m)) uidCount.set(uid, (uidCount.get(uid) ?? 0) + 1);
  for (const m of masters) {
    if (m.split || m.syncId !== null) continue;
    if ([...uidsOf(m)].some((uid) => (uidCount.get(uid) ?? 0) > 1)) m.split = 'clone';
  }

  return [...masters, ...orphans];
}

export function decodeCalendar(row: Row): LocalCalendar {
  const flags = parseJsonColumn<Record<string, unknown>>(row[Calendars.CAL_SYNC3]);
  const shadow = parseJsonColumn<CalendarLike>(row[Calendars.CAL_SYNC2]);
  const readOnly = flags?.readOnly === 'rights' || flags?.readOnly === 'subscription' ? flags.readOnly : undefined;
  return {
    calendarRowId: Number(row[Calendars._ID]),
    syncId: str(row[Calendars._SYNC_ID]),
    cells: { ...row },
    shadow: shadow && typeof shadow === 'object' && !Array.isArray(shadow) && typeof shadow.id === 'string' ? shadow : null,
    flags: flags && typeof flags === 'object' ? { ...(readOnly ? { readOnly } : {}), ...(flags.taskOnly === true ? { taskOnly: true } : {}) } : null,
  };
}

/** Whether a master has no server identity yet (no `_SYNC_ID`, or a pending one). */
export function isNewMaster(local: LocalEventRow): boolean {
  return parseObjectRef(local.syncId) === null;
}
