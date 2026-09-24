import type { CalendarEvent } from '../api/types';
import { isServerRecurrenceInstance } from './recurrence-instances';

/** A loaded events window: ISO instants, `after` inclusive, `before` exclusive. */
export interface EventRange {
  after: string;
  before: string;
}

/**
 * How to bring a requested range in on top of what is loaded:
 * - `covered`: nothing to fetch.
 * - `extend`: fetch only `pieces` (the parts outside the loaded range) and
 *   merge them in; the loaded range becomes `union`.
 * - `replace`: load the requested range afresh — it doesn't touch the
 *   loaded one, or the union would grow past `maxSpanMs`.
 */
export type RangeLoadPlan =
  | { kind: 'covered' }
  | { kind: 'extend'; pieces: EventRange[]; union: EventRange }
  | { kind: 'replace' };

function ms(iso: string): number {
  return new Date(iso).getTime();
}

export function planRangeLoad(
  loaded: EventRange | null | undefined,
  requested: EventRange,
  maxSpanMs: number,
): RangeLoadPlan {
  if (!loaded) return { kind: 'replace' };
  const la = ms(loaded.after);
  const lb = ms(loaded.before);
  const ra = ms(requested.after);
  const rb = ms(requested.before);
  if ([la, lb, ra, rb].some((n) => isNaN(n))) return { kind: 'replace' };
  if (la <= ra && lb >= rb) return { kind: 'covered' };
  // Disjoint (a gap between them): a union would claim the gap is loaded.
  if (rb < la || ra > lb) return { kind: 'replace' };
  const union: EventRange = {
    after: ra < la ? requested.after : loaded.after,
    before: rb > lb ? requested.before : loaded.before,
  };
  if (ms(union.before) - ms(union.after) > maxSpanMs) return { kind: 'replace' };
  const pieces: EventRange[] = [];
  if (ra < la) pieces.push({ after: requested.after, before: loaded.after });
  if (rb > lb) pieces.push({ after: loaded.before, before: requested.before });
  return { kind: 'extend', pieces, union };
}

/**
 * What makes two loaded events the same one. Server-expanded occurrences
 * (lib/recurrence-instances) are matched by base event and recurrence id:
 * their synthetic ids are positional, so the same occurrence is not
 * guaranteed the same id in two separately queried ranges.
 */
export function rangeEventKey(event: CalendarEvent): string {
  if (isServerRecurrenceInstance(event)) {
    return `occurrence|${event.accountId ?? ''}|${event.baseEventId}|${event.recurrenceId ?? ''}`;
  }
  return `id|${event.id}`;
}

/**
 * Merge the events of newly loaded pieces into the loaded ones. An event
 * that overlaps a piece boundary (or an occurrence of a series expanded in
 * both) arrives twice; the fresh copy wins.
 */
export function mergeRangeEvents(
  existing: CalendarEvent[],
  incoming: CalendarEvent[],
): CalendarEvent[] {
  if (incoming.length === 0) return existing;
  const fresh = new Map<string, CalendarEvent>();
  for (const event of incoming) fresh.set(rangeEventKey(event), event);
  const out: CalendarEvent[] = [];
  for (const event of existing) {
    const key = rangeEventKey(event);
    const replacement = fresh.get(key);
    if (replacement) {
      out.push(replacement);
      fresh.delete(key);
    } else {
      out.push(event);
    }
  }
  for (const event of fresh.values()) out.push(event);
  return out;
}

/** True when `loaded` spans all of `requested` (compared as instants). */
export function coversRange(loaded: EventRange | null | undefined, requested: EventRange): boolean {
  return planRangeLoad(loaded, requested, Number.POSITIVE_INFINITY).kind === 'covered';
}

/**
 * How large the loaded range may grow by merging when `requested` is asked
 * for: twice the request, but at least `minMs` and at most `maxMs`. Growing a
 * scrolled window stays cached; jumping away from a large window starts
 * over instead of dragging (and refreshing) all of it along.
 */
export function mergedSpanLimit(requested: EventRange, minMs: number, maxMs: number): number {
  const span = ms(requested.before) - ms(requested.after);
  if (isNaN(span)) return minMs;
  return Math.min(maxMs, Math.max(minMs, 2 * span));
}

export function sameRange(a: EventRange | null | undefined, b: EventRange | null | undefined): boolean {
  return !!a && !!b && a.after === b.after && a.before === b.before;
}

/**
 * Serializes range loads: at most one runs at a time, and requests made
 * meanwhile collapse into the latest, which runs once the current load has
 * finished. `onBusyChange` reports when the loader starts and goes idle.
 */
export function createRangeLoader(
  load: (range: EventRange) => Promise<void>,
  onBusyChange?: (busy: boolean) => void,
): { request: (range: EventRange) => Promise<void>; isBusy: () => boolean } {
  let wanted: EventRange | null = null;
  let running: Promise<void> | null = null;

  const run = async () => {
    onBusyChange?.(true);
    try {
      let last: EventRange | null = null;
      while (wanted && !sameRange(wanted, last)) {
        last = wanted;
        try {
          await load(last);
        } catch {
          // The store reports failures through its error state.
        }
      }
    } finally {
      running = null;
      onBusyChange?.(false);
    }
  };

  return {
    request(range) {
      wanted = range;
      if (!running) running = run();
      return running;
    },
    isBusy: () => running !== null,
  };
}
