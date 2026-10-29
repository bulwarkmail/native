/**
 * New and deleted events (docs/device-sync.md, "Uploads" and "Identity").
 *
 * A new master row is claimed before anything is sent: the uid and target go
 * into SYNC_DATA3, UID_2445 and `_SYNC_ID = ~pending/<uid>`, so an app delete
 * becomes a soft delete the engine can act on and a retried create is found
 * by uid. The row keeps a uid it carries unless another row does too (a
 * CONTENT_EXCEPTION_URI split clones UID_2445). The create then sends the
 * whole event, with the exceptions and exclusions made before its upload as
 * overrides. A deleted event is destroyed, or loses only its synced calendar
 * memberships when it is in others as well.
 */
import type { Participant } from '../../api/types';
import { AttendeeType, Attendees, Events } from '../android-columns';
import type { CalendarContext, LocalEvent, LocalException, OpGroup, UploadAction } from '../planner';
import type { Row } from '../types';
import type { CalendarEventWire } from '../wire';
import { collectionKey, parseCollectionKey, parseObjectRef, pendingRef, pendingUidOf } from '../common/ids';
import type { PatchObject } from '../common/patch';
import { isSelfAddress } from './attendees';
import { applyAttendeeEdits, attendeeEdits, descriptionValue, locationChanges, reminderChanges, titleValue } from './edits';
import { exdateEntryKey } from './exdate';
import type { Override } from './exceptions';
import { isRemovedInstance } from './merge';
import { rruleParts, type RuleZone } from './rrule';
import { sendsSchedulingMessages } from './scheduling';
import { fixedOffsetTiming, rowTiming } from './timing';
import { exdateEntries, sideOfRow } from './units';
import { SKIP, SkipUpload, deviceRule, newOverride, put } from './upload';
import { argbToCss, availabilityFromDevice, participationFromDevice, privacyFromDevice, statusFromDevice } from './values';
import { canonicalZone, classifyLocal } from './zoned-time';

// ─── Creates ────────────────────────────────────────────

export interface CreateComputation {
  object: Partial<CalendarEventWire>;
  sendSchedulingMessages: boolean;
}

/** The event a new master row (with its exceptions and EXDATE) creates. Throws `SkipUpload`. */
export function computeCreate(local: LocalEvent, uid: string, calendarId: string, ctx: CalendarContext): CreateComputation {
  const cells = local.cells;
  const recurring = !!rruleParts(cells[Events.RRULE]);
  let t = rowTiming(cells, { server: null, baselineZone: null, recurring, deviceZone: ctx.deviceZone });
  if (!t) throw new SkipUpload('noStart');
  if (t.ambiguous) {
    if (recurring) throw new SkipUpload(SKIP.dstAmbiguous);
    t = fixedOffsetTiming(t);
  }
  const object: Record<string, unknown> = {
    '@type': 'Event',
    uid,
    calendarIds: { [calendarId]: true },
    title: titleValue(cells),
    start: t.start,
    duration: t.duration,
    freeBusyStatus: availabilityFromDevice(cells[Events.AVAILABILITY]),
  };
  // A row without STATUS gets JSCalendar's default, confirmed.
  const status = statusFromDevice(cells[Events.STATUS]);
  if (status) object.status = status;
  if (t.showWithoutTime) object.showWithoutTime = true;
  else object.timeZone = t.timeZone;
  const description = descriptionValue(cells);
  if (description) object.description = description;
  const privacy = privacyFromDevice(cells[Events.ACCESS_LEVEL]);
  if (privacy) object.privacy = privacy;
  const color = argbToCss(cells[Events.EVENT_COLOR]);
  if (color) object.color = color;
  const location = locationChanges({}, cells[Events.EVENT_LOCATION], ctx.mintKey).locations;
  if (location) object.locations = location;

  const { participants, organizer } = createParticipants(local, ctx);
  if (participants) {
    object.participants = participants;
    object.organizerCalendarAddress = `mailto:${organizer}`;
  }
  if (ctx.reminderOwner === 'device' && local.reminders.length) {
    const alerts = reminderChanges({}, undefined, local.reminders.map((r) => r.cells), ctx.mintKey).alerts;
    if (Object.keys(alerts).length) object.alerts = alerts;
  }

  const zone: RuleZone = t.showWithoutTime ? { allDay: true, zone: 'UTC' } : { allDay: false, zone: canonicalZone(t.timeZone) ?? 'UTC' };
  const rule = recurring ? deviceRule(cells[Events.RRULE], null, null, zone, false) : null;
  if (rule) {
    object.recurrenceRule = rule;
    const overrides: Record<string, Override> = {};
    const checked = (key: string | null) => {
      if (key && !zone.allDay && classifyLocal(key, zone.zone) === 'overlap') throw new SkipUpload(SKIP.dstAmbiguous);
      return key;
    };
    for (const entry of exdateEntries(sideOfRow(local))) {
      const key = exdateEntryKey(entry, zone);
      // Etar's "this and following" copies the old series' EXDATE: dates before the start are none of this series.
      if (!key || key < t.start) continue;
      overrides[checked(key)!] = { excluded: true };
    }
    for (const x of local.exceptions) {
      const key = checked(x.recurrenceId);
      if (!key) continue;
      overrides[key] = isRemovedInstance(x) ? { excluded: true } : createOverride(x, object as CalendarEventWire, key, local, ctx);
    }
    if (Object.keys(overrides).length) object.recurrenceOverrides = overrides;
  }
  return {
    object: object as Partial<CalendarEventWire>,
    sendSchedulingMessages: sendsSchedulingMessages(object as CalendarEventWire, { kind: 'create' }, ctx),
  };
}

