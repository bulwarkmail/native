import { describe, expect, it } from 'vitest';
import type { FilterRule } from '../../sieve/types';
import { generateScript } from '../../sieve/generator';
import { parseScript } from '../../sieve/parser';
import { replaceOrInsertRule } from '../quick-rules';
import {
  editorRetroSupport,
  formatPeriodBoundary,
  periodDraftOf,
  periodLabel,
  pickedBoundary,
  pickerDate,
  resolvePeriod,
  withPeriod,
  withPickedDate,
  withPickedTime,
} from '../rule-period';

const PERIOD = { activeFrom: '2026-10-05T06:00:30.000Z', activeUntil: '2026-10-16T16:00:00.000Z' };
const EXTENSIONS = ['fileinto', 'mailbox', 'relational', 'date'];

function rule(overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: 'r1',
    name: 'Away forward',
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'from', comparator: 'contains', value: '@' }],
    actions: [{ type: 'forward', value: 'kollege@example.com' }],
    stopProcessing: false,
    ...overrides,
  };
}

const t = (key: string, fallback?: string) => `${key}|${fallback ?? ''}`;

describe('periodDraftOf', () => {
  it('starts off without a period', () => {
    expect(periodDraftOf(undefined)).toEqual({ on: false, from: undefined, until: undefined });
    expect(periodDraftOf(rule())).toEqual({ on: false, from: undefined, until: undefined });
  });

  it('starts on with the saved boundaries, unchanged', () => {
    expect(periodDraftOf(rule(PERIOD))).toEqual({ on: true, from: PERIOD.activeFrom, until: PERIOD.activeUntil });
    expect(periodDraftOf(rule({ activeUntil: PERIOD.activeUntil }))).toEqual({ on: true, from: undefined, until: PERIOD.activeUntil });
  });
});

describe('resolvePeriod', () => {
  it('saves no period while it is off, whatever the fields hold', () => {
    expect(resolvePeriod({ on: false, from: 'garbage', until: undefined })).toEqual({ ok: true, activeFrom: undefined, activeUntil: undefined });
  });

  it('keeps the boundaries exactly, seconds included', () => {
    expect(resolvePeriod({ on: true, from: PERIOD.activeFrom, until: PERIOD.activeUntil }))
      .toEqual({ ok: true, ...PERIOD });
  });

  it('allows an open end', () => {
    expect(resolvePeriod({ on: true, from: PERIOD.activeFrom })).toEqual({ ok: true, activeFrom: PERIOD.activeFrom, activeUntil: undefined });
    expect(resolvePeriod({ on: true, until: PERIOD.activeUntil })).toEqual({ ok: true, activeFrom: undefined, activeUntil: PERIOD.activeUntil });
  });

  it('refuses a period with neither end', () => {
    expect(resolvePeriod({ on: true })).toEqual({ ok: false, error: 'empty' });
  });

  it('refuses a boundary the generator would drop the rule for', () => {
    expect(resolvePeriod({ on: true, from: '2026-10-05T06:00' })).toEqual({ ok: false, error: 'invalid' });
    expect(resolvePeriod({ on: true, until: '+010000-01-01T00:00:00.000Z' })).toEqual({ ok: false, error: 'invalid' });
    expect(resolvePeriod({ on: true, from: PERIOD.activeFrom, until: '9999-12-31T23:59-01:00' })).toEqual({ ok: false, error: 'invalid' });
  });

  it('refuses an end at or before the start', () => {
    expect(resolvePeriod({ on: true, from: PERIOD.activeUntil, until: PERIOD.activeFrom })).toEqual({ ok: false, error: 'order' });
    expect(resolvePeriod({ on: true, from: PERIOD.activeFrom, until: PERIOD.activeFrom })).toEqual({ ok: false, error: 'order' });
  });
});

describe('editing a rule keeps its period', () => {
  // The modal's save: seed the draft from the rule, resolve it, and build the
  // saved rule from the edited fields.
  function saveFromModal(start: FilterRule, edited: Partial<FilterRule>): FilterRule {
    const resolved = resolvePeriod(periodDraftOf(start));
    if (!resolved.ok) throw new Error(resolved.error);
    const { id, enabled, matchType, conditions, actions, stopProcessing } = start;
    return withPeriod({ id, enabled, matchType, conditions, actions, stopProcessing, name: start.name, ...edited }, resolved);
  }

  it('changing only the name keeps the period, through a merge and a wholesale replace', () => {
    const before = rule(PERIOD);
    const saved = saveFromModal(before, { name: 'Renamed' });
    expect(saved).toMatchObject({ name: 'Renamed', ...PERIOD });

    // FilterSettings merges into the stored rule (filter-store updateRule).
    expect({ ...before, ...saved }).toMatchObject({ name: 'Renamed', ...PERIOD });
    // The rule-from-message editor replaces it wholesale.
    const [replaced] = replaceOrInsertRule([before], saved);
    expect(replaced).toMatchObject({ name: 'Renamed', ...PERIOD });

    // And the period survives the script round trip.
    const parsed = parseScript(generateScript([replaced], undefined, { extensions: EXTENSIONS }));
    expect(parsed.isOpaque).toBe(false);
    expect(parsed.rules[0]).toMatchObject({ name: 'Renamed', ...PERIOD });
  });

  it('switching the period off clears it from the stored rule on a merge', () => {
    const before = rule(PERIOD);
    const resolved = resolvePeriod({ on: false, from: PERIOD.activeFrom, until: PERIOD.activeUntil });
    if (!resolved.ok) throw new Error('unexpected');
    const saved = withPeriod({ name: 'Away forward' }, resolved);
    expect('activeFrom' in saved && 'activeUntil' in saved).toBe(true);
    const merged = { ...before, ...saved };
    expect(merged.activeFrom).toBeUndefined();
    expect(merged.activeUntil).toBeUndefined();
  });
});

