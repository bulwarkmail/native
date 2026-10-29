/**
 * `name` ↔ the StructuredName row (docs/device-sync.md, "Name").
 *
 * Download writes DISPLAY_NAME and the components together, so the provider
 * leaves both alone; a name with `full` only is split by the provider, which
 * the baseline predicts roughly and the baseline heal corrects. Upload
 * replaces the first component of each edited column's kinds, keeps every
 * other component, and sends the whole `name/components` array (JSON Pointer
 * can't address array elements). `name/full` goes along when the display name
 * was typed, or re-derived when only components changed and the server's
 * `full` was the derived one (Stalwart never re-derives it by itself).
 */
import type { ContactName, NameComponent } from '../../api/types';
import { deriveFullName } from '../../lib/contact-utils';
import { StructuredName as SN } from '../android-columns';
import { clone } from '../common/json';
import type { Row } from '../types';
import { text } from './cells';

type Component = NameComponent & { phonetic?: string };

export const NAME_COLUMNS = [
  SN.DISPLAY_NAME, SN.GIVEN_NAME, SN.FAMILY_NAME, SN.PREFIX, SN.MIDDLE_NAME, SN.SUFFIX,
  SN.PHONETIC_GIVEN_NAME, SN.PHONETIC_MIDDLE_NAME, SN.PHONETIC_FAMILY_NAME,
] as const;

/** The component columns the provider splits a lone display name into, or joins into one. */
const NAME_PART_COLUMNS = [SN.PREFIX, SN.GIVEN_NAME, SN.MIDDLE_NAME, SN.FAMILY_NAME, SN.SUFFIX] as const;

interface ColumnSpec {
  column: string;
  kinds: string[];
  /** Rank in display order, for placing a component the name did not have. */
  rank: number;
}

const PARTS: ColumnSpec[] = [
  { column: SN.PREFIX, kinds: ['title', 'prefix'], rank: 0 },
  { column: SN.GIVEN_NAME, kinds: ['given'], rank: 1 },
  { column: SN.MIDDLE_NAME, kinds: ['given2', 'middle', 'additional'], rank: 2 },
  { column: SN.FAMILY_NAME, kinds: ['surname'], rank: 3 },
  { column: SN.SUFFIX, kinds: ['generation', 'credential', 'suffix'], rank: 5 },
];

const PHONETICS: Array<{ column: string; part: string }> = [
  { column: SN.PHONETIC_GIVEN_NAME, part: SN.GIVEN_NAME },
  { column: SN.PHONETIC_MIDDLE_NAME, part: SN.MIDDLE_NAME },
  { column: SN.PHONETIC_FAMILY_NAME, part: SN.FAMILY_NAME },
];

const RANK: Record<string, number> = { surname2: 4 };
for (const p of PARTS) for (const k of p.kinds) RANK[k] = p.rank;

function components(name: ContactName | undefined): Component[] {
  return Array.isArray(name?.components)
    ? (name!.components as Component[]).filter((c) => c && typeof c.kind === 'string')
    : [];
}

const firstOf = (comps: Component[], kinds: string[]) =>
  comps.find((c) => kinds.includes(c.kind) && typeof c.value === 'string');

/** StructuredName cells of a card's name; null when there is no name to show. */
export function nameCells(name: ContactName | undefined): Row | null {
  if (!name || typeof name !== 'object') return null;
  const comps = components(name);
  const cells: Row = {};
  for (const p of PARTS) cells[p.column] = text(firstOf(comps, p.kinds)?.value);
  const surname2 = comps.filter((c) => c.kind === 'surname2').map((c) => text(c.value)).filter(Boolean);
  if (surname2.length) cells[SN.FAMILY_NAME] = [cells[SN.FAMILY_NAME], ...surname2].filter(Boolean).join(' ');
  for (const ph of PHONETICS) {
    const spec = PARTS.find((p) => p.column === ph.part)!;
    cells[ph.column] = text(firstOf(comps, spec.kinds)?.phonetic);
  }
  const full = typeof name.full === 'string' && name.full.trim() ? name.full : deriveFullName(comps);
  cells[SN.DISPLAY_NAME] = text(full);
  return Object.values(cells).some((v) => v !== null) ? cells : null;
}

/**
 * What ContactsProvider stores for written name cells: a display name without
 * components is split into them (roughly as its NameSplitter does for simple
 * names; the baseline heal corrects the rest).
 */
export function predictStoredName(cells: Row): Row {
  const out = { ...cells };
  const display = text(cells[SN.DISPLAY_NAME]);
  if (display && NAME_PART_COLUMNS.every((c) => text(cells[c]) === null)) {
    const words = display.trim().split(/\s+/);
    out[SN.GIVEN_NAME] = words[0] ?? null;
    out[SN.FAMILY_NAME] = words.length > 1 ? words.slice(1).join(' ') : null;
  }
  return out;
}