/** An exception of a series that is created with it: what the exception row says differently from its master row. */
function createOverride(x: LocalException, master: CalendarEventWire, key: string, local: LocalEvent, ctx: CalendarContext): Override {
  const values: Record<string, unknown> = {};
  let t = rowTiming(x.cells, {
    server: master,
    baselineZone: String(local.cells[Events.EVENT_TIMEZONE] ?? ''),
    recurring: false,
    deviceZone: ctx.deviceZone,
  });
  if (t) {
    if (t.ambiguous) throw new SkipUpload(SKIP.dstAmbiguous);
    if (t.showWithoutTime !== !!master.showWithoutTime) t = { ...t, showWithoutTime: !!master.showWithoutTime };
    values.start = t.start;
    values.duration = t.duration;
  }
  const cells = x.cells;
  // What the exception row leaves empty is one its app did not model: it comes from the series.
  const differs = (column: string) => {
    const v = cells[column];
    return v !== null && v !== undefined && v !== '' && String(v) !== String(local.cells[column] ?? '');
  };
  if (differs(Events.TITLE)) values.title = titleValue(cells);
  if (differs(Events.DESCRIPTION)) values.description = descriptionValue(cells);
  if (differs(Events.EVENT_LOCATION)) values.locations = locationChanges(master, cells[Events.EVENT_LOCATION], ctx.mintKey).locations;
  if (differs(Events.STATUS)) values.status = statusFromDevice(cells[Events.STATUS]);
  if (differs(Events.AVAILABILITY)) values.freeBusyStatus = availabilityFromDevice(cells[Events.AVAILABILITY]);
  if (differs(Events.EVENT_COLOR)) values.color = argbToCss(cells[Events.EVENT_COLOR]);
  if (x.attendees.length) {
    const edits = attendeeEdits(x.attendees.map((a) => a.cells), local.attendees.map((a) => a.cells), ctx, false);
    if (edits.length) values.participants = applyAttendeeEdits(master.participants, edits, ctx, ctx.mintKey, false).participants;
  }
  return newOverride(master, key, values);
}

/**
 * Participants of a new event from its attendee rows: the user as organizer
 * (unless ORGANIZER names someone else) and everyone else as attendees.
 * None when the user is alone.
 */
