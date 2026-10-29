/**
 * A card as the data rows the device should hold for it: one `Unit` per row,
 * with its DATA_SYNC1 key, its mapped cells and whatever else the write needs
 * (docs/device-sync.md, "Contacts mapping"). Units are what changes are
 * detected, merged and uploaded by.
 */
import type {
  ContactAddress,
  ContactAnniversary,
  ContactEmail,
  ContactLink,
  ContactNickname,
  ContactNote,
  ContactOrganization,
  ContactPhone,
  ContactRelation,
  ContactTitle,
} from '../../api/types';
import { partialDateToString } from '../../lib/contact-utils';
import {
  CommonKind,
  Data,
  GroupMembership,
  MimeType,
  NicknameType,
  Organization as Org,
  StructuredPostal as SP,
} from '../android-columns';
import { canonicalJson } from '../common/json';
import type { ContactCardWire, ContactsContext } from '../planner';
import type { Row, WriteRow } from '../types';
import { cellText, text } from './cells';
import { NAME_KEY, entryKey, orgKey } from './keys';
import { NAME_COLUMNS, nameCells, nameMatches, predictStoredName } from './name';
import { photoEntry, photoPayload } from './photo';
import { POSTAL_PART_COLUMNS, postalCells, predictStoredPostal } from './postal';
import { emailType, eventType, phoneType, postalType, relationType, websiteType } from './types-map';

/** The group SOURCE_IDs the rows' memberships were written from, kept in the shadow (see `memberOf`). */
export const MEMBER_OF = '~memberOf';

export interface KindSpec {
  mimetype: string;
  /** Mapped columns: recorded in the baseline, compared for changes. */
  columns: readonly string[];
  /** Columns a row matched by value may upload when non-empty and different (not TYPE/LABEL/IS_PRIMARY). */
  valueColumns: readonly string[];
  /** Whether a row matched by value uploads its TYPE/LABEL too (phones, emails, addresses, events). */
  typed: boolean;
  /** Value-match key of a row; null when the row has nothing to match by. */
  primary(cells: Row): string | null;
  /** Editors that re-insert rows (Fossify) rewrite this kind on every save. */
  rewritten: boolean;
  /** Missing rows of this kind are always deletions: no editor re-inserts it. */
  inPlaceOnly?: boolean;
}

const low = (v: unknown) => text(v)?.trim().toLowerCase() ?? null;
const squash = (v: unknown) => low(v)?.replace(/[\s,]+/g, ' ').trim() || null;

const TYPED = [CommonKind.TYPE, CommonKind.LABEL];

