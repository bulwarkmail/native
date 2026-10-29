/**
 * Test rig for the contacts planner: the fake device providers, the fake
 * Stalwart, and a ContactsContext wired between them. Plans are applied the
 * way the engine applies them (one op group per batch); uploads go through
 * the fake server's patch handling and come back through its normalisation.
 */
import { GroupMembership, Groups, RawContacts } from '../../android-columns';
import { makeKeyMinter, parseObjectRef, uuidFrom } from '../../common/ids';
import { contactsPlanner } from '../../contacts/planner';
import type {
  ContactCardWire,
  ContactsContext,
  LocalContact,
  LocalGroup,
  OpGroup,
  UploadAction,
  UploadPlan,
} from '../../planner';
import { CONTACTS_AUTHORITY, type BatchResult, type ProviderPort, type Row } from '../../types';
import { FakeJmapServer } from '../fakes/fake-jmap-server';
import { FakeDeviceProviders } from '../fakes/fake-provider';

export const ACCOUNT = 'usera@example.org';
export const JMAP = 'c';

export function seeded(seed = 7): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

function rowsOf(res: { columns: string[]; rows: unknown[][] }): Row[] {
  return res.rows.map((cells) => Object.fromEntries(res.columns.map((c, i) => [c, cells[i]])) as Row);
}

export class Harness {
  readonly device = new FakeDeviceProviders();
  readonly port: ProviderPort = this.device.port(ACCOUNT, CONTACTS_AUTHORITY);
  readonly server = new FakeJmapServer();
  readonly book: string;
  readonly planner = contactsPlanner;
  /** Base64 of blob-backed photos by blobId, and the device photo per raw contact. */
  readonly blobs = new Map<string, string>();
  readonly devicePhotos = new Map<number, string>();
  readonly names = new Map<string, string>();
  readonly readOnlyBooks = new Set<string>();
  readonly unselected = new Set<string>();
  /** When false the context has no `groupsOf` (memberships not synced). */
  groupIndex = true;
  readonly ctx: ContactsContext;

  constructor() {
    this.server.addAccount(JMAP, { name: ACCOUNT });
    this.book = this.server.addAddressBook(JMAP, { name: 'Personal' });
    const random = seeded();
    const mintKey = makeKeyMinter(random);
    const self = this;
    this.ctx = {
      jmapAccountId: JMAP,
      now: 1_800_000_000_000,
      mintKey,
      mintUid: () => `urn:uuid:${uuidFrom(random)}`,
      selectedCollections: (card) =>
        Object.keys(card.addressBookIds ?? {}).map((id) => `${JMAP}/${id}`).filter((k) => !self.unselected.has(k)),
      isReadOnly: (card) => Object.keys(card.addressBookIds ?? {}).every((id) => self.readOnlyBooks.has(id)),
      isSelected: (key) => !self.unselected.has(key),
      createTarget: () => `${JMAP}/${self.book}`,
      photoBytes: (entry) => (entry.blobId ? self.blobs.get(entry.blobId) ?? null : null),
      devicePhoto: (id) => self.devicePhotos.get(id) ?? null,
      nameForUid: (uid) => self.names.get(uid) ?? null,
      groupRowIdBySourceId: (sourceId) => {
        const row = self.device.rows('groups', 'sourceid = ?', [sourceId])[0];
        return row ? Number(row[Groups._ID]) : null;
      },
      groupsOf(uid: string) {
        return self.server
          .all('ContactCard', JMAP)
          .filter((c) => c.kind === 'group' && (c.members as Record<string, boolean> | undefined)?.[uid] === true)
          .map((c) => `${JMAP}/${c.id as string}`);
      },
      groupReadOnly(sourceId: string) {
        const ref = parseObjectRef(sourceId);
        const card = ref ? self.server.get('ContactCard', ref.accountId, ref.id) : undefined;
        const books = Object.keys((card?.addressBookIds as Record<string, boolean> | undefined) ?? {});
        return books.length > 0 && books.every((id) => self.readOnlyBooks.has(id));
      },
    };
  }

  /** The context as the engine may build it without a group index. */
  context(): ContactsContext {
    if (this.groupIndex) return this.ctx;
    const { groupsOf: _drop, ...rest } = this.ctx;
    return rest as ContactsContext;
  }

  async apply(group: OpGroup): Promise<BatchResult> {
    if (!group.ops.length) return { ok: true, results: [] };
    return this.port.applyBatch(group.ops);
  }

  async applyOk(group: OpGroup): Promise<void> {
    const res = await this.apply(group);
    if (!res.ok) throw new Error(`batch failed: ${res.reason} ${res.message}`);
  }

  async contacts(): Promise<LocalContact[]> {
    const raw = rowsOf(await this.port.query({ table: 'raw_contacts', columns: [...this.planner.rawContactColumns] }));
    const data = rowsOf(await this.port.query({ table: 'data', columns: [...this.planner.dataColumns] }));
    return raw.map((r) => this.planner.decodeContact(r, data.filter((d) => d.raw_contact_id === r._id)));
  }

