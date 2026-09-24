import { describe, it, expect } from 'vitest';
import { translate, type MessageParams } from '../../i18n';
import type { RecurrenceRule } from '../../api/types';
import { buildRecurrenceSummary, recurrenceEndLabel, recurrenceIntervalLabel } from '../recurrence';

const t = (key: string, fallback?: string, params?: MessageParams) =>
  translate('en', key, fallback, params);

const rule = (r: Partial<RecurrenceRule>): RecurrenceRule => ({ '@type': 'RecurrenceRule', frequency: 'weekly', ...r });

describe('recurrence summary', () => {
  it('uses plurals for the interval and the occurrence count', () => {
    expect(recurrenceIntervalLabel('daily', 1, t)).toBe('Daily');
    expect(recurrenceIntervalLabel('weekly', 3, t)).toBe('Every 3 weeks');
    expect(recurrenceEndLabel(rule({ count: 1 }), t)).toBe('1 occurrence');
    expect(recurrenceEndLabel(rule({ count: 12 }), t)).toBe('12 occurrences');
  });

  it('builds the summary from the catalog fragments', () => {
    expect(buildRecurrenceSummary(rule({
      interval: 2,
      byDay: [{ day: 'we' }, { day: 'mo' }],
      count: 5,
    }), t)).toBe('Every 2 weeks on Mon, Wed · 5 occurrences');
    expect(buildRecurrenceSummary(rule({
      frequency: 'monthly',
      byDay: [{ day: 'th', nthOfPeriod: 3 }],
      until: '2027-03-01T23:59:59',
    }), t)).toBe('Monthly on the third Thursday · Until Mar 1, 2027');
    expect(buildRecurrenceSummary(rule({ frequency: 'hourly' }), t)).toBeNull();
  });
});
