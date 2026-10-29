/**
 * In-memory stand-in for Android's Contacts and Calendar providers, as the
 * device sync engine reaches them through the native bridge (`ProviderPort`),
 * plus a "user" face that edits rows the way Contacts and Calendar apps do.
 *
 * It models the provider behaviour the engine relies on (docs/device-sync.md,
 * "Device data model", and the AOSP facts quoted there):
 *
 * - Sync-adapter writes never set DIRTY; app writes do (data rows, events and
 *   their attendees/reminders). The provider never clears DIRTY. Events and
 *   calendars the sync adapter inserts have DIRTY NULL unless it writes one.
 * - Contacts `data1`..`data14` are TEXT columns: numbers are stored, and read
 *   back, as their text.
 * - RawContacts.VERSION goes up on every data-row insert, update or delete,
 *   whoever makes it, and on a DELETED change; never for DIRTY, SOURCE_ID or
 *   SYNC1-4. Groups bump VERSION on every update.
 * - App deletes are soft for raw contacts (always) and for events with a
 *   `_sync_id`; an app-deleted event without one is gone at once. Sync-adapter
 *   deletes are hard, and an event's exceptions survive the master.
 * - Batches are atomic here (a real provider may commit at yield points under
 *   contention; the engine must not rely on either), at most 499 contacts ops
 *   between yield points, asserts compare as text.
 * - Normalisation: a lone display name is split, missing display name and
 *   formatted address are derived, the organizer defaults to the calendar
 *   owner, all-day times are zeroed in UTC and `P<n>S` all-day durations become
 *   `P<n>D`, while `PT0S`-style all-day durations, NULL STATUS updates,
 *   SELF_ATTENDEE_STATUS updates and RRULEs with unknown parts fail the batch.
 *   STATUS has no default: an event an app inserts without one holds NULL.
 * - Photos, as PhotoProcessor keeps them: one within the 96 px thumbnail is
 *   the thumbnail alone (PHOTO_FILE_ID NULL), a bigger one (or bytes that are
 *   no JPEG or PNG) a display photo with a file id; DATA15 never reads back.
 * - A batch over one Binder transaction (`estimateBatchBytes` over 1 MB, by
 *   default) fails with `tooLarge`.
 * - Scoping: rows of other accounts are invisible and untouchable.
 * - The native bridge's rules (android/.../sync/ProviderOps.kt and
 *   ProviderScope.kt): an op with `id` expects exactly one row unless it says
 *   otherwise, and applies `where` too; attendees, reminders and extended
 *   properties refuse `_id` in `where` (ambiguous in CalendarProvider's
 *   join), and extended properties are updated by `id` only; a named parent,
 *   exception master or group that is gone fails with `assert`, one of
 *   another account with `scope`; `syncState` must be the batch's last op
 *   and no yield point; settings inserts return no id. Query and photo
 *   errors carry the native rejection `code`.
 *
 * Pure TypeScript, for vitest only.
 */
import {
  AttendeeRelationship,
  AttendeeStatus,
  AttendeeType,
  Attendees,
  Calendars,
  Colors,
  ContactsSettings,
  Data,
  Events,
  ExtendedProperties,
  GroupMembership,
  Groups,
  MimeType,
  RawContacts,
  Reminders,
  StructuredName,
  StructuredPostal,
} from '../../android-columns';
import {
  CALENDAR_AUTHORITY,
  CALENDAR_TABLES,
  CONTACTS_AUTHORITY,
  CONTACTS_TABLES,
  type Authority,
  type BatchFailure,
  type BatchResult,
  type Cell,
  type OpResult,
  type PhotoData,
  type ProviderOp,
  type ProviderPort,
  type ProviderQuery,
  type ProviderRows,
  type ProviderTable,
  type Row,
  type WriteCell,
  type WriteRow,
} from '../../types';
import { estimateBatchBytes } from '../../engine/batch';
import { compileOrderBy, compileWhere, whereColumns } from './fake-sql';

export const FAKE_ACCOUNT_TYPE = 'com.anonymous.bulwarkmobile.account';
const APP_PACKAGE = 'com.example.calendarapp';

type StoredRow = Record<string, Cell>;

/** Rows keyed by `_id`, which every stored row also carries as a column. */
class RowMap extends Map<number, StoredRow> {
  override set(id: number, row: StoredRow): this {
    row._id = id;
    return super.set(id, row);
  }
}
type Tables = Record<ProviderTable, RowMap>;

const numbered = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

const COLUMNS: Record<ProviderTable, Set<string>> = {
  raw_contacts: new Set([...Object.values(RawContacts), 'custom_ringtone', 'send_to_voicemail', 'backup_id']),
  data: new Set([...Object.values(Data), GroupMembership.GROUP_SOURCE_ID]),
  groups: new Set([...Object.values(Groups), 'auto_add', 'favorites']),
  settings: new Set(Object.values(ContactsSettings)),
  calendars: new Set([...Object.values(Calendars), ...numbered('cal_sync', 4, 10)]),
  events: new Set([...Object.values(Events), ...numbered('sync_data', 7, 10), 'lastSynced']),
  attendees: new Set(Object.values(Attendees)),
  reminders: new Set(Object.values(Reminders)),
  extended_properties: new Set(Object.values(ExtendedProperties)),
  colors: new Set(Object.values(Colors)),
};

/** Columns the providers take on writes but refuse in every projection and selection ("Invalid column"). */
const WRITE_ONLY_COLUMNS: Partial<Record<ProviderTable, Set<string>>> = {
  raw_contacts: new Set([RawContacts.RAW_CONTACT_IS_READ_ONLY]),
};

/** Columns only the provider computes; writes to them are refused like SQLite would for a view. */
const READ_ONLY_COLUMNS: Partial<Record<ProviderTable, Set<string>>> = {
  data: new Set([GroupMembership.GROUP_SOURCE_ID]),
  events: new Set([Events.ACCOUNT_NAME, Events.ACCOUNT_TYPE]),
};

class FakeProviderError extends Error {
  constructor(readonly reason: BatchFailure, message: string) {
    super(message);
  }
}

/** A rejected query or photo read, with the `code` the native module rejects with. */
function rejection(code: BatchFailure, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const isEmpty = (v: Cell | undefined) => v === null || v === undefined || v === '';

/** The parent row each row of a table belongs to. */
const PARENTS: Partial<Record<ProviderTable, { column: string; table: ProviderTable }>> = {
  data: { column: Data.RAW_CONTACT_ID, table: 'raw_contacts' },
  events: { column: Events.CALENDAR_ID, table: 'calendars' },
  attendees: { column: Attendees.EVENT_ID, table: 'events' },
  reminders: { column: Reminders.EVENT_ID, table: 'events' },
  extended_properties: { column: ExtendedProperties.EVENT_ID, table: 'events' },
};

/** Tables read through CalendarProvider's join, where a bare `_id` is ambiguous. */
const JOINED_CHILD_TABLES: ReadonlySet<ProviderTable> = new Set(['attendees', 'reminders', 'extended_properties']);

/** Tables that carry the account in `account_name`/`account_type`. */
const ACCOUNT_TABLES: ReadonlySet<ProviderTable> = new Set(['raw_contacts', 'groups', 'settings', 'calendars', 'colors']);

/**
 * The table a written column points into when the row it names must be the
 * account's too (ProviderOps.kt `referencedTable`): a parent, an exception's
 * master, a membership's group.
 */
function referencedTable(table: ProviderTable, column: string, values: WriteRow): ProviderTable | null {
  if (PARENTS[table]?.column === column) return PARENTS[table].table;
  if (table === 'events' && column === Events.ORIGINAL_ID) return 'events';
  if (table === 'data' && column === Data.DATA1 && values[Data.MIMETYPE] === MimeType.GROUP_MEMBERSHIP) return 'groups';
  return null;
}

const TEXT_DATA_COLUMNS: ReadonlySet<string> = new Set(numbered('data', 1, 14));

/** ContactsProvider's `data1`..`data14` have TEXT affinity: SQLite stores numbers as their text. */
function textifyData(row: StoredRow): void {
  for (const column of TEXT_DATA_COLUMNS) {
    const v = row[column];
    if (typeof v === 'number') row[column] = String(v);
  }
}

/**
 * What the native side refuses before touching the provider (ProviderOps.kt
 * `parseBatch`): a misplaced syncState, bad back-references, inserts that
 * name no parent, and contacts batches without enough yield points.
 */
function refuseBatch(authority: Authority, ops: ProviderOp[]): { reason: BatchFailure; message: string } | null {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op !== 'syncState') continue;
    if (i !== ops.length - 1) return { reason: 'scope', message: `op ${i}: syncState must be the last op of its batch` };
    if (op.yieldAllowed) return { reason: 'scope', message: `op ${i}: syncState must not be a yield point` };
  }
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op !== 'insert') continue;
    for (const [column, ref] of Object.entries(op.refs ?? {})) {
      const target = ops[ref];
      if (!Number.isInteger(ref) || ref < 0 || ref >= i || target?.op !== 'insert' || target.table === 'settings') {
        return { reason: 'provider', message: `op ${i}: ${column} refers to op ${ref}, which is not an earlier insert with a row id` };
      }
      const expected = referencedTable(op.table, column, op.values);
      if (expected && target.table !== expected) {
        return { reason: 'scope', message: `op ${i}: ${column} must refer to a ${expected} insert, not ${target.table}` };
      }
    }
    const parent = PARENTS[op.table];
    if (parent && !(parent.column in (op.refs ?? {})) && (op.values[parent.column] ?? null) === null) {
      return { reason: 'scope', message: `op ${i}: a ${op.table} insert must name its ${parent.column}` };
    }
  }
  if (authority === CONTACTS_AUTHORITY) {
    // ContactsProvider counts an op before resetting at a yield point.
    let sinceYield = 0;
    for (let i = 0; i < ops.length; i++) {
      if (++sinceYield >= 500) {
        return { reason: 'provider', message: 'Too many content provider operations between yield points' };
      }
      if (i > 0 && ops[i].yieldAllowed) sinceYield = 0;
    }
  }
  return null;
}

