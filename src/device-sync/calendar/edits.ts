/**
 * Device edits of attendees, reminders and the location, turned into
 * JSCalendar values (docs/device-sync.md, "Other properties").
 *
 * - Attendees: the user's own status is their RSVP; an added row is a new
 *   participant (`roles: {attendee: true}`, `needs-action`, `expectReply`);
 *   a removed row deletes its participants. Other people's statuses, the
 *   organizer relationship and, for lossy editors, the attendee type are not
 *   the device's to change.
 * - Reminders replace the alerts a Reminders row can hold, keeping the keys
 *   of those still there; the others stay.
 * - The location edits the first location's name, adds one, or deletes it.
 *
 * Changes come back as paths (raw member names) so the caller escapes them
 * once, with `ptr`, wherever the patch is rooted.
 */
import type { Alert, Participant } from '../../api/types';
import { Attendees, AttendeeType, Events } from '../android-columns';
import type { Row } from '../types';
import type { CalendarLike, CalendarEventWire } from '../wire';
import { clone } from '../common/json';
import { addressGroups, isSelfAddress, participantIdFor, type SelfContext } from './attendees';
import { attendeeDiffers, attendeesByKey } from './units';
import { effectiveAlerts, remindersToAlerts } from './reminders';
import { participationFromDevice } from './values';

export type MintKey = (taken?: Iterable<string>) => string;

/** One change: a path of raw member names below some root, and the value (null removes). */
export interface PathChange {
  path: string[];
  value: unknown;
}

export interface AttendeeEdit {
  kind: 'add' | 'remove' | 'change';
  key: string;
  row?: Row;
  baseline?: Row;
}

/** What the device changed in the attendee rows since `baselineRows`. */
export function attendeeEdits(currentRows: Row[], baselineRows: Row[], self: SelfContext, lossy: boolean): AttendeeEdit[] {
  const cur = attendeesByKey(currentRows, self);
  const bl = attendeesByKey(baselineRows, self);
  const edits: AttendeeEdit[] = [];
  for (const key of new Set([...bl.keys(), ...cur.keys()])) {
    const row = cur.get(key);
    const baseline = bl.get(key);
    if (row && !baseline) edits.push({ kind: 'add', key, row });
    else if (!row && baseline) edits.push({ kind: 'remove', key, baseline });
    else if (attendeeDiffers(row, baseline, lossy)) edits.push({ kind: 'change', key, row, baseline });
  }
  return edits;
}

/** Whether an attendee address key is the user's. */
export function isSelfKey(key: string): boolean {
  return key.startsWith('self:');
}

/** A participant for an attendee row an app added. */
export function newParticipant(row: Row, self: SelfContext): Participant {
  const email = String(row[Attendees.ATTENDEE_EMAIL] ?? '').trim();
  const p: Participant = {
    '@type': 'Participant',
    calendarAddress: `mailto:${email}`,
    roles: { attendee: true },
    participationStatus: 'needs-action',
    expectReply: true,
  };
  const name = row[Attendees.ATTENDEE_NAME];
  if (typeof name === 'string' && name.trim()) p.name = name.trim();
  const type = Number(row[Attendees.ATTENDEE_TYPE]);
  if (type === AttendeeType.OPTIONAL) p.roles = { attendee: true, optional: true };
  if (type === AttendeeType.RESOURCE) p.kind = 'resource';
  if (isSelfAddress(email, self)) {
    const status = participationFromDevice(row[Attendees.ATTENDEE_STATUS]);
    if (status) p.participationStatus = status;
    delete p.expectReply;
  }
  return p;
}

export interface AttendeeChanges {
  /** Changes below the participants map (`[id]`, `[id, 'participationStatus']`, …). */
  changes: PathChange[];
  /** The whole map after the edits. */
  participants: Record<string, Participant>;
  /** The user's own status changed. */
  rsvp: boolean;
  /** Someone was added or removed, or a name or type changed. */
  others: boolean;
}