function createParticipants(local: LocalEvent, ctx: CalendarContext): { participants: Record<string, Participant> | null; organizer: string } {
  const rows = local.attendees.map((a) => a.cells);
  const isSelf = (row: Row) => isSelfAddress(String(row[Attendees.ATTENDEE_EMAIL] ?? ''), ctx);
  const organizerCell = String(local.cells[Events.ORGANIZER] ?? '').trim();
  const organizer = organizerCell && !isSelfAddress(organizerCell, ctx) ? organizerCell : ctx.ownerAccount;
  const guests = rows.filter((r) => !isSelf(r));
  if (!guests.length) return { participants: null, organizer };
  const participants: Record<string, Participant> = {};
  const self = rows.find(isSelf);
  const iOrganize = isSelfAddress(organizer, ctx);
  if (iOrganize || self) {
    const status = self ? participationFromDevice(self[Attendees.ATTENDEE_STATUS]) : null;
    participants[ctx.mintKey(Object.keys(participants))] = {
      '@type': 'Participant',
      calendarAddress: `mailto:${ctx.ownerAccount}`,
      roles: iOrganize ? { owner: true, attendee: true } : { attendee: true },
      participationStatus: status ?? (iOrganize ? 'accepted' : 'needs-action'),
    };
  }
  for (const row of guests) {
    const email = String(row[Attendees.ATTENDEE_EMAIL]).trim();
    const p: Participant = {
      '@type': 'Participant',
      calendarAddress: `mailto:${email}`,
      roles: email.toLowerCase() === organizer.toLowerCase() ? { owner: true } : { attendee: true },
      participationStatus: 'needs-action',
      expectReply: true,
    };
    const name = row[Attendees.ATTENDEE_NAME];
    if (typeof name === 'string' && name.trim()) p.name = name.trim();
    if (Number(row[Attendees.ATTENDEE_TYPE]) === AttendeeType.OPTIONAL) p.roles = { ...p.roles, optional: true };
    if (Number(row[Attendees.ATTENDEE_TYPE]) === AttendeeType.RESOURCE) p.kind = 'resource';
    participants[ctx.mintKey(Object.keys(participants))] = p;
  }
  return { participants, organizer };
}

// ─── Claims ─────────────────────────────────────────────

/**
 * The claim of a new row (see the header). A split clone also drops the
 * source's shadow and baseline it was cloned with, points the source's
 * exceptions back at the source (the provider's trigger may have followed the
 * `_SYNC_ID` change) and marks the source dirty, so the source's capped rule
 * uploads even when this group is applied before the source is planned.
 */
export function claimOps(local: LocalEvent, uid: string, target: string): OpGroup {
  const ops: OpGroup['ops'] = [
    {
      op: 'assert',
      table: 'events',
      id: local.eventId,
      values: { [Events._SYNC_ID]: local.syncId, [Events.DELETED]: local.cells[Events.DELETED] ?? null },
      expectCount: 1,
    },
  ];
  const values: Row = {
    [Events._SYNC_ID]: pendingRef(uid),
    [Events.UID_2445]: uid,
    [Events.SYNC_DATA3]: JSON.stringify({ uid, target }),
  };
  const sharedSyncId = local.split === 'clone' && parseObjectRef(local.syncId) ? local.syncId : null;
  if (local.split === 'clone') {
    Object.assign(values, { [Events.SYNC_DATA1]: null, [Events.SYNC_DATA2]: null, [Events.SYNC_DATA4]: null, [Events.SYNC_DATA5]: null });
  }
  ops.push({ op: 'update', table: 'events', id: local.eventId, values, expectCount: 1 });
  if (sharedSyncId) {
    ops.push({
      op: 'update',
      table: 'events',
      where: `${Events.ORIGINAL_SYNC_ID} = ? AND (${Events.ORIGINAL_ID} IS NULL OR ${Events.ORIGINAL_ID} != ?)`,
      args: [pendingRef(uid), local.eventId],
      values: { [Events.ORIGINAL_SYNC_ID]: sharedSyncId },
    });
    // The clone no longer carries the shared `_SYNC_ID` here, so this reaches the source master(s) only.
    ops.push({
      op: 'update',
      table: 'events',
      where: `${Events._SYNC_ID} = ? AND ${Events.ORIGINAL_ID} IS NULL`,
      args: [sharedSyncId],
      values: { [Events.DIRTY]: 1 },
    });
  }
  return { ref: `row:${local.eventId}`, ops };
}