/** AOSP calendarcommon2 Duration.parse: `[+-]P` then `<digits><W|D|H|M|S>`, `T` ignored. */
export function aospDurationValid(value: string): boolean {
  return /^[+-]?P(T?\d+[WDHMS])*T?$/.test(value) && /\d/.test(value);
}

/** AOSP EventRecurrence.parse: known parts only (X-* ignored), FREQ required, no RRULE: prefix. */
export function aospRruleValid(value: string): boolean {
  const known = new Set([
    'FREQ', 'UNTIL', 'COUNT', 'INTERVAL', 'BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYDAY', 'BYMONTHDAY',
    'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS', 'WKST',
  ]);
  return value.split('\n').every((rule) => {
    const seen = new Set<string>();
    let freq = false;
    for (const part of rule.toUpperCase().split(';')) {
      if (!part) continue;
      const [name] = part.split('=');
      if (name.startsWith('X-')) continue;
      if (!known.has(name) || seen.has(name)) return false;
      seen.add(name);
      if (name === 'FREQ') freq = true;
    }
    return freq;
  });
}

export interface FakeProviderOptions {
  accountType?: string;
  /** Derive/split names and addresses like ContactsProvider (default true). */
  normalize?: boolean;
  /** Bytes of one applyBatch, as `estimateBatchBytes` weighs them, before it fails with `tooLarge` (default 1 MB). */
  maxBatchBytes?: number;
}

/**
 * Both providers of one device. `port(account, authority)` is what the engine
 * gets; `user` edits like apps do; the rest is for test setup and assertions.
 */
export class FakeDeviceProviders {
  readonly accountType: string;
  private readonly normalize: boolean;
  private readonly maxBatchBytes: number;
  private tables: Tables = FakeDeviceProviders.emptyTables();
  private syncState = new Map<string, string>();
  private photos = new Map<number, string>();
  private nextId = 1;
  private nextPhotoFile = 1000;
  private pendingFailure: { reason: BatchFailure; message: string } | null = null;
  private partialFailure: { groups: number; reason: BatchFailure; when: (ops: ProviderOp[]) => boolean } | null = null;
  private beforeBatch: Array<() => void> = [];
  /** Every batch applied or refused, for assertions on write counts. */
  readonly batches: Array<{ account: string; authority: Authority; ops: ProviderOp[]; ok: boolean }> = [];

  readonly user = new FakeUser(this);

  constructor(options: FakeProviderOptions = {}) {
    this.accountType = options.accountType ?? FAKE_ACCOUNT_TYPE;
    this.normalize = options.normalize ?? true;
    this.maxBatchBytes = options.maxBatchBytes ?? 1_000_000;
  }

  private static emptyTables(): Tables {
    return {
      raw_contacts: new RowMap(),
      data: new RowMap(),
      groups: new RowMap(),
      settings: new RowMap(),
      calendars: new RowMap(),
      events: new RowMap(),
      attendees: new RowMap(),
      reminders: new RowMap(),
      extended_properties: new RowMap(),
      colors: new RowMap(),
    };
  }

  port(accountName: string, authority: Authority): ProviderPort {
    return new FakePort(this, accountName, authority);
  }

  // ── test hooks ─────────────────────────────────────────

  /** The next applyBatch fails with this reason, applying nothing. */
  failNextBatch(reason: BatchFailure, message = `injected ${reason}`): void {
    this.pendingFailure = { reason, message };
  }

  /** Runs `fn` right before the next applyBatch is applied (a concurrent user edit). */
  beforeNextBatch(fn: () => void): void {
    this.beforeBatch.push(fn);
  }

  /**
   * The next applyBatch that `when` matches behaves like a provider that
   * yielded under contention: the ops before its `groups + 1`-th yield point
   * (its first `groups` groups) are committed, then the batch fails with
   * `reason` and the rest is rolled back.
   */
  partialCommitNextBatch(groups: number, reason: BatchFailure = 'assert', when: (ops: ProviderOp[]) => boolean = () => true): void {
    this.partialFailure = { groups, reason, when };
  }

  /** Removes an account the way AccountManager does: the providers drop all its rows and SyncState. */
  removeAccount(accountName: string): void {
    for (const table of ['raw_contacts', 'groups', 'settings', 'calendars', 'colors'] as const) {
      for (const [id, row] of this.tables[table]) {
        if (row.account_name === accountName && row.account_type === this.accountType) this.deleteRow(table, id);
      }
    }
    for (const authority of [CONTACTS_AUTHORITY, CALENDAR_AUTHORITY]) this.syncState.delete(`${authority}|${accountName}`);
  }

  // ── inspection ─────────────────────────────────────────

  rows(table: ProviderTable, where?: string, args: Array<string | number> = []): Row[] {
    const pred = compileWhere(where, args);
    return [...this.tables[table].values()]
      .filter((row) => pred((c) => this.readCell(table, row, c)))
      .map((row) => ({ ...this.view(table, row) }));
  }

  row(table: ProviderTable, id: number): Row | undefined {
    const row = this.tables[table].get(id);
    return row ? { ...this.view(table, row) } : undefined;
  }

  /** Stored photo bytes (base64) by PHOTO_FILE_ID. */
  photo(fileId: number): string | undefined {
    return this.photos.get(fileId);
  }

  readSyncState(accountName: string, authority: Authority): string | null {
    return this.syncState.get(`${authority}|${accountName}`) ?? null;
  }

  // ── internals shared by the port and the user face ─────

  /** @internal */ allocId(): number {
    return this.nextId++;
  }

  /** @internal */ table(table: ProviderTable): RowMap {
    return this.tables[table];
  }

  /** @internal */ readCell(table: ProviderTable, row: StoredRow, column: string): Cell {
    if (table === 'data' && column === GroupMembership.GROUP_SOURCE_ID) {
      if (row[Data.MIMETYPE] !== MimeType.GROUP_MEMBERSHIP || row[Data.DATA1] === null) return null;
      return this.tables.groups.get(Number(row[Data.DATA1]))?.[Groups.SOURCE_ID] ?? null;
    }
    if (table === 'events' && (column === Events.ACCOUNT_NAME || column === Events.ACCOUNT_TYPE)) {
      return this.tables.calendars.get(Number(row[Events.CALENDAR_ID]))?.[column] ?? null;
    }
    if (table === 'data' && column === Data.DATA15 && row[Data.MIMETYPE] === MimeType.PHOTO) return null;
    const v = row[column];
    return v === undefined ? null : v;
  }

  private view(table: ProviderTable, row: StoredRow): StoredRow {
    const out: StoredRow = {};
    for (const column of COLUMNS[table]) out[column] = this.readCell(table, row, column);
    return out;
  }

  /** @internal */ owned(table: ProviderTable, row: StoredRow, accountName: string): boolean {
    const mine = (r: StoredRow | undefined) =>
      !!r && r[RawContacts.ACCOUNT_NAME] === accountName && r[RawContacts.ACCOUNT_TYPE] === this.accountType;
    switch (table) {
      case 'raw_contacts':
      case 'groups':
      case 'settings':
      case 'calendars':
      case 'colors':
        return mine(row);
      case 'data':
        return mine(this.tables.raw_contacts.get(Number(row[Data.RAW_CONTACT_ID])));
      case 'events':
        return mine(this.tables.calendars.get(Number(row[Events.CALENDAR_ID])));
      case 'attendees':
      case 'reminders':
      case 'extended_properties': {
        const event = this.tables.events.get(Number(row.event_id));
        return !!event && this.owned('events', event, accountName);
      }
    }
  }

