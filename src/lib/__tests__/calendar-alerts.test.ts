import { describe, it, expect } from 'vitest';
import {
  offsetToMinutesBefore,
  minutesBeforeToOffset,
  alertsToReminders,
  remindersToAlerts,
  formatReminder,
  preservedAlerts,
  reminderFieldsToSave,
  withOwnAlertIds,
} from '../calendar-alerts';
import { translate, type MessageParams } from '../../i18n';
import type { Alert } from '../../api/types';

describe('calendar-alerts', () => {
  describe('offsetToMinutesBefore', () => {
    it('parses minute offsets', () => {
      expect(offsetToMinutesBefore('-PT15M')).toBe(15);
      expect(offsetToMinutesBefore('-PT30M')).toBe(30);
    });
    it('parses hour and day offsets', () => {
      expect(offsetToMinutesBefore('-PT1H')).toBe(60);
      expect(offsetToMinutesBefore('-P1D')).toBe(60 * 24);
    });
    it('treats PT0S as at-time (0)', () => {
      expect(offsetToMinutesBefore('PT0S')).toBe(0);
    });
    it('returns negative minutesBefore for post-start offsets', () => {
      expect(offsetToMinutesBefore('PT10M')).toBe(-10);
    });
    it('returns null for garbage', () => {
      expect(offsetToMinutesBefore('nonsense')).toBeNull();
    });
  });

  describe('minutesBeforeToOffset', () => {
    it('round-trips through offsetToMinutesBefore', () => {
      for (const m of [0, 5, 15, 30, 60, 120, 60 * 24, 60 * 24 * 7]) {
        expect(offsetToMinutesBefore(minutesBeforeToOffset(m))).toBe(m);
      }
    });
    it('emits PT0S at time of event', () => {
      expect(minutesBeforeToOffset(0)).toBe('PT0S');
    });
  });

  describe('alertsToReminders / remindersToAlerts', () => {
    it('extracts and de-dupes reminders, sorted by lead time desc', () => {
      const reminders = alertsToReminders({
        a: { trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' }, action: 'display' },
        b: { trigger: { '@type': 'OffsetTrigger', offset: '-P1D' }, action: 'display' },
        c: { trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' }, action: 'display' },
      });
      expect(reminders).toEqual([{ minutesBefore: 60 * 24 }, { minutesBefore: 15 }]);
    });

    it('builds an alerts map from reminders', () => {
      const alerts = remindersToAlerts([{ minutesBefore: 15 }, { minutesBefore: 0 }]);
      expect(alerts && Object.keys(alerts)).toHaveLength(2);
      const offsets = Object.values(alerts!).map((a) => a.trigger.offset);
      expect(offsets).toContain('-PT15M');
      expect(offsets).toContain('PT0S');
    });

    it('returns undefined for an empty reminder list', () => {
      expect(remindersToAlerts([])).toBeUndefined();
    });

    it('round-trips alerts → reminders → alerts', () => {
      const reminders = [{ minutesBefore: 60 }, { minutesBefore: 10 }];
      const back = alertsToReminders(remindersToAlerts(reminders));
      expect(back).toEqual([{ minutesBefore: 60 }, { minutesBefore: 10 }]);
    });
  });

  describe('formatReminder', () => {
    it('formats common offsets', () => {
      expect(formatReminder(0)).toBe('At time of event');
      expect(formatReminder(15)).toBe('15 minutes before');
      expect(formatReminder(60)).toBe('1 hour before');
      expect(formatReminder(60 * 24)).toBe('1 day before');
      expect(formatReminder(60 * 24 * 7)).toBe('1 week before');
      expect(formatReminder(-1)).toBe('1 minute after');
      expect(formatReminder(-30)).toBe('30 minutes after');
    });

    it('uses the catalog plurals of the app language', () => {
      const de = (key: string, fallback?: string, params?: MessageParams) => translate('de', key, fallback, params);
      expect(formatReminder(1, de)).toBe(translate('de', 'calendar.alerts.minutes_before', '', { count: 1 }));
      expect(formatReminder(120, de)).toBe(translate('de', 'calendar.alerts.hours_before', '', { count: 2 }));
      expect(formatReminder(120, de)).not.toContain('hours');
    });
  });
});

// While an event uses its calendar's default alerts, Stalwart 1.0 fills the
// defaults into `alerts` under the default alerts' ids, and on save drops
// every alert under one of those ids. The editor wrote the alerts back with
// useDefaultAlerts: false on every save, freezing today's defaults into the
// event.
describe('reminderFieldsToSave', () => {
  const offsetAlert = (offset: string) => ({
    '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset, relativeTo: 'start' }, action: 'display',
  }) as Alert;
  // What 1.0 returns for an event on its calendar's defaults.
  const onDefaults = {
    useDefaultAlerts: true,
    alerts: { 'default-15': offsetAlert('-PT15M'), 'default-abs': { '@type': 'Alert', trigger: { '@type': 'AbsoluteTrigger', when: '2026-09-01T08:00:00Z' } } as Alert },
  };

  it('writes nothing while the reminders are the ones the event had, so the defaults stay on', () => {
    const reminders = alertsToReminders(onDefaults.alerts);
    expect(reminderFieldsToSave(onDefaults, reminders, preservedAlerts(onDefaults.alerts))).toEqual({});
    // Order and repeats are no change.
    expect(reminderFieldsToSave(
      { alerts: { a: offsetAlert('-PT15M'), b: offsetAlert('-PT1H') } },
      [{ minutesBefore: 60 }, { minutesBefore: 15 }, { minutesBefore: 15 }],
      {},
    )).toEqual({});
  });

  it('turns the defaults off for a changed event and gives its alerts ids of their own on Stalwart 1.0', () => {
    const fields = reminderFieldsToSave(
      onDefaults,
      [{ minutesBefore: 15 }, { minutesBefore: 60 }],
      preservedAlerts(onDefaults.alerts),
      ['reminder-1'],
    );

    expect(fields.useDefaultAlerts).toBe(false);
    const ids = Object.keys(fields.alerts ?? {});
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(['default-15', 'default-abs', 'reminder-1']).not.toContain(id);
    // The alert the editor cannot show stays, under its new id.
    expect(Object.values(fields.alerts ?? {})).toContainEqual(onDefaults.alerts['default-abs']);
  });

  it('removes the alerts and the defaults when every reminder is removed', () => {
    expect(reminderFieldsToSave(onDefaults, [], {})).toEqual({ alerts: null, useDefaultAlerts: false });
  });

  it('replaces the own alerts of an event without defaults, keeping what the editor cannot show', () => {
    const own = { alerts: { a: offsetAlert('-PT15M'), abs: onDefaults.alerts['default-abs'] } };
    const fields = reminderFieldsToSave(own, [{ minutesBefore: 30 }], preservedAlerts(own.alerts));

    expect(fields).toEqual({
      alerts: { abs: own.alerts.abs, 'reminder-1': offsetAlert('-PT30M') },
      useDefaultAlerts: false,
    });
  });

  it('gives a new event its reminders, and writes nothing without any', () => {
    expect(reminderFieldsToSave(null, [{ minutesBefore: 10 }], {})).toEqual({
      alerts: { 'reminder-1': offsetAlert('-PT10M') },
      useDefaultAlerts: false,
    });
    expect(reminderFieldsToSave(null, [], {})).toEqual({});
  });
});

describe('withOwnAlertIds', () => {
  it('numbers the alerts past every id taken', () => {
    const alert = { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT5M' } } as Alert;
    expect(Object.keys(withOwnAlertIds([alert, alert], ['reminder-1', 'reminder-3']))).toEqual(['reminder-2', 'reminder-4']);
  });
});
