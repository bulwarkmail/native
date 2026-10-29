/**
 * Small planners for the engine tests, faithful to the planner contract
 * (src/device-sync/planner.ts) for a toy mapping:
 *
 * - contacts: `name.full` ↔ one StructuredName row (DISPLAY_NAME), group
 *   cards ↔ Groups rows (TITLE), memberships ↔ GroupMembership rows;
 * - calendar: `title` ↔ one event row (plus the columns the provider
 *   requires), calendars ↔ Calendars rows.
 *
 * Like the real planners they assert what they read first (VERSION and
 * DIRTY, or the event projection), keep baselines in DATA_SYNC3 /
 * SYNC_DATA4, merge dirty items per unit (server wins a real conflict),
 * adopt pending creates by uid, claim new items before creating them, and
 * return `effect: 'none'` for echoes.
 */
import { Data, Events, GroupMembership, MimeType } from '../../android-columns';
import { collectionKey, parseCollectionKey, parseObjectRef, pendingRef, pendingUidOf } from '../../common/ids';
import { deepEqual, parseJsonColumn } from '../../common/json';
import { ptr } from '../../common/patch';
import type {
  AcceptedPlan,
  CalendarContext,
  CalendarEventWire,
  CalendarPlanner,
  ContactCardWire,
  ContactsContext,
  ContactsPlanner,
  DownloadPlan,
  LocalCalendar,
  LocalContact,
  LocalEvent,
  LocalGroup,
  OpGroup,
  UploadAction,
  UploadPlan,
} from '../../planner';
import type { ProviderOp, Row } from '../../types';

const num = (v: unknown) => Number(v ?? 0);
const flag = (v: unknown) => Number(v ?? 0) === 1;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const onIds = (map: Record<string, boolean> | undefined | null) =>
  Object.entries(map ?? {}).filter(([, on]) => on === true).map(([id]) => id);

interface ToyContactsContext extends ContactsContext {
  groupsOf?(uid: string): string[];
}

// ─── Contacts ───────────────────────────────────────────

function nameOf(card: ContactCardWire | null | undefined): string {
  return card?.name?.full ?? '';
}

function nameRow(local: LocalContact) {
  return local.rows.find((r) => r.mimetype === MimeType.STRUCTURED_NAME) ?? null;
}

function membershipRows(local: LocalContact) {
  return local.rows.filter((r) => r.mimetype === MimeType.GROUP_MEMBERSHIP);
}

function cardCollections(acct: string, card: ContactCardWire): string {
  return onIds(card.addressBookIds).map((id) => collectionKey(acct, id)).join(',');
}

function shadowOf(card: ContactCardWire): string {
  return JSON.stringify(card);
}

/** Group SOURCE_IDs a card should be a member of, with their row ids. */
function wantedGroups(card: ContactCardWire, ctx: ToyContactsContext): Array<{ sourceId: string; rowId: number }> {
  if (typeof card.uid !== 'string' || !ctx.groupsOf) return [];
  return ctx
    .groupsOf(card.uid)
    .map((sourceId) => ({ sourceId, rowId: ctx.groupRowIdBySourceId(sourceId) }))
    .filter((g): g is { sourceId: string; rowId: number } => g.rowId !== null);
}

function membershipOps(local: LocalContact | null, card: ContactCardWire, ctx: ToyContactsContext, parent: number | null): ProviderOp[] {
  const wanted = wantedGroups(card, ctx);
  const have = local ? membershipRows(local) : [];
  const ops: ProviderOp[] = [];
  for (const row of have) {
    if (!wanted.some((g) => g.sourceId === row.cells.group_sourceid)) ops.push({ op: 'delete', table: 'data', id: row.id, expectCount: 1 });
  }
  for (const group of wanted) {
    if (have.some((r) => r.cells.group_sourceid === group.sourceId)) continue;
    const values = { [Data.MIMETYPE]: MimeType.GROUP_MEMBERSHIP, [GroupMembership.GROUP_ROW_ID]: group.rowId };
    ops.push(
      parent === null
        ? { op: 'insert', table: 'data', values, refs: { [Data.RAW_CONTACT_ID]: 0 } }
        : { op: 'insert', table: 'data', values: { ...values, [Data.RAW_CONTACT_ID]: parent } },
    );
  }
  return ops;
}

