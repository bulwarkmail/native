/**
 * Contacts: address books ↔ raw contacts and groups of one Android account
 * (docs/device-sync.md, "Contacts mapping"). Group cards (`kind: "group"`)
 * are Groups rows and are always written before the contacts of the same
 * download, so memberships never name a group that does not exist yet.
 */
import { MimeType } from '../android-columns';
import { collectionKey, parseCollectionKey } from '../common/ids';
import { parseJsonColumn } from '../common/json';
import type {
  AddressBookLike,
  ContactCardWire,
  ContactsContext,
  ContactsPlanner,
  LocalContact,
  LocalGroup,
} from '../planner';
import { CONTACTS_AUTHORITY, type Row } from '../types';
import { ADDRESS_BOOK_PROPERTIES, CONTACT_CARD_PROPERTIES } from '../wire';
import type { Work } from './batch';
import type { RunEnv } from './context';
import { ItemSync, type Pending } from './item-sync';
import { accountOfRef, idInAccount, refOf, type Held, type Kind, type ServerObject } from './kinds';
import { poisonFingerprint } from './poison';
import { flag, num, str } from './provider';
import { isCollectionSelected } from './selection';
import { accountOf, type StateChange, type SyncState } from './sync-state';

/**
 * The context the engine hands the contacts planner. `groupsOf` is
 * not part of `ContactsContext` yet: memberships are stored on the group
 * cards (`members` holds member uids), so a contact's GroupMembership rows
 * need the reverse lookup.
 */
export interface ContactsRunContext extends ContactsContext {
  /** SOURCE_IDs of the group cards whose `members` include this uid. */
  groupsOf(uid: string): string[];
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? BASE64[n & 63] : '=';
  }
  return out;
}

/** Base64 of a `data:` URI's bytes, or null. */
export function dataUriBase64(uri: unknown): string | null {
  if (typeof uri !== 'string' || !/^data:/i.test(uri)) return null;
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const header = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  if (/;base64$/i.test(header)) return payload.replace(/\s+/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] === '%' && /^[0-9a-f]{2}$/i.test(payload.slice(i + 1, i + 3))) {
      bytes.push(parseInt(payload.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(payload.charCodeAt(i) & 0xff);
    }
  }
  return toBase64(Uint8Array.from(bytes));
}

/** The name a Relation row shows for a card. */
export function displayNameOf(card: Pick<ContactCardWire, 'name'> | null | undefined): string | null {
  const full = card?.name?.full;
  if (typeof full === 'string' && full.trim()) return full.trim();
  const parts = (card?.name?.components ?? [])
    .filter((c) => c && c.kind !== 'separator' && typeof c.value === 'string' && c.value.trim())
    .map((c) => (c.value as string).trim());
  return parts.length ? parts.join(' ') : null;
}

