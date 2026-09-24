import { describe, it, expect } from 'vitest';
import {
  baseRange,
  computeScrollWindow,
  fixedScrollWindowState,
  freshScrollWindowState,
  growScrollWindow,
  loadedPartOfWindow,
  normalizeScrollWindowState,
  scrollWindowContains,
  scrollWindowLoadRange,
  windowStateForJump,
  SCROLL_WINDOW_MAX,
  SCROLL_WINDOW_STEP,
  type ScrollWindowOptions,
} from '../calendar-scroll-window';

// #759: every calendar view keeps one window of days around the focused
// day; edges double, navigation inside the window does not reset it.

const opts: ScrollWindowOptions = { weekStartsOn: 1 };
// Local-midnight dates; compare by local fields.
const local = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('baseRange', () => {
  it('is the day itself, the week, the month grid, or 30 days for the agenda', () => {
    const wed = new Date(2026, 8, 9); // Wednesday
    expect(local(baseRange('day', wed, opts).start)).toBe('2026-09-09');
    expect(local(baseRange('day', wed, opts).end)).toBe('2026-09-09');
    expect(local(baseRange('week', wed, opts).start)).toBe('2026-09-07');
    expect(local(baseRange('week', wed, opts).end)).toBe('2026-09-13');
    expect(local(baseRange('month', wed, opts).start)).toBe('2026-08-31');
    expect(local(baseRange('month', wed, opts).end)).toBe('2026-10-04');
    expect(local(baseRange('agenda', wed, opts).start)).toBe('2026-09-09');
    expect(local(baseRange('agenda', wed, opts).end)).toBe('2026-10-09');
  });

  it('follows the first day of the week', () => {
    const wed = new Date(2026, 8, 9);
    const sunday = { weekStartsOn: 0 as const };
    expect(local(baseRange('week', wed, sunday).start)).toBe('2026-09-06');
    expect(local(baseRange('week', wed, sunday).end)).toBe('2026-09-12');
    const saturday = { weekStartsOn: 6 as const };
    expect(local(baseRange('month', wed, saturday).start)).toBe('2026-08-29');
  });
});

describe('computeScrollWindow', () => {
  it('starts as the base range plus a step either side, snapped to whole weeks', () => {
    const win = computeScrollWindow(freshScrollWindowState('month', new Date(2026, 8, 9)), opts);
    // 2026-08-31 - 30 days = 2026-08-01 (Saturday) -> start of that week
    expect(local(win.start)).toBe('2026-07-27');
    // 2026-10-04 + 30 days = 2026-11-03 (Tuesday) -> end of that week
    expect(local(win.end)).toBe('2026-11-08');
    expect(win.canExtendStart).toBe(true);
    expect(win.canExtendEnd).toBe(true);
  });

  it('is exactly one period when free scrolling is off (agenda keeps its 30 days)', () => {
    const month = computeScrollWindow(fixedScrollWindowState('month', new Date(2026, 8, 9)), opts);
    expect(local(month.start)).toBe('2026-08-31');
    expect(local(month.end)).toBe('2026-10-04');
    const week = computeScrollWindow(fixedScrollWindowState('week', new Date(2026, 8, 9)), opts);
    expect([local(week.start), local(week.end)]).toEqual(['2026-09-07', '2026-09-13']);
    const day = computeScrollWindow(fixedScrollWindowState('day', new Date(2026, 8, 9)), opts);
    expect([local(day.start), local(day.end)]).toEqual(['2026-09-09', '2026-09-09']);
    const agenda = computeScrollWindow(fixedScrollWindowState('agenda', new Date(2026, 8, 9)), opts);
    expect([local(agenda.start), local(agenda.end)]).toEqual(['2026-09-09', '2026-10-09']);
  });

  it('starts the agenda at the anchor and loads 60 days ahead', () => {
    const win = computeScrollWindow(freshScrollWindowState('agenda', new Date(2026, 8, 9)), opts);
    expect(local(win.start)).toBe('2026-09-09');
    expect(local(win.end)).toBe('2026-11-08');
  });

  it('does not snap the day view to weeks', () => {
    const win = computeScrollWindow(freshScrollWindowState('day', new Date(2026, 8, 9)), opts);
    expect(local(win.start)).toBe('2026-08-10');
    expect(local(win.end)).toBe('2026-10-09');
  });

  it('snaps a grown week window to whole weeks', () => {
    const state = growScrollWindow(freshScrollWindowState('week', new Date(2026, 8, 9)), 'before');
    const win = computeScrollWindow(state, opts);
    // 2026-09-07 - 60 days = 2026-07-09 (Thursday) -> Monday 2026-07-06
    expect(local(win.start)).toBe('2026-07-06');
    expect(win.start.getDay()).toBe(1);
    expect(win.end.getDay()).toBe(0);
  });

  it('reports the limits once a side reached its maximum', () => {
    const state = { ...freshScrollWindowState('week', new Date(2026, 8, 9)), before: SCROLL_WINDOW_MAX.week };
    expect(computeScrollWindow(state, opts).canExtendStart).toBe(false);
    expect(computeScrollWindow(state, opts).canExtendEnd).toBe(true);
  });

  it('keeps whole local days across a DST change', () => {
    // Europe switches back on 2026-10-25; the window still ends on a midnight.
    const win = computeScrollWindow(freshScrollWindowState('agenda', new Date(2026, 9, 1)), opts);
    expect(win.end.getHours()).toBe(0);
    expect(local(win.end)).toBe('2026-11-30');
  });
});

