import { describe, expect, it } from 'vitest';
import type { RecurrenceRule } from '../../../api/types';
import {
  canonicalRRule,
  isRuleRepresentable,
  parseUntil,
  ruleToRRule,
  rruleToRule,
  unrepresentableParts,
  untilUtc,
} from '../../calendar/rrule';
import { aospRruleValid } from '../fakes/fake-provider';
import { exdateSet, formatExdate, parseExdate } from '../../calendar/exdate';

const timed = { allDay: false, zone: 'Europe/Berlin' };
const allDay = { allDay: true, zone: 'UTC' };

describe('calendar/rrule', () => {
  it.each<[string, RecurrenceRule, string]>([
    ['daily', { frequency: 'daily' }, 'FREQ=DAILY'],
    ['interval', { frequency: 'weekly', interval: 2 }, 'FREQ=WEEKLY;INTERVAL=2'],
    ['count', { frequency: 'daily', count: 10 }, 'FREQ=DAILY;COUNT=10'],
    ['byDay', { frequency: 'weekly', byDay: [{ day: 'mo' }, { day: 'we' }] }, 'FREQ=WEEKLY;BYDAY=MO,WE'],
    ['nth weekday', { frequency: 'monthly', byDay: [{ day: 'fr', nthOfPeriod: -1 }, { day: 'tu', nthOfPeriod: 2 }] }, 'FREQ=MONTHLY;BYDAY=-1FR,2TU'],
    ['byMonthDay', { frequency: 'monthly', byMonthDay: [1, 15, -1] }, 'FREQ=MONTHLY;BYMONTHDAY=1,15,-1'],
    ['byMonth', { frequency: 'yearly', byMonth: ['3', '10'] }, 'FREQ=YEARLY;BYMONTH=3,10'],
    ['byYearDay', { frequency: 'yearly', byYearDay: [1, -1] }, 'FREQ=YEARLY;BYYEARDAY=1,-1'],
    ['byWeekNo', { frequency: 'yearly', byWeekNo: [20], byDay: [{ day: 'mo' }] }, 'FREQ=YEARLY;BYDAY=MO;BYWEEKNO=20'],
    ['byHour/Minute/Second', { frequency: 'daily', byHour: [9, 17], byMinute: [0, 30], bySecond: [0] }, 'FREQ=DAILY;BYSECOND=0;BYMINUTE=0,30;BYHOUR=9,17'],
    ['bySetPosition', { frequency: 'monthly', byDay: [{ day: 'mo' }, { day: 'tu' }], bySetPosition: [-1] }, 'FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1'],
    ['wkst', { frequency: 'weekly', interval: 2, firstDayOfWeek: 'su' }, 'FREQ=WEEKLY;INTERVAL=2;WKST=SU'],
  ])('writes and reads back %s', (_name, rule, rrule) => {
    const written = ruleToRRule(rule, timed)!;
    expect(written).toBe(rrule);
    expect(aospRruleValid(written)).toBe(true);
    expect(rruleToRule(written, timed)).toEqual(rule);
  });

  it('leaves out the defaults: INTERVAL=1, WKST=MO, rscale gregorian, skip omit', () => {
    expect(ruleToRRule({ frequency: 'weekly', interval: 1, firstDayOfWeek: 'mo', rscale: 'gregorian', skip: 'omit' }, timed)).toBe('FREQ=WEEKLY');
  });

  it('writes UNTIL as UTC for timed rules, converted from the event zone, and as a date for all-day rules', () => {
    expect(ruleToRRule({ frequency: 'daily', until: '2026-10-30T09:00:00' }, timed)).toBe('FREQ=DAILY;UNTIL=20261030T080000Z');
    expect(ruleToRRule({ frequency: 'daily', until: '2026-07-30T09:00:00' }, timed)).toBe('FREQ=DAILY;UNTIL=20260730T070000Z');
    expect(ruleToRRule({ frequency: 'daily', until: '2026-10-30T23:59:59' }, allDay)).toBe('FREQ=DAILY;UNTIL=20261030');
    expect(rruleToRule('FREQ=DAILY;UNTIL=20261030T080000Z', timed)).toEqual({ frequency: 'daily', until: '2026-10-30T09:00:00' });
    expect(rruleToRule('FREQ=DAILY;UNTIL=20261030', allDay)).toEqual({ frequency: 'daily', until: '2026-10-30T00:00:00' });
  });

  it('converts UNTIL across DST edges', () => {
    // New York spring gap: 02:30 does not exist, UNTIL moves forward like the instance does.
    expect(ruleToRRule({ frequency: 'daily', until: '2026-03-08T02:30:00' }, { allDay: false, zone: 'America/New_York' })).toBe(
      'FREQ=DAILY;UNTIL=20260308T073000Z',
    );
    // Berlin autumn overlap: the first instant.
    expect(ruleToRRule({ frequency: 'daily', until: '2026-10-25T02:30:00' }, timed)).toBe('FREQ=DAILY;UNTIL=20261025T003000Z');
    expect(untilUtc({ frequency: 'daily', until: '2026-10-25T02:30:00' }, timed)).toBe(Date.parse('2026-10-25T00:30:00Z'));
    // Sydney's autumn overlap.
    expect(ruleToRRule({ frequency: 'weekly', until: '2026-04-05T02:30:00' }, { allDay: false, zone: 'Australia/Sydney' })).toBe(
      'FREQ=WEEKLY;UNTIL=20260404T153000Z',
    );
  });

  it('reads rules the way device apps write them', () => {
    expect(rruleToRule('rrule:freq=weekly;byday=mo,we;x-fossify=1', timed)).toEqual({ frequency: 'weekly', byDay: [{ day: 'mo' }, { day: 'we' }] });
    // Etar writes all-day UNTIL as a UTC date-time (the instance start minus 1 s).
    expect(rruleToRule('FREQ=DAILY;UNTIL=20261015T235959Z', allDay)).toEqual({ frequency: 'daily', until: '2026-10-15T00:00:00' });
    // A floating UNTIL is UTC to AOSP, and so is a DATE on a timed rule.
    expect(parseUntil('20261030T080000', timed)).toBe('2026-10-30T09:00:00');
    expect(parseUntil('20261030', timed)).toBe('2026-10-30T01:00:00');
    // COUNT wins over UNTIL next to it.
    expect(rruleToRule('FREQ=DAILY;COUNT=5;UNTIL=20261030T080000Z', timed)).toEqual({ frequency: 'daily', count: 5 });
    // Several rules: the first one.
    expect(rruleToRule('FREQ=DAILY\nFREQ=WEEKLY', timed)).toEqual({ frequency: 'daily' });
    expect(rruleToRule('INTERVAL=2', timed)).toBeNull();
    expect(rruleToRule('FREQ=FORTNIGHTLY', timed)).toBeNull();
    expect(rruleToRule(null, timed)).toBeNull();
  });

  it('tells rules AOSP cannot hold', () => {
    expect(unrepresentableParts({ frequency: 'yearly', rscale: 'chinese' })).toEqual(['rscale']);
    expect(unrepresentableParts({ frequency: 'monthly', skip: 'forward' })).toEqual(['skip']);
    expect(unrepresentableParts({ frequency: 'yearly', byMonth: ['5L'] })).toEqual(['byMonth']);
    expect(isRuleRepresentable({ frequency: 'yearly', rscale: 'GREGORIAN', skip: 'omit' })).toBe(true);
    // Never RSCALE or SKIP; a leap month is dropped, not written.
    const written = ruleToRRule({ frequency: 'yearly', rscale: 'chinese', skip: 'forward', byMonth: ['5L', '6'] }, timed)!;
    expect(written).toBe('FREQ=YEARLY;BYMONTH=6');
    expect(aospRruleValid(written)).toBe(true);
  });

  it('compares rules by meaning', () => {
    expect(canonicalRRule('FREQ=WEEKLY;BYDAY=WE,MO;INTERVAL=1;WKST=MO')).toBe(canonicalRRule('freq=weekly;byday=mo,we'));
    expect(canonicalRRule('FREQ=WEEKLY;BYDAY=MO')).not.toBe(canonicalRRule('FREQ=WEEKLY;BYDAY=TU'));
    expect(canonicalRRule(null)).toBe('');
  });
});

