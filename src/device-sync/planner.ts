/**
 * The contract between the sync engine (src/device-sync/engine, which owns all
 * I/O: provider queries and batches, JMAP requests, retries, state) and the
 * two mappers (src/device-sync/contacts and src/device-sync/calendar, which
 * are pure planners). docs/device-sync.md describes the rules both follow.
 *
 * A planner never performs I/O. The engine queries rows with the planner's
 * column lists, hands them to `decode*`, asks for a plan, and applies the
 * plan's op groups. Every op group is applied atomically; asserts come first
 * in a group, so a group whose rows changed since they were read fails as a
 * whole and the engine re-reads and re-plans that item.
 *
 * `refs` inside a group's ops are indexes into THAT group; the engine rebases
 * them when it packs several groups into one batch, and marks the first op of
 * each group `yieldAllowed`.
 */
import type { AddressBookLike, CalendarLike, ContactCardWire, CalendarEventWire } from './wire';
import type { ProviderOp, ReminderOwner, Row } from './types';
import type { PatchObject } from './common/patch';

// ─── Shared ────────────────────────────────────────────

/** Ops for one item, applied atomically, asserts first. */
export interface OpGroup {
  /** For logs and reports: SOURCE_ID/_SYNC_ID or `row:<_id>`. */
  ref: string;
  ops: ProviderOp[];
  /**
   * Further groups of the same item, for one too big for a provider
   * transaction (a big meeting): the engine applies `[this, ...next]` in
   * order, each atomically in a batch of its own, and counts the item once
   * the last one is in. When one fails, the item is read and planned again
   * from what the earlier ones wrote, so a planner orders them for that: a
   * new row's identity first, a master's shadow last. They have no `next`.
   */
  next?: OpGroup[];
}

/** Why an item is left alone, with the fingerprint that lifts the back-off when the item changes. */
export interface PoisonMarker {
  /** Fingerprint of what failed (the patch, or the row projection). */
  fp: string;
  /** SetError type or engine code (`dstAmbiguous`, `ruleNotRepresentable`, …). */
  type: string;
  description?: string;
  /** Attempts so far. */
  n: number;
  /** Epoch ms before which the item is not retried unless `fp` changes. */
  until: number;
}

/** A create claimed on the device: the uid and the collection it goes to, fixed at the claim. */
export interface PendingCreate {
  uid: string;
  /** `<jmapAccountId>/<collectionId>`. */
  target: string;
}

export interface MapContext {
  /** JMAP account of the object (the personal one or a shared one). */
  jmapAccountId: string;
  now: number;
  /** New map keys: `b` + 8 base36 characters, never one of `taken`. */
  mintKey(taken?: Iterable<string>): string;
  /** A new uid for a device-created object. */
  mintUid(): string;
}

/**
 * One server write an upload plan asks for. The engine batches them into
 * `/set` calls per JMAP account, adds `ifInState`, and reports each result
 * back through `planAccepted` / the SetError handling in the engine.
 */
export type UploadAction<TObj> =
  /** Create `object` (which carries `uid`) in `collectionId`, after looking the uid up. */
  | { kind: 'create'; uid: string; collectionId: string; object: Partial<TObj>; sendSchedulingMessages?: boolean }
  /** Patch the object; never empty. */
  | { kind: 'update'; id: string; patch: PatchObject; sendSchedulingMessages?: boolean }
  /** Destroy the object (`id`), or whatever carries `uid` when the create's outcome is unknown. */
  | { kind: 'destroy'; id: string | null; uid: string | null; sendSchedulingMessages?: boolean };

/**
 * What to do with a dirty, new or deleted local item.
 * - `clean`: nothing mapped changed (only STARRED, say): apply `ops` (they clear DIRTY behind an assert).
 * - `claim`: a new item without a pending uid: apply `ops` (they write the uid), then re-read and plan again.
 * - `upload`: send `actions`; `local` is what they were computed from.
 * - `purge`: a deleted item that never reached the server: apply `ops`.
 * - `revert`: the item may not be changed on the server (read-only): apply `ops` (rewrite from the shadow);
 *   `reason`, set when a device change is put back, goes to the report.
 * - `skip`: poisoned and backed off, or not representable; `reason` goes to the report.
 */
