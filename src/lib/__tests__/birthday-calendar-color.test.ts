import { describe, expect, it } from 'vitest';
import { BIRTHDAY_CALENDAR_COLOR, createBirthdayCalendar } from '../birthday-calendar';
import { useSettingsStore } from '../../stores/settings-store';

describe('birthday calendar colour', () => {
  it('takes the colour the user picked and keeps yellow until then', () => {
    expect(createBirthdayCalendar('Birthdays', '#ef4444').color).toBe('#ef4444');
    expect(createBirthdayCalendar('Birthdays').color).toBe(BIRTHDAY_CALENDAR_COLOR);
    expect(useSettingsStore.getState().birthdayCalendarColor).toBe(BIRTHDAY_CALENDAR_COLOR);
  });
});