  async contact(rawContactId: number): Promise<LocalContact> {
    const found = (await this.contacts()).find((c) => c.rawContactId === rawContactId);
    if (!found) throw new Error(`no raw contact ${rawContactId}`);
    return found;
  }

  async bySource(cardId: string): Promise<LocalContact | null> {
    return (await this.contacts()).find((c) => c.sourceId === `${JMAP}/${cardId}`) ?? null;
  }

  async groups(): Promise<LocalGroup[]> {
    const rows = rowsOf(await this.port.query({ table: 'groups', columns: [...this.planner.groupColumns] }));
    return rows.map((r) => this.planner.decodeGroup(r));
  }

  card(id: string): ContactCardWire {
    const card = this.server.get('ContactCard', JMAP, id);
    if (!card) throw new Error(`no card ${id}`);
    return card as ContactCardWire;
  }

  addCard(card: Record<string, unknown>): string {
    return this.server.addCard(JMAP, { addressBookIds: { [this.book]: true }, ...card });
  }

  /** Downloads a server card into its local contact (or a new one); returns the raw contact id. */
  async download(cardId: string): Promise<number> {
    const card = this.card(cardId);
    const local = await this.bySource(cardId);
    const plan = card.kind === 'group'
      ? this.planner.planGroupDownload(card, (await this.groups()).find((g) => g.sourceId === `${JMAP}/${cardId}`) ?? null, this.context())
      : this.planner.planDownload(card, local, this.context());
    await this.applyOk(plan.ops);
    if (card.kind === 'group') return -1;
    const after = await this.bySource(cardId);
    if (!after) throw new Error('download wrote no contact');
    const heal = this.planner.planBaselineHeal(after);
    if (heal) await this.applyOk(heal);
    return after.rawContactId;
  }

  /** A card on the server and on the device, clean. */
  async seed(card: Record<string, unknown>): Promise<{ id: string; rawId: number }> {
    const id = this.addCard(card);
    return { id, rawId: await this.download(id) };
  }

  /** Sends upload actions to the fake server the way the engine would; returns the touched card id. */
  send(actions: UploadAction<ContactCardWire>[]): string | null {
    let touched: string | null = null;
    for (const a of actions) {
      if (a.kind === 'update') {
        this.server.serverUpdate('ContactCard', JMAP, a.id, a.patch);
        touched = a.id;
      } else if (a.kind === 'create') {
        touched = this.server.addCard(JMAP, a.object as Record<string, unknown>);
      } else if (a.id) {
        this.server.serverDestroy('ContactCard', JMAP, a.id);
      }
    }
    return touched;
  }

  /** Plans an upload for a contact, claiming it first when it is new. */
  async planUpload(rawContactId: number): Promise<UploadPlan<ContactCardWire>> {
    let plan = this.planner.planUpload(await this.contact(rawContactId), this.context());
    if (plan.kind === 'claim') {
      await this.applyOk(plan.ops);
      plan = this.planner.planUpload(await this.contact(rawContactId), this.context());
    }
    return plan;
  }

  /**
   * One upload round for a contact: plan, send, re-read the card, apply the
   * accepted plan (or its keep-dirty fallback). Returns the plan.
   */
  async upload(rawContactId: number, between?: () => void): Promise<UploadPlan<ContactCardWire>> {
    const plan = await this.planUpload(rawContactId);
    const local = await this.contact(rawContactId);
    if (plan.kind === 'upload') {
      const touched = this.send(plan.actions);
      between?.();
      if (local.deleted) {
        const accepted = this.planner.planAccepted(local, {} as ContactCardWire, this.context());
        await this.applyOk(accepted.ops);
        return plan;
      }
      const server = this.card(touched!);
      const accepted = this.planner.planAccepted(local, server, this.context());
      const res = await this.apply(accepted.ops);
      if (!res.ok) await this.applyOk(accepted.keepDirtyOps);
    } else if (plan.kind !== 'skip') {
      between?.();
      await this.applyOk(plan.ops);
    }
    return plan;
  }

  cardIdOf(local: LocalContact): string {
    return parseObjectRef(local.sourceId)!.id;
  }

  /** Data rows of a raw contact as the provider holds them, keyed by DATA_SYNC1 (or `row:<id>`). */
  rowsByKey(rawContactId: number): Record<string, Row> {
    const out: Record<string, Row> = {};
    for (const r of this.device.rows('data', 'raw_contact_id = ?', [rawContactId])) {
      out[(r.data_sync1 as string | null) ?? `row:${r._id}`] = r;
    }
    return out;
  }

  rawContact(rawContactId: number): Row {
    return this.device.row('raw_contacts', rawContactId)!;
  }

  dirty(rawContactId: number): boolean {
    return Number(this.rawContact(rawContactId)[RawContacts.DIRTY]) === 1;
  }

  membershipGroups(rawContactId: number): string[] {
    return this.device
      .rows('data', 'raw_contact_id = ? AND mimetype = ?', [rawContactId, 'vnd.android.cursor.item/group_membership'])
      .map((r) => r[GroupMembership.GROUP_SOURCE_ID] as string)
      .sort();
  }
}