export type UploadPlan<TObj> =
  | { kind: 'clean'; ops: OpGroup }
  | { kind: 'claim'; ops: OpGroup }
  | { kind: 'upload'; actions: UploadAction<TObj>[] }
  | { kind: 'purge'; ops: OpGroup }
  | { kind: 'revert'; ops: OpGroup; refetch?: boolean; reason?: string }
  | { kind: 'skip'; reason: string };

export interface DownloadPlan {
  ops: OpGroup;
  /** Units where both sides changed differently; the server won each. */
  conflicts: number;
  /** Local changes that survived the merge and still need an upload. */
  stillDirty: boolean;
  /** `none` when rows already match (an echo): the engine then writes nothing. */
  effect: 'insert' | 'update' | 'none';
  /** Rows this plan inserts, updates or deletes; reported as progress only when applied. */
  writes: number;
}

/**
 * After the server accepted an upload (the engine re-fetched `server`):
 * - `ops` write identity, shadow and baselines and clear DIRTY, behind the
 *   same assert the upload was read under (VERSION / projection);
 * - `keepDirtyOps` are applied instead when that assert fails (edited again
 *   meanwhile): identity, shadow, and the baselines of the uploaded units set
 *   to the values that were uploaded; rows and DIRTY untouched.
 */
export interface AcceptedPlan {
  ops: OpGroup;
  keepDirtyOps: OpGroup;
}

// ─── Contacts ──────────────────────────────────────────

export interface LocalDataRow {
  id: number;
  mimetype: string;
  /** The row's mapped cells (data1..data14, is_primary, group_sourceid), as read. */
  cells: Row;
  /** DATA_SYNC1: entry key(s), a hint only (Fossify drops it). */
  key: string | null;
  /** DATA_SYNC2: photo hash. */
  photoHash: string | null;
  /** DATA_SYNC3 decoded: the mapped cells as stored after our last write. */
  baseline: Row | null;
}

export interface LocalContact {
  rawContactId: number;
  /** `<jmapAccountId>/<cardId>`, null until created on the server. */
  sourceId: string | null;
  version: number;
  dirty: boolean;
  deleted: boolean;
  /** SYNC1: collection keys. */
  collections: string[];
  /** SYNC2: the last server card, photos reduced to hashes. */
  shadow: ContactCardWire | null;
  /** SYNC3. */
  pending: PendingCreate | null;
  /** SYNC4. */
  poison: PoisonMarker | null;
  rows: LocalDataRow[];
}

export interface LocalGroup {
  groupId: number;
  sourceId: string | null;
  version: number;
  dirty: boolean;
  deleted: boolean;
  title: string | null;
  shadow: ContactCardWire | null;
  pending: PendingCreate | null;
  poison: PoisonMarker | null;
}

export interface ContactsContext extends MapContext {
  /** Selected collection keys this card is in (`<jmapAccountId>/<addressBookId>`). */
  selectedCollections(card: ContactCardWire): string[];
  /** True when none of the card's address books grants `mayWrite`. */
  isReadOnly(card: ContactCardWire): boolean;
  /** Whether a collection key is selected for sync on this device. */
  isSelected(collectionKey: string): boolean;
  /**
   * Where a contact created on the device goes, fixed at its claim: the chosen
   * book when it is selected and writable, else the first selected writable
   * book of the personal account; null when there is none (the item is poisoned).
   */
  createTarget(): string | null;
  /** Base64 bytes of a photo `media` entry; blob-backed ones are fetched by the engine beforehand. */
  photoBytes(entry: { uri?: string; blobId?: string; mediaType?: string }): string | null;
  /**
   * The device's photo of a raw contact as a JPEG (longer side ≤ 512 px, base64), read by the engine
   * beforehand for every dirty contact that has a photo row; null when there is none.
   */
  devicePhoto(rawContactId: number): string | null;
  /** Display name of a card with this uid among the synced ones (Relation names). */
  nameForUid(uid: string): string | null;
  /** Group rows by SOURCE_ID, for memberships. */
  groupRowIdBySourceId(sourceId: string): number | null;
  /**
   * SOURCE_IDs of the synced group cards whose `members` list this uid: the
   * server keeps memberships on the group cards, so a contact's
   * GroupMembership rows need the reverse lookup. The engine always provides
   * it; without it the planner leaves memberships as they are.
   */
  groupsOf?(uid: string): string[];
  /**
   * Whether a synced group card (by SOURCE_ID) is in read-only address books
   * only, so the device may not change its members. The engine provides it
   * from the group rows' shadows; without it every group counts as writable.
   */
  groupReadOnly?(sourceId: string): boolean;
}

