import {
  addDays,
  endOfMonth,
  endOfWeek,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subDays,
} from 'date-fns';
import { dayKey } from './calendar-utils';

/**
 * The calendar views scroll freely (#759; webmail lib/calendar-scroll-window):
 * each keeps one window of days around the day the user navigated to.
 * Reaching an edge of the rendered range widens that side, and only the new
 * part is fetched (calendar-store `extendRange`). A navigation that lands
 * inside the window just scrolls; one that leaves it starts a fresh window
 * there.
 */

export type ScrollViewMode = 'month' | 'week' | 'day' | 'agenda';

export type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface DayRange {
  start: Date;
  end: Date;
}

export interface ScrollWindowState {
  mode: ScrollViewMode;
  /** yyyy-MM-dd of the day the window was started from. */
  anchorKey: string;
  /** Days added before the base range of the anchor. */
  before: number;
  /** Days added after the base range of the anchor. */
  after: number;
}

export interface ScrollWindow extends DayRange {
  canExtendStart: boolean;
  canExtendEnd: boolean;
}

/** The day the user navigated to; `nonce` changes on every navigation. */
export interface CalendarFocus {
  date: Date;
  nonce: number;
}

export interface ScrollWindowOptions {
  weekStartsOn: WeekStartsOn;
}

/** First growth step in days; every further step doubles the side. */
export const SCROLL_WINDOW_STEP = 30;

/** Furthest a side may grow, in days. Time grids render one column per day. */
export const SCROLL_WINDOW_MAX: Record<ScrollViewMode, number> = {
  month: 365,
  agenda: 365,
  week: 180,
  day: 180,
};

/** Days loaded after the base range before the user scrolls anywhere. */
const INITIAL_AFTER: Record<ScrollViewMode, number> = {
  month: SCROLL_WINDOW_STEP,
  agenda: SCROLL_WINDOW_STEP,
  week: SCROLL_WINDOW_STEP,
  day: SCROLL_WINDOW_STEP,
};

/**
 * Days loaded before the base range at first. The grids open with a step
 * of room above / to the left, so the list isn't mounted right at its start
 * edge (where rows would be prepended while it is still settling on the
 * focus). The agenda starts at its anchor and loads the past on request.
 */
const INITIAL_BEFORE: Record<ScrollViewMode, number> = {
  month: SCROLL_WINDOW_STEP,
  agenda: 0,
  week: SCROLL_WINDOW_STEP,
  day: SCROLL_WINDOW_STEP,
};

export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function freshScrollWindowState(mode: ScrollViewMode, anchor: Date): ScrollWindowState {
  return { mode, anchorKey: dayKey(anchor), before: INITIAL_BEFORE[mode], after: INITIAL_AFTER[mode] };
}

/**
 * The window with free scrolling turned off: exactly the base range (one
 * month/week/day, the agenda's 30 days). Never grows; navigation always
 * starts over here.
 */
export function fixedScrollWindowState(mode: ScrollViewMode, anchor: Date): ScrollWindowState {
  return { mode, anchorKey: dayKey(anchor), before: 0, after: 0 };
}

/** The range a view shows for a date when nothing has been scrolled yet. */
export function baseRange(mode: ScrollViewMode, date: Date, opts: ScrollWindowOptions): DayRange {
  const day = startOfDay(date);
  switch (mode) {
    case 'day':
      return { start: day, end: day };
    case 'week':
      return {
        start: startOfWeek(day, { weekStartsOn: opts.weekStartsOn }),
        end: startOfDay(endOfWeek(day, { weekStartsOn: opts.weekStartsOn })),
      };
    case 'month':
      return {
        start: startOfWeek(startOfMonth(day), { weekStartsOn: opts.weekStartsOn }),
        end: startOfDay(endOfWeek(endOfMonth(day), { weekStartsOn: opts.weekStartsOn })),
      };
    case 'agenda':
      return { start: day, end: addDays(day, SCROLL_WINDOW_STEP) };
  }
}

