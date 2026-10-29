/**
 * Data-row cells as the contacts planner compares them. The bridge hands
 * numbers back as numbers or text, "" and NULL mean the same (the design's
 * rule for names, and what editors do to every field), and IS_PRIMARY 0 is
 * the same as unset. Baselines (DATA_SYNC3) keep text over 1 KB as its hash.
 */
import { sha256Hex } from '../../lib/sha256';
import { Data } from '../android-columns';
import { parseJsonColumn, utf8 } from '../common/json';
import type { Cell, Row } from '../types';

const LONG_TEXT = 1024;
const HASH_PREFIX = '#sha256:';

/** Comparable text of a cell; null for NULL, "" and anything that is not a cell. */
export function cellText(value: unknown, column?: string): string | null {
  let text: string | null = null;
  if (typeof value === 'string') text = value === '' ? null : value;
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  if (column === Data.IS_PRIMARY && text === '0') return null;
  return text;
}

export function sameCell(a: unknown, b: unknown, column?: string): boolean {
  return cellText(a, column) === cellText(b, column);
}

function baselineValue(value: unknown, column: string): string | null {
  const text = cellText(value, column);
  if (text !== null && text.length > LONG_TEXT) return `${HASH_PREFIX}${sha256Hex(utf8(text))}`;
  return text;
}

/** DATA_SYNC3 of a row: its mapped cells, long text hashed. */
export function encodeBaseline(cells: Row, columns: readonly string[]): string {
  const out: Record<string, string | null> = {};
  for (const c of columns) if (c in cells) out[c] = baselineValue(cells[c], c);
  return JSON.stringify(out);
}

/** A baseline read back from DATA_SYNC3; null when another app left something else there. */
export function decodeBaseline(text: unknown): Row | null {
  const parsed = parseJsonColumn<unknown>(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out: Row = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v !== null && typeof v !== 'string' && typeof v !== 'number') return null;
    out[k] = v as Cell;
  }
  return out;
}

/** Whether a cell still holds what the baseline recorded for it. */
function matchesBaseline(value: unknown, baseline: Row, column: string): boolean {
  const recorded = cellText(baseline[column], column);
  if (recorded !== null && recorded.startsWith(HASH_PREFIX)) return baselineValue(value, column) === recorded;
  return cellText(value, column) === recorded;
}

/** Mapped columns that differ from the baseline; columns the baseline never recorded count as unchanged. */
export function changedFromBaseline(cells: Row, baseline: Row, columns: readonly string[]): string[] {
  return columns.filter((c) => c in baseline && !matchesBaseline(cells[c], baseline, c));
}

/** The cell as text for building card values; null when blank. */
export function text(value: unknown): string | null {
  const t = cellText(value);
  return t === null || t.trim() === '' ? null : t;
}

export function num(value: unknown): number | null {
  const t = cellText(value);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
