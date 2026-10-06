import { describe, it, expect } from 'vitest';
import {
  BIRTHDAY_CALENDAR_COLOR,
  createBirthdayCalendar,
  generateBirthdayEvents,
} from '../birthday-calendar';
import { getEventColor } from '../calendar-utils';
import type { ContactCard } from '../../api/types';

const contact = {
  id: 'c1',
  name: { full: 'Ada Lovelace' },
  anniversaries: { a: { kind: 'birth', date: '1990-03-05' } },
} as unknown as ContactCard;

describe('birthday calendar colour', () => {
  it('uses webmail default yellow unless given a colour', () => {
    expect(BIRTHDAY_CALENDAR_COLOR).toBe('#eab308');
    expect(createBirthdayCalendar().color).toBe('#eab308');
    expect(createBirthdayCalendar('Birthdays', '#3b82f6').color).toBe('#3b82f6');
    expect(createBirthdayCalendar('Birthdays', '').color).toBe('#eab308');
  });

  it('paints events in the calendar colour, not a fixed one', () => {
    const events = generateBirthdayEvents([contact], '2026-03-01T00:00:00', '2026-03-31T23:59:59');
    expect(events).toHaveLength(1);
    const cal = createBirthdayCalendar('Birthdays', '#3b82f6');
    expect(getEventColor(events[0], [cal])).toBe('#3b82f6');
  });
});
