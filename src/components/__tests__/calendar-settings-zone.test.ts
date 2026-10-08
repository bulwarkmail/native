// The time zone is one app-wide setting, owned by Language & region. The
// calendar pane used to edit it too, under a "calendar" description and with
// a zone list of its own.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, '..', 'settings', 'CalendarSettings.tsx'), 'utf8');

describe('calendar settings', () => {
  it('leave the time zone to Language & region', () => {
    expect(source).not.toContain("'calendarTimeZone'");
    expect(source).not.toContain('calendar.settings.time_zone');
  });
});
