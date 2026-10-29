/**
 * Rows back to JSContact: the sub-field edits of a changed unit, and the
 * entries a new row stands for. Only what the row can say is touched; a
 * phone's other features, an entry's other contexts and every property
 * Android has no column for stay as the server has them.
 */
import type { ContactAddress, ContactTitle } from '../../api/types';
import { stringToPartialDate } from '../../lib/contact-utils';
import {
  CommonKind,
  ContactEventType,
  Data,
  EmailType,
  MimeType,
  Organization as Org,
  PhoneType,
  PostalType,
  RelationType,
  StructuredPostal as SP,
  WebsiteType,
} from '../android-columns';
import type { ContactCardWire } from '../planner';
import type { Row } from '../types';
import { num, text } from './cells';
import { parseEntryKey, parseOrgKey } from './keys';
import { editPostalComponents, postalComponentsFromRow, POSTAL_PART_COLUMNS } from './postal';
import {
  emailFlags,
  eventKind,
  PHONE_TYPE_FEATURES,
  phoneFlags,
  postalFlags,
  relationName,
  relationTypesOf,
  TYPED_CONTEXTS,
  websiteFlags,
  type EntryFlags,
} from './types-map';

/** A pointer (raw member names) and the value it should get; null removes. */
export interface Edit {
  path: string[];
  value: unknown;
}

/** An entry a row adds (or, for a relation, a key it moves to). */
export interface NewEntry {
  map: string;
  /** Fixed key (relatedTo is keyed by its value); otherwise a new key is minted. */
  key?: string;
  /** Reference into another new entry's key, e.g. a title's organization. */
  value: Record<string, unknown>;
  /** Entries created together share a group id so titles can point at their organization. */
  role?: 'organization' | 'title';
}

type Entry = Record<string, unknown>;

const flagsOf = (value: unknown): Record<string, boolean> =>
  value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, boolean>) } : {};