/** Whether a stored name row is what writing `wanted` gives (the provider's split allowed). */
export function nameMatches(wanted: Row, stored: Row, same: (a: unknown, b: unknown) => boolean): boolean {
  const split = NAME_PART_COLUMNS.every((c) => text(wanted[c]) === null);
  return NAME_COLUMNS.every((c) => (split && (NAME_PART_COLUMNS as readonly string[]).includes(c)) || same(wanted[c], stored[c]));
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The display names the provider (or an editor) computes from the components. */
function joins(cells: Row): string[] {
  const [prefix, given, middle, family, suffix] = NAME_PART_COLUMNS.map((c) => text(cells[c]));
  const western = [prefix, given, middle, family].filter(Boolean).join(' ');
  return [
    [prefix, given, middle, family, suffix].filter(Boolean).join(' '),
    suffix ? `${western}, ${suffix}` : western,
    [prefix, family, middle, given, suffix].filter(Boolean).join(''),
    [prefix, family, given, middle].filter(Boolean).join(' ') + (suffix ? `, ${suffix}` : ''),
  ].map(squash);
}

const NAME_KINDS = new Set(['surname', 'given', 'given2', 'title', 'credential', 'surname2', 'generation']);

/** `full` as Stalwart derives it (components in order, separators verbatim). */
function serverDerivedFull(name: ContactName): string {
  const sep = typeof name.defaultSeparator === 'string' && name.defaultSeparator ? name.defaultSeparator : ' ';
  let full = '';
  let afterValue = false;
  for (const c of components(name)) {
    if (typeof c.value !== 'string') continue;
    if (c.kind === 'separator') {
      full += c.value;
      afterValue = false;
    } else if (NAME_KINDS.has(c.kind)) {
      if (afterValue) full += sep;
      full += c.value;
      afterValue = true;
    }
  }
  return full;
}

/** Whether the server's `full` only repeats its components (so it follows them). */
export function fullIsDerived(name: ContactName | undefined): boolean {
  if (!name) return true;
  const full = typeof name.full === 'string' ? squash(name.full) : '';
  if (!full) return true;
  const comps = components(name);
  return full === squash(deriveFullName(comps)) || full === squash(serverDerivedFull(name));
}

function place(comps: Component[], component: Component): void {
  const rank = RANK[component.kind] ?? 99;
  const at = comps.findIndex((c) => (RANK[c.kind] ?? -1) > rank);
  if (at < 0) comps.push(component);
  else comps.splice(at, 0, component);
}

/** The server's components with the edited columns applied. */
function editComponents(name: ContactName | undefined, cells: Row, changed: ReadonlySet<string>): Component[] {
  const comps = clone(components(name));
  for (const p of PARTS) {
    if (!changed.has(p.column)) continue;
    const value = text(cells[p.column]);
    if (p.column === SN.FAMILY_NAME) {
      for (let i = comps.length - 1; i >= 0; i--) if (comps[i].kind === 'surname2') comps.splice(i, 1);
    }
    const target = firstOf(comps, p.kinds);
    if (target && value !== null) target.value = value;
    else if (target) comps.splice(comps.indexOf(target), 1);
    else if (value !== null) place(comps, { kind: p.kinds[0], value });
  }
  for (const ph of PHONETICS) {
    if (!changed.has(ph.column)) continue;
    const spec = PARTS.find((p) => p.column === ph.part)!;
    const value = text(cells[ph.column]);
    const target = firstOf(comps, spec.kinds);
    if (target && value !== null) target.phonetic = value;
    else if (target) delete target.phonetic;
    else if (value !== null) place(comps, { kind: spec.kinds[0], value: '', phonetic: value });
  }
  return comps;
}

/**
 * The name part of a patch for edited name columns: `name/components`,
 * `name/full`, or the whole `name` when the card has none.
 */
export function namePatch(name: ContactName | undefined, cells: Row, changed: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const partsChanged = [...PARTS.map((p) => p.column), ...PHONETICS.map((p) => p.column)].some((c) => changed.has(c));
  const displayChanged = changed.has(SN.DISPLAY_NAME);
  if (!partsChanged && !displayChanged) return out;
  const display = text(cells[SN.DISPLAY_NAME]);
  if (name && typeof name === 'object' && components(name).length === 0) {
    // The server holds this name as `full` alone, so the device's components are the
    // provider's split of it: the name goes up whole from the row.
    const all = editComponents(undefined, cells, new Set(NAME_COLUMNS));
    const full = display ?? (deriveFullName(all) || null);
    if (all.length) out['name/components'] = all;
    if (full !== (typeof name.full === 'string' ? name.full : null)) out['name/full'] = full;
    return out;
  }
  const comps = partsChanged ? editComponents(name, cells, changed) : components(name);
  let full: string | null | undefined;
  if (displayChanged && display && !joins(cells).includes(squash(display))) full = display;
  else if (fullIsDerived(name)) full = deriveFullName(comps) || display || null;
  const hasName = !!name && typeof name === 'object';
  if (!hasName) {
    const whole: Record<string, unknown> = {};
    if (comps.length) whole.components = comps;
    if (full) whole.full = full;
    if (Object.keys(whole).length) out.name = whole;
    return out;
  }
  if (partsChanged) out['name/components'] = comps.length ? comps : null;
  if (full !== undefined && full !== (typeof name!.full === 'string' ? name!.full : null)) out['name/full'] = full;
  return out;
}
