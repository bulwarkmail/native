/**
 * What changed in a unit, on either side (docs/device-sync.md, "Row
 * matching"). A row matched by its key is compared column by column with its
 * baseline, so an emptied column is a real deletion. A row matched by value
 * has no baseline: its values count only where they are non-empty and differ
 * from the shadow's projection, TYPE and LABEL only for phones, emails,
 * addresses and events, and IS_PRIMARY never.
 */
import { CommonKind, Data, MimeType, StructuredPostal as SP } from '../android-columns';
import type { Row } from '../types';
import { changedFromBaseline, sameCell, text } from './cells';
import type { Match } from './matching';
import { POSTAL_PART_COLUMNS, providerSplitPostal, resplitPostal } from './postal';
import { SPECS, type Unit } from './project';

const isPart = (column: string) => (POSTAL_PART_COLUMNS as readonly string[]).includes(column);

/** A postal row holding the provider's split of a formatted address an editor wrote alone. */
function isProviderSplit(m: Match): boolean {
  const { row } = m;
  if (row.mimetype !== MimeType.STRUCTURED_POSTAL || !providerSplitPostal(row.cells)) return false;
  // A multi-part formatted address in STREET was the provider's split, not a typed street.
  return m.how !== 'key' || !row.baseline || /[,\n]/.test(text(row.cells[SP.FORMATTED_ADDRESS]) ?? '');
}

/** The address as the device showed it before the edit: a keyed row's baseline, else the shadow's. */
function postalBefore(m: Match): Row {
  return m.how === 'key' && m.row.baseline ? m.row.baseline : m.unit.cells;
}

/**
 * The cells an upload takes a row's values from: its own, except for a
 * provider split whose line changed. Its parts are read back from the new
 * line along the old one (`resplitPostal`), else they stay what the device
 * holds, the whole line as the street: `full` and the components never
 * contradict each other on the server.
 */
export function uploadCells(m: Match): Row {
  if (!isProviderSplit(m)) return m.row.cells;
  const before = postalBefore(m);
  const line = text(m.row.cells[SP.FORMATTED_ADDRESS]);
  if (!line || sameCell(line, before[SP.FORMATTED_ADDRESS])) return m.row.cells;
  return { ...m.row.cells, ...(resplitPostal(before, line) ?? {}) };
}

export function localChanges(m: Match): string[] {
  const { unit } = m;
  const changed = rawChanges(m).filter((c) => !unit.truncated?.includes(c));
  if (!isProviderSplit(m)) return changed;
  // The provider's split is no typed street: only a new line changes the parts, to what it says.
  const others = changed.filter((c) => !isPart(c));
  if (!others.includes(SP.FORMATTED_ADDRESS)) return others;
  const before = postalBefore(m);
  const after = uploadCells(m);
  return [...others, ...POSTAL_PART_COLUMNS.filter((c) => !sameCell(after[c], before[c]))];
}

function rawChanges(m: Match): string[] {
  const spec = SPECS[m.row.mimetype];
  const { row, unit } = m;
  if (m.how === 'key' && row.baseline) return changedFromBaseline(row.cells, row.baseline, spec.columns);
  if (row.mimetype === MimeType.PHOTO) {
    // A photo row without our baseline was put there by an editor: its picture counts as new.
    return m.how === 'key' ? [] : [Data.DATA14];
  }
  const out = spec.valueColumns.filter((c) => text(row.cells[c]) !== null && !sameCell(row.cells[c], unit.cells[c], c));
  if (spec.typed && text(row.cells[CommonKind.TYPE]) !== null && !sameCell(row.cells[CommonKind.TYPE], unit.cells[CommonKind.TYPE])) {
    out.push(CommonKind.TYPE, CommonKind.LABEL);
  } else if (spec.typed && text(row.cells[CommonKind.LABEL]) !== null && !sameCell(row.cells[CommonKind.LABEL], unit.cells[CommonKind.LABEL])) {
    out.push(CommonKind.LABEL);
  }
  return out;
}

/** Whether two units show the same on the device (sub-fields Android can't hold don't count). */
export function sameUnit(a: Unit, b: Unit): boolean {
  if (a.mimetype !== b.mimetype) return false;
  // A photo whose bytes could not be had compares as unchanged.
  if (a.mimetype === MimeType.PHOTO) return a.photoHash === undefined || b.photoHash === undefined || a.photoHash === b.photoHash;
  return SPECS[a.mimetype].columns.every((c) => sameCell(a.cells[c], b.cells[c], c));
}
