import { describe, it, expect, vi } from 'vitest';
import type { CalendarEvent } from '../../api/types';
import {
  coversRange,
  createRangeLoader,
  mergeRangeEvents,
  mergedSpanLimit,
  planRangeLoad,
  type EventRange,
} from '../calendar-range-cache';

const DAY = 24 * 60 * 60 * 1000;
const YEAR = 366 * DAY;
const r = (after: string, before: string): EventRange => ({ after, before });

describe('planRangeLoad', () => {
  it('loads afresh when nothing is loaded', () => {
    expect(planRangeLoad(null, r('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'), YEAR)).toEqual({
      kind: 'replace',
    });
  });

  it('does nothing when the loaded range covers the request', () => {
    const loaded = r('2026-08-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
    expect(planRangeLoad(loaded, r('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'), YEAR)).toEqual({
      kind: 'covered',
    });
  });

  it('fetches only the new part when the window grows at the end', () => {
    const loaded = r('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    const plan = planRangeLoad(loaded, r('2026-09-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), YEAR);
    expect(plan).toEqual({
      kind: 'extend',
      pieces: [r('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')],
      union: r('2026-09-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
    });
  });

  it('fetches only the new part when the window grows at the start', () => {
    const loaded = r('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    const plan = planRangeLoad(loaded, r('2026-08-01T00:00:00.000Z', '2026-09-15T00:00:00.000Z'), YEAR);
    expect(plan).toEqual({
      kind: 'extend',
      pieces: [r('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')],
      union: r('2026-08-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
    });
  });

  it('fetches both sides when the request surrounds the loaded range', () => {
    const loaded = r('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    const plan = planRangeLoad(loaded, r('2026-08-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), YEAR);
    expect(plan.kind).toBe('extend');
    if (plan.kind !== 'extend') return;
    expect(plan.pieces).toEqual([
      r('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
      r('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
    ]);
  });

  it('extends a range that merely touches the loaded one', () => {
    const loaded = r('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    const plan = planRangeLoad(loaded, r('2026-10-01T00:00:00.000Z', '2026-10-15T00:00:00.000Z'), YEAR);
    expect(plan.kind).toBe('extend');
  });

  it('starts over for a disjoint range instead of claiming the gap', () => {
    const loaded = r('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    expect(planRangeLoad(loaded, r('2027-03-01T00:00:00.000Z', '2027-04-01T00:00:00.000Z'), YEAR).kind).toBe('replace');
    expect(planRangeLoad(loaded, r('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'), YEAR).kind).toBe('replace');
  });

  it('starts over when the union would grow past the cap', () => {
    const loaded = r('2026-01-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
    const plan = planRangeLoad(loaded, r('2026-11-01T00:00:00.000Z', '2027-03-01T00:00:00.000Z'), YEAR);
    expect(plan.kind).toBe('replace');
  });

  it('compares instants, not strings, across time-zone offsets', () => {
    const loaded = r('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    // 02:00+02:00 is the same instant as the loaded start.
    expect(planRangeLoad(loaded, r('2026-09-01T02:00:00+02:00', '2026-09-15T00:00:00.000Z'), YEAR).kind).toBe(
      'covered',
    );
  });
});

describe('coversRange', () => {
  const loaded = r('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');

  it('is true only when the whole request is loaded', () => {
    expect(coversRange(loaded, r('2026-09-10T00:00:00.000Z', '2026-09-20T00:00:00.000Z'))).toBe(true);
    expect(coversRange(loaded, loaded)).toBe(true);
    expect(coversRange(loaded, r('2026-09-10T00:00:00.000Z', '2026-10-02T00:00:00.000Z'))).toBe(false);
    expect(coversRange(null, loaded)).toBe(false);
  });
});

describe('mergedSpanLimit', () => {
  const MIN = 183 * DAY;
  const MAX = 3 * YEAR;

  it('allows twice the request, within the floor and the ceiling', () => {
    expect(mergedSpanLimit(r('2026-01-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), MIN, MAX)).toBe(2 * 304 * DAY);
    expect(mergedSpanLimit(r('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'), MIN, MAX)).toBe(MIN);
    expect(mergedSpanLimit(r('2024-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'), MIN, MAX)).toBe(MAX);
  });

  it('makes a jump away from a large window start over', () => {
    // Two years loaded; a fresh 3-month window right after it.
    const loaded = r('2025-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
    const jump = r('2026-12-20T00:00:00.000Z', '2027-03-20T00:00:00.000Z');
    expect(planRangeLoad(loaded, jump, mergedSpanLimit(jump, MIN, MAX)).kind).toBe('replace');
    // Growing that large window itself keeps merging.
    const grown = r('2025-01-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z');
    expect(planRangeLoad(loaded, grown, mergedSpanLimit(grown, MIN, MAX)).kind).toBe('extend');
  });
});

describe('mergeRangeEvents', () => {
  const ev = (id: string, title = id) => ({ id, title }) as CalendarEvent;

  it('adds the new events and keeps the loaded ones', () => {
    const merged = mergeRangeEvents([ev('a'), ev('b')], [ev('c')]);
    expect(merged.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps one copy of an event that crosses the piece boundary, the fresh one', () => {
    const merged = mergeRangeEvents([ev('a', 'old'), ev('b')], [ev('a', 'new'), ev('series:2026-10-01')]);
    expect(merged.map((e) => e.id)).toEqual(['a', 'b', 'series:2026-10-01']);
    expect(merged[0].title).toBe('new');
  });

  it('matches server-expanded occurrences by series and recurrence id, not by synthetic id', () => {
    const occurrence = (id: string, recurrenceId: string, title = id) =>
      ({ id, title, baseEventId: 'base1', recurrenceId }) as CalendarEvent;
    const merged = mergeRangeEvents(
      [occurrence('h1', '2026-09-30T09:00:00', 'old'), occurrence('h2', '2026-09-23T09:00:00')],
      [occurrence('k7', '2026-09-30T09:00:00', 'new'), occurrence('k8', '2026-10-07T09:00:00')],
    );
    expect(merged.map((e) => e.id)).toEqual(['k7', 'h2', 'k8']);
    expect(merged[0].title).toBe('new');
  });

  it('keeps occurrences of different series or accounts apart', () => {
    const a = { id: 'x1', baseEventId: 'base1', recurrenceId: '2026-09-30T09:00:00' } as CalendarEvent;
    const b = { id: 'x2', baseEventId: 'base2', recurrenceId: '2026-09-30T09:00:00' } as CalendarEvent;
    const c = { id: 'acc:x3', originalId: 'x3', accountId: 'acc', baseEventId: 'base1', recurrenceId: '2026-09-30T09:00:00' } as CalendarEvent;
    expect(mergeRangeEvents([a], [b, c])).toHaveLength(3);
  });

  it('returns the loaded array untouched when nothing new arrived', () => {
    const existing = [ev('a')];
    expect(mergeRangeEvents(existing, [])).toBe(existing);
  });
});

describe('createRangeLoader', () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => { resolve = res; });
    return { promise, resolve };
  }

  it('runs one load at a time and collapses requests made meanwhile into the latest', async () => {
    const gates: Array<{ range: EventRange; resolve: () => void }> = [];
    const load = vi.fn((range: EventRange) => {
      const d = deferred();
      gates.push({ range, resolve: d.resolve });
      return d.promise;
    });
    const busy: boolean[] = [];
    const loader = createRangeLoader(load, (b) => busy.push(b));

    const first = loader.request(r('a1', 'b1'));
    loader.request(r('a2', 'b2'));
    const last = loader.request(r('a3', 'b3'));
    expect(load).toHaveBeenCalledTimes(1);
    expect(loader.isBusy()).toBe(true);

    gates[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    expect(gates[1].range).toEqual(r('a3', 'b3'));

    gates[1].resolve();
    await Promise.all([first, last]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(loader.isBusy()).toBe(false);
    expect(busy).toEqual([true, false]);
  });

  it('ignores a repeat of the range being loaded, but not a later one', async () => {
    const load = vi.fn(async () => undefined);
    const loader = createRangeLoader(load);
    const first = loader.request(r('a', 'b'));
    loader.request(r('a', 'b'));
    await first;
    expect(load).toHaveBeenCalledTimes(1);
    // Once idle, a request runs again (the store skips a covered range).
    await loader.request(r('a', 'b'));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps going after a failed load', async () => {
    const load = vi.fn(async (range: EventRange) => {
      if (range.after === 'bad') throw new Error('offline');
    });
    const loader = createRangeLoader(load);
    const p = loader.request(r('bad', 'x'));
    loader.request(r('good', 'y'));
    await p;
    expect(load).toHaveBeenCalledTimes(2);
    expect(loader.isBusy()).toBe(false);
  });
});
