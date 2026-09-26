import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '../../api/types';
import { isRecurringSeriesMember } from '../recurrence-overrides';

// The scope edits ("this", "this and following", "all") are tested in
// recurrence-scope-edit.test.ts.

const master: CalendarEvent = {
  id: 'ev-1',
  uid: 'uid-1',
  calendarIds: { 'cal-1': true },
  title: 'Standup',
  start: '2026-03-02T09:00:00',
  duration: 'PT30M',
  timeZone: 'Europe/Berlin',
  recurrenceRules: [{ frequency: 'daily', interval: 1, count: 10 }],
};

const occurrence: CalendarEvent = {
  ...master,
  id: 'ev-1:2026-03-04T09:00:00',
  originalId: 'ev-1',
  start: '2026-03-04T09:00:00',
  recurrenceId: '2026-03-04T09:00:00',
};

describe('isRecurringSeriesMember', () => {
  it('detects masters and expanded occurrences but not plain shared events', () => {
    expect(isRecurringSeriesMember(master)).toBe(true);
    expect(isRecurringSeriesMember(occurrence)).toBe(true);
    expect(isRecurringSeriesMember({ recurrenceRules: [] })).toBe(false);
    expect(isRecurringSeriesMember({ originalId: 'raw' } as CalendarEvent)).toBe(false);
  });
});