/** Replaces the flags a TYPE speaks for; null when nothing is left. */
function swapFlags(current: unknown, owned: string[], wanted: string[]): Record<string, boolean> | null {
  const out = flagsOf(current);
  for (const k of owned) delete out[k];
  for (const k of wanted) out[k] = true;
  return Object.keys(out).length ? out : null;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function pushIf(out: Edit[], entry: Entry, path: string[], field: string, value: unknown): void {
  if (!same(entry[field], value)) out.push({ path: [...path, field], value });
}

/**
 * A new TYPE replaces the contexts and features it speaks for; a new LABEL of
 * the same custom TYPE is only the label (the contexts it hides stay).
 */
function typeEdits(out: Edit[], entry: Entry, path: string[], flags: EntryFlags, changed: ReadonlySet<string>, custom: boolean): void {
  if (changed.has(CommonKind.TYPE)) {
    pushIf(out, entry, path, 'contexts', swapFlags(entry.contexts, TYPED_CONTEXTS, flags.contexts));
    if (flags.features) pushIf(out, entry, path, 'features', swapFlags(entry.features, PHONE_TYPE_FEATURES, flags.features));
    pushIf(out, entry, path, 'label', flags.label);
  } else if (changed.has(CommonKind.LABEL) && custom) {
    pushIf(out, entry, path, 'label', flags.label);
  }
}

function prefEdit(out: Edit[], entry: Entry, path: string[], cells: Row): void {
  const primary = num(cells[Data.IS_PRIMARY]) === 1;
  if (primary && entry.pref !== 1) out.push({ path: [...path, 'pref'], value: 1 });
  else if (!primary && entry.pref === 1) out.push({ path: [...path, 'pref'], value: null });
}

const typeOf = (cells: Row) => num(cells[CommonKind.TYPE]);
const labelOf = (cells: Row) => text(cells[CommonKind.LABEL]);

function mapEntry(card: ContactCardWire, map: string, key: string): Entry | null {
  const m = card[map];
  const e = m && typeof m === 'object' ? (m as Record<string, unknown>)[key] : undefined;
  return e && typeof e === 'object' ? (e as Entry) : null;
}

function partialDate(value: unknown): Record<string, unknown> | null {
  const t = text(value);
  const pd = t ? stringToPartialDate(t) : null;
  return pd ? { '@type': 'PartialDate', ...pd } : null;
}

function splitUnits(value: string | null): Array<{ name: string }> | null {
  const units = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return units.length ? units.map((name) => ({ name })) : null;
}

export interface UnitEdits {
  edits: Edit[];
  /** Entries to add (a company typed into a title-only row creates its organization). */
  added: NewEntry[];
  /** Entries this unit no longer has (a relation moved to another key, a title emptied). */
  removed: Array<{ map: string; key: string }>;
}

/**
 * Edits for a changed unit. `changed` are the row's changed columns, `key`
 * the unit's DATA_SYNC1 key in the shadow, `baseCells` the shadow's
 * projection of it (the TYPE a relation had), `byKey` whether the row was
 * matched by its key.
 */
export function unitEdits(
  mimetype: string,
  key: string,
  card: ContactCardWire,
  cells: Row,
  baseCells: Row,
  changed: ReadonlySet<string>,
  shownName: string | null,
  byKey: boolean,
): UnitEdits {
  const edits: Edit[] = [];
  const added: NewEntry[] = [];
  const removed: Array<{ map: string; key: string }> = [];
  const result = { edits, added, removed };
  if (mimetype === MimeType.ORGANIZATION) return orgEdits(key, card, cells, changed, result);
  const parsed = parseEntryKey(key);
  if (!parsed) return result;
  const entry = mapEntry(card, parsed.map, parsed.key);
  if (!entry) return result;
  const path = [parsed.map, parsed.key];
  const typeChanged = changed.has(CommonKind.TYPE) || changed.has(CommonKind.LABEL);
  switch (mimetype) {
    case MimeType.NICKNAME:
      if (changed.has(Data.DATA1)) pushIf(edits, entry, path, 'name', text(cells[Data.DATA1]));
      break;
    case MimeType.EMAIL:
      if (changed.has(Data.DATA1)) pushIf(edits, entry, path, 'address', text(cells[Data.DATA1]));
      if (typeChanged) typeEdits(edits, entry, path, emailFlags(typeOf(cells), labelOf(cells)), changed, typeOf(cells) === EmailType.CUSTOM);
      if (changed.has(Data.IS_PRIMARY)) prefEdit(edits, entry, path, cells);
      break;
    case MimeType.PHONE:
      if (changed.has(Data.DATA1)) pushIf(edits, entry, path, 'number', text(cells[Data.DATA1]));
      if (typeChanged) typeEdits(edits, entry, path, phoneFlags(typeOf(cells), labelOf(cells)), changed, typeOf(cells) === PhoneType.CUSTOM);
      if (changed.has(Data.IS_PRIMARY)) prefEdit(edits, entry, path, cells);
      break;
    case MimeType.STRUCTURED_POSTAL: {
      const parts = new Set(POSTAL_PART_COLUMNS.filter((c) => changed.has(c)));
      if (parts.size) {
        const comps = editPostalComponents(entry as ContactAddress, cells, parts);
        pushIf(edits, entry, path, 'components', comps.length ? comps : null);
      }
      if (changed.has(SP.FORMATTED_ADDRESS)) pushIf(edits, entry, path, 'full', text(cells[SP.FORMATTED_ADDRESS]));
      if (typeChanged) typeEdits(edits, entry, path, postalFlags(typeOf(cells), labelOf(cells)), changed, typeOf(cells) === PostalType.CUSTOM);
      break;
    }
    case MimeType.WEBSITE:
      if (changed.has(Data.DATA1)) pushIf(edits, entry, path, 'uri', text(cells[Data.DATA1]));
      if (typeChanged) typeEdits(edits, entry, path, websiteFlags(typeOf(cells), labelOf(cells)), changed, typeOf(cells) === WebsiteType.CUSTOM);
      break;
    case MimeType.EVENT:
      if (changed.has(Data.DATA1)) {
        const date = partialDate(cells[Data.DATA1]);
        // Free text Stalwart can't take stays on the device only.
        if (date) pushIf(edits, entry, path, 'date', date);
      }
      if (changed.has(CommonKind.TYPE) || (changed.has(CommonKind.LABEL) && typeOf(cells) === ContactEventType.CUSTOM)) {
        pushIf(edits, entry, path, 'kind', eventKind(typeOf(cells), labelOf(cells)));
      }
      break;
    case MimeType.RELATION: {
      const name = text(cells[Data.DATA1]);
      // Only a row we wrote can be renamed: a re-inserted row showing another name may just
      // show a related card that was renamed since.
      const renamed = byKey && changed.has(Data.DATA1) && name !== null && name !== shownName && name !== parsed.key;
      const relationChanged = changed.has(CommonKind.TYPE) || (changed.has(CommonKind.LABEL) && typeOf(cells) === RelationType.CUSTOM);
      const relation = relationChanged
        ? swapFlags(entry.relation, relationTypesOf(typeOf(baseCells), labelOf(baseCells)), relationTypes(cells)) ?? {}
        : flagsOf(entry.relation);
      if (renamed) {
        // relatedTo is keyed by its value: another name is another entry.
        removed.push({ map: 'relatedTo', key: parsed.key });
        added.push({ map: 'relatedTo', key: name!, value: { ...entry, relation } });
      } else if (relationChanged) {
        pushIf(edits, entry, path, 'relation', relation);
      }
      break;
    }
    case MimeType.NOTE:
      if (changed.has(Data.DATA1)) pushIf(edits, entry, path, 'note', text(cells[Data.DATA1]));
      break;
  }
  return result;
}

function relationTypes(cells: Row): string[] {
  const name = relationName(typeOf(cells), labelOf(cells));
  return name ? [name] : [];
}

function orgEdits(key: string, card: ContactCardWire, cells: Row, changed: ReadonlySet<string>, out: UnitEdits): UnitEdits {
  const parts = parseOrgKey(key);
  if (!parts) return out;
  const org = parts.org ? mapEntry(card, 'organizations', parts.org) : null;
  const orgPath = parts.org ? ['organizations', parts.org] : null;
  const company = text(cells[Org.COMPANY]);
  const department = text(cells[Org.DEPARTMENT]);
  let newOrg: NewEntry | null = null;
  if (org && orgPath) {
    if (changed.has(Org.COMPANY)) pushIf(out.edits, org, orgPath, 'name', company);
    if (changed.has(Org.DEPARTMENT)) pushIf(out.edits, org, orgPath, 'units', splitUnits(department));
  } else if ((changed.has(Org.COMPANY) && company) || (changed.has(Org.DEPARTMENT) && department)) {
    const value: Record<string, unknown> = {};
    if (company) value.name = company;
    const units = splitUnits(department);
    if (units) value.units = units;
    newOrg = { map: 'organizations', value, role: 'organization' };
    out.added.push(newOrg);
  }
  const titleEdit = (column: string, titleKey: string | null, kind: 'title' | 'role') => {
    const title = titleKey ? mapEntry(card, 'titles', titleKey) : null;
    const value = text(cells[column]);
    if (title && titleKey) {
      if (changed.has(column)) {
        if (value === null) out.removed.push({ map: 'titles', key: titleKey });
        else pushIf(out.edits, title, ['titles', titleKey], 'name', value);
      }
      if (newOrg) out.edits.push({ path: ['titles', titleKey, 'organizationId'], value: newOrg });
    } else if (changed.has(column) && value !== null) {
      const t: Record<string, unknown> = { name: value, kind };
      if (parts.org) t.organizationId = parts.org;
      out.added.push({ map: 'titles', value: t, role: 'title' });
    }
  };
  titleEdit(Org.TITLE, parts.title, 'title');
  titleEdit(Org.JOB_DESCRIPTION, parts.role, 'role');
  // A new organization's titles point at its minted key (resolved by the patch builder).
  if (newOrg) for (const e of out.added) if (e.role === 'title') e.value.organizationId = newOrg;
  return out;
}

/** The entries a new row adds. */
export function newEntries(mimetype: string, cells: Row, shownName?: string | null): NewEntry[] {
  const typeFlags = (flags: EntryFlags, withFeatures = false): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const contexts = swapFlags(undefined, [], flags.contexts);
    if (contexts) out.contexts = contexts;
    if (withFeatures) {
      const features = swapFlags(undefined, [], flags.features ?? []);
      if (features) out.features = features;
    }
    if (flags.label) out.label = flags.label;
    return out;
  };
  const primary = num(cells[Data.IS_PRIMARY]) === 1 ? { pref: 1 } : {};
  const value = text(cells[Data.DATA1]);
  switch (mimetype) {
    case MimeType.NICKNAME:
      return value ? [{ map: 'nicknames', value: { name: value } }] : [];
    case MimeType.EMAIL:
      return value ? [{ map: 'emails', value: { address: value, ...typeFlags(emailFlags(typeOf(cells), labelOf(cells))), ...primary } }] : [];
    case MimeType.PHONE:
      return value ? [{ map: 'phones', value: { number: value, ...typeFlags(phoneFlags(typeOf(cells), labelOf(cells)), true), ...primary } }] : [];
    case MimeType.STRUCTURED_POSTAL: {
      const address: Record<string, unknown> = {};
      const comps = postalComponentsFromRow(cells);
      if (comps.length) address.components = comps;
      const full = text(cells[SP.FORMATTED_ADDRESS]);
      if (full) address.full = full;
      if (!comps.length && !full) return [];
      return [{ map: 'addresses', value: { ...address, ...typeFlags(postalFlags(typeOf(cells), labelOf(cells))) } }];
    }
    case MimeType.ORGANIZATION: {
      const out: NewEntry[] = [];
      const company = text(cells[Org.COMPANY]);
      const units = splitUnits(text(cells[Org.DEPARTMENT]));
      let org: NewEntry | null = null;
      if (company || units) {
        const v: Record<string, unknown> = {};
        if (company) v.name = company;
        if (units) v.units = units;
        org = { map: 'organizations', value: v, role: 'organization' };
        out.push(org);
      }
      const title = (column: string, kind: ContactTitle['kind']) => {
        const name = text(cells[column]);
        if (!name) return;
        const v: Record<string, unknown> = { name, kind };
        if (org) v.organizationId = org;
        out.push({ map: 'titles', value: v, role: 'title' });
      };
      title(Org.TITLE, 'title');
      title(Org.JOB_DESCRIPTION, 'role');
      return out;
    }
    case MimeType.WEBSITE:
      return value ? [{ map: 'links', value: { uri: value, ...typeFlags(websiteFlags(typeOf(cells), labelOf(cells))) } }] : [];
    case MimeType.EVENT: {
      const date = partialDate(cells[Data.DATA1]);
      return date ? [{ map: 'anniversaries', value: { kind: eventKind(typeOf(cells), labelOf(cells)), date } }] : [];
    }
    case MimeType.RELATION: {
      if (!value || value === shownName) return [];
      const type = relationName(typeOf(cells), labelOf(cells));
      return [{ map: 'relatedTo', key: value, value: { relation: type ? { [type]: true } : {} } }];
    }
    case MimeType.NOTE:
      return value ? [{ map: 'notes', value: { note: value } }] : [];
    default:
      return [];
  }
}

/** Keys (map, key) a unit stands for, for deleting it. */
export function unitEntries(mimetype: string, key: string): Array<{ map: string; key: string }> {
  if (mimetype === MimeType.ORGANIZATION) {
    const parts = parseOrgKey(key);
    if (!parts) return [];
    const out: Array<{ map: string; key: string }> = [];
    if (parts.org) out.push({ map: 'organizations', key: parts.org });
    if (parts.title) out.push({ map: 'titles', key: parts.title });
    if (parts.role) out.push({ map: 'titles', key: parts.role });
    return out;
  }
  const parsed = parseEntryKey(key);
  return parsed ? [parsed] : [];
}