  /** @internal */ deleteRow(table: ProviderTable, id: number): void {
    const row = this.tables[table].get(id);
    if (!row) return;
    this.tables[table].delete(id);
    if (table === 'raw_contacts') {
      for (const [dataId, d] of this.tables.data) if (d[Data.RAW_CONTACT_ID] === id) this.tables.data.delete(dataId);
    } else if (table === 'groups') {
      for (const [dataId, d] of this.tables.data) {
        if (d[Data.MIMETYPE] === MimeType.GROUP_MEMBERSHIP && Number(d[Data.DATA1]) === id) {
          this.tables.data.delete(dataId);
          this.bumpVersion(Number(d[Data.RAW_CONTACT_ID]));
        }
      }
    } else if (table === 'calendars') {
      for (const [eventId, e] of this.tables.events) if (e[Events.CALENDAR_ID] === id) this.deleteRow('events', eventId);
    } else if (table === 'events') {
      for (const child of ['attendees', 'reminders', 'extended_properties'] as const) {
        for (const [childId, c] of this.tables[child]) if (c.event_id === id) this.tables[child].delete(childId);
      }
    }
  }

  /** @internal */ bumpVersion(rawContactId: number): void {
    const rc = this.tables.raw_contacts.get(rawContactId);
    if (rc) rc[RawContacts.VERSION] = Number(rc[RawContacts.VERSION] ?? 1) + 1;
  }

  /** @internal */ markEventDirty(eventId: number): void {
    const e = this.tables.events.get(eventId);
    if (!e) return;
    e[Events.DIRTY] = 1;
    const mutators = String(e[Events.MUTATORS] ?? '');
    if (!mutators.split(',').includes(APP_PACKAGE)) e[Events.MUTATORS] = mutators ? `${mutators},${APP_PACKAGE}` : APP_PACKAGE;
  }

  /** @internal */ storePhoto(b64: string): number {
    const fileId = this.nextPhotoFile++;
    this.photos.set(fileId, b64);
    return fileId;
  }

  /** @internal Provider-side fixes of a data row after a write (ContactsProvider's row handlers). */
  normalizeData(row: StoredRow): void {
    if (!this.normalize) return;
    if (row[Data.MIMETYPE] === MimeType.STRUCTURED_NAME) {
      const parts = [
        StructuredName.PREFIX,
        StructuredName.GIVEN_NAME,
        StructuredName.MIDDLE_NAME,
        StructuredName.FAMILY_NAME,
        StructuredName.SUFFIX,
      ];
      const anyPart = parts.some((c) => !isEmpty(row[c]));
      if (isEmpty(row[StructuredName.DISPLAY_NAME]) && anyPart) {
        row[StructuredName.DISPLAY_NAME] = parts.map((c) => row[c]).filter((v) => !isEmpty(v)).join(' ');
      } else if (!isEmpty(row[StructuredName.DISPLAY_NAME]) && !anyPart) {
        const words = String(row[StructuredName.DISPLAY_NAME]).trim().split(/\s+/);
        row[StructuredName.GIVEN_NAME] = words[0] ?? null;
        row[StructuredName.FAMILY_NAME] = words.length > 1 ? words.slice(1).join(' ') : null;
      }
    } else if (row[Data.MIMETYPE] === MimeType.STRUCTURED_POSTAL) {
      const parts = [
        StructuredPostal.STREET,
        StructuredPostal.POBOX,
        StructuredPostal.NEIGHBORHOOD,
        StructuredPostal.CITY,
        StructuredPostal.REGION,
        StructuredPostal.POSTCODE,
        StructuredPostal.COUNTRY,
      ];
      const anyPart = parts.some((c) => !isEmpty(row[c]));
      if (isEmpty(row[StructuredPostal.FORMATTED_ADDRESS]) && anyPart) {
        row[StructuredPostal.FORMATTED_ADDRESS] = parts.map((c) => row[c]).filter((v) => !isEmpty(v)).join(', ');
      } else if (!isEmpty(row[StructuredPostal.FORMATTED_ADDRESS]) && !anyPart) {
        row[StructuredPostal.STREET] = row[StructuredPostal.FORMATTED_ADDRESS];
      }
    }
  }

  /** @internal CalendarProvider's checks and fixes of an event row (sync adapter and app alike). */
  fixEvent(row: StoredRow, isInsert: boolean): void {
    const recurring = !isEmpty(row[Events.RRULE]) || !isEmpty(row[Events.RDATE]);
    const exception = !isEmpty(row[Events.ORIGINAL_SYNC_ID]) || !isEmpty(row[Events.ORIGINAL_ID]);
    if (!isEmpty(row[Events.RRULE]) && !aospRruleValid(String(row[Events.RRULE]))) {
      throw new FakeProviderError('provider', `Invalid recurrence rule: ${row[Events.RRULE]}`);
    }
    if (recurring) {
      row[Events.DTEND] = null;
      if (isEmpty(row[Events.DURATION])) throw new FakeProviderError('provider', 'Recurring event without DURATION');
    } else if (exception || !isEmpty(row[Events.DTEND])) {
      row[Events.DURATION] = null;
    }
    if (!isEmpty(row[Events.DURATION]) && !aospDurationValid(String(row[Events.DURATION]))) {
      throw new FakeProviderError('provider', `Invalid DURATION ${row[Events.DURATION]}`);
    }
    if (isInsert && isEmpty(row[Events.DTSTART])) throw new FakeProviderError('provider', 'DTSTART field missing');
    if (Number(row[Events.ALL_DAY]) === 1) {
      for (const c of [Events.DTSTART, Events.DTEND]) {
        if (!isEmpty(row[c])) row[c] = Math.floor(Number(row[c]) / 86_400_000) * 86_400_000;
      }
      const d = row[Events.DURATION];
      if (!isEmpty(d)) {
        const s = String(d);
        if (s.endsWith('S')) {
          const n = Number(s.substring(1, s.length - 1)); // Integer.parseInt(duration.substring(1, len-1))
          if (!Number.isInteger(n)) throw new FakeProviderError('provider', `NumberFormatException: ${s}`);
          row[Events.DURATION] = `P${Math.ceil(n / 86_400)}D`;
        }
      }
    }
  }

  /** @internal */ applyBatch(accountName: string, authority: Authority, ops: ProviderOp[]): BatchResult {
    const record = (ok: boolean) => this.batches.push({ account: accountName, authority, ops, ok });
    if (this.pendingFailure) {
      const { reason, message } = this.pendingFailure;
      this.pendingFailure = null;
      record(false);
      return { ok: false, reason, message };
    }
    if (parcelBytes(ops) > this.maxBatchBytes) {
      record(false);
      return { ok: false, reason: 'tooLarge', message: 'TransactionTooLargeException' };
    }
    const refusal = refuseBatch(authority, ops);
    if (refusal) {
      record(false);
      return { ok: false, ...refusal };
    }
    for (const hook of this.beforeBatch.splice(0)) hook();

    if (this.partialFailure?.when(ops)) {
      const { groups, reason } = this.partialFailure;
      this.partialFailure = null;
      const starts = ops.flatMap((op, i) => (i === 0 || (op as { yieldAllowed?: boolean }).yieldAllowed ? [i] : []));
      const cut = starts[groups] ?? 0;
      if (cut > 0) {
        const committed = this.applyBatch(accountName, authority, ops.slice(0, cut));
        if (!committed.ok) return committed;
      }
      record(false);
      return { ok: false, reason, message: `injected ${reason} after a yield point` };
    }

    const snapshot = {
      tables: cloneTables(this.tables),
      syncState: new Map(this.syncState),
      photos: new Map(this.photos),
      nextId: this.nextId,
      nextPhotoFile: this.nextPhotoFile,
    };
    try {
      const results = new BatchApplier(this, accountName, authority).apply(ops);
      record(true);
      return { ok: true, results };
    } catch (e) {
      this.tables = snapshot.tables;
      this.syncState = snapshot.syncState;
      this.photos = snapshot.photos;
      this.nextId = snapshot.nextId;
      this.nextPhotoFile = snapshot.nextPhotoFile;
      record(false);
      if (e instanceof FakeProviderError) return { ok: false, reason: e.reason, message: e.message };
      return { ok: false, reason: 'provider', message: (e as Error).message };
    }
  }

  /** @internal */ setSyncState(accountName: string, authority: Authority, value: string): void {
    this.syncState.set(`${authority}|${accountName}`, value);
  }
}