export const SPECS: Record<string, KindSpec> = {
  [MimeType.STRUCTURED_NAME]: {
    mimetype: MimeType.STRUCTURED_NAME, columns: NAME_COLUMNS, valueColumns: NAME_COLUMNS, typed: false,
    primary: () => NAME_KEY, rewritten: false,
  },
  [MimeType.NICKNAME]: {
    mimetype: MimeType.NICKNAME, columns: [Data.DATA1], valueColumns: [Data.DATA1], typed: false,
    primary: (c) => low(c[Data.DATA1]), rewritten: true,
  },
  [MimeType.EMAIL]: {
    mimetype: MimeType.EMAIL, columns: [Data.DATA1, ...TYPED, Data.IS_PRIMARY], valueColumns: [Data.DATA1], typed: true,
    primary: (c) => low(c[Data.DATA1]), rewritten: true,
  },
  [MimeType.PHONE]: {
    mimetype: MimeType.PHONE, columns: [Data.DATA1, ...TYPED, Data.IS_PRIMARY], valueColumns: [Data.DATA1], typed: true,
    primary: (c) => {
      const digits = text(c[Data.DATA1])?.replace(/\D/g, '');
      return digits || low(c[Data.DATA1]);
    },
    rewritten: true,
  },
  [MimeType.STRUCTURED_POSTAL]: {
    mimetype: MimeType.STRUCTURED_POSTAL,
    columns: [SP.FORMATTED_ADDRESS, ...TYPED, ...POSTAL_PART_COLUMNS],
    valueColumns: [SP.FORMATTED_ADDRESS, ...POSTAL_PART_COLUMNS],
    typed: true,
    primary: (c) => squash(c[SP.FORMATTED_ADDRESS]) ?? squash(POSTAL_PART_COLUMNS.map((k) => text(c[k])).filter(Boolean).join(' ')),
    rewritten: true,
  },
  [MimeType.ORGANIZATION]: {
    mimetype: MimeType.ORGANIZATION,
    columns: [Org.COMPANY, Org.TITLE, Org.DEPARTMENT, Org.JOB_DESCRIPTION],
    valueColumns: [Org.COMPANY, Org.TITLE, Org.DEPARTMENT, Org.JOB_DESCRIPTION],
    typed: false,
    primary: (c) => low(c[Org.COMPANY]) ?? low(c[Org.TITLE]) ?? low(c[Org.JOB_DESCRIPTION]),
    rewritten: true,
  },
  [MimeType.WEBSITE]: {
    mimetype: MimeType.WEBSITE, columns: [Data.DATA1, ...TYPED], valueColumns: [Data.DATA1], typed: false,
    primary: (c) => low(c[Data.DATA1])?.replace(/\/+$/, '') ?? null, rewritten: true,
  },
  [MimeType.EVENT]: {
    mimetype: MimeType.EVENT, columns: [Data.DATA1, ...TYPED], valueColumns: [Data.DATA1], typed: true,
    primary: (c) => (text(c[Data.DATA1]) ? `${text(c[Data.DATA1])!.trim()}|${cellText(c[Data.DATA2]) ?? ''}` : null),
    rewritten: true,
  },
  [MimeType.RELATION]: {
    mimetype: MimeType.RELATION, columns: [Data.DATA1, ...TYPED], valueColumns: [Data.DATA1], typed: false,
    primary: (c) => low(c[Data.DATA1]), rewritten: false,
  },
  [MimeType.NOTE]: {
    mimetype: MimeType.NOTE, columns: [Data.DATA1], valueColumns: [Data.DATA1], typed: false,
    primary: (c) => text(c[Data.DATA1])?.trim() ?? null, rewritten: true,
  },
  [MimeType.PHOTO]: {
    mimetype: MimeType.PHOTO, columns: [Data.DATA14], valueColumns: [], typed: false,
    primary: () => 'photo', rewritten: false, inPlaceOnly: true,
  },
  [MimeType.GROUP_MEMBERSHIP]: {
    mimetype: MimeType.GROUP_MEMBERSHIP, columns: [GroupMembership.GROUP_SOURCE_ID], valueColumns: [], typed: false,
    primary: (c) => text(c[GroupMembership.GROUP_SOURCE_ID]), rewritten: true,
  },
};

/** Kinds in the order rows are written and compared. */
export const KIND_ORDER = [
  MimeType.STRUCTURED_NAME, MimeType.NICKNAME, MimeType.EMAIL, MimeType.PHONE, MimeType.STRUCTURED_POSTAL,
  MimeType.ORGANIZATION, MimeType.WEBSITE, MimeType.EVENT, MimeType.RELATION, MimeType.NOTE, MimeType.PHOTO,
  MimeType.GROUP_MEMBERSHIP,
];

/** One data row the card calls for. */
export interface Unit {
  mimetype: string;
  /** DATA_SYNC1. */
  key: string;
  /** The mapped cells, as written. */
  cells: Row;
  /** Written but not mapped: a nickname's TYPE, photo bytes, a membership's group row id. */
  extra?: WriteRow;
  /** Photos: the hash of the server photo (DATA_SYNC2); unknown when its bytes are not at hand. */
  photoHash?: string;
  /** Canonical JSON of the card entries the row comes from, for key reconciliation. */
  source: string;
  /** Columns cut to the provider's limit: the device never held all of them, so they never upload. */
  truncated?: string[];
}

export interface ProjectOptions {
  /** Group SOURCE_IDs whose `members` hold the card's uid; null leaves memberships alone. */
  memberOf: string[] | null;
}

const entries = <T>(map: unknown): Array<[string, T]> =>
  map && typeof map === 'object' && !Array.isArray(map)
    ? Object.entries(map as Record<string, T>).filter(([, v]) => v && typeof v === 'object')
    : [];

/** ContactsProvider cuts text columns to 10 KiB and phone numbers to 1000 characters, and keeps the cut. */
const MAX_TEXT = 10 * 1024;
const MAX_NUMBER = 1000;

function unit(mimetype: string, key: string, cells: Row, source: unknown, extra?: WriteRow): Unit {
  const out: Unit = { mimetype, key, cells, extra, source: canonicalJson(source) };
  for (const [column, value] of Object.entries(cells)) {
    const max = mimetype === MimeType.PHONE && column === Data.DATA1 ? MAX_NUMBER : MAX_TEXT;
    if (typeof value === 'string' && value.length > max) {
      cells[column] = value.slice(0, max);
      (out.truncated ??= []).push(column);
    }
  }
  return out;
}

