import type { BusyPeriod } from '../api/types';

export type AvailabilityStatus = 'free' | 'busy' | 'tentative' | 'unknown' | 'checking';

export interface BusyBlock {
  start: number;
  end: number;
  tentative: boolean;
}

/** Longest event window asked about; beyond it availability stays unknown. */
const MAX_RANGE_DAYS = 7;

function parsed(p: BusyPeriod): { start: number; end: number; tentative: boolean } | null {
  const start = new Date(p.utcStart).getTime();
  const end = new Date(p.utcEnd).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end, tentative: p.busyStatus === 'tentative' };
}

/**
 * The busy periods clipped to [start, end), sorted, with overlapping or
 * touching ones merged. A merged block is tentative only when every period
 * in it is.
 */
export function mergeBusyBlocks(periods: BusyPeriod[], start: Date, end: Date): BusyBlock[] {
  const lo = start.getTime();
  const hi = end.getTime();
  const items: BusyBlock[] = [];
  for (const p of periods) {
    const b = parsed(p);
    if (!b || b.end <= lo || b.start >= hi) continue;
    items.push({ start: Math.max(b.start, lo), end: Math.min(b.end, hi), tentative: b.tentative });
  }
  items.sort((a, b) => a.start - b.start);
  const out: BusyBlock[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && it.start <= last.end) {
      last.end = Math.max(last.end, it.end);
      last.tentative = last.tentative && it.tentative;
    } else {
      out.push({ ...it });
    }
  }
  return out;
}

/** Status of one attendee over the window: busy wins over tentative. */
export function availabilityFor(periods: BusyPeriod[], start: Date, end: Date): 'free' | 'busy' | 'tentative' {
  let status: 'free' | 'busy' | 'tentative' = 'free';
  for (const p of periods) {
    const b = parsed(p);
    if (!b || b.start >= end.getTime() || b.end <= start.getTime()) continue;
    if (!b.tentative) return 'busy';
    status = 'tentative';
  }
  return status;
}

/**
 * What is asked of the server for an event: the whole local days it covers,
 * so moving the time within a day needs no new request. Null when the event
 * has no valid window or spans more than a week.
 */
export function availabilityRange(start: Date, end: Date): { start: Date; end: Date } | null {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;
  const from = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const to = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  if (days > MAX_RANGE_DAYS) return null;
  return { start: from, end: to };
}

export interface StripSegment {
  left: number;
  width: number;
  tentative: boolean;
}

/** Busy blocks as fractions (0..1) of the event window, for the strip. */
export function stripSegments(blocks: BusyBlock[], start: Date, end: Date): StripSegment[] {
  const lo = start.getTime();
  const span = end.getTime() - lo;
  if (span <= 0) return [];
  const out: StripSegment[] = [];
  for (const b of blocks) {
    const s = Math.max(b.start, lo);
    const e = Math.min(b.end, end.getTime());
    if (e <= s) continue;
    out.push({ left: (s - lo) / span, width: (e - s) / span, tentative: b.tentative });
  }
  return out;
}
