// Port of webmail components/email/structured-mail/use-booking-calendar.ts
// at 3aac5a5c4. App differences:
// - lookups go through api/calendar findEventsByUid (CalendarEvent/query by
//   uid in the primary account) and writes through the calendar store, whose
//   account guard (writeScope) stops a write that an account switch overtook;
//   an action of several writes also checks calendarOperationScope between
//   them, and a lookup that lands after a switch is dropped;
// - the store's writes throw instead of answering false, and no plugin can
//   stop them, so there is no "blocked" notice;
// - an add goes through sanitizeOutgoingCalendarEventData first, as the
//   webmail's calendar store does on create;
// - "View in calendar" opens the event on the Calendar tab the way a tapped
//   reminder does (pending-calendar-open), through the caller's navigator.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { findEventsByUid } from '../../../api/calendar';
import type { Calendar, CalendarEvent, Email } from '../../../api/types';
import { canCreateEventsIn } from '../../../lib/calendar-editability';
import { useHasCalendar } from '../../../lib/capabilities';
import {
  bookingEndsAt,
  bookingEventPatch,
  bookingEventSlots,
  eventNeedsUpdate,
  senderDomainOf,
  type BookingEventLabels,
  type BookingEventSlot,
} from '../../../lib/structured-mail/calendar';
import { sanitizeOutgoingCalendarEventData } from '../../../lib/structured-mail/event-normalization';
import type { StructuredCard } from '../../../lib/structured-mail';
import { setPendingCalendarOpen } from '../../../navigation/pending-calendar-open';
import {
  CalendarAccountChangedError,
  calendarOperationScope,
  calendarStoreGeneration,
  useCalendarStore,
} from '../../../stores/calendar-store';
import { useCalendarSubscriptionsStore } from '../../../stores/calendar-subscriptions-store';
import { useLocaleStore } from '../../../stores/locale-store';

/**
 * What the card offers for its booking:
 * - `hidden`: nothing (no calendar, shipment, booking over, lookup failed)
 * - `loading`: looking the events up; nothing to show yet
 * - `add`: none of the booking's events is in the calendar
 * - `in-calendar`: every live event is there and up to date
 * - `update`: some are there, and others are missing, changed or cancelled
 * - `remove`: the booking is cancelled and its events are still there
 * - `cancelled`: the booking is cancelled and nothing of it is in the calendar
 */
export type BookingCalendarStatus = 'hidden' | 'loading' | 'add' | 'in-calendar' | 'update' | 'remove' | 'cancelled';

export interface BookingCalendar {
  status: BookingCalendarStatus;
  /** Calendars an add can go into: own account, writable, not tasks-only; the default first. */
  calendars: Calendar[];
  busy: boolean;
  /** What went wrong with the last action, in the user's language. */
  error: string | null;
  /** What the last action did, for a short confirmation. */
  notice: 'added' | 'updated' | 'removed' | null;
  /** Add every live event, into `calendarId` or the default calendar. */
  add: (calendarId?: string) => Promise<void>;
  /** Add the missing live events, update the changed ones, remove the cancelled ones. */
  update: () => Promise<void>;
  /** Remove the events of cancelled legs or of the cancelled booking. */
  remove: () => Promise<void>;
  /** Open the booking's event on the Calendar tab (through `openCalendar`). */
  viewInCalendar: () => void;
}

/**
 * Uids whose events a card removed in this session. Another card for the
 * same booking (a conversation showing two of its mails) may still hold the
 * event from its own lookup; this tells it the event is gone.
 */
const removedUids = new Set<string>();

/** For tests: forget the uids removed so far. */
export function resetRemovedBookingUids(): void {
  removedUids.clear();
}

type Lookup = { key: string; failed: false; events: Record<string, CalendarEvent | null> } | { key: string; failed: true };

interface Plan {
  status: BookingCalendarStatus;
  /** Live slots and the stored event of each (null: not in the calendar). */
  live: { slot: BookingEventSlot; existing: CalendarEvent | null }[];
  /** Stored events of cancelled slots. */
  stale: { slot: BookingEventSlot; existing: CalendarEvent }[];
}

