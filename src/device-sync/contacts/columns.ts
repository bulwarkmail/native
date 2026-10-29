/**
 * The columns the engine queries for contacts, and the decoders that turn
 * rows into `LocalContact`/`LocalGroup`. Sync columns are read defensively:
 * any app holding WRITE_CONTACTS can write them, so what does not parse is
 * treated as absent.
 */
import { Data, GroupMembership, Groups, RawContacts } from '../android-columns';
import { parseCollectionKey } from '../common/ids';
import { parseJsonColumn } from '../common/json';
import type { ContactCardWire, LocalContact, LocalDataRow, LocalGroup, PendingCreate, PoisonMarker } from '../planner';
import type { Row } from '../types';
import { cellText, decodeBaseline, num } from './cells';

const DATA_CELLS = [
  Data.IS_PRIMARY, Data.DATA1, Data.DATA2, Data.DATA3, Data.DATA4, Data.DATA5, Data.DATA6, Data.DATA7,
  Data.DATA8, Data.DATA9, Data.DATA10, Data.DATA11, Data.DATA12, Data.DATA13, Data.DATA14,
  GroupMembership.GROUP_SOURCE_ID,
];

/**
 * RAW_CONTACT_IS_READ_ONLY is not among them: the providers take it on
 * writes but refuse it in every projection ("Invalid column").
 */
export const RAW_CONTACT_COLUMNS: readonly string[] = [
  RawContacts._ID, RawContacts.SOURCE_ID, RawContacts.VERSION, RawContacts.DIRTY, RawContacts.DELETED,
  RawContacts.SYNC1, RawContacts.SYNC2, RawContacts.SYNC3, RawContacts.SYNC4,
];

export const DATA_COLUMNS: readonly string[] = [
  Data._ID, Data.RAW_CONTACT_ID, Data.MIMETYPE, ...DATA_CELLS, Data.DATA_SYNC1, Data.DATA_SYNC2, Data.DATA_SYNC3,
];

export const GROUP_COLUMNS: readonly string[] = [
  Groups._ID, Groups.SOURCE_ID, Groups.VERSION, Groups.DIRTY, Groups.DELETED, Groups.TITLE,
  Groups.SYNC2, Groups.SYNC3, Groups.SYNC4,
];

const flag = (v: unknown) => num(v) === 1;

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

export function decodeShadow(v: unknown): ContactCardWire | null {
  const card = parseJsonColumn<unknown>(v);
  return card && typeof card === 'object' && !Array.isArray(card) && typeof (card as { id?: unknown }).id === 'string'
    ? (card as ContactCardWire)
    : null;
}

export function decodePending(v: unknown): PendingCreate | null {
  const p = parseJsonColumn<Record<string, unknown>>(v);
  if (!p || typeof p !== 'object' || typeof p.uid !== 'string' || !p.uid || typeof p.target !== 'string') return null;
  return parseCollectionKey(p.target) ? { uid: p.uid, target: p.target } : null;
}

export function decodePoison(v: unknown): PoisonMarker | null {
  const p = parseJsonColumn<Record<string, unknown>>(v);
  if (!p || typeof p !== 'object' || typeof p.fp !== 'string' || typeof p.type !== 'string') return null;
  if (typeof p.n !== 'number' || typeof p.until !== 'number') return null;
  return {
    fp: p.fp,
    type: p.type,
    n: p.n,
    until: p.until,
    ...(typeof p.description === 'string' ? { description: p.description } : {}),
  };
}

function decodeDataRow(row: Row): LocalDataRow {
  const cells: Row = {};
  for (const c of DATA_CELLS) if (c in row) cells[c] = row[c];
  return {
    id: Number(row[Data._ID]),
    mimetype: String(row[Data.MIMETYPE] ?? ''),
    cells,
    key: stringOrNull(row[Data.DATA_SYNC1]),
    photoHash: stringOrNull(row[Data.DATA_SYNC2]),
    baseline: decodeBaseline(row[Data.DATA_SYNC3]),
  };
}

export function decodeContact(rawContact: Row, data: Row[]): LocalContact {
  const id = Number(rawContact[RawContacts._ID]);
  const own = data.filter((d) => !(Data.RAW_CONTACT_ID in d) || Number(d[Data.RAW_CONTACT_ID]) === id);
  const collections = (cellText(rawContact[RawContacts.SYNC1]) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => parseCollectionKey(s));
  return {
    rawContactId: id,
    sourceId: stringOrNull(rawContact[RawContacts.SOURCE_ID]),
    version: num(rawContact[RawContacts.VERSION]) ?? 0,
    dirty: flag(rawContact[RawContacts.DIRTY]),
    deleted: flag(rawContact[RawContacts.DELETED]),
    collections,
    shadow: decodeShadow(rawContact[RawContacts.SYNC2]),
    pending: decodePending(rawContact[RawContacts.SYNC3]),
    poison: decodePoison(rawContact[RawContacts.SYNC4]),
    rows: own.map(decodeDataRow),
  };
}

export function decodeGroup(group: Row): LocalGroup {
  return {
    groupId: Number(group[Groups._ID]),
    sourceId: stringOrNull(group[Groups.SOURCE_ID]),
    version: num(group[Groups.VERSION]) ?? 0,
    dirty: flag(group[Groups.DIRTY]),
    deleted: flag(group[Groups.DELETED]),
    title: typeof group[Groups.TITLE] === 'string' ? (group[Groups.TITLE] as string) : null,
    shadow: decodeShadow(group[Groups.SYNC2]),
    pending: decodePending(group[Groups.SYNC3]),
    poison: decodePoison(group[Groups.SYNC4]),
  };
}