/** The uid of a new row's complete, consistent claim, or null when it has to be claimed (again). */
export function claimedUid(local: LocalEvent): string | null {
  if (local.split === 'clone' || !local.pending) return null;
  const uid = local.pending.uid;
  if (pendingUidOf(local.syncId) !== uid || local.cells[Events.UID_2445] !== uid) return null;
  return uid;
}

/** The uid a claim writes: the row's own unless it is a clone of another row's. */
export function claimUid(local: LocalEvent, ctx: CalendarContext): string {
  if (local.split === 'clone') return ctx.mintUid();
  const own = local.cells[Events.UID_2445];
  if (typeof own === 'string' && own.trim()) return own;
  return pendingUidOf(local.syncId) ?? ctx.mintUid();
}

/** Where a new row's create goes: the target fixed at its claim, else the calendar of its row. */
export function createTarget(local: LocalEvent, ctx: CalendarContext): { key: string; calendarId: string } | null {
  if (local.pending && local.split !== 'clone') {
    const parsed = parseCollectionKey(local.pending.target);
    if (parsed) return { key: local.pending.target, calendarId: parsed.id };
  }
  const cal = ctx.calendarIdOfRow(local.calendarRowId);
  return cal ? { key: collectionKey(cal.jmapAccountId, cal.calendarId), calendarId: cal.calendarId } : null;
}

// ─── Deletions ──────────────────────────────────────────

/**
 * Whether the server moved a deleted event out of the calendar its row is in
 * (`own`), and into none this device syncs, before the device's deletion
 * reached it: the deletion is moot then, and the event stays where it is now.
 * A calendar deselected since is still the row's own, so that deletion goes
 * up; so does one of an event moved into another synced calendar.
 */
export function movedAway(local: LocalEvent, own: { jmapAccountId: string; calendarId: string }, ctx: CalendarContext): boolean {
  if (!local.shadow) return false;
  const ownKey = collectionKey(own.jmapAccountId, own.calendarId);
  const keys = Object.entries(local.shadow.calendarIds ?? {}).filter(([, on]) => on).map(([id]) => collectionKey(ctx.jmapAccountId, id));
  return !keys.some((key) => key === ownKey || ctx.isSelected(key));
}

/**
 * A deleted event with identity: an object in several calendars loses only
 * the selected memberships; otherwise it is destroyed, with scheduling
 * messages when others take part.
 */
export function deleteActions(local: LocalEvent, ctx: CalendarContext): UploadAction<CalendarEventWire>[] {
  const ref = parseObjectRef(local.syncId)!;
  const shadow = local.shadow;
  if (shadow) {
    const memberships = Object.entries(shadow.calendarIds ?? {}).filter(([, on]) => on).map(([id]) => id);
    const selected = memberships.filter((id) => ctx.isSelected(collectionKey(ctx.jmapAccountId, id)));
    if (selected.length && selected.length < memberships.length) {
      const patch: PatchObject = {};
      for (const id of selected) put(patch, ['calendarIds', id], null);
      return [{ kind: 'update', id: ref.id, patch }];
    }
  }
  const action: UploadAction<CalendarEventWire> = { kind: 'destroy', id: ref.id, uid: typeof shadow?.uid === 'string' ? shadow.uid : null };
  if (shadow && sendsSchedulingMessages(shadow, { kind: 'destroy' }, ctx)) action.sendSchedulingMessages = true;
  return [action];
}