/** Own calendars an event can be created in, the default first. */
export function bookingTargetCalendars(
  calendars: Calendar[],
  isSubscriptionCalendar: (calendarId: string) => boolean,
  taskOnlyCalendarIds: readonly string[],
): Calendar[] {
  const own = calendars.filter((c) =>
    !c.isShared
    && !taskOnlyCalendarIds.includes(c.id)
    && canCreateEventsIn(c, isSubscriptionCalendar));
  const defaultCalendar = own.find((c) => c.isDefault);
  return defaultCalendar ? [defaultCalendar, ...own.filter((c) => c !== defaultCalendar)] : own;
}

export function planFor(slots: BookingEventSlot[], existingOf: (uid: string) => CalendarEvent | null): Plan {
  const live = slots
    .filter((slot) => !slot.cancelled && slot.event)
    .map((slot) => ({ slot, existing: existingOf(slot.uid) }));
  const stale = slots
    .filter((slot) => slot.cancelled)
    .map((slot) => ({ slot, existing: existingOf(slot.uid) }))
    .filter((entry): entry is { slot: BookingEventSlot; existing: CalendarEvent } => entry.existing !== null);
  let status: BookingCalendarStatus;
  if (live.length === 0) {
    status = slots.some((s) => s.cancelled) ? (stale.length > 0 ? 'remove' : 'cancelled') : 'hidden';
  } else {
    const found = live.filter((entry) => entry.existing);
    const changed = found.some((entry) => eventNeedsUpdate(entry.existing as CalendarEvent, entry.slot.event as Partial<CalendarEvent>));
    if (found.length === 0 && stale.length === 0) status = 'add';
    else if (found.length < live.length || changed || stale.length > 0) status = 'update';
    else status = 'in-calendar';
  }
  return { status, live, stale };
}

/**
 * Calendar state and actions for one booking card. Looks each of the
 * booking's event uids up in the primary calendar account, merges what it
 * finds into the calendar store, and never creates an event whose uid it
 * found. Hidden unless the account has calendars and the booking isn't over.
 */