describe('calendar/exdate', () => {
  it('writes excluded instances as UTC date-times, or dates for all-day events', () => {
    expect(formatExdate(['2026-10-14T09:00:00', '2026-10-12T09:00:00'], timed)).toBe('20261012T070000Z,20261014T070000Z');
    expect(formatExdate(['2026-10-12T00:00:00'], allDay)).toBe('20261012');
    expect(formatExdate([], timed)).toBeNull();
  });

  it('reads every form back into recurrence ids in the event zone', () => {
    expect(parseExdate('20261012T070000Z,20261014T070000Z', timed)).toEqual(['2026-10-12T09:00:00', '2026-10-14T09:00:00']);
    // A zone prefix, a floating time without one (UTC), several lines.
    expect(parseExdate('Europe/Berlin;20261012T090000\n20261014T070000', timed)).toEqual(['2026-10-12T09:00:00', '2026-10-14T09:00:00']);
    expect(parseExdate('20261012,20261013T000000Z', allDay)).toEqual(['2026-10-12T00:00:00', '2026-10-13T00:00:00']);
    expect(parseExdate('garbage,20261012T070000Z', timed)).toEqual(['2026-10-12T09:00:00']);
    expect(parseExdate(null, timed)).toEqual([]);
  });

  it('compares columns by the instants they name', () => {
    expect([...exdateSet('Europe/Berlin;20261012T090000')]).toEqual(['20261012T070000Z']);
    expect([...exdateSet('20261012T000000Z', true)]).toEqual(['20261012']);
  });
});
