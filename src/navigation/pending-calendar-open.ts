import { create } from 'zustand';

/** The event or task a calendar reminder notification points at. */
export interface CalendarReminderTarget {
  kind: 'event' | 'task';
  /** Store id of the event (or occurrence) when the reminder was scheduled. */
  eventId: string;
  /** Raw JMAP id of the stored event; a series' base event for an occurrence. */
  serverId?: string;
  /** JMAP account of an event on a calendar shared with the user. */
  accountId?: string;
  /** The occurrence of a recurring series. */
  recurrenceId?: string;
  /** When the occurrence starts (ms), to find it again on the server. */
  startMs?: number;
  /** The signed-in account the reminder was scheduled for. */
  appAccountId?: string;
}

// A tapped reminder arrives before CalendarScreen is mounted (cold start) or
// while it shows something else. The target is parked here and consumed by
// the screen, like pending-settings-tab.
interface PendingCalendarOpenState {
  target: CalendarReminderTarget | null;
  set: (target: CalendarReminderTarget | null) => void;
  consume: () => CalendarReminderTarget | null;
}

export const usePendingCalendarOpen = create<PendingCalendarOpenState>((set, get) => ({
  target: null,
  set: (target) => set({ target }),
  consume: () => {
    const target = get().target;
    if (target) set({ target: null });
    return target;
  },
}));

export function setPendingCalendarOpen(target: CalendarReminderTarget | null): void {
  usePendingCalendarOpen.getState().set(target);
}