export function useBookingCalendar(
  booking: StructuredCard | null | undefined,
  email: Pick<Email, 'from' | 'subject'> | null | undefined,
  options: { openCalendar?: () => void } = {},
): BookingCalendar {
  const t = useLocaleStore((s) => s.t);
  const hasCalendar = useHasCalendar();
  const calendars = useCalendarStore((s) => s.calendars);
  const storeEvents = useCalendarStore((s) => s.events);
  const taskOnlyCalendarIds = useCalendarStore((s) => s.taskOnlyCalendarIds);
  const createEvent = useCalendarStore((s) => s.createEvent);
  const updateEvent = useCalendarStore((s) => s.updateEvent);
  const deleteEvent = useCalendarStore((s) => s.deleteEvent);
  const subscriptions = useCalendarSubscriptionsStore((s) => s.subscriptions);
  const { openCalendar } = options;

  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<BookingCalendar['notice']>(null);
  const [refresh, setRefresh] = useState(0);

  const senderDomain = senderDomainOf(email?.from?.[0]?.email);
  const subject = email?.subject;
  const labels = useMemo<Partial<BookingEventLabels>>(() => ({
    reference: (reference) => t('structured_mail_calendar.description.reference', 'Booking reference: {reference}', { reference }),
    passengers: (names) => t('structured_mail_calendar.description.passengers', 'Passengers: {names}', { names }),
    seats: (seats) => t('structured_mail_calendar.description.seats', 'Seats: {seats}', { seats }),
    checkin: (url) => t('structured_mail_calendar.description.checkin', 'Check in: {url}', { url }),
    manage: (url) => t('structured_mail_calendar.description.manage', 'Manage booking: {url}', { url }),
    ticket: (url) => t('structured_mail_calendar.description.ticket', 'Ticket: {url}', { url }),
    phone: (phone) => t('structured_mail_calendar.description.phone', 'Phone: {phone}', { phone }),
    car: (car) => t('structured_mail_calendar.description.car', 'Car: {car}', { car }),
    tickets: (numbers) => t('structured_mail_calendar.description.tickets', 'Tickets: {numbers}', { numbers }),
    partySize: (count) => t('structured_mail_calendar.description.party_size', 'Party size: {count}', { count }),
    rentalCar: (company) => (company
      ? t('structured_mail_calendar.title.rental_car_company', 'Rental car: {company}', { company })
      : t('structured_mail_calendar.title.rental_car', 'Rental car')),
    addedFrom: (domain, mailSubject) => (mailSubject
      ? t('structured_mail_calendar.description.added_from_subject', 'Added from the mail “{subject}” from {domain}', { domain, subject: mailSubject })
      : t('structured_mail_calendar.description.added_from', 'Added from a mail from {domain}', { domain })),
  }), [t]);

  const slots = useMemo(
    () => (booking && senderDomain ? bookingEventSlots(booking, { senderDomain, mailSubjectOrProvider: subject, labels }) : []),
    [booking, senderDomain, subject, labels],
  );
  const uidKey = slots.map((s) => s.uid).join(' ');

  const endsAt = booking && booking.kind !== 'shipment' ? bookingEndsAt(booking) : null;
  const over = endsAt === null || endsAt < Date.now();
  const active = hasCalendar && !over && slots.length > 0;

  useEffect(() => {
    if (!active || !uidKey) return;
    let current = true;
    const generation = calendarStoreGeneration();
    const uids = uidKey.split(' ');
    // The primary calendar account, the only one the picker offers.
    Promise.all(uids.map((uid) => findEventsByUid(uid)))
      .then((results) => {
        // An account switch since: what came back is the previous account's.
        if (!current || generation !== calendarStoreGeneration()) return;
        const events: Record<string, CalendarEvent | null> = {};
        uids.forEach((uid, i) => {
          events[uid] = results[i].find((e) => e.uid === uid && !e.recurrenceId) ?? null;
          if (events[uid]) removedUids.delete(uid);
        });
        setLookup({ key: uidKey, failed: false, events });
        const hits = Object.values(events).filter((e): e is CalendarEvent => e !== null);
        if (hits.length > 0) {
          useCalendarStore.setState((s) => {
            const ids = new Set(s.events.map((e) => e.id));
            const added = hits.filter((e) => !ids.has(e.id));
            return added.length > 0 ? { events: [...s.events, ...added] } : s;
          });
        }
      })
      .catch(() => {
        // Not knowing what the calendar holds, offering "Add" could duplicate: show nothing.
        if (current) setLookup({ key: uidKey, failed: true });
      });
    return () => { current = false; };
  }, [active, uidKey, refresh]);

  const targets = useMemo(() => {
    const isSubscriptionCalendar = (id: string) => subscriptions.some((s) => s.calendarId === id);
    return bookingTargetCalendars(calendars, isSubscriptionCalendar, taskOnlyCalendarIds);
  }, [calendars, subscriptions, taskOnlyCalendarIds]);

  const known = lookup && lookup.key === uidKey && !lookup.failed ? lookup.events : null;
  const existingOf = useCallback((uid: string): CalendarEvent | null => {
    if (removedUids.has(uid)) return null;
    const stored = known?.[uid];
    // The store's copy of the same event is fresher after a change elsewhere.
    if (stored) return storeEvents.find((e) => e.id === stored.id) ?? stored;
    // Added since the lookup, maybe by another card for the same booking.
    return storeEvents.find((e) => e.uid === uid && !e.recurrenceId && !e.isShared) ?? null;
  }, [known, storeEvents]);

  const plan = useMemo<Plan>(() => {
    if (!active) return { status: 'hidden', live: [], stale: [] };
    if (!lookup || lookup.key !== uidKey) return { status: 'loading', live: [], stale: [] };
    if (lookup.failed) return { status: 'hidden', live: [], stale: [] };
    return planFor(slots, existingOf);
  }, [active, lookup, uidKey, slots, existingOf]);

  const status: BookingCalendarStatus = plan.status === 'add' && targets.length === 0 ? 'hidden' : plan.status;

  const remember = useCallback((uid: string, event: CalendarEvent | null) => {
    setLookup((prev) => (prev && !prev.failed && prev.key === uidKey ? { ...prev, events: { ...prev.events, [uid]: event } } : prev));
  }, [uidKey]);

  /** Run one action; on failure say why and look the events up again. */
  const run = useCallback(async (done: NonNullable<BookingCalendar['notice']>, work: (assertScope: () => void) => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const scope = calendarOperationScope();
    try {
      await work(scope.assert);
      setNotice(done);
    } catch (err) {
      // The account changed under the action: nothing failed in the account shown now.
      if (err instanceof CalendarAccountChangedError) return;
      setError(t('structured_mail_calendar.action_failed', "Couldn't change your calendar. Try again."));
      setRefresh((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }, [busy, t]);

  const createMissing = useCallback(async (calendarId: string, assertScope: () => void): Promise<void> => {
    for (const { slot, existing } of plan.live) {
      if (existing) continue;
      assertScope();
      const created = await createEvent(sanitizeOutgoingCalendarEventData({ ...slot.event }), calendarId);
      removedUids.delete(slot.uid);
      remember(slot.uid, created);
    }
  }, [plan.live, createEvent, remember]);

  const removeStale = useCallback(async (assertScope: () => void): Promise<void> => {
    for (const { slot, existing } of plan.stale) {
      assertScope();
      // Marked before the store drops the event, so other cards that
      // re-render on that change already see it gone.
      removedUids.add(slot.uid);
      try {
        await deleteEvent(existing.id);
      } catch (err) {
        removedUids.delete(slot.uid);
        throw err;
      }
      remember(slot.uid, null);
    }
  }, [plan.stale, deleteEvent, remember]);

  const add = useCallback((calendarId?: string) => run('added', async (assertScope) => {
    const target = calendarId ?? targets[0]?.id;
    if (!target || !targets.some((c) => c.id === target)) throw new Error('no writable calendar');
    await createMissing(target, assertScope);
  }), [run, targets, createMissing]);

  const update = useCallback(() => run('updated', async (assertScope) => {
    for (const { slot, existing } of plan.live) {
      if (!existing || !eventNeedsUpdate(existing, slot.event as Partial<CalendarEvent>)) continue;
      // Only what moved; title and notes the user changed stay.
      const patch = bookingEventPatch(existing, slot.event as Partial<CalendarEvent>, senderDomain);
      if (Object.keys(patch).length === 0) continue;
      assertScope();
      await updateEvent(existing.id, patch);
      // The store merged the patch into its copy, which the card reads first.
      remember(slot.uid, { ...existing, ...patch } as CalendarEvent);
    }
    if (plan.live.some((entry) => !entry.existing)) {
      // Missing legs go where the booking's other events are.
      const used = plan.live.flatMap((entry) => Object.keys(entry.existing?.calendarIds ?? {}));
      const target = targets.find((c) => used.includes(c.id))?.id ?? targets[0]?.id;
      if (!target) throw new Error('no writable calendar');
      await createMissing(target, assertScope);
    }
    await removeStale(assertScope);
  }), [run, plan.live, senderDomain, targets, updateEvent, remember, createMissing, removeStale]);

  const remove = useCallback(() => run('removed', removeStale), [run, removeStale]);

  const viewInCalendar = useCallback(() => {
    const target = plan.live.find((entry) => entry.existing)?.existing ?? plan.stale[0]?.existing;
    if (target) {
      const startMs = target.utcStart ? Date.parse(target.utcStart) : NaN;
      setPendingCalendarOpen({
        kind: 'event',
        eventId: target.id,
        serverId: target.originalId ?? target.id,
        ...(Number.isFinite(startMs) ? { startMs } : {}),
      });
    }
    openCalendar?.();
  }, [plan, openCalendar]);

  return {
    status,
    calendars: targets,
    busy,
    error: status === 'hidden' ? null : error,
    notice: status === 'hidden' ? null : notice,
    add,
    update,
    remove,
    viewInCalendar,
  };
}