function onIds(map: Record<string, boolean> | undefined | null): string[] {
  return Object.entries(map ?? {})
    .filter(([, on]) => on === true)
    .map(([id]) => id);
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

export class ContactsSync extends ItemSync {
  protected readonly itemType = 'ContactCard' as const;
  protected readonly itemProperties = CONTACT_CARD_PROPERTIES;
  protected readonly parentFilter = 'inAddressBook' as const;
  protected readonly parentProperty = 'addressBookIds' as const;

  readonly contactKind: Kind<LocalContact, ContactCardWire>;
  readonly groupKind: Kind<LocalGroup, ContactCardWire>;
  private readonly planner: ContactsPlanner;
  private readonly rawColumns: string[];
  private readonly dataColumns: string[];
  private readonly groupColumns: string[];

  private readonly books = new Map<string, AddressBookLike[]>();
  private readonly syncedKeys = new Set<string>();
  private readonly collectionStates = new Map<string, string>();
  /** Group SOURCE_ID → Groups row id, and member uid → group SOURCE_IDs; rebuilt after group writes. */
  private readonly groupRows = new Map<string, number>();
  private readonly membership = new Map<string, Set<string>>();
  /** Group SOURCE_IDs whose cards are in read-only address books only: the device may not change their members. */
  private readonly readOnlyGroups = new Set<string>();
  private groupsStale = true;
  /** Per account: group refs that appeared (true) or went (false), for `SyncState.groups`. */
  private readonly groupChanges = new Map<string, Map<string, boolean>>();
  /** Per account: group refs listed in `groups` whose rows an app hard-deleted. */
  private absent = new Map<string, string[]>();
  private readonly blobPhotos = new Map<string, string | null>();
  private readonly devicePhotos = new Map<number, string | null>();
  private uidNames: Map<string, string> | null = null;
  private uidRefs: Map<string, string[]> | null = null;
  /** Per account: raw contacts the upload phases looked at, for their memberships. */
  private readonly uploadRows = new Map<string, Set<number>>();
  /** Group ref → ids of the contacts whose membership in it flips with the version being downloaded. */
  private readonly refreshes = new Map<string, string[]>();

  constructor(env: RunEnv) {
    super(env);
    this.planner = env.deps.planners.contacts;
    this.rawColumns = union(this.planner.rawContactColumns, ['_id']);
    this.dataColumns = union(this.planner.dataColumns, ['_id', 'raw_contact_id', 'mimetype']);
    this.groupColumns = union(this.planner.groupColumns, ['_id']);
    this.contactKind = this.makeContactKind();
    this.groupKind = this.makeGroupKind();
  }

  // ── Kinds ──

  private makeContactKind(): Kind<LocalContact, ContactCardWire> {
    const planner = this.planner;
    return {
      name: 'contact',
      table: 'raw_contacts',
      identityColumn: 'sourceid',
      poisonColumn: 'sync4',
      meta: (c) => ({
        rowId: c.rawContactId,
        sourceId: c.sourceId,
        pending: c.pending,
        dirty: c.dirty,
        deleted: c.deleted,
        isNew: !c.sourceId,
        poison: c.poison,
        // The card's books as last seen: SYNC1 lists only the selected ones, none for a card that left them all.
        collections: c.shadow ? this.cardKeys(accountOfRef(c.sourceId), c.shadow) : c.collections,
      }),
      fingerprint: (c) =>
        poisonFingerprint({
          deleted: c.deleted,
          shadow: c.shadow,
          rows: c.rows.map((r) => JSON.stringify([r.mimetype, r.cells])).sort(),
        }),
      loadByRefs: async (refs) => {
        const out = new Map<string, LocalContact>();
        for (const c of await this.loadContactsIn('sourceid', refs)) if (c.sourceId) out.set(c.sourceId, c);
        return out;
      },
      loadByRowIds: (ids) => this.loadContactsIn('_id', ids),
      loadNew: () => this.loadContactsWhere('sourceid IS NULL'),
      planDownload: (card, local, acct) => planner.planDownload(card, local, this.ctx(acct)),
      planLocalDelete: (c) => planner.planLocalDelete(c),
      planBaselineHeal: (c) => planner.planBaselineHeal(c),
      planUpload: (c, acct) => planner.planUpload(c, this.ctx(acct)),
      planAccepted: (c, card, acct) => planner.planAccepted(c, card, this.ctx(acct)),
      unclaimed: (c) => ({ ...c, pending: null }),
    };
  }

  private makeGroupKind(): Kind<LocalGroup, ContactCardWire> {
    const planner = this.planner;
    return {
      name: 'group',
      table: 'groups',
      identityColumn: 'sourceid',
      poisonColumn: 'sync4',
      meta: (g) => ({
        rowId: g.groupId,
        sourceId: g.sourceId,
        pending: g.pending,
        dirty: g.dirty,
        deleted: g.deleted,
        isNew: !g.sourceId,
        poison: g.poison,
        collections: this.cardKeys(accountOfRef(g.sourceId), g.shadow),
      }),
      fingerprint: (g) => poisonFingerprint({ deleted: g.deleted, title: g.title, shadow: g.shadow }),
      loadByRefs: async (refs) => {
        const out = new Map<string, LocalGroup>();
        for (const g of await this.loadGroupsIn('sourceid', refs)) if (g.sourceId) out.set(g.sourceId, g);
        return out;
      },
      loadByRowIds: (ids) => this.loadGroupsIn('_id', ids),
      loadNew: () => this.loadGroupsWhere('sourceid IS NULL'),
      planDownload: (card, local, acct) => planner.planGroupDownload(card, local, this.ctx(acct)),
      planLocalDelete: (g) => planner.planGroupLocalDelete(g),
      planBaselineHeal: () => null,
      planUpload: (g, acct) => planner.planGroupUpload(g, this.ctx(acct)),
      planAccepted: (g, card, acct) => planner.planGroupAccepted(g, card, this.ctx(acct)),
      unclaimed: (g) => ({ ...g, pending: null }),
    };
  }

  protected kinds(): Kind[] {
    return [this.groupKind, this.contactKind];
  }

  protected kindOf(object: ServerObject): Kind {
    return object.kind === 'group' ? this.groupKind : this.contactKind;
  }

  // ── Loading ──

  private async decodeContacts(rawRows: Row[]): Promise<LocalContact[]> {
    if (!rawRows.length) return [];
    const data = await this.env.reader.rowsIn('data', this.dataColumns, 'raw_contact_id', rawRows.map((r) => num(r._id)));
    const byContact = new Map<number, Row[]>();
    for (const row of data) {
      const id = num(row.raw_contact_id);
      let list = byContact.get(id);
      if (!list) byContact.set(id, (list = []));
      list.push(row);
    }
    return rawRows.map((rc) => this.planner.decodeContact(rc, byContact.get(num(rc._id)) ?? []));
  }

  private async loadContactsIn(column: '_id' | 'sourceid', values: ReadonlyArray<string | number>): Promise<LocalContact[]> {
    if (!values.length) return [];
    return this.decodeContacts(await this.env.reader.rowsIn('raw_contacts', this.rawColumns, column, values));
  }

  private async loadContactsWhere(where?: string, args?: Array<string | number>): Promise<LocalContact[]> {
    return this.decodeContacts(await this.env.reader.rows('raw_contacts', this.rawColumns, where, args));
  }

  private async loadGroupsIn(column: '_id' | 'sourceid', values: ReadonlyArray<string | number>): Promise<LocalGroup[]> {
    if (!values.length) return [];
    const rows = await this.env.reader.rowsIn('groups', this.groupColumns, column, values);
    return rows.map((r) => this.planner.decodeGroup(r));
  }

  private async loadGroupsWhere(where?: string, args?: Array<string | number>): Promise<LocalGroup[]> {
    const rows = await this.env.reader.rows('groups', this.groupColumns, where, args);
    return rows.map((r) => this.planner.decodeGroup(r));
  }

  /** Group rows by SOURCE_ID, who is a member of which group, and which groups are read-only, from the group cards' shadows. */
  private async refreshGroups(): Promise<void> {
    this.groupRows.clear();
    this.membership.clear();
    this.readOnlyGroups.clear();
    for (const group of await this.loadGroupsWhere()) {
      if (!group.sourceId || group.deleted) continue;
      this.groupRows.set(group.sourceId, group.groupId);
      if (this.inReadOnlyBooksOnly(accountOfRef(group.sourceId), group.shadow)) this.readOnlyGroups.add(group.sourceId);
      for (const uid of onIds(group.shadow?.members as Record<string, boolean> | undefined)) {
        let set = this.membership.get(uid);
        if (!set) this.membership.set(uid, (set = new Set()));
        set.add(group.sourceId);
      }
    }
    this.groupsStale = false;
  }

  // ── Collections ──

  private cardKeys(acct: string | null, card: Pick<ContactCardWire, 'addressBookIds'> | null | undefined): string[] {
    if (!acct || !card) return [];
    return onIds(card.addressBookIds).map((id) => collectionKey(acct, id));
  }

  private book(key: string): AddressBookLike | undefined {
    const parsed = parseCollectionKey(key);
    return parsed ? this.books.get(parsed.accountId)?.find((b) => b.id === parsed.id) : undefined;
  }

  private writable(key: string): boolean {
    const book = this.book(key);
    return !!book && book.myRights?.mayWrite !== false;
  }

  /** Whether the card is in address books, and only in ones that take no writes. */
  private inReadOnlyBooksOnly(acct: string | null, card: Pick<ContactCardWire, 'addressBookIds'> | null | undefined): boolean {
    const keys = this.cardKeys(acct, card);
    return keys.length > 0 && keys.every((k) => this.book(k)?.myRights?.mayWrite === false);
  }

  protected collectionGone(key: string): boolean {
    const parsed = parseCollectionKey(key);
    const books = parsed ? this.books.get(parsed.accountId) : undefined;
    return !!books && !books.some((b) => b.id === parsed!.id);
  }

  protected async collections(write: boolean): Promise<void> {
    this.syncedKeys.clear();
    for (const account of this.env.accounts) {
      const containers = await this.containersOf<AddressBookLike>('AddressBook', account.id, ADDRESS_BOOK_PROPERTIES);
      if (!containers) continue;
      const { list, state } = containers;
      this.books.set(account.id, list);
      for (const book of list) {
        if (isCollectionSelected(this.env.prefs.contactsSelection, account, CONTACTS_AUTHORITY, book)) {
          this.syncedKeys.add(collectionKey(account.id, book.id));
        }
      }
      if (state) {
        this.collectionStates.set(account.id, state);
        this.env.recordKnownState(account.id, 'AddressBook', state);
      }
    }
    if (write) await this.ensureSettingsRow();
  }

  /** One Settings row per account with UNGROUPED_VISIBLE=1: the default 0 hides every contact without a visible group. */
  private async ensureSettingsRow(): Promise<void> {
    const rows = await this.env.reader.rows('settings', ['ungrouped_visible', 'should_sync']);
    const values = { ungrouped_visible: 1, should_sync: 1 };
    if (!rows.length) {
      await this.env.writer.write([{ group: { ref: 'settings', ops: [{ op: 'insert', table: 'settings', values }] } }]);
    } else if (rows.some((r) => num(r.ungrouped_visible) !== 1 || num(r.should_sync) !== 1)) {
      await this.env.writer.write([{ group: { ref: 'settings', ops: [{ op: 'update', table: 'settings', values }] } }]);
    }
  }

  protected syncedCollections(acct: string): string[] {
    return (this.books.get(acct) ?? [])
      .filter((b) => this.syncedKeys.has(collectionKey(acct, b.id)))
      .map((b) => b.id);
  }

  protected inSelection(acct: string, object: ServerObject): boolean {
    return this.cardKeys(acct, object as ContactCardWire).some((k) => this.syncedKeys.has(k));
  }

  /**
   * Where a contact created on the device goes: the chosen book when it
   * syncs and is writable, else the personal account's default (or first)
   * synced writable book; null when there is none.
   */
  createTarget(): string | null {
    const chosen = this.env.prefs.newContactsAddressBook;
    if (chosen && this.syncedKeys.has(chosen) && this.writable(chosen)) return chosen;
    const primary = this.env.accounts.find((a) => a.primary) ?? this.env.accounts[0];
    if (!primary) return null;
    const books = [...(this.books.get(primary.id) ?? [])].sort(
      (a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id),
    );
    const book = books.find((b) => {
      const key = collectionKey(primary.id, b.id);
      return this.syncedKeys.has(key) && this.writable(key);
    });
    return book ? collectionKey(primary.id, book.id) : null;
  }

  private photoBytes(entry: { uri?: string; blobId?: string }): string | null {
    if (entry.blobId) return this.blobPhotos.get(entry.blobId) ?? null;
    return dataUriBase64(entry.uri);
  }

  ctx(acct: string): ContactsRunContext {
    const env = this.env;
    return {
      jmapAccountId: acct,
      now: env.now(),
      mintKey: (taken) => env.mintKey(taken),
      mintUid: () => env.mintUid(),
      selectedCollections: (card) => this.cardKeys(acct, card).filter((k) => this.syncedKeys.has(k)),
      isReadOnly: (card) => this.inReadOnlyBooksOnly(acct, card),
      isSelected: (key) => this.syncedKeys.has(key),
      createTarget: () => this.createTarget(),
      photoBytes: (entry) => this.photoBytes(entry),
      devicePhoto: (rawContactId) => this.devicePhotos.get(rawContactId) ?? null,
      nameForUid: (uid) => this.uidNames?.get(uid) ?? null,
      groupRowIdBySourceId: (sourceId) => this.groupRows.get(sourceId) ?? null,
      groupsOf: (uid) => [...(this.membership.get(uid) ?? [])],
      groupReadOnly: (sourceId) => this.readOnlyGroups.has(sourceId),
    };
  }

  // ── Downloads ──

  /**
   * Group cards first: a membership naming an unknown group makes the
   * provider create an empty one. Memberships live on the group cards, so
   * when a group's `members` changed, its old and new members come along in
   * the same download (before its state op): their GroupMembership rows
   * change although their own cards did not.
   */
  protected async order(acct: string, ids: string[]): Promise<{ first: string[]; rest: string[]; missing: string[] }> {
    if (!ids.length) return { first: [], rest: [], missing: [] };
    const { list, notFound } = await this.env.jmap.get<{ id: string; kind?: string; members?: Record<string, boolean> }>(
      'ContactCard',
      acct,
      ids,
      ['id', 'kind', 'members'],
    );
    const groups = list.filter((c) => c.kind === 'group');
    const groupIds = new Set(groups.map((c) => c.id));
    const found = new Set(list.map((c) => c.id));
    const rest = ids.filter((id) => found.has(id) && !groupIds.has(id));
    const members = (await this.membersToRefresh(acct, groups)).filter((id) => !groupIds.has(id));
    return {
      first: ids.filter((id) => groupIds.has(id)),
      rest: members.length ? [...new Set([...rest, ...members])].sort() : rest,
      missing: notFound,
    };
  }

  /**
   * Contacts of `acct` whose membership in one of these group cards flipped
   * since the group's shadow; kept per group for `dependents`.
   */
  private async membersToRefresh(acct: string, groups: Array<{ id: string; members?: Record<string, boolean> }>): Promise<string[]> {
    if (!groups.length) return [];
    const locals = await this.groupKind.loadByRefs(groups.map((g) => refOf(acct, g.id)));
    const flippedBy = new Map<string, Set<string>>();
    for (const group of groups) {
      const ref = refOf(acct, group.id);
      const before = new Set(onIds(locals.get(ref)?.shadow?.members as Record<string, boolean> | undefined));
      const after = new Set(onIds(group.members));
      const flipped = new Set([...before].filter((uid) => !after.has(uid)).concat([...after].filter((uid) => !before.has(uid))));
      this.refreshes.delete(ref);
      if (flipped.size) flippedBy.set(ref, flipped);
    }
    if (!flippedBy.size) return [];
    await this.ensureShadowIndex();
    const out = new Set<string>();
    for (const [ref, flipped] of flippedBy) {
      const ids: string[] = [];
      for (const uid of flipped) {
        for (const member of this.uidRefs?.get(uid) ?? []) {
          const id = idInAccount(member, acct);
          if (id) ids.push(id);
        }
      }
      this.refreshes.set(ref, ids);
      for (const id of ids) out.add(id);
    }
    return [...out];
  }

  /** The members a group card gained or lost: refreshed in this page, or first thing next run. */
  protected dependents(kind: Kind, acct: string, object: ServerObject): string[] {
    return kind === this.groupKind ? this.refreshes.get(refOf(acct, object.id)) ?? [] : [];
  }

  protected async beforePlanning(acct: string, objects: ServerObject[]): Promise<void> {
    const cards = objects as ContactCardWire[];
    if (this.groupsStale && cards.some((c) => c.kind !== 'group')) await this.refreshGroups();
    for (const card of cards) {
      const photo = Object.values(card.media ?? {}).find((m) => m?.kind === 'photo') as
        | { blobId?: string; mediaType?: string }
        | undefined;
      if (!photo?.blobId || this.blobPhotos.has(photo.blobId)) continue;
      try {
        this.blobPhotos.set(photo.blobId, toBase64(await this.env.jmap.downloadBlob(acct, photo.blobId, photo.mediaType)));
      } catch (error) {
        this.env.log('photo download failed', error);
        this.blobPhotos.set(photo.blobId, null);
      }
    }
    if (cards.some((c) => Object.keys(c.relatedTo ?? {}).length > 0)) await this.ensureShadowIndex();
    for (const card of cards) this.indexCard(acct, card);
  }

  private indexCard(acct: string, card: ContactCardWire & { id?: string }): void {
    if (!this.uidNames || !this.uidRefs || typeof card.uid !== 'string' || card.kind === 'group') return;
    const name = displayNameOf(card);
    if (name) this.uidNames.set(card.uid, name);
    if (card.id) {
      const ref = refOf(acct, card.id);
      const refs = this.uidRefs.get(card.uid) ?? [];
      if (!refs.includes(ref)) this.uidRefs.set(card.uid, [...refs, ref]);
    }
  }

  /**
   * The synced cards by uid (their names for Relation rows, their rows for
   * membership changes), read from the shadows on first need and kept up to
   * date with every card downloaded afterwards.
   */
  private async ensureShadowIndex(): Promise<void> {
    if (this.uidNames && this.uidRefs) return;
    const names = new Map<string, string>();
    const refs = new Map<string, string[]>();
    for (const row of await this.env.reader.rows('raw_contacts', ['sourceid', 'sync2'], 'sourceid IS NOT NULL')) {
      const shadow = parseJsonColumn<ContactCardWire>(row.sync2);
      const ref = str(row.sourceid);
      if (!shadow || typeof shadow.uid !== 'string' || !ref) continue;
      const name = displayNameOf(shadow);
      if (name) names.set(shadow.uid, name);
      refs.set(shadow.uid, [...(refs.get(shadow.uid) ?? []), ref]);
    }
    this.uidNames = names;
    this.uidRefs = refs;
  }

  protected adoptionTargetMatches(acct: string, object: ServerObject, target: string): boolean {
    return this.cardKeys(acct, object as ContactCardWire).includes(target);
  }

  protected lookupScope(_acct: string, collectionId: string): string | null {
    // Card uids are unique per address book.
    return collectionId;
  }

  private groupChange(acct: string, ref: string, present: boolean): void {
    let changes = this.groupChanges.get(acct);
    if (!changes) this.groupChanges.set(acct, (changes = new Map()));
    changes.set(ref, present);
    this.groupsStale = true;
  }

  protected onDownloaded(kind: Kind, acct: string, object: ServerObject): void {
    if (kind === this.groupKind) this.groupChange(acct, refOf(acct, object.id), true);
    else this.indexCard(acct, object as ContactCardWire);
  }

  /** A group whose row is there already is listed too: the batch that listed it may never have been stored. */
  protected onEcho(kind: Kind, acct: string, object: ServerObject): void {
    const ref = refOf(acct, object.id);
    if (kind === this.groupKind && !(this.env.store.account(acct).groups ?? []).includes(ref)) this.groupChange(acct, ref, true);
  }

  protected onRemoved(kind: Kind, acct: string, id: string): void {
    if (kind === this.groupKind) this.groupChange(acct, refOf(acct, id), false);
  }

  /** `groups` names a group row from the batch that inserts it until the batch that deletes it. */
  protected listing(kind: Kind, acct: string, id: string, present: boolean): StateChange | undefined {
    if (kind !== this.groupKind) return undefined;
    const ref = refOf(acct, id);
    return (next) => {
      const account = accountOf(next, acct);
      const groups = new Set(account.groups ?? []);
      if (present) groups.add(ref);
      else groups.delete(ref);
      account.groups = [...groups];
    };
  }

  protected onAccepted(kind: Kind, acct: string, server: ServerObject): void {
    if (kind === this.groupKind) this.groupChange(acct, refOf(acct, server.id), true);
    else this.indexCard(acct, server as ContactCardWire);
  }

  protected decorateState(acct: string, next: SyncState): () => void {
    const account = accountOf(next, acct);
    const changes = this.groupChanges.get(acct);
    const consumed = new Map(changes ?? []);
    if (consumed.size || account.groups === undefined) {
      const groups = new Set(account.groups ?? []);
      for (const [ref, present] of consumed) {
        if (present) groups.add(ref);
        else groups.delete(ref);
      }
      account.groups = [...groups];
    }
    const collections = this.collectionStates.get(acct);
    if (collections) account.collectionsState = collections;
    return () => {
      for (const [ref, present] of consumed) if (changes?.get(ref) === present) changes.delete(ref);
    };
  }

  protected async localIdentities(acct: string): Promise<Map<string, { dirty: boolean; deleted: boolean }>> {
    const out = new Map<string, { dirty: boolean; deleted: boolean }>();
    for (const table of ['groups', 'raw_contacts'] as const) {
      for (const row of await this.env.reader.rows(table, ['_id', 'sourceid', 'dirty', 'deleted'], 'sourceid LIKE ?', [`${acct}/%`])) {
        const id = idInAccount(str(row.sourceid), acct);
        if (id) out.set(id, { dirty: flag(row.dirty), deleted: flag(row.deleted) });
      }
    }
    return out;
  }

  // ── Uploads ──

  protected async loadUploadItems(): Promise<Held[]> {
    const groups = await this.loadGroupsWhere('dirty = 1 OR deleted = 1 OR sourceid IS NULL');
    const contacts = await this.loadContactsWhere('dirty = 1 OR deleted = 1 OR sourceid IS NULL');
    return [
      ...groups.map((local) => ({ kind: this.groupKind as Kind, local })),
      ...contacts.map((local) => ({ kind: this.contactKind as Kind, local })),
    ];
  }

  protected claimAccount(): string | null {
    const target = this.createTarget();
    return accountOfRef(target) ?? this.env.accounts.find((a) => a.primary)?.id ?? this.env.accounts[0]?.id ?? null;
  }

  protected noteUploadItems(acct: string, items: Held[]): void {
    let rows = this.uploadRows.get(acct);
    if (!rows) this.uploadRows.set(acct, (rows = new Set()));
    for (const held of items) if (held.kind === this.contactKind) rows.add(held.kind.meta(held.local).rowId);
  }

  /**
   * The group index `groupsOf` answers from (a run that downloaded no
   * contact never read it: every removal from a group would look done), and
   * the device photo of every contact about to be planned that has a photo
   * row (JPEG, ≤ 512 px).
   */
  protected async beforeUploadPlanning(items: Held[]): Promise<void> {
    if (this.groupsStale && items.some((held) => held.kind === this.contactKind)) await this.refreshGroups();
    for (const held of items) {
      if (held.kind !== this.contactKind) continue;
      const contact = held.local as LocalContact;
      if (this.devicePhotos.has(contact.rawContactId) || !contact.rows.some((r) => r.mimetype === MimeType.PHOTO)) continue;
      try {
        const photo = await this.env.reader.port.readPhoto(contact.rawContactId, 512);
        this.devicePhotos.set(contact.rawContactId, photo?.jpegBase64 ?? null);
      } catch (error) {
        this.env.log('photo read failed', error);
        this.devicePhotos.set(contact.rawContactId, null);
      }
    }
  }

  /** Group refs the SyncState lists whose rows are gone: an app hard-deleted them (Fossify does). */
  private async absentGroups(): Promise<Map<string, string[]>> {
    const present = new Set<string>();
    for (const row of await this.env.reader.rows('groups', ['sourceid'], 'sourceid IS NOT NULL')) {
      const ref = str(row.sourceid);
      if (ref) present.add(ref);
    }
    const out = new Map<string, string[]>();
    for (const [acct, account] of Object.entries(this.env.store.committed.accounts)) {
      const changes = this.groupChanges.get(acct);
      const refs = (account.groups ?? []).filter((ref) => !present.has(ref) && changes?.get(ref) !== false);
      if (refs.length) out.set(acct, refs);
    }
    return out;
  }

  protected async countDeletions(items: Held[]): Promise<{ count: number; synced: number; accounts: Set<string> }> {
    let count = 0;
    const accounts = new Set<string>();
    for (const held of items) {
      const meta = held.kind.meta(held.local);
      if (!meta.deleted || !meta.sourceId) continue;
      count++;
      const acct = accountOfRef(meta.sourceId);
      if (acct) accounts.add(acct);
    }
    this.absent = await this.absentGroups();
    for (const [acct, refs] of this.absent) {
      count += refs.length;
      accounts.add(acct);
    }
    const synced =
      (await this.env.reader.rows('raw_contacts', ['_id'], 'sourceid IS NOT NULL')).length +
      (await this.env.reader.rows('groups', ['_id'], 'sourceid IS NOT NULL')).length;
    return { count, synced: Math.max(synced, count), accounts };
  }

  protected onDiscard(next: SyncState, accounts: Set<string>): void {
    for (const acct of accounts) {
      const gone = new Set(this.absent.get(acct) ?? []);
      if (!gone.size) continue;
      const account = accountOf(next, acct);
      account.groups = (account.groups ?? []).filter((ref) => !gone.has(ref));
    }
    this.absent = new Map();
  }

  protected async extraPhase(acct: string, deletionsAllowed: boolean): Promise<void> {
    if (deletionsAllowed) await this.deleteAbsentGroups(acct);
    await this.uploadMemberships(acct);
  }

  /**
   * A group hard-deleted on the device: destroyed on the server, or, when
   * it is also in address books that do not sync, removed from the synced
   * ones only. A card that is no longer a group, or in no book that syncs,
   * is not what the device showed: it is only forgotten.
   */
  private async deleteAbsentGroups(acct: string): Promise<void> {
    const refs = (this.absent.get(acct) ?? []).filter((ref) => this.groupChanges.get(acct)?.get(ref) !== false);
    if (!refs.length) return;
    await this.env.checkpoints.check('upload:groups');
    const ids = refs.map((ref) => idInAccount(ref, acct)).filter((id): id is string => !!id);
    const { list, notFound } = await this.env.jmap.get<ContactCardWire & { id: string }>('ContactCard', acct, ids, ['id', 'addressBookIds', 'kind']);
    for (const id of notFound) this.groupChange(acct, refOf(acct, id), false);
    const update: Record<string, Record<string, unknown>> = {};
    const destroy: string[] = [];
    for (const card of list) {
      const books = onIds(card.addressBookIds);
      const synced = books.filter((id) => this.syncedKeys.has(collectionKey(acct, id)));
      if (card.kind !== 'group' || !synced.length) {
        this.groupChange(acct, refOf(acct, card.id), false);
      } else if (synced.length < books.length) {
        update[card.id] = Object.fromEntries(synced.map((id) => [`addressBookIds/${id}`, null]));
      } else {
        destroy.push(card.id);
      }
    }
    if (!destroy.length && !Object.keys(update).length) return;
    const { response } = await this.setChecked(acct, { update, destroy });
    const done = [...(response.destroyed ?? []), ...Object.keys(response.updated ?? {})];
    for (const id of done) {
      this.groupChange(acct, refOf(acct, id), false);
      this.env.report.stats.uploaded.deleted++;
    }
    for (const [id, error] of [...Object.entries(response.notDestroyed ?? {}), ...Object.entries(response.notUpdated ?? {})]) {
      if (error?.type === 'notFound') this.groupChange(acct, refOf(acct, id), false);
      else this.env.report.itemError({ ref: refOf(acct, id), side: 'upload', type: error?.type ?? 'serverFail', description: error?.description });
    }
  }

  /** Memberships edited on the device become patches of the group cards' `members`. */
  private async uploadMemberships(acct: string): Promise<void> {
    const rows = [...(this.uploadRows.get(acct) ?? [])];
    if (!rows.length) return;
    await this.env.checkpoints.check('upload:memberships');
    const contacts = (await this.contactKind.loadByRowIds(rows)).filter((c) => !c.deleted);
    const groups = (await this.loadGroupsWhere('sourceid LIKE ?', [`${acct}/%`])).filter(
      (g) => accountOfRef(g.sourceId) === acct && !g.deleted,
    );
    const actions = this.planner.planMembershipUploads(contacts, groups, this.ctx(acct));
    if (!actions.length) return;
    const byGroup = new Map<string, Pending>();
    for (const action of actions) {
      const id = action.kind === 'create' ? null : action.id;
      const group = id ? groups.find((g) => g.sourceId === refOf(acct, id)) : undefined;
      if (!group) {
        this.env.report.itemError({ ref: id ? refOf(acct, id) : 'membership', side: 'upload', type: 'unknownGroup' });
        continue;
      }
      if (this.isStale(acct, group.sourceId)) {
        // Its shadow is behind the server: members built from it could undo server changes. The contact stays dirty.
        this.env.report.itemError({ ref: group.sourceId as string, side: 'upload', type: 'stale', description: 'Waits until the server version could be stored' });
        continue;
      }
      let pending = byGroup.get(group.sourceId as string);
      if (!pending) {
        const held: Held = { kind: this.groupKind, local: group };
        pending = { held, meta: this.groupKind.meta(group), fingerprint: this.groupKind.fingerprint(group), actions: [] };
        byGroup.set(group.sourceId as string, pending);
      }
      pending.actions.push(action as Pending['actions'][number]);
    }
    if (!byGroup.size) return;
    await this.send(acct, [...byGroup.values()]);
    await this.cleanAfterMemberships(acct, rows);
  }

  /**
   * A contact stays dirty until the group cards show its membership edits.
   * Those that now have nothing else to upload are cleaned right away, so
   * nothing looks like it still waits (turning sync off would ask about it).
   */
  private async cleanAfterMemberships(acct: string, rowIds: number[]): Promise<void> {
    await this.refreshGroups();
    const works: Work[] = [];
    for (const contact of await this.contactKind.loadByRowIds(rowIds)) {
      if (!contact.dirty || contact.deleted || this.isStale(acct, contact.sourceId)) continue;
      let plan;
      try {
        plan = this.contactKind.planUpload(contact, acct);
      } catch (error) {
        this.plannerFailed(acct, contact.sourceId ?? `row:${contact.rawContactId}`, 'upload', error);
        continue;
      }
      if (plan.kind === 'clean') works.push({ group: plan.ops });
    }
    await this.env.writer.write(works);
  }

  // ── Deselection ──

  /**
   * After the upload: rows of contacts in no synced address book go, when
   * clean (a deselected book, or a card moved away on the server). Dirty
   * ones stay until their upload succeeds, and keep their book `partial`,
   * so the next run drops it again. A book is `partial` from before its
   * first dropped row until the last: a stop half-way leaves it to load
   * again when it is selected again, or to drop again when it is not.
   */
  protected async dropOutsideSelection(acct: string): Promise<void> {
    const synced = new Set(this.syncedCollections(acct).map((id) => collectionKey(acct, id)));
    const committed = this.env.store.account(acct);
    const deselected = [...new Set([...committed.selected, ...(committed.partial ?? [])])].filter((key) => !synced.has(key));
    const outside = [...(this.outside.get(acct) ?? [])];
    if (!deselected.length && !outside.length) return;

    const kept = new Set<string>();
    const consider = (held: Held, works: Work[]) => {
      const meta = held.kind.meta(held.local);
      const id = idInAccount(meta.sourceId, acct);
      // Rows whose collections are unknown are never dropped.
      if (!id || !meta.collections.length || meta.collections.some((k) => synced.has(k))) return;
      const work = this.removeWork(acct, id, held, 'outside');
      if (work) works.push(work);
      else for (const key of meta.collections) if (deselected.includes(key)) kept.add(key);
    };
    if (deselected.length) {
      await this.env.writer.write([], this.tail([acct], (next) => {
        const a = accountOf(next, acct);
        a.selected = a.selected.filter((key) => !deselected.includes(key));
        a.partial = [...new Set([...(a.partial ?? []), ...deselected])];
      }));
      const groupWorks: Work[] = [];
      for (const group of await this.loadGroupsWhere('sourceid LIKE ?', [`${acct}/%`])) consider({ kind: this.groupKind, local: group }, groupWorks);
      await this.env.writer.write(groupWorks);
      const rows = await this.env.reader.rows('raw_contacts', ['_id', 'sourceid'], 'sourceid LIKE ?', [`${acct}/%`]);
      const ids = rows.filter((r) => accountOfRef(str(r.sourceid)) === acct).map((r) => num(r._id));
      for (let i = 0; i < ids.length; i += this.env.tuning.chunkSize) {
        await this.env.checkpoints.check('deselect');
        const works: Work[] = [];
        for (const contact of await this.contactKind.loadByRowIds(ids.slice(i, i + this.env.tuning.chunkSize))) {
          consider({ kind: this.contactKind, local: contact }, works);
        }
        await this.env.writer.write(works);
      }
      // Every synced book was loaded before this pass; a book still holding a dirty item stays partial.
      await this.env.writer.write([], this.tail([acct], (next) => {
        const a = accountOf(next, acct);
        a.selected = [...synced];
        a.partial = [...kept];
      }));
    } else {
      const works: Work[] = [];
      for (const kind of this.kinds()) {
        for (const local of (await kind.loadByRefs(outside)).values()) consider({ kind, local }, works);
      }
      await this.env.writer.write(works);
    }
    this.outside.delete(acct);
  }
}
