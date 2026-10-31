// Free-text search conditions for Email/query, ported from the webmail's
// lib/jmap/search-utils.ts (5967a1c4) so both clients send the same filters.

/**
 * A KB size field (the filter panel's custom size) as a positive byte count
 * for Email/query's minSize / maxSize (RFC 8621 §4.4.1), or null when unset
 * or not a positive number (webmail lib/jmap/search-utils.ts, 720e14622).
 */
export function sizeFilterBytes(value: string | undefined): number | null {
  const kb = Number(value);
  if (!value || !Number.isFinite(kb) || kb <= 0) return null;
  return Math.round(kb * 1024);
}

/** The size presets of the filter panel, in MB: "Larger than 1 MB" and so on. */
export const SIZE_PRESETS_MB = [1, 5, 10, 25] as const;

/**
 * Which size choice the filter panel shows for the KB bounds: none set, a
 * "Larger than N MB" preset, or a custom range.
 */
export function sizePresetOf(minSizeKb: string | undefined, maxSizeKb: string | undefined): string {
  if (!minSizeKb && !maxSizeKb) return 'any';
  if (!maxSizeKb) {
    const mb = SIZE_PRESETS_MB.find((m) => String(m * 1024) === minSizeKb);
    if (mb) return `mb${mb}`;
  }
  return 'custom';
}

/** Filter properties whose value the server reads as free text. */
type Translate = (key: string, fallback: string, values?: Record<string, string | number>) => string;

/**
 * The chip for a custom size bound: "Larger than 1 KB". It read "Larger than
 * (KB): 1 KB", built from the field's placeholder.
 */
export function sizeChipLabel(bound: 'min' | 'max', kb: string, t: Translate): string {
  return bound === 'min'
    ? t('advanced_search.larger_than_kb', 'Larger than {size} KB', { size: kb })
    : t('advanced_search.smaller_than_kb', 'Smaller than {size} KB', { size: kb });
}

/**
 * The filter button's name for screen readers, with the number of active
 * filters in it. It was given as an accessibility value, which Android left
 * in the description ("Advanced search filters, 1") once the value went away
 * after Clear; a changed label always replaces the description.
 */
export function filterButtonLabel(count: number, t: Translate): string {
  const name = t('advanced_search.advanced_filters_tooltip', 'Advanced search filters');
  return count > 0 ? t('advanced_search.advanced_filters_count', '{name}, {count} active', { name, count }) : name;
}

/**
 * Whether "Custom size" stays picked. With the sheet closed and no bound
 * left (the chip removed, the search cleared) it goes back to "Any size":
 * it stayed picked, with empty fields, after the size chip was removed.
 */
export function keepCustomSize(
  customSize: boolean,
  sheetOpen: boolean,
  minSizeKb: string | undefined,
  maxSizeKb: string | undefined,
): boolean {
  if (!customSize) return false;
  return sheetOpen || !!minSizeKb || !!maxSizeKb;
}

/**
 * Where the filter sheet sits: clear of the status bar, the navigation bar
 * and the keyboard, and never taller than the space between them, so its
 * body scrolls instead of running off the bottom (Pixel 7: the last row was
 * cut off) and the size fields stay above the keyboard. `height` is the
 * sheet's window; `shrunkBy` how much the window already gave way to the
 * keyboard (adjustResize, which an edge-to-edge window doesn't get), so the
 * keyboard is not taken off twice.
 */
export function filterSheetFrame(
  height: number,
  insetTop: number,
  insetBottom: number,
  keyboard: number,
  gap: number,
  shrunkBy = 0,
): { paddingTop: number; paddingBottom: number; maxHeight: number } {
  const paddingTop = insetTop + gap;
  const paddingBottom = Math.max(insetBottom, keyboard - Math.max(0, shrunkBy)) + gap;
  return { paddingTop, paddingBottom, maxHeight: Math.max(120, height - paddingTop - paddingBottom) };
}

export type SearchTextProperty = 'text' | 'from' | 'to' | 'subject' | 'body';

// A "quoted phrase" (the closing quote may still be missing while the user
// types) or a run of non-space characters.
const SEARCH_PART_RE = /"([^"]*)"?|(\S+)/g;

/**
 * Splits typed search text into the values to send as separate text
 * conditions, ANDed together.
 *
 * Stalwart 1.0 reads a whole filter value that starts and ends with `"` (or
 * `'`) as one exact phrase, and a value ending in `*` as one prefix over
 * everything before it (not split into words, at most 16 bytes). Sent as one
 * value, `"annual report" 2024 "draft"` is a single phrase and
 * `project budg*` a prefix containing a space: both find nothing. So:
 * - every `"phrase"` is a part of its own, kept quoted; empty quotes are
 *   dropped;
 * - every word ending in `*` is a part of its own; a lone `*` is dropped;
 * - all other words stay together in one part, joined by single spaces, so
 *   they still have to match within one field and the server detects the
 *   language on the whole string. Without quotes or stars, that part is the
 *   query as typed.
 * Outer `'` quotes are stripped from that last part, since they would make
 * it a phrase too. The built-in index of 0.16 has neither phrases nor
 * prefixes: a quoted part is an AND of its words, matched without stemming,
 * and `*` only separates words.
 */
export function splitSearchText(raw: string): string[] {
  const parts: string[] = [];
  const words: string[] = [];
  let wordsAt = -1;
  for (const [, phrase, word] of raw.matchAll(SEARCH_PART_RE)) {
    if (phrase !== undefined) {
      const trimmed = phrase.trim();
      if (trimmed) parts.push(`"${trimmed}"`);
    } else if (word.endsWith('*')) {
      if (!/^\*+$/.test(word)) parts.push(word);
    } else {
      if (wordsAt < 0) wordsAt = parts.length;
      words.push(word);
    }
  }
  let bare = words.join(' ');
  while (bare.length > 1 && bare.startsWith("'") && bare.endsWith("'")) {
    bare = bare.slice(1, -1).trim();
  }
  // Keep the parts in the order they were typed.
  if (bare) parts.splice(wordsAt, 0, bare);
  return parts;
}

/**
 * One `{ [property]: part }` condition per part of `raw` (see
 * splitSearchText). When no part is left (`""`, a lone `*`), the input is
 * sent as one condition as before: dropping it would widen the search to
 * every message.
 */
export function textConditions(raw: string, property: SearchTextProperty = 'text'): Record<string, string>[] {
  const parts = splitSearchText(raw);
  if (parts.length === 0) return [{ [property]: raw.trim() }];
  return parts.map((part) => ({ [property]: part }));
}

/** `textConditions` as one filter: the single condition, or an AND of them. */
export function textFilter(raw: string, property: SearchTextProperty = 'text'): Record<string, unknown> {
  const conditions = textConditions(raw, property);
  return conditions.length === 1 ? conditions[0] : { operator: 'AND', conditions };
}