/**
 * What a batch weighs in its Binder transaction: `estimateBatchBytes`, with a
 * photo blob counted by its bytes (the native side hands ContentValues a
 * decoded `byte[]`, not the base64 text).
 */
function parcelBytes(ops: readonly ProviderOp[]): number {
  let blobs = 0;
  const texts = ops.map((op) => {
    if (op.op !== 'insert' && op.op !== 'update') return op;
    const values = { ...op.values };
    for (const [column, value] of Object.entries(values)) {
      if (value === null || typeof value !== 'object') continue;
      blobs += Math.floor((value.b64.length * 3) / 4);
      values[column] = null;
    }
    return { ...op, values };
  });
  return estimateBatchBytes(texts) + blobs;
}

function cloneTables(tables: Tables): Tables {
  const out = {} as Tables;
  for (const [name, rows] of Object.entries(tables) as Array<[ProviderTable, RowMap]>) {
    const copy = new RowMap();
    for (const [id, row] of rows) copy.set(id, { ...row });
    out[name] = copy;
  }
  return out;
}

function tablesFor(authority: Authority): readonly ProviderTable[] {
  return authority === CONTACTS_AUTHORITY ? CONTACTS_TABLES : CALENDAR_TABLES;
}

function checkColumns(table: ProviderTable, columns: Iterable<string>, write: boolean): void {
  for (const c of columns) {
    if (!COLUMNS[table].has(c)) throw new FakeProviderError('provider', `no such column: ${c} in ${table}`);
    if (!write && WRITE_ONLY_COLUMNS[table]?.has(c)) throw new FakeProviderError('provider', `Invalid column ${c}`);
    if (write && READ_ONLY_COLUMNS[table]?.has(c)) throw new FakeProviderError('provider', `${c} is read-only in ${table}`);
  }
}

/** SQLite on CalendarProvider's attendee join: "ambiguous column name: _id". Address those rows with `id`. */
function checkNoBareId(table: ProviderTable, where: string | undefined): void {
  if (JOINED_CHILD_TABLES.has(table) && whereColumns(where).includes('_id')) {
    throw new FakeProviderError('provider', `ambiguous column name: _id (address ${table} rows with id)`);
  }
}

class FakePort implements ProviderPort {
  constructor(
    private readonly fake: FakeDeviceProviders,
    readonly accountName: string,
    readonly authority: Authority,
  ) {}

  async query(q: ProviderQuery): Promise<ProviderRows> {
    if (!tablesFor(this.authority).includes(q.table)) {
      throw rejection('scope', `table ${q.table} is not part of ${this.authority}`);
    }
    try {
      checkColumns(q.table, [...q.columns, ...whereColumns(q.where)], false);
      checkNoBareId(q.table, q.where);
    } catch (e) {
      throw rejection('provider', (e as Error).message);
    }
    const pred = compileWhere(q.where, q.args);
    const order = compileOrderBy(q.orderBy);
    const rows = [...this.fake.table(q.table).values()]
      .filter((row) => this.fake.owned(q.table, row, this.accountName))
      .filter((row) => pred((c) => this.fake.readCell(q.table, row, c)))
      .sort((a, b) => order((c) => this.fake.readCell(q.table, a, c), (c) => this.fake.readCell(q.table, b, c)));
    return {
      columns: q.columns,
      rows: rows.map((row) => q.columns.map((c) => this.fake.readCell(q.table, row, c))),
    };
  }

  async applyBatch(ops: ProviderOp[]): Promise<BatchResult> {
    return this.fake.applyBatch(this.accountName, this.authority, structuredClone(ops));
  }

  async readSyncState(): Promise<string | null> {
    return this.fake.readSyncState(this.accountName, this.authority);
  }

  async readPhoto(rawContactId: number, _maxPx: number): Promise<PhotoData | null> {
    const rc = this.fake.table('raw_contacts').get(rawContactId);
    if (!rc || !this.fake.owned('raw_contacts', rc, this.accountName)) {
      throw rejection('scope', `Raw contact ${rawContactId} is not part of the account`);
    }
    for (const row of this.fake.table('data').values()) {
      if (row[Data.RAW_CONTACT_ID] === rawContactId && row[Data.MIMETYPE] === MimeType.PHOTO) {
        const fileId = row[Data.DATA14] === null || row[Data.DATA14] === undefined ? null : Number(row[Data.DATA14]);
        // A photo kept as its thumbnail alone is read from the thumbnail.
        const thumbnail = row[Data.DATA15];
        if (fileId === null) return typeof thumbnail === 'string' && thumbnail.startsWith('blob:') ? { jpegBase64: thumbnail.slice(5), fileId: null } : null;
        const b64 = this.fake.photo(fileId);
        return b64 === undefined ? null : { jpegBase64: b64, fileId };
      }
    }
    return null;
  }
}

/** Applies one batch as a sync adapter; throws FakeProviderError to roll it back. */
class BatchApplier {
  private readonly results: OpResult[] = [];
  private readonly insertedDataFor = new Set<number>();

  constructor(
    private readonly fake: FakeDeviceProviders,
    private readonly account: string,
    private readonly authority: Authority,
  ) {}

  apply(ops: ProviderOp[]): OpResult[] {
    ops.forEach((op, index) => this.results.push(this.applyOne(op, index)));
    // Data-row inserts bump each raw contact's VERSION once per transaction.
    for (const id of this.insertedDataFor) this.fake.bumpVersion(id);
    return this.results;
  }

  private scopeError(msg: string): never {
    throw new FakeProviderError('scope', msg);
  }

  private checkTable(table: ProviderTable): void {
    if (!tablesFor(this.authority).includes(table)) this.scopeError(`table ${table} is not part of ${this.authority}`);
  }

  /** The rows an op addresses: the `id` row if it also matches `where`, or every row of the account matching `where`. */
  private target(table: ProviderTable, id: number | undefined, where: string | undefined, args: Array<string | number> | undefined): number[] {
    if (id !== undefined && table === 'settings') throw new FakeProviderError('provider', 'settings rows have no id');
    checkColumns(table, whereColumns(where), false);
    checkNoBareId(table, where);
    const pred = compileWhere(where, args);
    const rows = this.fake.table(table);
    if (id !== undefined) {
      const row = rows.get(id);
      if (!row) return [];
      if (!this.fake.owned(table, row, this.account)) this.scopeError(`${table} ${id} belongs to another account`);
      return pred((c) => this.fake.readCell(table, row, c)) ? [id] : [];
    }
    return [...rows]
      .filter(([, row]) => this.fake.owned(table, row, this.account))
      .filter(([, row]) => pred((c) => this.fake.readCell(table, row, c)))
      .map(([rowId]) => rowId);
  }

  /** An op that names one row by id expects exactly that row unless it says otherwise. */
  private checkCount(ids: number[], id: number | undefined, expectCount: number | undefined): void {
    const expected = expectCount ?? (id !== undefined ? 1 : undefined);
    if (expected !== undefined && ids.length !== expected) {
      throw new FakeProviderError('assert', `wrong number of rows: ${ids.length}, expected ${expected}`);
    }
  }

  /** Account columns may only restate the account, and only on the tables that have them. */
  private checkAccountColumns(table: ProviderTable, values: WriteRow): void {
    for (const column of ['account_name', 'account_type', 'data_set']) {
      if (!(column in values)) continue;
      const cell = values[column];
      const restates =
        ACCOUNT_TABLES.has(table) &&
        (column === 'account_name' ? cell === this.account : column === 'account_type' ? cell === this.fake.accountType : cell === null);
      if (!restates) this.scopeError(`${table}.${column} would leave the account`);
    }
  }

  /**
   * Parents, masters and groups a written column names must be rows of the
   * account that still exist: a gone one fails with `assert` (the engine
   * re-reads), one of another account with `scope`. `skip`: columns filled by
   * back-references, checked before the batch ran.
   */
  private checkReferences(table: ProviderTable, values: WriteRow, skip: ReadonlySet<string> = new Set()): void {
    for (const [column, cell] of Object.entries(values)) {
      if (skip.has(column)) continue;
      const referenced = referencedTable(table, column, values);
      if (!referenced) continue;
      if (cell === null) {
        if (PARENTS[table]?.column === column) this.scopeError(`${table}.${column} must name a ${referenced} row`);
        continue;
      }
      const id = typeof cell === 'number' ? cell : typeof cell === 'string' && /^\d+$/.test(cell) ? Number(cell) : NaN;
      if (!Number.isInteger(id)) throw new FakeProviderError('provider', `${table}.${column} must be a row id`);
      const row = this.fake.table(referenced).get(id);
      if (!row) throw new FakeProviderError('assert', `${table}.${column} names ${referenced} ${id}, which no longer exists`);
      if (!this.fake.owned(referenced, row, this.account)) {
        this.scopeError(`${table}.${column} names ${referenced} ${id} of another account`);
      }
    }
  }