/** Ensures the state belongs to the view mode; otherwise starts over at the anchor. */
export function normalizeScrollWindowState(
  state: ScrollWindowState,
  mode: ScrollViewMode,
  anchor: Date,
): ScrollWindowState {
  return state.mode === mode ? state : freshScrollWindowState(mode, anchor);
}

export function computeScrollWindow(
  state: ScrollWindowState,
  opts: ScrollWindowOptions,
): ScrollWindow {
  const anchor = parseDayKey(state.anchorKey);
  const base = baseRange(state.mode, anchor, opts);
  let start = subDays(base.start, state.before);
  let end = addDays(base.end, state.after);
  if (state.mode === 'month' || state.mode === 'week') {
    // The grids are made of whole weeks.
    start = startOfWeek(start, { weekStartsOn: opts.weekStartsOn });
    end = endOfWeek(end, { weekStartsOn: opts.weekStartsOn });
  }
  const max = SCROLL_WINDOW_MAX[state.mode];
  return {
    start: startOfDay(start),
    end: startOfDay(end),
    canExtendStart: state.before < max,
    canExtendEnd: state.after < max,
  };
}

export function growScrollWindow(
  state: ScrollWindowState,
  side: 'before' | 'after',
): ScrollWindowState {
  const max = SCROLL_WINDOW_MAX[state.mode];
  const grown = Math.min(max, Math.max(SCROLL_WINDOW_STEP, state[side] * 2));
  return grown === state[side] ? state : { ...state, [side]: grown };
}

/** True when the view's base range for `date` is already inside the window. */
export function scrollWindowContains(
  window: DayRange,
  mode: ScrollViewMode,
  date: Date,
  opts: ScrollWindowOptions,
): boolean {
  const base = baseRange(mode, date, opts);
  return base.start.getTime() >= window.start.getTime() && base.end.getTime() <= window.end.getTime();
}

/**
 * Where a navigation to `date` leaves the window: unchanged when the target
 * is already inside it (the view just scrolls there), otherwise a fresh
 * window at the target.
 */
export function windowStateForJump(
  state: ScrollWindowState,
  mode: ScrollViewMode,
  date: Date,
  opts: ScrollWindowOptions,
): ScrollWindowState {
  const current = normalizeScrollWindowState(state, mode, date);
  const loaded = computeScrollWindow(current, opts);
  return scrollWindowContains(loaded, mode, date, opts)
    ? current
    : freshScrollWindowState(mode, date);
}

/**
 * The events range to load for a window: its whole days plus a margin on
 * either side, so the next step (an arrow press, the next edge) usually
 * finds its events already there. `before` is exclusive.
 */
export function scrollWindowLoadRange(
  window: DayRange,
  marginDays: number,
): { after: Date; before: Date } {
  return {
    after: subDays(window.start, marginDays),
    before: addDays(window.end, 1 + marginDays),
  };
}

/**
 * The part of the window whose events are loaded, as whole days, or null
 * when nothing of it is. `loadedAfter`/`loadedBefore` are the store's
 * loaded range (ISO instants, `before` exclusive).
 */
export function loadedPartOfWindow(
  window: DayRange,
  loadedAfter: string | null | undefined,
  loadedBefore: string | null | undefined,
): DayRange | null {
  if (!loadedAfter || !loadedBefore) return null;
  const after = new Date(loadedAfter);
  const before = new Date(loadedBefore);
  if (isNaN(after.getTime()) || isNaN(before.getTime())) return null;
  // First whole day at or after `after`, last whole day ending by `before`.
  const firstDay = startOfDay(after).getTime() === after.getTime() ? after : addDays(startOfDay(after), 1);
  const lastDay = subDays(startOfDay(before), 1);
  const start = firstDay > window.start ? startOfDay(firstDay) : window.start;
  const end = lastDay < window.end ? lastDay : window.end;
  return start.getTime() <= end.getTime() ? { start, end } : null;
}