export interface ContactsPlanner {
  readonly rawContactColumns: readonly string[];
  readonly dataColumns: readonly string[];
  readonly groupColumns: readonly string[];
  decodeContact(rawContact: Row, data: Row[]): LocalContact;
  decodeGroup(group: Row): LocalGroup;

  /**
   * A server individual/org card into a new, clean or dirty local contact. A
   * local item without identity whose pending uid is the card's uid (our own
   * create whose identity was never written) is adopted: identity and shadow
   * are written, DIRTY stays, local changes are merged.
   */
  planDownload(card: ContactCardWire, local: LocalContact | null, ctx: ContactsContext): DownloadPlan;
  /** The server destroyed the card, or it left every selected address book. */
  planLocalDelete(local: LocalContact): OpGroup;
  /** A clean contact whose rows drifted from their baselines (provider normalisation): rewrite the baselines. */
  planBaselineHeal(local: LocalContact): OpGroup | null;
  planUpload(local: LocalContact, ctx: ContactsContext): UploadPlan<ContactCardWire>;
  planAccepted(local: LocalContact, server: ContactCardWire, ctx: ContactsContext): AcceptedPlan;

  /** Group cards (`kind: "group"`) ↔ Groups rows. */
  planGroupDownload(card: ContactCardWire, local: LocalGroup | null, ctx: ContactsContext): DownloadPlan;
  planGroupLocalDelete(local: LocalGroup): OpGroup;
  planGroupUpload(local: LocalGroup, ctx: ContactsContext): UploadPlan<ContactCardWire>;
  planGroupAccepted(local: LocalGroup, server: ContactCardWire, ctx: ContactsContext): AcceptedPlan;
  /**
   * Membership edits made on the device (GroupMembership rows of dirty
   * contacts against the group cards' `members`) as patches of group cards.
   * Called after contacts were uploaded, so new contacts have their uid.
   */
  planMembershipUploads(contacts: LocalContact[], groups: LocalGroup[], ctx: ContactsContext): UploadAction<ContactCardWire>[];
}

// ─── Calendar ──────────────────────────────────────────

export interface LocalAttendee {
  id: number;
  cells: Row;
}

export interface LocalReminder {
  id: number;
  cells: Row;
}

/** Baseline of an event row: its mapped columns, attendees and reminders as stored (SYNC_DATA4). */
export interface EventBaseline {
  cells: Row;
  attendees: Row[];
  reminders: Row[];
}

export interface LocalEventRow {
  eventId: number;
  calendarRowId: number;
  /** `_SYNC_ID`: `<acct>/<id>`, `<acct>/<id>#<rid>` (exception), `~pending/<uid>`, or null. */
  syncId: string | null;
  dirty: boolean;
  deleted: boolean;
  /** The mapped event columns as read (title, dtstart, rrule, status, …). */
  cells: Row;
  attendees: LocalAttendee[];
  reminders: LocalReminder[];
  baseline: EventBaseline | null;
  /** SYNC_DATA3. */
  pending: PendingCreate | null;
  /** SYNC_DATA5. */
  poison: PoisonMarker | null;
  /** Events.MUTATORS: packages that changed the row since our last write (lossy editors, see the design). */
  mutators: string | null;
}

export interface LocalException extends LocalEventRow {
  /** SYNC_DATA2 (our rows), else derived from ORIGINAL_INSTANCE_TIME by the planner. */
  recurrenceId: string | null;
  originalInstanceTime: number | null;
}

export interface LocalEvent extends LocalEventRow {
  /** SYNC_DATA1: the last server event, with its overrides. */
  shadow: CalendarEventWire | null;
  /** Rows whose ORIGINAL_SYNC_ID / ORIGINAL_ID point at this master. */
  exceptions: LocalException[];
  /**
   * Set by `decodeEvents` when another master shares this `_SYNC_ID` (a
   * CONTENT_EXCEPTION_URI split): `clone` on the newer row, which uploads as a
   * new event; `source` on the older one, whose rule uploads as it stands.
   */
  split?: 'clone' | 'source';
}

