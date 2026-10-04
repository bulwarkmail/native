// Capping a crowded all-day strip (webmail calendar-week-view). The strip
// shows at most three rows until the user expands it.

export const DEFAULT_ALL_DAY_MAX_ROWS = 3;

export interface AllDayStripLayout {
  /** Rows to draw. */
  visibleRows: number;
  /** Rows left out while collapsed (webmail's "+N"). */
  hiddenCount: number;
  /** Whether a toggle is needed at all. */
  expandable: boolean;
}

/**
 * `rowCounts` holds the rows each shown day needs; days left out of the
 * week are not in it.
 */
export function allDayStripLayout(rowCounts: number[], expanded: boolean): AllDayStripLayout {
  const needed = rowCounts.reduce((max, n) => Math.max(max, n), 0);
  const expandable = needed > DEFAULT_ALL_DAY_MAX_ROWS;
  const visibleRows = expanded ? needed : Math.min(DEFAULT_ALL_DAY_MAX_ROWS, needed);
  return { visibleRows, hiddenCount: needed - visibleRows, expandable };
}

/**
 * Rows each column in `[from, to)` needs, from segments already placed on
 * the shown columns. A segment counts only for the columns it covers inside
 * the range, so one that partly overlaps it still counts there.
 */
export function allDayRowCounts(
  segments: ReadonlyArray<{ startIndex: number; span: number; row: number }>,
  from: number,
  to: number,
): number[] {
  const counts = new Array<number>(Math.max(0, to - from)).fill(0);
  for (const s of segments) {
    const end = Math.min(to, s.startIndex + s.span);
    for (let i = Math.max(from, s.startIndex); i < end; i++) counts[i - from] = Math.max(counts[i - from], s.row + 1);
  }
  return counts;
}
