import { describe, it, expect } from 'vitest';
import {
  availabilityFor,
  availabilityRange,
  availabilityStatusLabel,
  everyoneAs,
  mergeBusyBlocks,
  principalIdsFromDirectory,
  stripSegments,
} from '../availability';

const d = (s: string) => new Date(s);
const P = (a: string, b: string, busyStatus: 'confirmed' | 'tentative' | 'unavailable' | null = null) => ({
  utcStart: a, utcEnd: b, busyStatus,
});

describe('mergeBusyBlocks', () => {
  const start = d('2026-10-06T09:00:00Z');
  const end = d('2026-10-06T17:00:00Z');

  it('merges overlapping and touching blocks, sorted', () => {
    const blocks = mergeBusyBlocks([
      P('2026-10-06T12:00:00Z', '2026-10-06T13:00:00Z'),
      P('2026-10-06T10:00:00Z', '2026-10-06T11:00:00Z'),
      P('2026-10-06T10:30:00Z', '2026-10-06T12:00:00Z'),
    ], start, end);
    expect(blocks).toEqual([
      { start: d('2026-10-06T10:00:00Z').getTime(), end: d('2026-10-06T13:00:00Z').getTime(), tentative: false },
    ]);
  });

  it('clips to the range and drops blocks outside it', () => {
    const blocks = mergeBusyBlocks([
      P('2026-10-06T07:00:00Z', '2026-10-06T10:00:00Z'),
      P('2026-10-06T18:00:00Z', '2026-10-06T19:00:00Z'),
    ], start, end);
    expect(blocks).toEqual([{ start: start.getTime(), end: d('2026-10-06T10:00:00Z').getTime(), tentative: false }]);
  });

  it('a busy block beats a tentative one it overlaps', () => {
    const blocks = mergeBusyBlocks([
      P('2026-10-06T10:00:00Z', '2026-10-06T11:00:00Z', 'tentative'),
      P('2026-10-06T10:30:00Z', '2026-10-06T11:30:00Z', 'confirmed'),
    ], start, end);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tentative).toBe(false);
  });

  it('ignores malformed periods', () => {
    expect(mergeBusyBlocks([P('nope', 'x'), P('2026-10-06T11:00:00Z', '2026-10-06T10:00:00Z')], start, end)).toEqual([]);
  });
});

describe('availabilityFor', () => {
  const start = d('2026-10-06T10:00:00Z');
  const end = d('2026-10-06T11:00:00Z');
  it('is free without overlap, busy with one, tentative when only tentative', () => {
    expect(availabilityFor([P('2026-10-06T11:00:00Z', '2026-10-06T12:00:00Z')], start, end)).toBe('free');
    expect(availabilityFor([P('2026-10-06T10:30:00Z', '2026-10-06T12:00:00Z')], start, end)).toBe('busy');
    expect(availabilityFor([P('2026-10-06T10:30:00Z', '2026-10-06T12:00:00Z', 'tentative')], start, end)).toBe('tentative');
  });
});

describe('availabilityRange', () => {
  it('spans the whole local days of the event', () => {
    const r = availabilityRange(new Date(2026, 9, 6, 10), new Date(2026, 9, 6, 11))!;
    expect(r.start).toEqual(new Date(2026, 9, 6));
    expect(r.end).toEqual(new Date(2026, 9, 7));
  });
  it('is null for an invalid or very long event', () => {
    expect(availabilityRange(new Date(2026, 9, 6, 11), new Date(2026, 9, 6, 10))).toBeNull();
    expect(availabilityRange(new Date(2026, 9, 1), new Date(2026, 11, 1))).toBeNull();
  });
});

describe('stripSegments', () => {
  it('returns fractions of the event window', () => {
    const s = d('2026-10-06T10:00:00Z');
    const e = d('2026-10-06T12:00:00Z');
    const blocks = mergeBusyBlocks([P('2026-10-06T11:00:00Z', '2026-10-06T13:00:00Z')], s, e);
    expect(stripSegments(blocks, s, e)).toEqual([{ left: 0.5, width: 0.5, tentative: false }]);
  });
});

describe('availabilityStatusLabel', () => {
  const t = (key: string, fallback: string) => `${key}|${fallback}`;

  it('says what each status means, with webmail\'s keys', () => {
    expect(availabilityStatusLabel('free', t)).toBe('calendar.participants.availability.free|Available');
    expect(availabilityStatusLabel('busy', t)).toBe('calendar.participants.availability.busy|Busy');
    expect(availabilityStatusLabel('tentative', t)).toBe('calendar.participants.availability.tentative|Tentative');
    expect(availabilityStatusLabel('checking', t)).toBe('calendar.participants.availability.checking|Checking…');
  });

  it('keeps "Not a user on this server" for an address without a principal only', () => {
    expect(availabilityStatusLabel('unknown', t))
      .toBe('calendar.participants.availability.unknown|Not a user on this server');
    expect(availabilityStatusLabel('failed', t))
      .toBe("calendar.participants.availability.failed|Couldn't check availability");
  });
});

describe('everyoneAs', () => {
  it('gives every address the same status and no blocks', () => {
    expect(everyoneAs(['a@x.com', 'b@x.com'], 'checking')).toEqual({
      'a@x.com': { status: 'checking', blocks: [] },
      'b@x.com': { status: 'checking', blocks: [] },
    });
    expect(everyoneAs([], 'failed')).toEqual({});
  });
});

describe('principalIdsFromDirectory', () => {
  const people = [
    { principalId: 'p1', email: 'Dana@Example.com' },
    { principalId: '', email: 'nobody@example.com' },
  ];

  it('maps lower-cased addresses to principals of the account asked about', () => {
    const map = principalIdsFromDirectory({ directoryAccountId: 'acc-1', directoryPeople: people }, 'acc-1');
    expect(map && [...map]).toEqual([['dana@example.com', 'p1']]);
  });

  it('is null when the directory is not loaded for that account (a failed load)', () => {
    expect(principalIdsFromDirectory({ directoryAccountId: null, directoryPeople: [] }, 'acc-1')).toBeNull();
    expect(principalIdsFromDirectory({ directoryAccountId: 'acc-2', directoryPeople: people }, 'acc-1')).toBeNull();
  });
});
