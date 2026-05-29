import { describe, it, expect } from 'vitest';
import {
  offsetToMinutesBefore,
  minutesBeforeToOffset,
  alertsToReminders,
  remindersToAlerts,
  formatReminder,
} from '../calendar-alerts';

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
    });
  });
});
