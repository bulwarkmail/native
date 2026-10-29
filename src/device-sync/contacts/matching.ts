/**
 * Row matching and key reconciliation (docs/device-sync.md, "Row matching"
 * and "Key reconciliation"). Keys are hints: Fossify re-inserts every row but
 * the name on each save, without DATA_SYNC columns, dropping what it does not
 * model; AOSP edits in place. Stalwart regenerates `k1…kN` keys by position
 * for cards written over CardDAV, so keys can shift under us.
 */
import type { LocalDataRow } from '../planner';
import { isEmptyRow, SPECS, type Unit } from './project';

export interface Match {
  row: LocalDataRow;
  unit: Unit;
  how: 'key' | 'value' | 'pair';
}

export interface KindMatch {
  mimetype: string;
  matched: Match[];
  /** Rows no unit accounts for: new entries. */
  fresh: LocalDataRow[];
  /** Units without a row. */
  missing: Unit[];
  /** Non-empty rows of the kind. */
  rows: LocalDataRow[];
}

/**
 * Matches one kind's non-empty rows to units: by key, then by the kind's
 * primary value, then (only when the counts agree) pairwise in order.
 */
export function matchKind(mimetype: string, rows: LocalDataRow[], units: Unit[]): KindMatch {
  const spec = SPECS[mimetype];
  const live = rows.filter((r) => r.mimetype === mimetype && !isEmptyRow(mimetype, r.cells));
  const kindUnits = units.filter((u) => u.mimetype === mimetype);
  const matched: Match[] = [];
  const takenUnits = new Set<Unit>();
  const takenRows = new Set<LocalDataRow>();
  const byKey = new Map(kindUnits.map((u) => [u.key, u]));

  for (const row of live) {
    const u = row.key ? byKey.get(row.key) : undefined;
    if (u && !takenUnits.has(u)) {
      matched.push({ row, unit: u, how: 'key' });
      takenUnits.add(u);
      takenRows.add(row);
    }
  }
  for (const row of live) {
    if (takenRows.has(row)) continue;
    const p = spec.primary(row.cells);
    if (p === null) continue;
    const u = kindUnits.find((x) => !takenUnits.has(x) && spec.primary(x.cells) === p);
    if (u) {
      matched.push({ row, unit: u, how: 'value' });
      takenUnits.add(u);
      takenRows.add(row);
    }
  }
  const restRows = live.filter((r) => !takenRows.has(r));
  const restUnits = kindUnits.filter((u) => !takenUnits.has(u));
  if (restRows.length && restRows.length === restUnits.length) {
    restRows.forEach((row, i) => matched.push({ row, unit: restUnits[i], how: 'pair' }));
    return { mimetype, matched, fresh: [], missing: [], rows: live };
  }
  return { mimetype, matched, fresh: restRows, missing: restUnits, rows: live };
}

/**
 * Whether the units of a kind that lost their rows were deleted on the
 * device. Only when the kind still has rows matched by key (an in-place
 * editor removed one); when every row is keyless an editor rewrote them all
 * and a missing entry may just be one it could not show. A kind left without
 * any row is judged by the rest of the contact: keyed rows of kinds that
 * re-inserting editors rewrite mean an in-place editor did it.
 */
export function deletionsInferred(kind: KindMatch, inPlaceEvidence: boolean): boolean {
  const spec = SPECS[kind.mimetype];
  if (spec.inPlaceOnly) return true;
  if (kind.matched.some((m) => m.how === 'key')) return true;
  return kind.rows.length === 0 && inPlaceEvidence;
}

/** Keyed rows of rewritten kinds: evidence that the last editor worked in place. */
export function inPlaceEvidence(kinds: KindMatch[]): boolean {
  return kinds.some((k) => SPECS[k.mimetype].rewritten && k.matched.some((m) => m.how === 'key'));
}

/**
 * Maps the keys of the shadow's units to the new server version's keys by
 * content: equal entries first, then equal primary values, then an
 * unchanged key (an entry edited in place). Unmapped units were removed on
 * the server; unmapped new units were added.
 */
export function reconcileKeys(base: Unit[], remote: Unit[]): Map<string, string> {
  const out = new Map<string, string>();
  const kinds = new Set([...base, ...remote].map((u) => u.mimetype));
  for (const mimetype of kinds) {
    const spec = SPECS[mimetype];
    const b = base.filter((u) => u.mimetype === mimetype);
    const r = remote.filter((u) => u.mimetype === mimetype);
    const takenB = new Set<Unit>();
    const takenR = new Set<Unit>();
    const link = (x: Unit, y: Unit) => {
      out.set(x.key, y.key);
      takenB.add(x);
      takenR.add(y);
    };
    for (const x of b) {
      const y = r.find((u) => !takenR.has(u) && u.key === x.key && u.source === x.source);
      if (y) link(x, y);
    }
    for (const x of b) {
      if (takenB.has(x)) continue;
      const y = r.find((u) => !takenR.has(u) && u.source === x.source);
      if (y) link(x, y);
    }
    for (const x of b) {
      if (takenB.has(x)) continue;
      const p = spec.primary(x.cells);
      const y = p === null ? undefined : r.find((u) => !takenR.has(u) && spec.primary(u.cells) === p);
      if (y) link(x, y);
    }
    for (const x of b) {
      if (takenB.has(x)) continue;
      const y = r.find((u) => !takenR.has(u) && u.key === x.key);
      if (y) link(x, y);
    }
  }
  return out;
}
