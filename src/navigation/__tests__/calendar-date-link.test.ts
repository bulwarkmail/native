import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { handleDeepLink, parseDeepLink } from '../linking';
import { parseCalendarLinkDate, usePendingCalendarDate } from '../pending-calendar-date';
import { usePendingCalendarOpen } from '../pending-calendar-open';

// A `/calendar/<view>/<yyyy-mm-dd>` link opened only the Calendar tab, on
// whatever day it showed (file 10 "date deep links", 05 "Deep links to
// calendar/event"). Webmail lib/deep-links.ts parseCalendarPath.

const nav = () => ({ isReady: () => true, navigate: vi.fn() });

describe('calendar date deep links', () => {
  it('parses the view and the day, and only real days', () => {
    expect(parseDeepLink('bulwarkmobile://calendar/week/2026-08-29'))
      .toEqual({ kind: 'calendar', view: 'week', date: '2026-08-29' });
    expect(parseDeepLink('https://mail.example.com/de/calendar/day/2026-02-03'))
      .toEqual({ kind: 'calendar', view: 'day', date: '2026-02-03' });
    expect(parseDeepLink('bulwarkmobile://calendar/agenda')).toEqual({ kind: 'calendar', view: 'agenda' });
    expect(parseDeepLink('bulwarkmobile://calendar/tasks')).toEqual({ kind: 'calendar', view: 'tasks' });
    // A bare date keeps the view on screen.
    expect(parseDeepLink('bulwarkmobile://calendar/2026-08-06')).toEqual({ kind: 'calendar', date: '2026-08-06' });
    // 2026-02-31 does not roll over into March.
    expect(parseDeepLink('bulwarkmobile://calendar/month/2026-02-31')).toEqual({ kind: 'calendar', view: 'month' });
    expect(parseDeepLink('bulwarkmobile://calendar/year/2026-08-06')).toEqual({ kind: 'calendar' });
  });

  it('reads the day as a local calendar day', () => {
    const d = parseCalendarLinkDate('2026-08-06')!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 7, 6, 0]);
    expect(parseCalendarLinkDate('2026-13-01')).toBeNull();
    expect(parseCalendarLinkDate('06.08.2026')).toBeNull();
  });

  it('parks the view and day for the Calendar tab', async () => {
    const navigation = nav();
    const link = parseDeepLink('bulwarkmobile://calendar/day/2026-08-06')!;
    expect(await handleDeepLink(link, { navigation: navigation as never, resolveThreadId: async () => null })).toBe(true);
    expect(usePendingCalendarDate.getState().consume()).toEqual({ view: 'day', date: '2026-08-06' });
    expect(usePendingCalendarOpen.getState().consume()).toBeNull();
    expect(navigation.navigate).toHaveBeenCalledWith('MainTabs', { screen: 'Calendar' });

    // A plain /calendar link parks nothing.
    await handleDeepLink(parseDeepLink('bulwarkmobile://calendar')!, { navigation: navigation as never, resolveThreadId: async () => null });
    expect(usePendingCalendarDate.getState().consume()).toBeNull();
  });

  // No RN renderer in the test env: check the screen's wiring instead.
  it('is applied by the Calendar screen', () => {
    const screen = fs.readFileSync(path.resolve(__dirname, '../../screens/CalendarScreen.tsx'), 'utf8');
    expect(screen).toMatch(/const link = usePendingCalendarDate\.getState\(\)\.consume\(\);\s*if \(link\) applyDateLink\(link\);/);
    expect(screen).toMatch(/const mode: ViewMode = link\.view && link\.view !== 'tasks' \? link\.view : viewMode;/);
    expect(screen).toMatch(/setFocus\(\(prev\) => \(\{ date, nonce: prev\.nonce \+ 1 \}\)\);\s*setWindowState\(\(prev\) =>\s*mode === viewMode/);
  });
});
