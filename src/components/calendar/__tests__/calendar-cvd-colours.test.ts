import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cvdColor } from '../../../lib/cvd-palette';

// Checked on the source: the suite has no React Native renderer. Every place
// that draws a calendar's colour runs it through useCvdColor() first, so the
// colour-blind-safe setting recolours calendars as its description promises
// (webmail cf4d02b49). The colour pickers keep the raw colours.
const src = path.resolve(__dirname, '../../..');
const DRAWERS = [
  'components/calendar/EventCard.tsx',
  'components/calendar/EventDetailSheet.tsx',
  'components/calendar/MonthView.tsx',
  'components/calendar/WeekView.tsx',
  'components/calendar/TimeGridScrollView.tsx',
  'components/calendar/CalendarSearchSheet.tsx',
  'components/calendar/CalendarSidebarDrawer.tsx',
  'components/calendar/EventModal.tsx',
  'components/calendar/TasksSheet.tsx',
  'components/calendar/ICalImportSheet.tsx',
  'components/contacts/ContactActivity.tsx',
  'components/email/CalendarInvitationBanner.tsx',
  'components/email/structured-mail/booking-calendar-actions.tsx',
];

function colourCalls(source: string): string[] {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*import\b/.test(line) && /\bget(Event|Calendar)Color\(/.test(line))
    .map((line) => line.trim());
}

describe('calendar colours in the colour-blind-safe palette', () => {
  it.each(DRAWERS)('%s paints every calendar colour it draws', (file) => {
    const source = fs.readFileSync(path.join(src, file), 'utf8');
    expect(source).toMatch(/const paint = useCvdColor\(\);/);
    const calls = colourCalls(source);
    expect(calls.length).toBeGreaterThan(0);
    for (const line of calls) {
      expect(line).toMatch(/paint\(get(Event|Calendar)Color\(/);
    }
  });

  it('keeps the raw colour in the calendar editor, which is a colour picker', () => {
    const source = fs.readFileSync(path.join(src, 'components/calendar/CalendarEditSheet.tsx'), 'utf8');
    expect(source).not.toMatch(/useCvdColor/);
  });

  it('paints a subscription swatch through the hook', () => {
    const source = fs.readFileSync(path.join(src, 'components/calendar/ICalSubscriptionSheet.tsx'), 'utf8');
    expect(source).toMatch(/paint\(sub\.color\)/);
  });

  it('maps a calendar green to the palette green only when the setting is on', () => {
    expect(cvdColor('#22c55e', false)).toBe('#22c55e');
    expect(cvdColor('#22c55e', true).toLowerCase()).not.toBe('#22c55e');
  });
});
