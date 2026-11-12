import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { monthEventLook } from '../calendar-month-timed-style';
import { useSettingsStore } from '../../stores/settings-store';
import type { CalendarEvent } from '../../api/types';

// Webmail 1.20 (#1449): timed events in the month view as a bar, coloured
// text, or a dot and text.
const timed = { id: 'e', start: '2026-11-20T10:00:00', duration: 'PT1H' } as CalendarEvent;
const untilMidnight = { id: 'm', start: '2026-11-20T22:00:00', duration: 'PT2H' } as CalendarEvent;
const allDay = { id: 'a', start: '2026-11-20T00:00:00', duration: 'P1D', showWithoutTime: true } as CalendarEvent;
const overnight = { id: 'o', start: '2026-11-20T22:00:00', duration: 'PT5H' } as CalendarEvent;

describe('timed events in the month view', () => {
  beforeEach(() => useSettingsStore.getState().resetToDefaults());

  it('draws a timed event the chosen way and keeps all-day and multi-day events bars', () => {
    expect(monthEventLook(timed, 'text')).toBe('text');
    expect(monthEventLook(timed, 'dot')).toBe('dot');
    expect(monthEventLook(untilMidnight, 'dot')).toBe('dot');
    expect(monthEventLook(allDay, 'dot')).toBe('bar');
    expect(monthEventLook(overnight, 'text')).toBe('bar');
    expect(monthEventLook(timed, 'bar')).toBe('bar');
  });

  it('is a setting, a bar by default, under the webmail key', () => {
    expect(useSettingsStore.getState().calendarMonthTimedEvents).toBe('bar');
    useSettingsStore.getState().updateSetting('calendarMonthTimedEvents', 'dot');
    expect(useSettingsStore.getState().calendarMonthTimedEvents).toBe('dot');
  });

  // No render setup in the repo: the month view and the settings page are read.
  it('is what both month grids use and what Calendar settings offer', () => {
    const month = readFileSync(join(__dirname, '../../components/calendar/MonthView.tsx'), 'utf-8');
    expect(month.match(/const look = monthEventLook\(event, timedStyle\);/g)?.length).toBe(2);
    const settings = readFileSync(join(__dirname, '../../components/settings/CalendarSettings.tsx'), 'utf-8');
    expect(settings).toContain("update('calendarMonthTimedEvents'");
  });
});