/** The first entry of a pref-ordered map that is preferred (`pref: 1`) marks IS_PRIMARY. */
function primaryKey<T extends { pref?: number }>(list: Array<[string, T]>): string | null {
  return list.find(([, e]) => e.pref === 1)?.[0] ?? null;
}

function organizationUnits(card: ContactCardWire): Unit[] {
  const orgs = entries<ContactOrganization>(card.organizations);
  const titles = entries<ContactTitle>(card.titles).filter(([, t]) => text(t.name));
  const used = new Set<string>();
  const pick = (org: string | null, role: boolean) => {
    const hit = titles.find(([k, t]) => !used.has(k) && (t.organizationId ?? null) === org && (t.kind === 'role') === role);
    if (hit) used.add(hit[0]);
    return hit ?? null;
  };
  const out: Unit[] = [];
  const push = (org: [string, ContactOrganization] | null, title: [string, ContactTitle] | null, role: [string, ContactTitle] | null) => {
    const units = Array.isArray(org?.[1].units)
      ? org![1].units!.map((u) => text(u?.name)).filter(Boolean).join(', ')
      : null;
    const cells: Row = {
      [Org.COMPANY]: text(org?.[1].name),
      [Org.TITLE]: text(title?.[1].name),
      [Org.DEPARTMENT]: text(units),
      [Org.JOB_DESCRIPTION]: text(role?.[1].name),
    };
    if (Object.values(cells).every((v) => v === null)) return;
    const key = orgKey({ org: org?.[0] ?? null, title: title?.[0] ?? null, role: role?.[0] ?? null });
    out.push(unit(MimeType.ORGANIZATION, key, cells, [org?.[1] ?? null, title?.[1] ?? null, role?.[1] ?? null]));
  };
  for (const org of orgs) {
    const orgId = org[0];
    push(org, pick(orgId, false), pick(orgId, true));
  }
  // Titles of no (or an unknown) organization get rows of their own.
  for (const t of titles) {
    if (used.has(t[0])) continue;
    used.add(t[0]);
    if (t[1].kind === 'role') push(null, null, t);
    else push(null, t, null);
  }
  return out;
}