export const toyContactsPlanner: ContactsPlanner = {
  rawContactColumns: ['_id', 'sourceid', 'version', 'dirty', 'deleted', 'sync1', 'sync2', 'sync3', 'sync4'],
  dataColumns: ['_id', 'raw_contact_id', 'mimetype', 'data1', 'data_sync1', 'data_sync3', 'group_sourceid'],
  groupColumns: ['_id', 'sourceid', 'version', 'dirty', 'deleted', 'title', 'sync2', 'sync3', 'sync4'],

  decodeContact(rc: Row, data: Row[]): LocalContact {
    return {
      rawContactId: num(rc._id),
      sourceId: str(rc.sourceid),
      version: num(rc.version),
      dirty: flag(rc.dirty),
      deleted: flag(rc.deleted),
      collections: (str(rc.sync1) ?? '').split(',').filter(Boolean),
      shadow: parseJsonColumn<ContactCardWire>(rc.sync2),
      pending: parseJsonColumn(rc.sync3),
      poison: parseJsonColumn(rc.sync4),
      rows: data.map((d) => ({
        id: num(d._id),
        mimetype: String(d.mimetype),
        cells: { data1: d.data1 ?? null, group_sourceid: d.group_sourceid ?? null },
        key: str(d.data_sync1),
        photoHash: null,
        baseline: parseJsonColumn<Row>(d.data_sync3),
      })),
    };
  },

  decodeGroup(row: Row): LocalGroup {
    return {
      groupId: num(row._id),
      sourceId: str(row.sourceid),
      version: num(row.version),
      dirty: flag(row.dirty),
      deleted: flag(row.deleted),
      title: str(row.title),
      shadow: parseJsonColumn<ContactCardWire>(row.sync2),
      pending: parseJsonColumn(row.sync3),
      poison: parseJsonColumn(row.sync4),
    };
  },

  planDownload(card, local, context): DownloadPlan {
    const ctx = context as ToyContactsContext;
    const acct = ctx.jmapAccountId;
    const ref = `${acct}/${card.id}`;
    const name = nameOf(card);
    const raw = { sourceid: ref, sync1: cardCollections(acct, card), sync2: shadowOf(card), raw_contact_is_read_only: ctx.isReadOnly(card) ? 1 : 0 };
    if (!local) {
      const ops: ProviderOp[] = [
        { op: 'insert', table: 'raw_contacts', values: raw },
        {
          op: 'insert',
          table: 'data',
          values: { [Data.MIMETYPE]: MimeType.STRUCTURED_NAME, data1: name, data_sync1: 'name', data_sync3: JSON.stringify({ data1: name }) },
          refs: { [Data.RAW_CONTACT_ID]: 0 },
        },
        ...membershipOps(null, card, ctx, null),
      ];
      return { ops: { ref, ops }, conflicts: 0, stillDirty: false, effect: 'insert', writes: ops.length };
    }
    const row = nameRow(local);
    const guard: ProviderOp = {
      op: 'assert',
      table: 'raw_contacts',
      id: local.rawContactId,
      values: { version: local.version, dirty: local.dirty ? 1 : 0 },
      expectCount: 1,
    };
    const ops: ProviderOp[] = [guard];
    let conflicts = 0;
    let stillDirty = false;
    const writeName = (value: string) => {
      if (row) {
        ops.push({ op: 'update', table: 'data', id: row.id, values: { data1: value, data_sync3: JSON.stringify({ data1: value }) }, expectCount: 1 });
      } else {
        ops.push({
          op: 'insert',
          table: 'data',
          values: { [Data.RAW_CONTACT_ID]: local.rawContactId, [Data.MIMETYPE]: MimeType.STRUCTURED_NAME, data1: value, data_sync1: 'name', data_sync3: JSON.stringify({ data1: value }) },
        });
      }
    };
    const adopting = !local.sourceId && local.pending?.uid === card.uid;
    if (local.deleted) {
      // The device delete wins over a server edit; the destroy is on its way.
      return { ops: { ref, ops: [guard] }, conflicts: 0, stillDirty: true, effect: 'none', writes: 0 };
    }
    const localValue = String(row?.cells.data1 ?? '');
    if (adopting) {
      // Our own create: identity and shadow; the rows stay the user's, measured against the server's value.
      ops.push({ op: 'update', table: 'raw_contacts', id: local.rawContactId, values: { ...raw, sync3: null } });
      if (row) ops.push({ op: 'update', table: 'data', id: row.id, values: { data_sync3: JSON.stringify({ data1: name }) }, expectCount: 1 });
      return { ops: { ref, ops }, conflicts: 0, stillDirty: localValue !== name, effect: 'update', writes: ops.length - 1 };
    }
    const shadowName = nameOf(local.shadow);
    const baseValue = String(row?.baseline?.data1 ?? shadowName);
    const localChanged = local.dirty && localValue !== baseValue;
    const remoteChanged = name !== shadowName;
    if (!localChanged) {
      if (localValue !== name) writeName(name);
    } else if (remoteChanged) {
      if (localValue === name) writeName(name);
      else {
        writeName(name);
        conflicts++;
      }
    } else {
      stillDirty = true;
    }
    ops.push(...membershipOps(local, card, ctx, local.rawContactId));
    const shadowSame = deepEqual(local.shadow, card) && local.collections.join(',') === raw.sync1;
    if (!shadowSame) ops.push({ op: 'update', table: 'raw_contacts', id: local.rawContactId, values: raw });
    const writes = ops.length - 1;
    return { ops: { ref, ops }, conflicts, stillDirty, effect: writes > 0 ? 'update' : 'none', writes };
  },

  planLocalDelete(local): OpGroup {
    return { ref: local.sourceId ?? `row:${local.rawContactId}`, ops: [{ op: 'delete', table: 'raw_contacts', id: local.rawContactId }] };
  },

  planBaselineHeal(local): OpGroup | null {
    const row = nameRow(local);
    if (local.dirty || !row || deepEqual(row.baseline, { data1: row.cells.data1 })) return null;
    return {
      ref: local.sourceId ?? `row:${local.rawContactId}`,
      ops: [
        { op: 'assert', table: 'raw_contacts', id: local.rawContactId, values: { version: local.version, dirty: 0 }, expectCount: 1 },
        { op: 'update', table: 'data', id: row.id, values: { data_sync3: JSON.stringify({ data1: row.cells.data1 }) }, expectCount: 1 },
      ],
    };
  },

  planUpload(local, ctx): UploadPlan<ContactCardWire> {
    const ref = local.sourceId ?? `row:${local.rawContactId}`;
    const guard: ProviderOp = { op: 'assert', table: 'raw_contacts', id: local.rawContactId, values: { version: local.version }, expectCount: 1 };
    const parsed = parseObjectRef(local.sourceId);
    if (local.deleted) {
      if (parsed) {
        const books = onIds(local.shadow?.addressBookIds);
        const synced = books.filter((b) => ctx.isSelected(collectionKey(parsed.accountId, b)));
        if (synced.length && synced.length < books.length) {
          return { kind: 'upload', actions: [{ kind: 'update', id: parsed.id, patch: Object.fromEntries(synced.map((b) => [`addressBookIds/${b}`, null])) }] };
        }
        return { kind: 'upload', actions: [{ kind: 'destroy', id: parsed.id, uid: null }] };
      }
      if (local.pending) return { kind: 'upload', actions: [{ kind: 'destroy', id: null, uid: local.pending.uid }] };
      return { kind: 'purge', ops: { ref, ops: [{ op: 'delete', table: 'raw_contacts', id: local.rawContactId }] } };
    }
    const row = nameRow(local);
    const value = String(row?.cells.data1 ?? '');
    if (!parsed) {
      if (!local.pending) {
        const target = ctx.createTarget();
        if (!target) return { kind: 'skip', reason: 'noWritableAddressBook' };
        return {
          kind: 'claim',
          ops: { ref, ops: [guard, { op: 'update', table: 'raw_contacts', id: local.rawContactId, values: { sync3: JSON.stringify({ uid: ctx.mintUid(), target }) } }] },
        };
      }
      const target = parseCollectionKey(local.pending.target);
      if (!target) return { kind: 'skip', reason: 'badTarget' };
      return {
        kind: 'upload',
        actions: [{ kind: 'create', uid: local.pending.uid, collectionId: target.id, object: { uid: local.pending.uid, name: { full: value } } }],
      };
    }
    if (local.shadow && ctx.isReadOnly(local.shadow)) {
      const shadowName = nameOf(local.shadow);
      return {
        kind: 'revert',
        ops: {
          ref,
          ops: [
            guard,
            ...(row ? [{ op: 'update' as const, table: 'data' as const, id: row.id, values: { data1: shadowName, data_sync3: JSON.stringify({ data1: shadowName }) } }] : []),
            { op: 'update', table: 'raw_contacts', id: local.rawContactId, values: { dirty: 0 } },
          ],
        },
      };
    }
    const base = String(row?.baseline?.data1 ?? nameOf(local.shadow));
    if (value === base) {
      return { kind: 'clean', ops: { ref, ops: [{ ...guard, values: { version: local.version, dirty: 1 } }, { op: 'update', table: 'raw_contacts', id: local.rawContactId, values: { dirty: 0 } }] } };
    }
    const patch = local.shadow?.name ? { 'name/full': value } : { name: { full: value } };
    return { kind: 'upload', actions: [{ kind: 'update', id: parsed.id, patch }] };
  },

  planAccepted(local, server, ctx): AcceptedPlan {
    const acct = ctx.jmapAccountId;
    const ref = `${acct}/${server.id}`;
    const row = nameRow(local);
    const identity = { sourceid: ref, sync1: cardCollections(acct, server), sync2: shadowOf(server), sync3: null };
    const baseline: ProviderOp[] = row
      ? [{ op: 'update', table: 'data', id: row.id, values: { data_sync3: JSON.stringify({ data1: row.cells.data1 }) }, expectCount: 1 }]
      : [];
    return {
      ops: {
        ref,
        ops: [
          { op: 'assert', table: 'raw_contacts', id: local.rawContactId, values: { version: local.version }, expectCount: 1 },
          { op: 'update', table: 'raw_contacts', id: local.rawContactId, values: { ...identity, dirty: 0 } },
          ...baseline,
        ],
      },
      keepDirtyOps: { ref, ops: [{ op: 'update', table: 'raw_contacts', id: local.rawContactId, values: identity }, ...baseline] },
    };
  },

  planGroupDownload(card, local, ctx): DownloadPlan {
    const acct = ctx.jmapAccountId;
    const ref = `${acct}/${card.id}`;
    const values = { sourceid: ref, title: nameOf(card), group_visible: 1, sync2: shadowOf(card) };
    if (!local) {
      return { ops: { ref, ops: [{ op: 'insert', table: 'groups', values }] }, conflicts: 0, stillDirty: false, effect: 'insert', writes: 1 };
    }
    if (local.deleted) return { ops: { ref, ops: [] }, conflicts: 0, stillDirty: true, effect: 'none', writes: 0 };
    const adopting = !local.sourceId && local.pending?.uid === card.uid;
    if (!adopting && local.title === values.title && deepEqual(local.shadow, card)) {
      return { ops: { ref, ops: [] }, conflicts: 0, stillDirty: local.dirty, effect: 'none', writes: 0 };
    }
    const localChanged = local.dirty && local.title !== nameOf(local.shadow);
    const keepTitle = adopting || (localChanged && values.title === nameOf(local.shadow));
    return {
      ops: {
        ref,
        ops: [
          { op: 'assert', table: 'groups', id: local.groupId, values: { version: local.version }, expectCount: 1 },
          { op: 'update', table: 'groups', id: local.groupId, values: { ...values, ...(keepTitle ? { title: local.title } : {}), sync3: null } },
        ],
      },
      conflicts: localChanged && !keepTitle && values.title !== local.title ? 1 : 0,
      stillDirty: keepTitle && local.dirty,
      effect: 'update',
      writes: 1,
    };
  },

  planGroupLocalDelete(local): OpGroup {
    return { ref: local.sourceId ?? `group:${local.groupId}`, ops: [{ op: 'delete', table: 'groups', id: local.groupId }] };
  },

  planGroupUpload(local, ctx): UploadPlan<ContactCardWire> {
    const ref = local.sourceId ?? `group:${local.groupId}`;
    const parsed = parseObjectRef(local.sourceId);
    if (local.deleted) {
      if (parsed) return { kind: 'upload', actions: [{ kind: 'destroy', id: parsed.id, uid: null }] };
      return { kind: 'purge', ops: { ref, ops: [{ op: 'delete', table: 'groups', id: local.groupId }] } };
    }
    if (!parsed) {
      if (!local.pending) {
        const target = ctx.createTarget();
        if (!target) return { kind: 'skip', reason: 'noWritableAddressBook' };
        return {
          kind: 'claim',
          ops: {
            ref,
            ops: [
              { op: 'assert', table: 'groups', id: local.groupId, values: { version: local.version }, expectCount: 1 },
              { op: 'update', table: 'groups', id: local.groupId, values: { sync3: JSON.stringify({ uid: ctx.mintUid(), target }) } },
            ],
          },
        };
      }
      const target = parseCollectionKey(local.pending.target);
      if (!target) return { kind: 'skip', reason: 'badTarget' };
      return {
        kind: 'upload',
        actions: [{ kind: 'create', uid: local.pending.uid, collectionId: target.id, object: { uid: local.pending.uid, kind: 'group', name: { full: local.title ?? '' } } }],
      };
    }
    if ((local.title ?? '') === nameOf(local.shadow)) {
      return {
        kind: 'clean',
        ops: { ref, ops: [{ op: 'assert', table: 'groups', id: local.groupId, values: { version: local.version }, expectCount: 1 }, { op: 'update', table: 'groups', id: local.groupId, values: { dirty: 0 } }] },
      };
    }
    return { kind: 'upload', actions: [{ kind: 'update', id: parsed.id, patch: { 'name/full': local.title ?? '' } }] };
  },

  planGroupAccepted(local, server, ctx): AcceptedPlan {
    const ref = `${ctx.jmapAccountId}/${server.id}`;
    const values = { sourceid: ref, sync2: shadowOf(server), sync3: null };
    return {
      ops: {
        ref,
        ops: [
          { op: 'assert', table: 'groups', id: local.groupId, values: { version: local.version }, expectCount: 1 },
          { op: 'update', table: 'groups', id: local.groupId, values: { ...values, dirty: 0 } },
        ],
      },
      keepDirtyOps: { ref, ops: [{ op: 'update', table: 'groups', id: local.groupId, values }] },
    };
  },

  planMembershipUploads(contacts, groups, ctx): UploadAction<ContactCardWire>[] {
    const acct = ctx.jmapAccountId;
    const patches = new Map<string, Record<string, unknown>>();
    for (const contact of contacts) {
      const uid = contact.shadow?.uid ?? contact.pending?.uid;
      if (!contact.sourceId || typeof uid !== 'string') continue;
      const wanted = new Set(membershipRows(contact).map((r) => String(r.cells.group_sourceid)));
      for (const group of groups) {
        const parsed = parseObjectRef(group.sourceId);
        if (!parsed || parsed.accountId !== acct) continue;
        const member = group.shadow?.members?.[uid] === true;
        const want = wanted.has(group.sourceId as string);
        if (member === want) continue;
        const patch = patches.get(parsed.id) ?? {};
        patch[ptr('members', uid)] = want ? true : null;
        patches.set(parsed.id, patch);
      }
    }
    return [...patches].map(([id, patch]) => ({ kind: 'update', id, patch }));
  },
};