  private values(table: ProviderTable, values: WriteRow): StoredRow {
    checkColumns(table, Object.keys(values), true);
    const out: StoredRow = {};
    for (const [column, cell] of Object.entries(values) as Array<[string, WriteCell]>) {
      if (cell !== null && typeof cell === 'object') {
        if (!(table === 'data' && column === Data.DATA15)) this.scopeError(`blob not allowed in ${table}.${column}`);
        out[column] = `blob:${cell.b64}`;
      } else {
        out[column] = cell;
      }
    }
    return out;
  }

  /**
   * A photo row's full-size bytes, as PhotoProcessor keeps them: within the
   * 96 px thumbnail as the thumbnail alone (PHOTO_FILE_ID NULL, the bytes kept
   * for readPhoto), else as a stored display photo plus a file id.
   */
  private processPhoto(row: StoredRow): void {
    const v = row[Data.DATA15];
    if (typeof v === 'string' && v.startsWith('blob:')) {
      const size = imageSize(v.slice(5));
      if (size && Math.max(size.width, size.height) <= THUMBNAIL_PX) {
        row[Data.DATA14] = null;
        return;
      }
      row[Data.DATA14] = this.fake.storePhoto(v.slice(5));
      row[Data.DATA15] = 'thumbnail';
    }
  }

  private applyOne(op: ProviderOp, index: number): OpResult {
    if (op.op === 'syncState') {
      this.fake.setSyncState(this.account, this.authority, op.value);
      return {};
    }
    this.checkTable(op.table);
    switch (op.op) {
      case 'insert':
        return this.insert(op.table, op.values, op.refs, index);
      case 'update':
        return this.update(op.table, op.id, op.where, op.args, op.values, op.expectCount);
      case 'delete':
        return this.delete(op.table, op.id, op.where, op.args, op.expectCount);
      case 'assert':
        return this.assert(op.table, op.id, op.where, op.args, op.values, op.expectCount);
    }
  }

  private insert(table: ProviderTable, values: WriteRow, refs: Record<string, number> | undefined, index: number): OpResult {
    this.checkAccountColumns(table, values);
    this.checkReferences(table, values, new Set(Object.keys(refs ?? {})));
    const row = this.values(table, values);
    // Back-references win over values, as ContentProviderOperation applies them last.
    for (const [column, ref] of Object.entries(refs ?? {})) {
      if (ref >= index || this.results[ref]?.id === undefined) throw new FakeProviderError('provider', `bad back-reference ${ref}`);
      row[column] = this.results[ref].id!;
    }
    const id = this.fake.allocId();
    const account = { account_name: this.account, account_type: this.fake.accountType };
    switch (table) {
      case 'raw_contacts':
        Object.assign(row, { ...defaults(RAW_CONTACT_DEFAULTS), ...row, ...account });
        break;
      case 'groups':
        Object.assign(row, { ...defaults(GROUP_DEFAULTS), ...row, ...account });
        break;
      case 'settings': {
        for (const [sid, s] of this.fake.table('settings')) {
          if (s.account_name === this.account && s.account_type === this.fake.accountType) this.fake.table('settings').delete(sid);
        }
        Object.assign(row, { [ContactsSettings.UNGROUPED_VISIBLE]: 0, [ContactsSettings.SHOULD_SYNC]: 1, ...row, ...account });
        this.fake.table(table).set(id, row);
        // Keyed by the account: the insert answers without a row id.
        return {};
      }
      case 'data': {
        row[Data.RAW_CONTACT_ID] = Number(row[Data.RAW_CONTACT_ID]);
        if (isEmpty(row[Data.MIMETYPE])) throw new FakeProviderError('provider', 'data row without mimetype');
        row[Data.DATA_VERSION] = 0;
        if (row[Data.MIMETYPE] === MimeType.GROUP_MEMBERSHIP) this.resolveMembership(row);
        this.processPhoto(row);
        this.fake.normalizeData(row);
        textifyData(row);
        this.insertedDataFor.add(Number(row[Data.RAW_CONTACT_ID]));
        break;
      }
      case 'calendars': {
        for (const c of [Calendars.NAME, Calendars.CALENDAR_DISPLAY_NAME, Calendars.CALENDAR_COLOR, Calendars.CALENDAR_ACCESS_LEVEL, Calendars.OWNER_ACCOUNT]) {
          if (isEmpty(row[c])) throw new FakeProviderError('provider', `calendar insert without ${c}`);
        }
        Object.assign(row, { ...defaults(CALENDAR_DEFAULTS), ...row, ...account });
        break;
      }
      case 'events': {
        const calendarId = Number(row[Events.CALENDAR_ID]);
        row[Events.CALENDAR_ID] = calendarId;
        const calendar = this.fake.table('calendars').get(calendarId)!;
        Object.assign(row, { ...defaults(EVENT_DEFAULTS), ...row });
        this.fake.fixEvent(row, true);
        if (isEmpty(row[Events.ORGANIZER])) row[Events.ORGANIZER] = calendar[Calendars.OWNER_ACCOUNT];
        this.linkException(row);
        const self = row[Events.SELF_ATTENDEE_STATUS];
        this.fake.table('events').set(id, row);
        if (!isEmpty(self)) {
          this.fake.table('attendees').set(this.fake.allocId(), {
            [Attendees.EVENT_ID]: id,
            [Attendees.ATTENDEE_EMAIL]: calendar[Calendars.OWNER_ACCOUNT],
            [Attendees.ATTENDEE_STATUS]: self,
          });
        }
        return { id };
      }
      case 'attendees':
      case 'reminders':
      case 'extended_properties':
        row.event_id = Number(row.event_id);
        break;
      case 'colors':
        Object.assign(row, { ...row, ...account });
        break;
    }
    this.fake.table(table).set(id, row);
    return { id };
  }

  private resolveMembership(row: StoredRow): void {
    const sourceId = row[GroupMembership.GROUP_SOURCE_ID];
    delete row[GroupMembership.GROUP_SOURCE_ID];
    if (row[Data.DATA1] !== null && row[Data.DATA1] !== undefined) return;
    if (isEmpty(sourceId)) throw new FakeProviderError('provider', 'membership needs GROUP_ROW_ID or GROUP_SOURCE_ID');
    for (const [gid, g] of this.fake.table('groups')) {
      if (g[Groups.SOURCE_ID] === sourceId && this.fake.owned('groups', g, this.account)) {
        row[Data.DATA1] = gid;
        return;
      }
    }
    // Like the provider: an unknown source id creates an empty, invisible group.
    const gid = this.fake.allocId();
    this.fake.table('groups').set(gid, {
      ...defaults(GROUP_DEFAULTS),
      [Groups.SOURCE_ID]: sourceId,
      account_name: this.account,
      account_type: this.fake.accountType,
    });
    row[Data.DATA1] = gid;
  }

  /** ORIGINAL_ID and ORIGINAL_SYNC_ID fill each other in from the master, as CalendarProvider does. */
  private linkException(row: StoredRow): void {
    const events = this.fake.table('events');
    if (!isEmpty(row[Events.ORIGINAL_SYNC_ID]) && isEmpty(row[Events.ORIGINAL_ID])) {
      for (const [mid, m] of events) {
        if (m[Events._SYNC_ID] === row[Events.ORIGINAL_SYNC_ID] && m[Events.CALENDAR_ID] === row[Events.CALENDAR_ID]) {
          row[Events.ORIGINAL_ID] = mid;
          break;
        }
      }
    } else if (!isEmpty(row[Events.ORIGINAL_ID]) && isEmpty(row[Events.ORIGINAL_SYNC_ID])) {
      row[Events.ORIGINAL_SYNC_ID] = events.get(Number(row[Events.ORIGINAL_ID]))?.[Events._SYNC_ID] ?? null;
    }
  }

