/**
 * `addresses/<k>` ↔ a StructuredPostal row (docs/device-sync.md, "Postal
 * components"). Each column joins the components of its kinds in order; an
 * edited column replaces all components it was built from with one
 * component of its first kind and keeps the rest (separators between other
 * components, unknown kinds, phonetics).
 */
import type { AddressComponent, ContactAddress } from '../../api/types';
import { StructuredPostal as SP } from '../android-columns';
import { clone } from '../common/json';
import type { Row } from '../types';
import { text } from './cells';

export const POSTAL_PART_COLUMNS = [SP.STREET, SP.POBOX, SP.NEIGHBORHOOD, SP.CITY, SP.REGION, SP.POSTCODE, SP.COUNTRY] as const;

const PARTS: Array<{ column: string; kinds: string[]; legacy?: keyof ContactAddress }> = [
  { column: SP.STREET, kinds: ['name', 'number', 'building', 'floor', 'apartment', 'room', 'block', 'direction', 'landmark'], legacy: 'street' },
  { column: SP.POBOX, kinds: ['postOfficeBox'] },
  { column: SP.NEIGHBORHOOD, kinds: ['district', 'subdistrict'] },
  { column: SP.CITY, kinds: ['locality'], legacy: 'locality' },
  { column: SP.REGION, kinds: ['region'], legacy: 'region' },
  { column: SP.POSTCODE, kinds: ['postcode'], legacy: 'postcode' },
  { column: SP.COUNTRY, kinds: ['country'], legacy: 'country' },
];

type Component = AddressComponent;

const RANK: Record<string, number> = {};
PARTS.forEach((p, i) => p.kinds.forEach((k) => (RANK[k] = i)));

function components(address: ContactAddress): Component[] {
  if (Array.isArray(address.components) && address.components.length) {
    return address.components.filter((c) => c && typeof c.kind === 'string');
  }
  // Legacy flat fields are read when there are no components (never written).
  const out: Component[] = [];
  for (const p of PARTS) {
    const v = p.legacy ? address[p.legacy] : undefined;
    if (typeof v === 'string' && v.trim()) out.push({ kind: p.kinds[0], value: v });
  }
  return out;
}

/** Joins the components of `kinds` in order; a separator between two of them is kept verbatim. */
function joinKinds(comps: Component[], kinds: string[], defaultSeparator: string): string | null {
  let out = '';
  let prevWasPart = false;
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i];
    if (!kinds.includes(c.kind) || typeof c.value !== 'string' || !c.value.trim()) {
      if (c.kind !== 'separator') prevWasPart = false;
      continue;
    }
    if (out) {
      const prev = comps[i - 1];
      out += prevWasPart && prev?.kind === 'separator' && typeof prev.value === 'string' ? prev.value : defaultSeparator;
    }
    out += c.value;
    prevWasPart = true;
  }
  return text(out);
}

/** The single-line address written when the card has no `full`, so the provider leaves the row alone. */
function joinPostal(cells: Row): string | null {
  const [street, pobox, neighborhood, city, region, postcode, country] = POSTAL_PART_COLUMNS.map((c) => text(cells[c]));
  const place = [postcode, city].filter(Boolean).join(' ');
  return text([street, pobox, neighborhood, place, region, country].filter(Boolean).join(', '));
}

/** Postal cells (without TYPE/LABEL) of an address. */
export function postalCells(address: ContactAddress): Row {
  const comps = components(address);
  const sep = typeof address.defaultSeparator === 'string' && address.defaultSeparator ? address.defaultSeparator : ' ';
  const cells: Row = {};
  for (const p of PARTS) cells[p.column] = joinKinds(comps, p.kinds, p.column === SP.STREET ? sep : ', ');
  const full = typeof address.full === 'string' && address.full.trim() ? address.full
    : typeof address.fullAddress === 'string' && address.fullAddress.trim() ? address.fullAddress
    : joinPostal(cells);
  cells[SP.FORMATTED_ADDRESS] = text(full);
  return cells;
}

/** What the provider stores: a formatted address without components is copied into STREET. */
export function predictStoredPostal(cells: Row): Row {
  const out = { ...cells };
  if (text(cells[SP.FORMATTED_ADDRESS]) && POSTAL_PART_COLUMNS.every((c) => text(cells[c]) === null)) {
    out[SP.STREET] = cells[SP.FORMATTED_ADDRESS];
  }
  return out;
}

/**
 * A postal row whose parts are only its formatted address copied into STREET:
 * the provider's split of an editor that wrote FORMATTED_ADDRESS alone.
 */
export function providerSplitPostal(cells: Row): boolean {
  const street = text(cells[SP.STREET]);
  return street !== null
    && street === text(cells[SP.FORMATTED_ADDRESS])
    && POSTAL_PART_COLUMNS.every((c) => c === SP.STREET || text(cells[c]) === null);
}