/** Applies attendee edits to a participants map (not changed in place). */
export function applyAttendeeEdits(
  participants: Record<string, Participant> | null | undefined,
  edits: AttendeeEdit[],
  self: SelfContext,
  mintKey: MintKey,
  lossy: boolean,
): AttendeeChanges {
  const map = clone(participants ?? {}) as Record<string, Participant>;
  const changes: PathChange[] = [];
  let rsvp = false;
  let others = false;
  const groups = addressGroups(map, self);
  const idsOf = (key: string) => groups.find((g) => g.key === key)?.ids ?? [];
  const setStatus = (id: string, row: Row, baseline?: Row) => {
    if (baseline && Number(row[Attendees.ATTENDEE_STATUS]) === Number(baseline[Attendees.ATTENDEE_STATUS])) return;
    const status = participationFromDevice(row[Attendees.ATTENDEE_STATUS]);
    if (!status || map[id].participationStatus === status) return;
    map[id] = { ...map[id], participationStatus: status };
    changes.push({ path: [id, 'participationStatus'], value: status });
    rsvp = true;
  };
  for (const edit of edits) {
    const selfRow = isSelfKey(edit.key);
    if (edit.kind === 'add') {
      const existing = participantIdFor(map, edit.row![Attendees.ATTENDEE_EMAIL], self);
      if (existing) {
        // The server has this address already (added meanwhile): only the user's own status counts.
        if (selfRow) setStatus(existing, edit.row!);
        continue;
      }
      // An app adding the owner's row next to new guests: Stalwart adds the organizer itself.
      if (selfRow) continue;
      const id = mintKey(Object.keys(map));
      map[id] = newParticipant(edit.row!, self);
      changes.push({ path: [id], value: map[id] });
      others = true;
    } else if (edit.kind === 'remove') {
      if (selfRow) continue;
      for (const id of idsOf(edit.key)) {
        delete map[id];
        changes.push({ path: [id], value: null });
        others = true;
      }
    } else {
      const id = participantIdFor(map, edit.row![Attendees.ATTENDEE_EMAIL], self);
      if (!id) continue;
      if (selfRow) setStatus(id, edit.row!, edit.baseline);
      const name = edit.row![Attendees.ATTENDEE_NAME];
      if (String(name ?? '') !== String(edit.baseline![Attendees.ATTENDEE_NAME] ?? '')) {
        if (typeof name === 'string' && name.trim()) {
          map[id] = { ...map[id], name: name.trim() };
          changes.push({ path: [id, 'name'], value: name.trim() });
        } else if (map[id].name !== undefined) {
          const { name: _gone, ...rest } = map[id];
          map[id] = rest;
          changes.push({ path: [id, 'name'], value: null });
        }
        others = true;
      }
      const type = Number(edit.row![Attendees.ATTENDEE_TYPE]);
      if (!lossy && type !== Number(edit.baseline![Attendees.ATTENDEE_TYPE])) {
        const roles = { ...(map[id].roles ?? { attendee: true }) };
        if (type === AttendeeType.OPTIONAL) roles.optional = true;
        else delete roles.optional;
        map[id] = { ...map[id], roles };
        changes.push({ path: [id, 'roles'], value: roles });
        if (type === AttendeeType.RESOURCE && map[id].kind !== 'resource') {
          map[id] = { ...map[id], kind: 'resource' };
          changes.push({ path: [id, 'kind'], value: 'resource' });
        } else if (type !== AttendeeType.RESOURCE && map[id].kind === 'resource') {
          const { kind: _gone, ...rest } = map[id];
          map[id] = rest;
          changes.push({ path: [id, 'kind'], value: null });
        }
        others = true;
      }
    }
  }
  return { changes, participants: map, rsvp, others };
}

export interface AlertChanges {
  /** Changes relative to the event: `['alerts', k]`, `['useDefaultAlerts']` or the whole `['alerts']`. */
  changes: PathChange[];
  /** The alerts in force afterwards. */
  alerts: Record<string, Alert>;
}

/**
 * The device's reminders as alert changes. With `useDefaultAlerts` the
 * calendar's defaults were in force: the event switches to explicit alerts
 * (built from them). An event without alerts gets the whole map, since a
 * pointer below a missing property fails.
 */
export function reminderChanges(
  event: Pick<CalendarEventWire, 'alerts' | 'useDefaultAlerts' | 'showWithoutTime'>,
  calendar: CalendarLike | undefined,
  reminders: Row[],
  mintKey: MintKey,
): AlertChanges {
  const current = effectiveAlerts(event, calendar);
  const { alerts, removed, added } = remindersToAlerts(current, reminders, mintKey);
  const changes: PathChange[] = [];
  if (event.useDefaultAlerts) {
    changes.push({ path: ['useDefaultAlerts'], value: false });
    changes.push({ path: ['alerts'], value: Object.keys(alerts).length ? alerts : null });
  } else if (!Object.keys(event.alerts ?? {}).length) {
    if (Object.keys(added).length) changes.push({ path: ['alerts'], value: alerts });
  } else {
    for (const key of removed) changes.push({ path: ['alerts', key], value: null });
    for (const [key, alert] of Object.entries(added)) changes.push({ path: ['alerts', key], value: alert });
  }
  return { changes, alerts };
}

/** The location edit, as changes relative to the event and as the resulting map. */
export function locationChanges(
  event: Pick<CalendarEventWire, 'locations'>,
  name: unknown,
  mintKey: MintKey,
): { changes: PathChange[]; locations: Record<string, unknown> | null } {
  const locations = clone((event.locations ?? {}) as Record<string, Record<string, unknown>>);
  const first = Object.keys(locations)[0];
  const text = typeof name === 'string' ? name.trim() : '';
  const changes: PathChange[] = [];
  if (!text) {
    if (first) {
      delete locations[first];
      changes.push({ path: ['locations', first], value: null });
    }
  } else if (first) {
    locations[first] = { ...locations[first], name: text };
    changes.push({ path: ['locations', first, 'name'], value: text });
  } else {
    const key = mintKey();
    locations[key] = { '@type': 'Location', name: text };
    changes.push({ path: ['locations'], value: { [key]: locations[key] } });
  }
  return { changes, locations: Object.keys(locations).length ? locations : null };
}

/** The title cell as JSCalendar text. */
export function titleValue(cells: Row): string {
  const t = cells[Events.TITLE];
  return typeof t === 'string' ? t : t === null || t === undefined ? '' : String(t);
}

/** The description cell as JSCalendar text; null removes it. */
export function descriptionValue(cells: Row): string | null {
  const d = cells[Events.DESCRIPTION];
  return typeof d === 'string' && d ? d : null;
}