  private update(
    table: ProviderTable,
    id: number | undefined,
    where: string | undefined,
    args: Array<string | number> | undefined,
    values: WriteRow,
    expectCount: number | undefined,
  ): OpResult {
    this.checkAccountColumns(table, values);
    this.checkReferences(table, values);
    if (table === 'extended_properties' && (id === undefined || where !== undefined)) {
      // CalendarProvider updates them only through the item URI, which takes no selection.
      throw new FakeProviderError('provider', 'extended properties can only be updated by id');
    }
    const ids = this.target(table, id, where, args);
    this.checkCount(ids, id, expectCount);
    const patch = this.values(table, values);
    for (const rowId of ids) {
      const row = this.fake.table(table).get(rowId)!;
      const before = { ...row };
      if (table === 'events') {
        if (Events.SELF_ATTENDEE_STATUS in patch) throw new FakeProviderError('provider', 'IllegalArgumentException: selfAttendeeStatus');
        if (Events.STATUS in patch && patch[Events.STATUS] === null) throw new FakeProviderError('provider', 'NullPointerException: eventStatus');
      }
      Object.assign(row, patch);
      switch (table) {
        case 'raw_contacts':
          if (before[RawContacts.DELETED] !== row[RawContacts.DELETED]) this.fake.bumpVersion(rowId);
          break;
        case 'groups':
          row[Groups.VERSION] = Number(row[Groups.VERSION] ?? 1) + 1;
          break;
        case 'data':
          row[Data.DATA_VERSION] = Number(row[Data.DATA_VERSION] ?? 0) + 1;
          this.processPhoto(row);
          this.fake.normalizeData(row);
          textifyData(row);
          this.fake.bumpVersion(Number(row[Data.RAW_CONTACT_ID]));
          break;
        case 'events':
          this.fake.fixEvent(row, false);
          if (Events.DIRTY in patch && Number(patch[Events.DIRTY]) === 0) row[Events.MUTATORS] = null;
          if (before[Events._SYNC_ID] !== row[Events._SYNC_ID] && !isEmpty(before[Events._SYNC_ID])) {
            for (const e of this.fake.table('events').values()) {
              if (e[Events.ORIGINAL_SYNC_ID] === before[Events._SYNC_ID]) e[Events.ORIGINAL_SYNC_ID] = row[Events._SYNC_ID];
            }
          }
          break;
      }
    }
    return { count: ids.length };
  }

  private delete(
    table: ProviderTable,
    id: number | undefined,
    where: string | undefined,
    args: Array<string | number> | undefined,
    expectCount: number | undefined,
  ): OpResult {
    const ids = this.target(table, id, where, args);
    this.checkCount(ids, id, expectCount);
    for (const rowId of ids) {
      const row = this.fake.table(table).get(rowId);
      if (!row) continue;
      if (table === 'data') this.fake.bumpVersion(Number(row[Data.RAW_CONTACT_ID]));
      this.fake.deleteRow(table, rowId);
    }
    return { count: ids.length };
  }

  private assert(
    table: ProviderTable,
    id: number | undefined,
    where: string | undefined,
    args: Array<string | number> | undefined,
    values: Row | undefined,
    expectCount: number | undefined,
  ): OpResult {
    const ids = this.target(table, id, where, args);
    this.checkCount(ids, id, expectCount);
    if (values) {
      checkColumns(table, Object.keys(values), false);
      for (const rowId of ids) {
        const row = this.fake.table(table).get(rowId)!;
        for (const [column, expected] of Object.entries(values)) {
          const actual = this.fake.readCell(table, row, column);
          const same = actual === null || expected === null ? actual === expected : String(actual) === String(expected);
          if (!same) {
            throw new FakeProviderError('assert', `Found value ${String(actual)} when expected ${String(expected)} for column ${column}`);
          }
        }
      }
    }
    return { count: ids.length };
  }
}

const defaults = (d: StoredRow): StoredRow => ({ ...d });

/** ContactsProvider's thumbnail size: a photo no bigger is kept as the thumbnail alone. */
const THUMBNAIL_PX = 96;

/** The pixel size of JPEG (its SOFn segment) or PNG (its IHDR chunk) bytes; null for anything else. */
function imageSize(b64: string): { width: number; height: number } | null {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const u16 = (i: number) => (bytes[i] << 8) | bytes[i + 1];
  const u32 = (i: number) => ((bytes[i] << 24) >>> 0) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
  if (bytes.length >= 24 && bytes[0] === 0x89 && String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR') {
    return { width: u32(16), height: u32(20) };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < bytes.length; ) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16(i + 5), width: u16(i + 7) };
    }
    i += 2 + u16(i + 2);
  }
  return null;
}

const RAW_CONTACT_DEFAULTS: StoredRow = {
  [RawContacts.SOURCE_ID]: null,
  [RawContacts.VERSION]: 1,
  [RawContacts.DIRTY]: 0,
  [RawContacts.DELETED]: 0,
  [RawContacts.SYNC1]: null,
  [RawContacts.SYNC2]: null,
  [RawContacts.SYNC3]: null,
  [RawContacts.SYNC4]: null,
  [RawContacts.RAW_CONTACT_IS_READ_ONLY]: 0,
  [RawContacts.AGGREGATION_MODE]: 0,
  [RawContacts.STARRED]: 0,
};

const GROUP_DEFAULTS: StoredRow = {
  [Groups.SOURCE_ID]: null,
  [Groups.VERSION]: 1,
  [Groups.DIRTY]: 0,
  [Groups.DELETED]: 0,
  [Groups.GROUP_VISIBLE]: 0,
  [Groups.SHOULD_SYNC]: 1,
  [Groups.GROUP_IS_READ_ONLY]: 0,
  auto_add: 0,
  favorites: 0,
};

const CALENDAR_DEFAULTS: StoredRow = {
  [Calendars.VISIBLE]: 1,
  [Calendars.SYNC_EVENTS]: 0,
  [Calendars.ALLOWED_REMINDERS]: '0,1',
  [Calendars.ALLOWED_AVAILABILITY]: '0,1',
  [Calendars.ALLOWED_ATTENDEE_TYPES]: '0,1,2',
  [Calendars.MAX_REMINDERS]: 5,
  [Calendars.CAN_ORGANIZER_RESPOND]: 1,
  [Calendars.CAN_MODIFY_TIME_ZONE]: 1,
  // No column default: NULL until someone writes it.
  [Calendars.DIRTY]: null,
};

const EVENT_DEFAULTS: StoredRow = {
  [Events.DIRTY]: null,
  [Events.DELETED]: 0,
  [Events.AVAILABILITY]: 0,
  [Events.ACCESS_LEVEL]: 0,
  [Events.HAS_ATTENDEE_DATA]: 0,
  [Events.GUESTS_CAN_MODIFY]: 0,
  [Events.GUESTS_CAN_INVITE_OTHERS]: 1,
  [Events.GUESTS_CAN_SEE_GUESTS]: 1,
  [Events.ALL_DAY]: 0,
  // No default for STATUS (`eventStatus INTEGER`): an app that writes none leaves NULL.
};

/**
 * Edits as Contacts and Calendar apps make them (not a sync adapter): they
 * set DIRTY, soft-delete, and some re-insert rows. Named after the app whose
 * behaviour they copy where it matters.
 */
export class FakeUser {
  constructor(private readonly fake: FakeDeviceProviders) {}

  private rc(id: number): StoredRow {
    const rc = this.fake.table('raw_contacts').get(id);
    if (!rc) throw new Error(`no raw contact ${id}`);
    return rc;
  }

  private dirtyContact(id: number): void {
    this.rc(id)[RawContacts.DIRTY] = 1;
  }

  /** A new contact from a Contacts app: no SOURCE_ID, DIRTY once data rows exist. */
  insertContact(accountName: string, rows: Row[]): number {
    const id = this.fake.allocId();
    this.fake.table('raw_contacts').set(id, {
      ...defaults(RAW_CONTACT_DEFAULTS),
      account_name: accountName,
      account_type: this.fake.accountType,
    });
    for (const row of rows) this.insertData(id, row);
    return id;
  }

  insertData(rawContactId: number, values: Row): number {
    const id = this.fake.allocId();
    const row: StoredRow = { ...values, [Data.RAW_CONTACT_ID]: rawContactId, [Data.DATA_VERSION]: 0 };
    this.fake.normalizeData(row);
    textifyData(row);
    this.fake.table('data').set(id, row);
    this.fake.bumpVersion(rawContactId);
    this.dirtyContact(rawContactId);
    return id;
  }

  /** AOSP Contacts: in-place update of the changed columns only (DATA_SYNC kept). */
  updateData(dataId: number, values: Row): void {
    const row = this.fake.table('data').get(dataId);
    if (!row) throw new Error(`no data row ${dataId}`);
    Object.assign(row, values);
    row[Data.DATA_VERSION] = Number(row[Data.DATA_VERSION] ?? 0) + 1;
    this.fake.normalizeData(row);
    textifyData(row);
    const rcId = Number(row[Data.RAW_CONTACT_ID]);
    this.fake.bumpVersion(rcId);
    this.dirtyContact(rcId);
  }

  deleteData(dataId: number): void {
    const row = this.fake.table('data').get(dataId);
    if (!row) return;
    const rcId = Number(row[Data.RAW_CONTACT_ID]);
    this.fake.table('data').delete(dataId);
    this.fake.bumpVersion(rcId);
    this.dirtyContact(rcId);
  }