// ─── Calendar ───────────────────────────────────────────

const EVENT_HOUR = 3_600_000;

function startMs(event: CalendarEventWire): number {
  return Date.parse(`${String(event.start ?? '2026-01-01T00:00:00').slice(0, 19)}Z`);
}

function localStart(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

function eventRef(ctx: CalendarContext, event: CalendarEventWire): string {
  return `${ctx.jmapAccountId}/${event.id}`;
}

export const toyCalendarPlanner: CalendarPlanner = {
  calendarColumns: ['_id', '_sync_id', 'name', 'calendar_displayName', 'calendar_access_level', 'maxReminders', 'cal_sync2', 'cal_sync3'],
  eventColumns: [
    '_id', 'calendar_id', '_sync_id', 'dirty', 'deleted', 'title', 'dtstart', 'dtend', 'eventTimezone', 'original_id',
    'original_sync_id', 'originalInstanceTime', 'sync_data1', 'sync_data2', 'sync_data3', 'sync_data4', 'sync_data5', 'uid2445', 'mutators',
  ],
  attendeeColumns: ['_id', 'event_id', 'attendeeEmail'],
  reminderColumns: ['_id', 'event_id', 'minutes'],

  decodeCalendar(row: Row): LocalCalendar {
    return {
      calendarRowId: num(row._id),
      syncId: str(row._sync_id),
      cells: row,
      shadow: parseJsonColumn(row.cal_sync2),
      flags: parseJsonColumn(row.cal_sync3),
    };
  },

  decodeEvents(events: Row[], attendees: Row[], reminders: Row[]): LocalEvent[] {
    const toRow = (row: Row) => ({
      eventId: num(row._id),
      calendarRowId: num(row.calendar_id),
      syncId: str(row._sync_id),
      dirty: flag(row.dirty),
      deleted: flag(row.deleted),
      cells: { title: row.title ?? null, dtstart: row.dtstart ?? null, dtend: row.dtend ?? null },
      attendees: attendees.filter((a) => num(a.event_id) === num(row._id)).map((a) => ({ id: num(a._id), cells: { attendeeEmail: a.attendeeEmail ?? null } })),
      reminders: reminders.filter((r) => num(r.event_id) === num(row._id)).map((r) => ({ id: num(r._id), cells: { minutes: r.minutes ?? null } })),
      baseline: parseJsonColumn<{ cells: Row; attendees: Row[]; reminders: Row[] }>(row.sync_data4),
      pending: parseJsonColumn(row.sync_data3),
      poison: parseJsonColumn(row.sync_data5),
      mutators: str(row.mutators),
    });
    const isException = (row: Row) => row.original_id !== null && row.original_id !== undefined || !!str(row.original_sync_id);
    const masters = events.filter((r) => !isException(r)).map((row) => ({
      ...toRow(row),
      shadow: parseJsonColumn<CalendarEventWire>(row.sync_data1),
      exceptions: events
        .filter((x) => isException(x) && (num(x.original_id) === num(row._id) || (str(x.original_sync_id) !== null && str(x.original_sync_id) === str(row._sync_id))))
        .map((x) => ({ ...toRow(x), recurrenceId: str(x.sync_data2), originalInstanceTime: x.originalInstanceTime === null ? null : num(x.originalInstanceTime) })),
    })) as LocalEvent[];
    const bySyncId = new Map<string, LocalEvent[]>();
    for (const m of masters) if (m.syncId) bySyncId.set(m.syncId, [...(bySyncId.get(m.syncId) ?? []), m]);
    for (const pair of bySyncId.values()) {
      if (pair.length < 2) continue;
      pair.sort((a, b) => a.eventId - b.eventId);
      pair[0].split = 'source';
      for (const clone of pair.slice(1)) clone.split = 'clone';
    }
    return masters;
  },

  planCalendars(selected, local, ctx) {
    const groups: OpGroup[] = [];
    const keys = new Set<string>();
    for (const { jmapAccountId, calendar, readOnly, accountName } of selected) {
      const key = collectionKey(jmapAccountId, calendar.id);
      keys.add(key);
      const values = {
        name: calendar.name,
        calendar_displayName: accountName ? `${calendar.name} (${accountName})` : calendar.name,
        calendar_access_level: readOnly ? 200 : 700,
        maxReminders: ctx.reminderOwner === 'device' ? 5 : 0,
        cal_sync2: JSON.stringify(calendar),
        cal_sync3: JSON.stringify(readOnly ? { readOnly: 'rights' } : {}),
      };
      const existing = local.find((l) => l.syncId === key);
      if (!existing) {
        groups.push({
          ref: key,
          ops: [{ op: 'insert', table: 'calendars', values: { ...values, _sync_id: key, calendar_color: -16776961, ownerAccount: ctx.ownerAccount, sync_events: 1, visible: 1 } }],
        });
      } else if (Object.entries(values).some(([k, v]) => String(existing.cells[k] ?? '') !== String(v))) {
        groups.push({ ref: key, ops: [{ op: 'update', table: 'calendars', id: existing.calendarRowId, values }] });
      }
    }
    return { groups, deleteCalendarRows: local.filter((l) => !l.syncId || !keys.has(l.syncId)).map((l) => l.calendarRowId) };
  },

  planDownload(event, local, ctx): DownloadPlan {
    const ref = eventRef(ctx, event);
    const calendarRowId = onIds(event.calendarIds).map((id) => ctx.calendarRowId(id)).find((id) => id !== null) ?? null;
    const start = startMs(event);
    const cells = { title: event.title ?? '', dtstart: start, dtend: start + EVENT_HOUR };
    const baseline = JSON.stringify({ cells: { title: cells.title }, attendees: [], reminders: [] });
    if (!local) {
      if (calendarRowId === null) return { ops: { ref, ops: [] }, conflicts: 0, stillDirty: false, effect: 'none', writes: 0 };
      const ops: ProviderOp[] = [{
        op: 'insert',
        table: 'events',
        // CalendarProvider leaves DIRTY NULL on a sync-adapter insert unless it is written.
        values: { calendar_id: calendarRowId, _sync_id: ref, ...cells, eventTimezone: 'UTC', eventStatus: 1, dirty: 0, uid2445: event.uid, sync_data1: JSON.stringify(event), sync_data4: baseline },
      }];
      return { ops: { ref, ops }, conflicts: 0, stillDirty: false, effect: 'insert', writes: 1 };
    }
    const guard: ProviderOp = { op: 'assert', table: 'events', id: local.eventId, values: { dirty: local.dirty ? 1 : 0, title: local.cells.title }, expectCount: 1 };
    if (local.deleted) return { ops: { ref, ops: [guard] }, conflicts: 0, stillDirty: true, effect: 'none', writes: 0 };
    const adopting = !parseObjectRef(local.syncId) && (local.pending?.uid ?? pendingUidOf(local.syncId)) === event.uid;
    if (adopting) {
      return {
        ops: { ref, ops: [guard, { op: 'update', table: 'events', id: local.eventId, values: { _sync_id: ref, sync_data1: JSON.stringify(event), sync_data3: null, sync_data4: baseline } }] },
        conflicts: 0,
        stillDirty: local.cells.title !== event.title,
        effect: 'update',
        writes: 1,
      };
    }
    const shadowTitle = local.shadow?.title ?? '';
    const baseTitle = String(local.baseline?.cells.title ?? shadowTitle);
    const localChanged = local.dirty && local.cells.title !== baseTitle;
    const remoteChanged = (event.title ?? '') !== shadowTitle;
    const values: Row = {};
    let conflicts = 0;
    if (!localChanged || remoteChanged) {
      if (local.cells.title !== cells.title || local.cells.dtstart !== cells.dtstart) Object.assign(values, cells, { sync_data4: baseline });
      if (localChanged && local.cells.title !== cells.title) conflicts = 1;
    }
    if (!deepEqual(local.shadow, event)) values.sync_data1 = JSON.stringify(event);
    if (!Object.keys(values).length) return { ops: { ref, ops: [guard] }, conflicts: 0, stillDirty: localChanged && !remoteChanged, effect: 'none', writes: 0 };
    return {
      ops: { ref, ops: [guard, { op: 'update', table: 'events', id: local.eventId, values, expectCount: 1 }] },
      conflicts,
      stillDirty: localChanged && !remoteChanged,
      effect: 'update',
      writes: 1,
    };
  },

  planLocalDelete(local): OpGroup {
    return {
      ref: local.syncId ?? `row:${local.eventId}`,
      ops: [
        ...local.exceptions.map((x) => ({ op: 'delete' as const, table: 'events' as const, id: x.eventId })),
        { op: 'delete', table: 'events', id: local.eventId },
      ],
    };
  },

  planBaselineHeal() {
    return null;
  },

  planUpload(local, ctx): UploadPlan<CalendarEventWire> {
    const ref = local.syncId ?? `row:${local.eventId}`;
    const identity = local.split === 'clone' ? null : parseObjectRef(local.syncId);
    const pendingUid = local.pending?.uid ?? pendingUidOf(local.syncId);
    if (local.deleted) {
      if (identity) return { kind: 'upload', actions: [{ kind: 'destroy', id: identity.id, uid: null }] };
      if (pendingUid) return { kind: 'upload', actions: [{ kind: 'destroy', id: null, uid: pendingUid }] };
      return { kind: 'purge', ops: { ref, ops: [{ op: 'delete', table: 'events', id: local.eventId }] } };
    }
    const guard: ProviderOp = { op: 'assert', table: 'events', id: local.eventId, values: { title: local.cells.title }, expectCount: 1 };
    if (!identity) {
      const calendar = ctx.calendarIdOfRow(local.calendarRowId);
      if (!calendar) return { kind: 'skip', reason: 'notOurCalendar' };
      if (!pendingUid || local.split === 'clone') {
        const uid = ctx.mintUid();
        return {
          kind: 'claim',
          ops: {
            ref,
            ops: [guard, {
              op: 'update',
              table: 'events',
              id: local.eventId,
              values: { _sync_id: pendingRef(uid), uid2445: uid, sync_data3: JSON.stringify({ uid, target: collectionKey(calendar.jmapAccountId, calendar.calendarId) }) },
            }],
          },
        };
      }
      const start = Number(local.cells.dtstart ?? 0);
      return {
        kind: 'upload',
        actions: [{
          kind: 'create',
          uid: pendingUid,
          collectionId: calendar.calendarId,
          object: { uid: pendingUid, title: String(local.cells.title ?? ''), start: localStart(start), duration: 'PT1H', timeZone: 'Etc/UTC' },
        }],
      };
    }
    if (ctx.isReadOnly(onIds(local.shadow?.calendarIds)[0] ?? '')) {
      return { kind: 'revert', ops: { ref, ops: [guard, { op: 'update', table: 'events', id: local.eventId, values: { title: local.shadow?.title ?? '', dirty: 0 } }] } };
    }
    const base = String(local.baseline?.cells.title ?? local.shadow?.title ?? '');
    if (local.cells.title === base) {
      return { kind: 'clean', ops: { ref, ops: [guard, { op: 'update', table: 'events', id: local.eventId, values: { dirty: 0 } }] } };
    }
    return { kind: 'upload', actions: [{ kind: 'update', id: identity.id, patch: { title: String(local.cells.title ?? '') } }] };
  },

  planAccepted(local, server, ctx): AcceptedPlan {
    const ref = eventRef(ctx, server);
    const values = {
      _sync_id: ref,
      sync_data1: JSON.stringify(server),
      sync_data3: null,
      sync_data4: JSON.stringify({ cells: { title: local.cells.title }, attendees: [], reminders: [] }),
    };
    return {
      ops: {
        ref,
        ops: [
          { op: 'assert', table: 'events', id: local.eventId, values: { title: local.cells.title }, expectCount: 1 },
          { op: 'update', table: 'events', id: local.eventId, values: { ...values, dirty: 0 } },
        ],
      },
      keepDirtyOps: { ref, ops: [{ op: 'update', table: 'events', id: local.eventId, values }] },
    };
  },

  planPairs() {
    return [];
  },
  planZoneChange() {
    return null;
  },
  planReminderOwnerChange() {
    return null;
  },
};

/** An Events column list the fake accepts in `where`, for tests that read rows. */
export const EVENT_TITLE = Events.TITLE;