/** Lines and comma-separated segments of a formatted address. */
const SEGMENT = /\s*(?:,|\r?\n)\s*/;

const wordsOf = (value: string) => value.split(/\s+/).filter(Boolean);

function wordsAt(words: string[], part: string[], at: number): boolean {
  return at >= 0 && at + part.length <= words.length && part.every((w, i) => words[at + i] === w);
}

/** The parts one segment of the old line is made of, in their order there (each part used once). */
function segmentParts(segment: string[], parts: Map<string, string[]>, used: Set<string>): string[] | null {
  if (!segment.length) return [];
  for (const [column, words] of parts) {
    if (used.has(column) || !wordsAt(segment, words, 0)) continue;
    used.add(column);
    const rest = segmentParts(segment.slice(words.length), parts, used);
    if (rest) return [column, ...rest];
    used.delete(column);
  }
  return null;
}

/**
 * The parts of an address whose formatted line an editor rewrote alone (the
 * provider then empties them on the device), read back along the old line:
 * each segment of the old line must be the words of some old parts in a row,
 * and the new line must have as many segments. A changed segment gives its
 * words to its one part, or to the one part left once the parts at its start
 * and end are found unchanged there. Null when the layout changed, or a change
 * can't be pinned to one part.
 */
export function resplitPostal(old: Row, line: string): Row | null {
  const before = text(old[SP.FORMATTED_ADDRESS]);
  if (!before) return null;
  const parts = new Map<string, string[]>();
  for (const c of POSTAL_PART_COLUMNS) {
    const value = text(old[c]);
    if (value) parts.set(c, wordsOf(value));
  }
  const oldSegments = before.split(SEGMENT).map(wordsOf).filter((w) => w.length);
  const newSegments = line.split(SEGMENT).map(wordsOf).filter((w) => w.length);
  if (oldSegments.length !== newSegments.length) return null;
  const out: Row = { [SP.FORMATTED_ADDRESS]: line };
  for (const c of POSTAL_PART_COLUMNS) out[c] = text(old[c]);
  const used = new Set<string>();
  for (let i = 0; i < oldSegments.length; i++) {
    const columns = segmentParts(oldSegments[i], parts, used);
    if (!columns) return null;
    const words = newSegments[i];
    if (words.join(' ') === oldSegments[i].join(' ')) continue;
    const size = (k: number) => parts.get(columns[k])!.length;
    let first = 0;
    let start = 0;
    while (first < columns.length - 1 && wordsAt(words, parts.get(columns[first])!, start)) start += size(first++);
    let last = columns.length;
    let end = words.length;
    while (last - 1 > first && end - size(last - 1) >= start && wordsAt(words, parts.get(columns[last - 1])!, end - size(last - 1))) end -= size(--last);
    if (last - first !== 1) return null;
    out[columns[first]] = words.slice(start, end).join(' ') || null;
  }
  return out;
}

/** The address's components with the edited columns applied (a list for `addresses/<k>/components`). */
export function editPostalComponents(address: ContactAddress, cells: Row, changed: ReadonlySet<string>): Component[] {
  const comps = clone(components(address));
  for (const p of PARTS) {
    if (!changed.has(p.column)) continue;
    const value = text(cells[p.column]);
    const first = comps.findIndex((c) => p.kinds.includes(c.kind));
    const drop = new Set<number>();
    comps.forEach((c, i) => {
      if (p.kinds.includes(c.kind)) drop.add(i);
    });
    // Separators only between removed parts (or at their edge) go with them.
    comps.forEach((c, i) => {
      if (c.kind !== 'separator') return;
      const before = i > 0 && drop.has(i - 1);
      const after = i < comps.length - 1 && drop.has(i + 1);
      if ((before && (after || i === comps.length - 1)) || (after && i === 0)) drop.add(i);
    });
    const kept = comps.filter((_, i) => !drop.has(i));
    if (value !== null) {
      let at = comps.slice(0, Math.max(first, 0)).filter((_, i) => !drop.has(i)).length;
      if (first < 0) {
        // A part the address did not have goes before the first part that follows it in display order.
        const later = kept.findIndex((c) => (RANK[c.kind] ?? -1) > (RANK[p.kinds[0]] ?? 0));
        at = later < 0 ? kept.length : later;
      }
      kept.splice(at, 0, { kind: p.kinds[0], value });
    }
    comps.splice(0, comps.length, ...kept);
  }
  return comps;
}

/** Components for a new address from its row. */
export function postalComponentsFromRow(cells: Row): Component[] {
  return editPostalComponents({}, cells, new Set(POSTAL_PART_COLUMNS));
}
