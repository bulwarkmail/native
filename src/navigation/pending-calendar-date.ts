import { create } from 'zustand';

/** The views a calendar link names (webmail lib/deep-links.ts CALENDAR_VIEWS). */
export const CALENDAR_LINK_VIEWS = ['month', 'week', 'day', 'agenda', 'tasks'] as const;
export type CalendarLinkView = typeof CALENDAR_LINK_VIEWS[number];

/** A `/calendar/<view>/<yyyy-mm-dd>` link: the view and the day to show. */
export interface CalendarDateLink {
  view?: CalendarLinkView;
  /** `YYYY-MM-DD`, a local calendar day. */
  date?: string;
}

/**
 * `YYYY-MM-DD` as a local-midnight Date; null when malformed or impossible
 * (2026-02-31 would otherwise roll over into March). The webmail's
 * parseLinkDate.
 */
export function parseCalendarLinkDate(value: string | null | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(date.getTime())) return null;
  if (date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) return null;
  return date;
}

// A date link arrives before CalendarScreen is mounted (cold start) or while
// it shows another day. It is parked here and consumed by the screen, like
// pending-calendar-open.
interface PendingCalendarDateState {
  link: CalendarDateLink | null;
  set: (link: CalendarDateLink | null) => void;
  consume: () => CalendarDateLink | null;
}

export const usePendingCalendarDate = create<PendingCalendarDateState>((set, get) => ({
  link: null,
  set: (link) => set({ link }),
  consume: () => {
    const link = get().link;
    if (link) set({ link: null });
    return link;
  },
}));

export function setPendingCalendarDate(link: CalendarDateLink | null): void {
  usePendingCalendarDate.getState().set(link);
}