  /**
   * Fossify Contacts' save: the name row is updated in place, the rows of
   * every other kind it models are deleted and `rows` inserted without
   * DATA_SYNC; relations and foreign kinds are left alone. Also stars through
   * the aggregate, which dirties the raw contact.
   */
  fossifySave(rawContactId: number, name: Row | null, rows: Row[]): void {
    const modeled = new Set<string>([
      MimeType.NICKNAME, MimeType.PHONE, MimeType.EMAIL, MimeType.STRUCTURED_POSTAL, MimeType.EVENT,
      MimeType.NOTE, MimeType.ORGANIZATION, MimeType.WEBSITE, MimeType.GROUP_MEMBERSHIP,
      'vnd.android.cursor.item/im',
    ]);
    for (const [id, row] of [...this.fake.table('data')]) {
      if (row[Data.RAW_CONTACT_ID] !== rawContactId) continue;
      if (name && row[Data.MIMETYPE] === MimeType.STRUCTURED_NAME) this.updateData(id, name);
      else if (modeled.has(String(row[Data.MIMETYPE]))) this.deleteData(id);
    }
    for (const row of rows) this.insertData(rawContactId, row);
    this.dirtyContact(rawContactId);
  }

  /** Soft delete: DELETED=1, DIRTY=1, rows kept until the sync adapter purges them. */
  deleteContact(rawContactId: number): void {
    const rc = this.rc(rawContactId);
    if (Number(rc[RawContacts.DELETED]) !== 1) this.fake.bumpVersion(rawContactId);
    rc[RawContacts.DELETED] = 1;
    rc[RawContacts.DIRTY] = 1;
  }

  /** Starring through the aggregate marks the raw contact dirty (any app, even a sync adapter). */
  star(rawContactId: number, starred = true): void {
    const rc = this.rc(rawContactId);
    rc[RawContacts.STARRED] = starred ? 1 : 0;
    rc[RawContacts.DIRTY] = 1;
  }

  /** A new photo from an editor: a new display photo file id on the photo row. */
  setPhoto(rawContactId: number, jpegBase64: string): void {
    const fileId = this.fake.storePhoto(jpegBase64);
    for (const [id, row] of this.fake.table('data')) {
      if (row[Data.RAW_CONTACT_ID] === rawContactId && row[Data.MIMETYPE] === MimeType.PHOTO) {
        this.updateData(id, { [Data.DATA14]: fileId, [Data.DATA15]: 'thumbnail' });
        return;
      }
    }
    this.insertData(rawContactId, { [Data.MIMETYPE]: MimeType.PHOTO, [Data.DATA14]: fileId, [Data.DATA15]: 'thumbnail' });
  }

  insertGroup(accountName: string, title: string): number {
    const id = this.fake.allocId();
    this.fake.table('groups').set(id, {
      ...defaults(GROUP_DEFAULTS),
      [Groups.TITLE]: title,
      [Groups.DIRTY]: 1,
      account_name: accountName,
      account_type: this.fake.accountType,
    });
    return id;
  }

  updateGroup(groupId: number, values: Row): void {
    const g = this.fake.table('groups').get(groupId);
    if (!g) throw new Error(`no group ${groupId}`);
    Object.assign(g, values, { [Groups.DIRTY]: 1 });
    g[Groups.VERSION] = Number(g[Groups.VERSION] ?? 1) + 1;
  }

  /** App delete: memberships go at once, the group stays DELETED=1 until purged. */
  deleteGroup(groupId: number): void {
    for (const [id, row] of [...this.fake.table('data')]) {
      if (row[Data.MIMETYPE] === MimeType.GROUP_MEMBERSHIP && Number(row[Data.DATA1]) === groupId) {
        this.fake.table('data').delete(id);
        this.fake.bumpVersion(Number(row[Data.RAW_CONTACT_ID]));
      }
    }
    const g = this.fake.table('groups').get(groupId);
    if (g) Object.assign(g, { [Groups.DELETED]: 1, [Groups.DIRTY]: 1 });
  }

  /** Fossify deletes groups through a sync-adapter URI: gone at once, no DELETED marker. */
  fossifyDeleteGroup(groupId: number): void {
    this.fake.deleteRow('groups', groupId);
  }

  addToGroup(rawContactId: number, groupId: number): number {
    return this.insertData(rawContactId, { [Data.MIMETYPE]: MimeType.GROUP_MEMBERSHIP, [Data.DATA1]: groupId });
  }

  // ── calendar ───────────────────────────────────────────

  private event(id: number): StoredRow {
    const e = this.fake.table('events').get(id);
    if (!e) throw new Error(`no event ${id}`);
    return e;
  }

  /** A new event from a calendar app: no _SYNC_ID, DIRTY=1, organizer defaults to the owner. */
  insertEvent(calendarId: number, values: Row, children: { attendees?: Row[]; reminders?: Row[] } = {}): number {
    const calendar = this.fake.table('calendars').get(calendarId);
    if (!calendar) throw new Error(`no calendar ${calendarId}`);
    const id = this.fake.allocId();
    const row: StoredRow = { ...defaults(EVENT_DEFAULTS), ...values, [Events.CALENDAR_ID]: calendarId };
    this.fake.fixEvent(row, true);
    if (isEmpty(row[Events.ORGANIZER])) row[Events.ORGANIZER] = calendar[Calendars.OWNER_ACCOUNT];
    this.fake.table('events').set(id, row);
    if (!isEmpty(row[Events.ORIGINAL_SYNC_ID]) && isEmpty(row[Events.ORIGINAL_ID])) {
      for (const [mid, m] of this.fake.table('events')) {
        if (mid !== id && m[Events._SYNC_ID] === row[Events.ORIGINAL_SYNC_ID]) row[Events.ORIGINAL_ID] = mid;
      }
    }
    for (const a of children.attendees ?? []) this.fake.table('attendees').set(this.fake.allocId(), { ...a, event_id: id });
    for (const r of children.reminders ?? []) this.fake.table('reminders').set(this.fake.allocId(), { ...r, event_id: id });
    this.fake.markEventDirty(id);
    return id;
  }

  updateEvent(eventId: number, values: Row): void {
    const e = this.event(eventId);
    if (Events.STATUS in values && values[Events.STATUS] === null) throw new Error('NullPointerException: eventStatus');
    Object.assign(e, values);
    this.fake.fixEvent(e, false);
    this.fake.markEventDirty(eventId);
  }

  /**
   * App delete: without _SYNC_ID the row (and its un-synced exceptions) is
   * gone at once; with one it becomes DELETED=1, DIRTY=1, its reminders and
   * extended properties go at once, un-synced exceptions are hard-deleted and
   * synced exceptions stay.
   */
  deleteEvent(eventId: number): void {
    const e = this.event(eventId);
    const syncId = e[Events._SYNC_ID];
    const exceptionsOf = () =>
      [...this.fake.table('events')].filter(([, x]) => Number(x[Events.ORIGINAL_ID]) === eventId);
    if (isEmpty(syncId)) {
      for (const [xid] of exceptionsOf()) this.fake.deleteRow('events', xid);
      this.fake.deleteRow('events', eventId);
      return;
    }
    for (const [xid, x] of exceptionsOf()) if (isEmpty(x[Events._SYNC_ID])) this.fake.deleteRow('events', xid);
    for (const child of ['reminders', 'extended_properties'] as const) {
      for (const [cid, c] of [...this.fake.table(child)]) if (c.event_id === eventId) this.fake.table(child).delete(cid);
    }
    e[Events.DELETED] = 1;
    this.fake.markEventDirty(eventId);
  }

  /** Etar "this event" edit: a new row with ORIGINAL_SYNC_ID and ORIGINAL_INSTANCE_TIME (no UID_2445). */
  insertException(masterId: number, originalInstanceTime: number, values: Row): number {
    const m = this.event(masterId);
    return this.insertEvent(Number(m[Events.CALENDAR_ID]), {
      [Events.TITLE]: m[Events.TITLE],
      [Events.EVENT_TIMEZONE]: m[Events.EVENT_TIMEZONE],
      [Events.ALL_DAY]: m[Events.ALL_DAY],
      [Events.STATUS]: m[Events.STATUS],
      ...values,
      [Events.ORIGINAL_SYNC_ID]: m[Events._SYNC_ID],
      [Events.ORIGINAL_ID]: masterId,
      [Events.ORIGINAL_INSTANCE_TIME]: originalInstanceTime,
      [Events.ORIGINAL_ALL_DAY]: m[Events.ALL_DAY],
    });
  }

  /** Etar/Fossify "delete this event": a cancelled exception row, no EXDATE. */
  cancelInstance(masterId: number, originalInstanceTime: number, instanceEnd: number): number {
    return this.insertException(masterId, originalInstanceTime, {
      [Events.STATUS]: 2,
      [Events.DTSTART]: originalInstanceTime,
      [Events.DTEND]: instanceEnd,
    });
  }

