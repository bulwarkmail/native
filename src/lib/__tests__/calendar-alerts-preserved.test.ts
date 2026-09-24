import { describe, it, expect } from 'vitest';
import { formatReminder, preservedAlerts, remindersToAlerts } from '../calendar-alerts';
import { formatMessage, type MessageParams } from '../../i18n/format';

describe('preservedAlerts / remindersToAlerts', () => {
  const alerts = {
    a: { trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' }, action: 'display' },
    abs: { trigger: { '@type': 'AbsoluteTrigger', when: '2026-03-01T08:00:00Z' }, action: 'display' },
    end: { trigger: { '@type': 'OffsetTrigger', offset: '-PT5M', relativeTo: 'end' }, action: 'display' },
    mail: { trigger: { '@type': 'OffsetTrigger', offset: '-PT1H' }, action: 'email' },
  };

  it('keeps alerts the picker cannot represent', () => {
    expect(Object.keys(preservedAlerts(alerts)).sort()).toEqual(['abs', 'end', 'mail']);
    expect(preservedAlerts(undefined)).toEqual({});
  });

  it('rebuilds the picker alerts on top of the preserved ones without key clashes', () => {
    const rebuilt = remindersToAlerts([{ minutesBefore: 10 }, { minutesBefore: 0 }], preservedAlerts(alerts))!;
    expect(Object.keys(rebuilt).sort()).toEqual(['abs', 'end', 'mail', 'reminder-1', 'reminder-2']);
    expect(rebuilt['reminder-1'].trigger).toEqual({ '@type': 'OffsetTrigger', offset: '-PT10M', relativeTo: 'start' });
    expect(rebuilt['reminder-2'].trigger.offset).toBe('PT0S');
    expect(rebuilt.abs).toBe(alerts.abs);
  });

  it('returns undefined only when nothing is left', () => {
    expect(remindersToAlerts([], {})).toBeUndefined();
    expect(Object.keys(remindersToAlerts([], preservedAlerts(alerts))!)).toHaveLength(3);
  });
});

describe('formatReminder', () => {
  it('falls back to English plurals', () => {
    expect(formatReminder(0)).toBe('At time of event');
    expect(formatReminder(1)).toBe('1 minute before');
    expect(formatReminder(45)).toBe('45 minutes before');
    expect(formatReminder(120)).toBe('2 hours before');
    expect(formatReminder(60 * 24)).toBe('1 day before');
    expect(formatReminder(60 * 24 * 14)).toBe('2 weeks before');
  });

  it('hands the count to the translation, which picks the plural form', () => {
    const t = (key: string, fallback?: string, params?: MessageParams) =>
      key === 'calendar.alerts.hours_before'
        ? formatMessage('{count, plural, one {# Stunde vorher} other {# Stunden vorher}}', params, 'de')
        : formatMessage(fallback ?? key, params, 'en');
    expect(formatReminder(120, t)).toBe('2 Stunden vorher');
    expect(formatReminder(60, t)).toBe('1 Stunde vorher');
    expect(formatReminder(5, t)).toBe('5 minutes before');
  });
});