/** Every data row a card maps to, in `KIND_ORDER`. */
export function projectCard(card: ContactCardWire, ctx: Pick<ContactsContext, 'nameForUid' | 'photoBytes' | 'groupRowIdBySourceId'>, options: ProjectOptions): Unit[] {
  const out: Unit[] = [];
  const name = nameCells(card.name);
  if (name) out.push(unit(MimeType.STRUCTURED_NAME, NAME_KEY, name, card.name));

  for (const [k, e] of entries<ContactNickname>(card.nicknames)) {
    if (!text(e.name)) continue;
    out.push(unit(MimeType.NICKNAME, entryKey('nicknames', k), { [Data.DATA1]: text(e.name) }, e, { [Data.DATA2]: NicknameType.DEFAULT }));
  }

  const emails = entries<ContactEmail>(card.emails).filter(([, e]) => text(e.address));
  const primaryEmail = primaryKey(emails);
  for (const [k, e] of emails) {
    const t = emailType(e);
    out.push(unit(MimeType.EMAIL, entryKey('emails', k), {
      [Data.DATA1]: text(e.address), [Data.DATA2]: t.type, [Data.DATA3]: t.label, [Data.IS_PRIMARY]: k === primaryEmail ? 1 : 0,
    }, e));
  }

  const phones = entries<ContactPhone>(card.phones).filter(([, e]) => text(e.number));
  const primaryPhone = primaryKey(phones);
  for (const [k, e] of phones) {
    const t = phoneType(e);
    out.push(unit(MimeType.PHONE, entryKey('phones', k), {
      [Data.DATA1]: text(e.number), [Data.DATA2]: t.type, [Data.DATA3]: t.label, [Data.IS_PRIMARY]: k === primaryPhone ? 1 : 0,
    }, e));
  }

  for (const [k, e] of entries<ContactAddress>(card.addresses)) {
    const cells = postalCells(e);
    if (Object.values(cells).every((v) => v === null)) continue;
    const t = postalType(e);
    out.push(unit(MimeType.STRUCTURED_POSTAL, entryKey('addresses', k), { ...cells, [SP.TYPE]: t.type, [SP.LABEL]: t.label }, e));
  }

  out.push(...organizationUnits(card));

  for (const [k, e] of entries<ContactLink>(card.links)) {
    if (!text(e.uri)) continue;
    const t = websiteType(e);
    out.push(unit(MimeType.WEBSITE, entryKey('links', k), { [Data.DATA1]: text(e.uri), [Data.DATA2]: t.type, [Data.DATA3]: t.label }, e));
  }

  for (const [k, e] of entries<ContactAnniversary>(card.anniversaries)) {
    const date = text(partialDateToString(e.date));
    if (!date) continue;
    const t = eventType(e.kind);
    out.push(unit(MimeType.EVENT, entryKey('anniversaries', k), { [Data.DATA1]: date, [Data.DATA2]: t.type, [Data.DATA3]: t.label }, e));
  }

  for (const [uri, e] of entries<ContactRelation>(card.relatedTo)) {
    if (!uri.trim()) continue;
    const shown = (uri.startsWith('urn:uuid:') ? ctx.nameForUid(uri) : null) ?? uri;
    const t = relationType(e.relation);
    out.push(unit(MimeType.RELATION, entryKey('relatedTo', uri), { [Data.DATA1]: shown, [Data.DATA2]: t.type, [Data.DATA3]: t.label }, e));
  }

  const note = entries<ContactNote>(card.notes).find(([, e]) => text(e.note));
  if (note) out.push(unit(MimeType.NOTE, entryKey('notes', note[0]), { [Data.DATA1]: text(note[1].note) }, note[1]));

  const photo = photoEntry(card);
  if (photo) {
    // Without its bytes (a blob the engine could not fetch) the photo still counts, so an
    // existing row is kept, not taken for a deletion; it just can't be written.
    const payload = photoPayload(photo.entry, ctx);
    const u = unit(MimeType.PHOTO, entryKey('media', photo.key), {}, payload?.hash ?? photo.entry);
    if (payload) u.photoHash = payload.hash;
    if (payload?.b64) u.extra = { [Data.DATA15]: { b64: payload.b64 } };
    out.push(u);
  }

  for (const gsid of options.memberOf ?? []) {
    const groupRowId = ctx.groupRowIdBySourceId(gsid);
    // A membership naming an unknown group would make the provider create an empty one.
    if (groupRowId === null) continue;
    out.push(unit(MimeType.GROUP_MEMBERSHIP, entryKey('members', gsid), { [GroupMembership.GROUP_SOURCE_ID]: gsid }, gsid, {
      [GroupMembership.GROUP_ROW_ID]: groupRowId,
    }));
  }
  return out;
}

/** What the provider stores for a unit's cells (it splits a lone display name or address). */
export function predictStored(u: Pick<Unit, 'mimetype' | 'cells'>): Row {
  if (u.mimetype === MimeType.STRUCTURED_NAME) return predictStoredName(u.cells);
  if (u.mimetype === MimeType.STRUCTURED_POSTAL) return predictStoredPostal(u.cells);
  return u.cells;
}

/** Whether a stored row is what writing the unit gives, allowing for the provider's normalisation. */
export function rowMatchesUnit(u: Pick<Unit, 'mimetype' | 'cells'>, stored: Row, same: (a: unknown, b: unknown, c?: string) => boolean): boolean {
  if (u.mimetype === MimeType.STRUCTURED_NAME) return nameMatches(u.cells, stored, same);
  const spec = SPECS[u.mimetype];
  if (u.mimetype === MimeType.STRUCTURED_POSTAL && POSTAL_PART_COLUMNS.every((c) => text(u.cells[c]) === null)) {
    return spec.columns.filter((c) => !(POSTAL_PART_COLUMNS as readonly string[]).includes(c)).every((c) => same(u.cells[c], stored[c], c));
  }
  if (u.mimetype === MimeType.PHOTO) return true;
  return spec.columns.every((c) => same(u.cells[c], stored[c], c));
}

/**
 * Whether a row has nothing in it (an editor's blank nickname or note). A
 * photo row always holds a photo: ContactsProvider keeps one within its 96 px
 * thumbnail as the thumbnail alone, without PHOTO_FILE_ID, and the thumbnail
 * (DATA15, a blob) does not read back.
 */
export function isEmptyRow(mimetype: string, cells: Row): boolean {
  const spec = SPECS[mimetype];
  if (!spec) return true;
  if (mimetype === MimeType.PHOTO) return false;
  if (mimetype === MimeType.GROUP_MEMBERSHIP) return cellText(cells[GroupMembership.GROUP_SOURCE_ID]) === null && cellText(cells[Data.DATA1]) === null;
  return spec.valueColumns.every((c) => text(cells[c]) === null);
}
