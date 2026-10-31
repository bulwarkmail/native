import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eventBlockColors, mixColors } from '../event-colors';
import { mergeWithDefaults } from '../../stores/settings-store';

// The webmail's "Light event colors" (calendarTintedEvents) had no
// counterpart on the phone (file 10 "light tinted colours"). Webmail
// event-card eventFillStyle: color-mix(color 20%, background), foreground
// text, a calendar-coloured bar at the start.

const page = { background: '#ffffff', text: '#111111' };
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

describe('light event colours', () => {
  it('tints active events and adds the start bar', () => {
    expect(eventBlockColors('#3b82f6', false, page, true)).toEqual({
      fill: mixColors('#3b82f6', '#ffffff', 0.2),
      text: '#111111',
      border: null,
      bar: '#3b82f6',
    });
    expect(mixColors('#3b82f6', '#ffffff', 0.2)).toBe('#d8e6fd');
    // Solid blocks stay the default.
    expect(eventBlockColors('#3b82f6', false, page)).toMatchObject({ fill: '#3b82f6' });
    expect(eventBlockColors('#3b82f6', false, page).bar).toBeUndefined();
  });

  it('keeps declined and cancelled events outlined', () => {
    const colors = eventBlockColors('#3b82f6', true, page, true);
    expect(colors.border).toBe('#3b82f6');
    expect(colors.fill).toBe('#ffffff');
    expect(colors.bar).toBeUndefined();
  });

  it('is a setting, off by default, under the webmail key', () => {
    expect(mergeWithDefaults({}).calendarTintedEvents).toBe(false);
    expect(mergeWithDefaults({ calendarTintedEvents: true }).calendarTintedEvents).toBe(true);
  });

  // No RN renderer in the test env: check the wiring.
  it('is offered in the calendar settings and read by every grid', () => {
    expect(read('components/settings/CalendarSettings.tsx')).toMatch(/onChange=\{\(v\) => update\('calendarTintedEvents', v\)\}/);
    for (const view of ['MonthView', 'TimeGridScrollView', 'WeekView']) {
      const src = read(`components/calendar/${view}.tsx`);
      expect(src).toMatch(/const tinted = useSettingsStore\(\(s\) => s\.calendarTintedEvents\);/);
      expect(src).toMatch(/eventBlockColors\([\s\S]*?tinted,?\s*\)/);
    }
    expect(read('components/calendar/EventBlock.tsx').match(/colors\.bar \? <View pointerEvents="none" style=\{\[styles\.startBar/g)).toHaveLength(2);
  });
});
