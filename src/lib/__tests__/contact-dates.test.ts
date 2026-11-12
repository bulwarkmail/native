import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatContactEventTime, formatPartialDate } from '../contact-utils';

// #1616: contact event times were always 24-hour, and birthdays used a fixed
// English month list.
describe('contact dates in the UI language', () => {
  it('writes a birthday with its month name in the language', () => {
    expect(formatPartialDate({ year: 1988, month: 3, day: 15 }, 'de')).toBe('15. März 1988');
    expect(formatPartialDate({ year: 1988, month: 3, day: 15 }, 'en')).toBe('March 15, 1988');
    expect(formatPartialDate({ month: 3, day: 15 }, 'fr')).toBe('15 mars');
  });

  it('shows only what a partial date has', () => {
    expect(formatPartialDate('--02-29', 'en')).toBe('February 29');
    expect(formatPartialDate({ year: 1990, month: 7 }, 'de')).toBe('Juli 1990');
    expect(formatPartialDate({ year: 1990 }, 'de')).toBe('1990');
    expect(formatPartialDate('1988-03-15', 'de')).toBe('15. März 1988');
  });

  it('reads a timestamp by its UTC day', () => {
    expect(formatPartialDate({ '@type': 'Timestamp', utc: '1988-03-15T23:30:00Z' }, 'en')).toBe('March 15, 1988');
  });

  it('is what the contact screen shows, in the app language', () => {
    const src = readFileSync(join(__dirname, '../../screens/ContactDetailScreen.tsx'), 'utf-8');
    expect(src).toMatch(/formatPartialDate\(a\.date, uiLocale\)/);
  });
});

describe('contact event times', () => {
  const event = { start: '2026-11-10T14:05:00', showWithoutTime: false };

  it('follow the 12- or 24-hour setting', () => {
    expect(formatContactEventTime(event, '24h', 'All day')).toBe('14:05');
    expect(formatContactEventTime(event, '12h', 'All day')).toBe('2:05 PM');
  });

  it('say all day for an all-day event', () => {
    expect(formatContactEventTime({ ...event, showWithoutTime: true }, '12h', 'All day')).toBe('All day');
  });

  it('is what the activity list shows', () => {
    const src = readFileSync(join(__dirname, '../../components/contacts/ContactActivity.tsx'), 'utf-8');
    expect(src).toMatch(/formatContactEventTime\(event, timeFormat, /);
    expect(src).not.toMatch(/'HH:mm'/);
  });
});