describe('growScrollWindow', () => {
  it('doubles a side from the first step up to the cap and then stays put', () => {
    let state = freshScrollWindowState('agenda', new Date(2026, 8, 9));
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      state = growScrollWindow(state, 'before');
      seen.push(state.before);
    }
    expect(seen).toEqual([SCROLL_WINDOW_STEP, 60, 120, 240, 365, 365, 365, 365]);
    const capped = growScrollWindow(state, 'before');
    expect(capped).toBe(state);
  });

  it('caps the time grids at half a year per side', () => {
    let state = freshScrollWindowState('day', new Date(2026, 8, 9));
    for (let i = 0; i < 10; i++) state = growScrollWindow(state, 'after');
    expect(state.after).toBe(180);
    expect(computeScrollWindow(state, opts).canExtendEnd).toBe(false);
  });
});

describe('normalizeScrollWindowState / scrollWindowContains', () => {
  it('starts over when the view mode changed', () => {
    const month = freshScrollWindowState('month', new Date(2026, 8, 9));
    expect(normalizeScrollWindowState(month, 'month', new Date(2026, 0, 1))).toBe(month);
    const week = normalizeScrollWindowState(month, 'week', new Date(2026, 0, 1));
    expect(week.mode).toBe('week');
    expect(week.anchorKey).toBe('2026-01-01');
  });

  it('knows whether a navigation target is already loaded', () => {
    const win = computeScrollWindow(freshScrollWindowState('month', new Date(2026, 8, 9)), opts);
    expect(scrollWindowContains(win, 'month', new Date(2026, 9, 15), opts)).toBe(true); // October grid ends Nov 1
    expect(scrollWindowContains(win, 'month', new Date(2026, 10, 15), opts)).toBe(false); // November grid ends Dec 6
    expect(scrollWindowContains(win, 'week', new Date(2026, 6, 27), opts)).toBe(true); // window starts Jul 27
    expect(scrollWindowContains(win, 'week', new Date(2026, 6, 26), opts)).toBe(false);
  });

  it('keys the anchor by calendar day', () => {
    expect(freshScrollWindowState('day', new Date(2026, 8, 9, 23, 59)).anchorKey).toBe('2026-09-09');
  });
});

describe('windowStateForJump', () => {
  it('keeps a grown window when the target is inside it', () => {
    const grown = growScrollWindow(freshScrollWindowState('agenda', new Date(2026, 8, 9)), 'after');
    // Agenda window: Sep 9 .. Sep 9 + 30 + 60 = Dec 8; Oct 1 + 30 days fits.
    expect(windowStateForJump(grown, 'agenda', new Date(2026, 9, 1), opts)).toBe(grown);
  });

  it('starts a fresh window at a target outside it', () => {
    const state = freshScrollWindowState('agenda', new Date(2026, 8, 9));
    const next = windowStateForJump(state, 'agenda', new Date(2027, 0, 5), opts);
    expect(next).toEqual(freshScrollWindowState('agenda', new Date(2027, 0, 5)));
  });

  it('starts a fresh window for another view mode', () => {
    const state = freshScrollWindowState('agenda', new Date(2026, 8, 9));
    const next = windowStateForJump(state, 'month', new Date(2026, 8, 20), opts);
    expect(next.mode).toBe('month');
    expect(next.anchorKey).toBe('2026-09-20');
  });

  it('jumps back to today inside the window without resetting it', () => {
    const today = new Date(2026, 8, 24);
    let state = freshScrollWindowState('agenda', today);
    state = growScrollWindow(state, 'before');
    state = growScrollWindow(state, 'after');
    expect(windowStateForJump(state, 'agenda', today, opts)).toBe(state);
  });
});

describe('scrollWindowLoadRange', () => {
  it('covers the whole days plus a margin, the end exclusive', () => {
    const range = scrollWindowLoadRange({ start: new Date(2026, 8, 9), end: new Date(2026, 8, 30) }, 14);
    expect(local(range.after)).toBe('2026-08-26');
    expect(range.after.getHours()).toBe(0);
    expect(local(range.before)).toBe('2026-10-15');
    expect(range.before.getHours()).toBe(0);
  });
});

describe('loadedPartOfWindow', () => {
  const window = { start: new Date(2026, 8, 9), end: new Date(2026, 10, 8) };

  it('is the whole window once the loaded range covers it', () => {
    const part = loadedPartOfWindow(
      window,
      new Date(2026, 7, 26).toISOString(),
      new Date(2026, 10, 23).toISOString(),
    );
    expect(part && [local(part.start), local(part.end)]).toEqual(['2026-09-09', '2026-11-08']);
  });

  it('stops at the last whole loaded day while the end is still loading', () => {
    const part = loadedPartOfWindow(
      window,
      new Date(2026, 7, 26).toISOString(),
      new Date(2026, 9, 1).toISOString(), // exclusive: Sep 30 is the last loaded day
    );
    expect(part && [local(part.start), local(part.end)]).toEqual(['2026-09-09', '2026-09-30']);
  });

  it('does not count a partly loaded day', () => {
    const part = loadedPartOfWindow(
      window,
      new Date(2026, 8, 20, 12).toISOString(),
      new Date(2026, 9, 1, 12).toISOString(),
    );
    expect(part && [local(part.start), local(part.end)]).toEqual(['2026-09-21', '2026-09-30']);
  });

  it('is null when nothing of the window is loaded yet', () => {
    expect(loadedPartOfWindow(window, null, null)).toBeNull();
    expect(
      loadedPartOfWindow(window, new Date(2025, 0, 1).toISOString(), new Date(2025, 1, 1).toISOString()),
    ).toBeNull();
  });
});