export interface LocalCalendar {
  calendarRowId: number;
  /** `<acct>/<calendarId>`. */
  syncId: string | null;
  cells: Row;
  /** CAL_SYNC2 (CAL_SYNC1 stays unused: CalendarProvider sends it as a sync extra). */
  shadow: CalendarLike | null;
  /** CAL_SYNC3. */
  flags: { readOnly?: 'rights' | 'subscription'; taskOnly?: boolean } | null;
}

export interface CalendarContext extends MapContext {
  /** The device zone floating events are written in. */
  deviceZone: string;
  /** `OWNER_ACCOUNT` of our calendars: the user's main calendar address, lowercase, no `mailto:`. */
  ownerAccount: string;
  /** Every address of the user ("me"), lowercase, no `mailto:`. */
  selfAddresses: string[];
  reminderOwner: ReminderOwner;
  /** Server calendars by id (for default alerts and rights). */
  calendar(calendarId: string): CalendarLike | undefined;
  /** Android calendar row of a server calendar of `jmapAccountId`, if synced. */
  calendarRowId(calendarId: string): number | null;
  /** Server calendar id of an Android calendar row, if it is one of ours. */
  calendarIdOfRow(calendarRowId: number): { jmapAccountId: string; calendarId: string } | null;
  /** Read-only on the device: no write rights, or a subscribed iCal feed. */
  isReadOnly(calendarId: string): boolean;
  /** Whether a collection key is selected for sync on this device. */
  isSelected(collectionKey: string): boolean;
}

export interface CalendarPlanner {
  readonly calendarColumns: readonly string[];
  readonly eventColumns: readonly string[];
  readonly attendeeColumns: readonly string[];
  readonly reminderColumns: readonly string[];
  decodeCalendar(row: Row): LocalCalendar;
  /** Groups exception rows under their masters; orphan exceptions come back as masters with `deleted` untouched. */
  decodeEvents(events: Row[], attendees: Row[], reminders: Row[]): LocalEvent[];

  /**
   * Calendar rows for the selected server calendars: inserts, updates (name,
   * colour, access, reminders allowed), deletes for deselected ones. The
   * engine uploads dirty events of calendars to be deleted first.
   */
  planCalendars(
    selected: Array<{ jmapAccountId: string; calendar: CalendarLike; readOnly: boolean; accountName: string }>,
    local: LocalCalendar[],
    ctx: Omit<CalendarContext, 'jmapAccountId'>,
  ): { groups: OpGroup[]; deleteCalendarRows: number[] };

  /** A server event (never a Task) into a new, clean or dirty local event with its exceptions; adopts a pending local event by uid like the contacts planner. */
  planDownload(event: CalendarEventWire, local: LocalEvent | null, ctx: CalendarContext): DownloadPlan;
  /** Deletes the master and its exception rows (a sync-adapter delete does not cascade). */
  planLocalDelete(local: LocalEvent): OpGroup;
  planBaselineHeal(local: LocalEvent): OpGroup | null;
  /**
   * May return several actions. For a "this and following" split, the
   * source's plan is the rule patch plus its pruned overrides; the new series
   * is a row of its own and goes through claim and create by itself.
   */
  planUpload(local: LocalEvent, ctx: CalendarContext): UploadPlan<CalendarEventWire>;
  planAccepted(local: LocalEvent, server: CalendarEventWire, ctx: CalendarContext): AcceptedPlan;
  /**
   * Deleted and new masters of one run that are one edit (Etar moves an event
   * to another calendar, or turns a series into a single event, by deleting
   * and re-inserting it): each pair uploads as a patch of the existing object;
   * `ops` move the identity and exceptions to the new row and purge the old one
   * once the patch is accepted.
   */
  planPairs(
    deleted: LocalEvent[],
    fresh: LocalEvent[],
    ctx: CalendarContext,
  ): Array<{ deleted: LocalEvent; fresh: LocalEvent; actions: UploadAction<CalendarEventWire>[]; ops: OpGroup }>;
  /** Floating events of a clean master re-written after the device zone changed. */
  planZoneChange(local: LocalEvent, previousZone: string, ctx: CalendarContext): OpGroup | null;
  /** Reminder rows re-written after the reminder owner changed (no server writes). */
  planReminderOwnerChange(local: LocalEvent, ctx: CalendarContext): OpGroup | null;
}

/** Re-exported so engine code imports one module. */
export type { AddressBookLike, CalendarLike, ContactCardWire, CalendarEventWire };