describe('editorRetroSupport', () => {
  const conditions = rule().conditions;
  const actions = [{ type: 'mark_read' as const }];

  it('never offers old mail for a rule with a period, even one not filled in yet', () => {
    expect(editorRetroSupport({ conditions, actions }, { on: true })).toEqual({ ok: false, reason: 'period' });
    expect(editorRetroSupport({ conditions, actions }, { on: true, from: PERIOD.activeFrom })).toEqual({ ok: false, reason: 'period' });
  });

  it('decides by the conditions and actions without one', () => {
    expect(editorRetroSupport({ conditions, actions }, { on: false, from: PERIOD.activeFrom })).toEqual({ ok: true });
    expect(editorRetroSupport({ conditions, actions: [{ type: 'forward', value: 'x@y.z' }] }, { on: false }))
      .toEqual({ ok: false, reason: 'action' });
  });
});

describe('picker dates', () => {
  it('shows a saved boundary as its moment, and a fallback otherwise', () => {
    expect(pickerDate(PERIOD.activeFrom, 0).getTime()).toBe(Date.parse(PERIOD.activeFrom));
    const fallback = Date.parse('2026-10-07T09:41:27.500Z');
    const shown = pickerDate(undefined, fallback);
    // Whole minutes: what a picker can show.
    expect(shown.getTime()).toBe(Date.parse('2026-10-07T09:41:00.000Z'));
    expect(pickerDate('not a date', fallback).getTime()).toBe(shown.getTime());
  });

  it('stores a pick as ISO UTC, and keeps the saved boundary when the same moment is picked', () => {
    expect(pickedBoundary(new Date('2026-10-05T08:00:00+02:00'))).toBe('2026-10-05T06:00:00.000Z');
    const sameMoment = new Date(Date.parse('2026-10-05T06:00:30Z'));
    expect(pickedBoundary(sameMoment, '2026-10-05T08:00:30+02:00')).toBe('2026-10-05T08:00:30+02:00');
  });

  it('turns a moment past year 9999 into a boundary that blocks Save, and ignores an invalid date', () => {
    const late = pickedBoundary(new Date(Date.UTC(10000, 0, 1)));
    expect(late).not.toBeNull();
    expect(resolvePeriod({ on: true, until: late! })).toEqual({ ok: false, error: 'invalid' });
    expect(pickedBoundary(new Date(NaN))).toBeNull();
  });

  it('combines the date step with the time step (Android)', () => {
    const base = new Date(2026, 9, 5, 8, 15, 30);
    const day = withPickedDate(base, new Date(2026, 11, 24, 3, 3, 3));
    expect([day.getFullYear(), day.getMonth(), day.getDate(), day.getHours(), day.getMinutes()]).toEqual([2026, 11, 24, 8, 15]);
    const time = withPickedTime(day, new Date(2000, 0, 1, 17, 45, 59));
    expect([time.getFullYear(), time.getMonth(), time.getDate(), time.getHours(), time.getMinutes(), time.getSeconds()])
      .toEqual([2026, 11, 24, 17, 45, 0]);
    // The base is not changed.
    expect(base.getMonth()).toBe(9);
  });
});

describe('periodLabel', () => {
  const at = (iso: string) => Date.parse(iso);

  it('is null without a period', () => {
    expect(periodLabel(rule(), { t, timeFormat: '24h', now: 0 })).toBeNull();
  });

  it('shows scheduled, active and expired for a rule that is on', () => {
    const r = rule(PERIOD);
    expect(periodLabel(r, { t, timeFormat: '24h', now: at('2026-10-01T00:00:00Z') })?.status)
      .toBe('settings.filters.period_status_scheduled|scheduled');
    expect(periodLabel(r, { t, timeFormat: '24h', now: at('2026-10-10T00:00:00Z') })?.status)
      .toBe('settings.filters.period_status_active|active');
    expect(periodLabel(r, { t, timeFormat: '24h', now: at('2026-11-01T00:00:00Z') })?.status)
      .toBe('settings.filters.period_status_expired|expired');
  });

  it('shows no status for a rule that is off', () => {
    const label = periodLabel(rule({ ...PERIOD, enabled: false }), { t, timeFormat: '24h', now: at('2026-10-10T00:00:00Z') });
    expect(label?.status).toBeNull();
    expect(label?.range).toContain(' – ');
  });

  it('shows an open end as an ellipsis', () => {
    const label = periodLabel(rule({ activeUntil: PERIOD.activeUntil }), { t, timeFormat: '24h', now: 0 });
    expect(label?.range.startsWith('… – ')).toBe(true);
    expect(label?.range).toContain('2026');
  });
});

describe('formatPeriodBoundary', () => {
  it('formats a usable boundary with its year, and anything else as an ellipsis', () => {
    expect(formatPeriodBoundary(PERIOD.activeUntil, '24h')).toContain('2026');
    expect(formatPeriodBoundary(undefined, '24h')).toBe('…');
    expect(formatPeriodBoundary('2026-10-05', '24h')).toBe('…');
  });
});