  /**
   * CONTENT_EXCEPTION_URI without RRULE: clones the master except _SYNC_ID and
   * SYNC_DATA*, copies attendees and reminders, marks only the exception dirty.
   */
  exceptionViaUri(masterId: number, originalInstanceTime: number, values: Row): number {
    const m = this.event(masterId);
    const clone: StoredRow = { ...m };
    for (const c of [Events._SYNC_ID, Events.SYNC_DATA1, Events.SYNC_DATA2, Events.SYNC_DATA3, Events.SYNC_DATA4, Events.SYNC_DATA5, Events.SYNC_DATA6]) clone[c] = null;
    for (const c of [Events.RRULE, Events.RDATE, Events.EXRULE, Events.EXDATE]) clone[c] = null;
    const duration = String(m[Events.DURATION] ?? 'P0S');
    const secs = Number(/(\d+)S$/.exec(duration)?.[1] ?? 0) + Number(/(\d+)D$/.exec(duration)?.[1] ?? 0) * 86_400;
    Object.assign(clone, {
      [Events.DTSTART]: originalInstanceTime,
      [Events.DTEND]: originalInstanceTime + secs * 1000,
      [Events.DURATION]: null,
      ...values,
      [Events.ORIGINAL_ID]: masterId,
      [Events.ORIGINAL_SYNC_ID]: m[Events._SYNC_ID],
      [Events.ORIGINAL_INSTANCE_TIME]: originalInstanceTime,
      [Events.ORIGINAL_ALL_DAY]: m[Events.ALL_DAY],
      [Events.DIRTY]: 1,
      [Events.DELETED]: 0,
    });
    delete clone[Events.SELF_ATTENDEE_STATUS];
    const id = this.fake.allocId();
    this.fake.table('events').set(id, clone);
    for (const child of ['attendees', 'reminders'] as const) {
      for (const c of [...this.fake.table(child).values()]) {
        if (c.event_id === masterId) this.fake.table(child).set(this.fake.allocId(), { ...c, event_id: id });
      }
    }
    const self = values[Events.SELF_ATTENDEE_STATUS];
    if (!isEmpty(self)) {
      const owner = this.fake.table('calendars').get(Number(m[Events.CALENDAR_ID]))?.[Calendars.OWNER_ACCOUNT];
      const mine = [...this.fake.table('attendees').values()].filter((a) => a.event_id === id && a[Attendees.ATTENDEE_EMAIL] === owner);
      if (mine.length !== 1) throw new Error('Status update WTF');
      mine[0][Attendees.ATTENDEE_STATUS] = self;
    }
    this.fake.markEventDirty(id);
    return id;
  }

  /**
   * CONTENT_EXCEPTION_URI with an RRULE ("this and following" split by a third
   * party): the master's rule gets UNTIL without DIRTY, and a clone INCLUDING
   * _SYNC_ID, SYNC_DATA* and UID_2445 is inserted.
   */
  splitViaUri(masterId: number, splitAt: number, untilUtc: string, values: Row): number {
    const m = this.event(masterId);
    m[Events.RRULE] = `${String(m[Events.RRULE]).replace(/;?(UNTIL|COUNT)=[^;]*/g, '')};UNTIL=${untilUtc}`;
    const id = this.fake.allocId();
    this.fake.table('events').set(id, { ...m, [Events.DTSTART]: splitAt, ...values, [Events.DIRTY]: 1 });
    this.fake.markEventDirty(id);
    return id;
  }

  /** Etar RSVP "all events": the attendee row's status, event DIRTY. */
  setAttendeeStatus(eventId: number, email: string, status: number): void {
    for (const a of this.fake.table('attendees').values()) {
      if (a.event_id === eventId && a[Attendees.ATTENDEE_EMAIL] === email) a[Attendees.ATTENDEE_STATUS] = status;
    }
    this.fake.markEventDirty(eventId);
  }

  addAttendee(eventId: number, values: Row): number {
    const id = this.fake.allocId();
    this.fake.table('attendees').set(id, { ...values, event_id: eventId });
    this.fake.markEventDirty(eventId);
    return id;
  }

  removeAttendee(attendeeId: number): void {
    const a = this.fake.table('attendees').get(attendeeId);
    if (!a) return;
    this.fake.table('attendees').delete(attendeeId);
    this.fake.markEventDirty(Number(a.event_id));
  }

  setReminders(eventId: number, reminders: Array<{ minutes: number; method?: number }>): void {
    for (const [id, r] of [...this.fake.table('reminders')]) if (r.event_id === eventId) this.fake.table('reminders').delete(id);
    for (const r of reminders) {
      this.fake.table('reminders').set(this.fake.allocId(), {
        event_id: eventId,
        [Reminders.MINUTES]: r.minutes,
        [Reminders.METHOD]: r.method ?? 1,
      });
    }
    this.fake.markEventDirty(eventId);
  }

  /** Fossify Calendar's save: the event row updated, attendees and reminders deleted and re-inserted. */
  fossifySaveEvent(eventId: number, values: Row, attendees: Row[], reminders: Array<{ minutes: number; method?: number }>): void {
    this.updateEvent(eventId, values);
    for (const [id, a] of [...this.fake.table('attendees')]) if (a.event_id === eventId) this.fake.table('attendees').delete(id);
    for (const a of attendees) this.fake.table('attendees').set(this.fake.allocId(), { ...a, event_id: eventId });
    this.setReminders(eventId, reminders);
  }

  /**
   * Etar's move to another calendar (EditEventHelper.saveEvent → moveEventToCalendar): a copy of the
   * event from its editor model is inserted there, then the event is deleted. The model leaves the
   * owner's own attendee row out (EditEventFragment: ATTENDEE_EMAIL equal to the calendar's
   * OWNER_ACCOUNT, ignoring case), so the copy gets every other attendee as a required attendee
   * without a status, and, when the owner had no row, the owner as its organizer. The reminders are
   * copied. (Exceptions Etar never synced, which it moves too on API 30+, are not modelled.)
   */
  etarMove(eventId: number, calendarId: number, changes: Row = {}): number {
    const old = this.event(eventId);
    const owner = String(this.fake.table('calendars').get(Number(old[Events.CALENDAR_ID]))?.[Calendars.OWNER_ACCOUNT] ?? '');
    const isOwner = (a: StoredRow) => String(a[Attendees.ATTENDEE_EMAIL] ?? '').toLowerCase() === owner.toLowerCase();
    const values: Row = {};
    for (const c of ETAR_COPY) if (old[c] !== undefined) values[c] = old[c];
    const rows = [...this.fake.table('attendees').values()].filter((a) => a.event_id === eventId);
    const others: Row[] = rows.filter((a) => !isOwner(a)).map((a) => ({
      [Attendees.ATTENDEE_NAME]: a[Attendees.ATTENDEE_NAME] ?? null,
      [Attendees.ATTENDEE_EMAIL]: a[Attendees.ATTENDEE_EMAIL],
      [Attendees.ATTENDEE_RELATIONSHIP]: AttendeeRelationship.ATTENDEE,
      [Attendees.ATTENDEE_TYPE]: AttendeeType.REQUIRED,
      [Attendees.ATTENDEE_STATUS]: AttendeeStatus.NONE,
    }));
    const organizer: Row[] = rows.some(isOwner) || !others.length ? [] : [{
      [Attendees.ATTENDEE_EMAIL]: owner,
      [Attendees.ATTENDEE_RELATIONSHIP]: AttendeeRelationship.ORGANIZER,
      [Attendees.ATTENDEE_TYPE]: AttendeeType.REQUIRED,
      [Attendees.ATTENDEE_STATUS]: AttendeeStatus.ACCEPTED,
    }];
    const reminders = [...this.fake.table('reminders').values()]
      .filter((r) => r.event_id === eventId)
      .map((r) => ({ [Reminders.MINUTES]: r[Reminders.MINUTES], [Reminders.METHOD]: r[Reminders.METHOD] }));
    const id = this.insertEvent(calendarId, { ...values, ...changes }, { attendees: [...organizer, ...others], reminders });
    this.deleteEvent(eventId);
    return id;
  }
}

/** The event columns Etar's editor model writes into the copy of an event it moves (getContentValuesFromModel). */
const ETAR_COPY = [
  Events.TITLE, Events.DESCRIPTION, Events.EVENT_LOCATION, Events.STATUS, Events.AVAILABILITY, Events.ACCESS_LEVEL,
  Events.EVENT_COLOR, Events.DTSTART, Events.DTEND, Events.DURATION, Events.EVENT_TIMEZONE, Events.ALL_DAY, Events.RRULE,
  Events.EXDATE,
];
