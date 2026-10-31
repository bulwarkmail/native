import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { formatScheduledSendAt, schedulePresetLabel, schedulePresets } from '../compose-schedule';

// Ported from the webmail's lib/__tests__/schedule-presets.test.ts and
// scheduled-send-label.test.ts. Local dates, so the expectations hold in any
// time zone.
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('schedulePresets', () => {
  it('offers tomorrow morning and afternoon and next Monday morning', () => {
    // Wednesday 2026-10-14, 18:30
    const presets = schedulePresets(local(2026, 10, 14, 18, 30));
    expect(presets.map((p) => [p.key, p.date.getTime()])).toEqual([
      ['tomorrow_morning', local(2026, 10, 15, 8).getTime()],
      ['tomorrow_afternoon', local(2026, 10, 15, 13).getTime()],
      ['monday_morning', local(2026, 10, 19, 8).getTime()],
    ]);
  });

  it('skips Monday on a Sunday, when it is tomorrow anyway', () => {
    expect(schedulePresets(local(2026, 10, 11, 18)).map((p) => p.key)).toEqual(['tomorrow_morning', 'tomorrow_afternoon']);
  });

  it('picks the Monday a week ahead on a Monday', () => {
    const presets = schedulePresets(local(2026, 10, 12, 9));
    expect(presets.find((p) => p.key === 'monday_morning')?.date.getTime()).toBe(local(2026, 10, 19, 8).getTime());
  });

  it('offers this morning and afternoon after midnight, while they are ahead (#1390)', () => {
    // Thursday 2026-10-15, 01:30
    const presets = schedulePresets(local(2026, 10, 15, 1, 30));
    expect(presets.slice(0, 3).map((p) => [p.key, p.date.getTime()])).toEqual([
      ['this_morning', local(2026, 10, 15, 8).getTime()],
      ['this_afternoon', local(2026, 10, 15, 13).getTime()],
      ['tomorrow_morning', local(2026, 10, 16, 8).getTime()],
    ]);
  });

  it('drops a time of today that is past or about to be', () => {
    expect(schedulePresets(local(2026, 10, 15, 9)).map((p) => p.key)[0]).toBe('this_afternoon');
    expect(schedulePresets(local(2026, 10, 15, 12, 58)).map((p) => p.key)[0]).toBe('tomorrow_morning');
  });

  it('labels every preset', () => {
    const t = (_key: string, fallback?: string) => fallback ?? '';
    expect(schedulePresets(local(2026, 10, 15, 1)).map((p) => schedulePresetLabel(p.key, t)))
      .toEqual(['This morning', 'This afternoon', 'Tomorrow morning', 'Tomorrow afternoon', 'Monday morning']);
  });
});

describe('formatScheduledSendAt', () => {
  const today = local(2026, 10, 11, 18, 0);

  it('shows 20:00 for a release one second before eight', () => {
    const label = formatScheduledSendAt(local(2026, 10, 11, 19, 59, 59).toISOString(), '24h', 'en', today);
    expect(label).toContain('20:00');
    expect(label).not.toContain('19:59');
  });

  it('shows only the time for a release later today', () => {
    expect(formatScheduledSendAt(local(2026, 10, 11, 21, 30).toISOString(), '24h', 'en', today)).toBe('21:30');
  });

  it('includes the date for a release on another day', () => {
    const label = formatScheduledSendAt(local(2026, 10, 12, 7, 59, 59).toISOString(), '24h', 'en', today);
    expect(label).toContain('08:00');
    expect(label).toMatch(/12/);
  });
});

describe('schedule wiring', () => {
  it('offers the presets in the composer and in Reschedule, and labels times rounded', () => {
    const compose = read('../../screens/ComposeScreen.tsx');
    expect(compose).toMatch(/\.\.\.webmailSchedulePresets\(now\)\.map\(/);
    expect(compose).toMatch(/time: formatScheduledSendAt\(when\.toISOString\(\), timeFormat, locale\)/);
    const scheduled = read('../../screens/ScheduledScreen.tsx');
    expect(scheduled).toMatch(/\.\.\.schedulePresets\(now\)\.map\(/);
    expect(scheduled).toMatch(/\(iso: string\) => formatScheduledSendAt\(iso, timeFormat, locale\)/);
  });
});
