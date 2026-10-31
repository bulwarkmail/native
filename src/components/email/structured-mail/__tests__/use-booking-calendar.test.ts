// Port of webmail components/email/structured-mail/__tests__/
// use-booking-calendar.test.tsx at 3aac5a5c4, against the app's calendar
// store (its write functions swapped for mocks) and api/calendar's
// findEventsByUid (mocked). The webmail's plugin "blocked" cases and its
// keyboard and viewport cases for the floating picker have no app
// counterpart; the account switch cases are the app's own.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => (await import('./render-native')).reactNativeMock());
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }));
const findEventsByUid = vi.fn();
vi.mock('../../../../api/calendar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/calendar')>()),
  findEventsByUid: (uid: string) => findEventsByUid(uid),
}));
const navigate = vi.fn();
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate }) }));

import type { Calendar, CalendarEvent, Email } from '../../../../api/types';
import { loadAirportZones, readStructuredMail, resolveCards, type Booking, type StructuredCard } from '../../../../lib/structured-mail';
import { bookingToEvents } from '../../../../lib/structured-mail/calendar';
import { usePendingCalendarOpen } from '../../../../navigation/pending-calendar-open';
import { CalendarAccountChangedError, useCalendarStore } from '../../../../stores/calendar-store';
import { useCalendarSubscriptionsStore } from '../../../../stores/calendar-subscriptions-store';
import { BookingCalendarActions } from '../booking-calendar-actions';
import { resetRemovedBookingUids, useBookingCalendar } from '../use-booking-calendar';
import { byTestId, findAll, render, renderHook, textOf, waitFor, type HostNode } from './render-native';

const ctx = 'http://schema.org';
const NOW = new Date('2026-11-01T12:00:00Z');
const EMAIL = { from: [{ email: 'booking@mail.lufthansa.com' }], subject: 'Your booking QX7K2M' } as unknown as Email;

function leg(number: string, dep: [string, string], arr: [string, string], status?: string) {
  return {
    '@context': ctx, '@type': 'FlightReservation', reservationNumber: 'QX7K2M', underName: 'Erika Mustermann',
    ...(status ? { reservationStatus: `http://schema.org/${status}` } : {}),
    reservationFor: {
      '@type': 'Flight', flightNumber: number, airline: { name: 'Lufthansa', iataCode: 'LH' },
      departureAirport: { iataCode: dep[0] }, departureTime: dep[1],
      arrivalAirport: { iataCode: arr[0] }, arrivalTime: arr[1],
    },
  };
}

const OUT = leg('400', ['FRA', '2026-12-01T10:15:00+01:00'], ['JFK', '2026-12-01T13:05:00-05:00']);
const OUT_MOVED = leg('400', ['FRA', '2026-12-01T12:40:00+01:00'], ['JFK', '2026-12-01T15:35:00-05:00']);
const BACK = leg('401', ['JFK', '2026-12-08T17:30:00-05:00'], ['FRA', '2026-12-09T07:20:00+01:00']);
const BACK_CANCELLED = leg('401', ['JFK', '2026-12-08T17:30:00-05:00'], ['FRA', '2026-12-09T07:20:00+01:00'], 'ReservationCancelled');
const OUT_CANCELLED = leg('400', ['FRA', '2026-12-01T10:15:00+01:00'], ['JFK', '2026-12-01T13:05:00-05:00'], 'ReservationCancelled');

async function bookingFrom(items: unknown[], mailDate = '2026-10-30T10:00:00Z'): Promise<Booking> {
  const html = `<html><head>${items.map((i) => `<script type="application/ld+json">${JSON.stringify(i)}</script>`).join('')}</head></html>`;
  const cards = resolveCards(readStructuredMail(html, { mailDate: new Date(mailDate) }), await loadAirportZones());
  expect(cards).toHaveLength(1);
  return cards[0] as Booking;
}

/** CalendarEvent/get's shape for an event made from `wanted`: id, calendar, server defaults. */
function stored(wanted: Partial<CalendarEvent>, id: string, calendarId = 'cal-default'): CalendarEvent {
  const locations = Object.fromEntries(Object.entries(wanted.locations ?? {}).map(([key, loc]) => [key, { ...loc, iCalendar: { name: 'vlocation' } }]));
  return {
    ...wanted, id, calendarIds: { [calendarId]: true }, utcStart: '2026-12-01T09:15:00Z', participants: null,
    description: 'whatever the server keeps', locations,
  } as unknown as CalendarEvent;
}

const rights = (write: boolean) => ({ mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: write, mayWriteOwn: write, mayUpdatePrivate: true, mayRSVP: true, mayShare: false, mayDelete: write });
const cal = (id: string, extra: Partial<Calendar> = {}): Calendar => ({
  id, name: id, color: '#3366ff', isDefault: false, isSubscribed: true, isVisible: true, sortOrder: 0, description: null,
  shareWith: null, myRights: rights(true), ...extra,
});

const createEvent = vi.fn();
const updateEvent = vi.fn();
const deleteEvent = vi.fn();
const initialCalendar = useCalendarStore.getState();
const initialSubscriptions = useCalendarSubscriptionsStore.getState();

/** The calendar holds these events, found by uid. */
function calendarHolds(events: CalendarEvent[]) {
  findEventsByUid.mockImplementation(async (uid: string) => events.filter((e) => e.uid === uid));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  findEventsByUid.mockReset();
  calendarHolds([]);
  resetRemovedBookingUids();
  createEvent.mockReset().mockImplementation(async (event: Partial<CalendarEvent>, calendarId: string) => {
    const created = { ...event, id: `new-${event.uid}`, calendarIds: { [calendarId]: true } } as CalendarEvent;
    useCalendarStore.setState((s) => ({ events: [...s.events, created] }));
    return created;
  });
  updateEvent.mockReset().mockImplementation(async (id: string, patch: Partial<CalendarEvent>) => {
    useCalendarStore.setState((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  });
  deleteEvent.mockReset().mockResolvedValue(undefined);
  navigate.mockReset();
  useCalendarStore.setState({
    calendars: [cal('cal-default', { isDefault: true })],
    events: [],
    taskOnlyCalendarIds: [],
    createEvent, updateEvent, deleteEvent,
  });
  useCalendarSubscriptionsStore.setState({ subscriptions: [] });
});

afterEach(() => {
  vi.useRealTimers();
  useCalendarStore.setState(initialCalendar, true);
  useCalendarSubscriptionsStore.setState(initialSubscriptions, true);
  usePendingCalendarOpen.setState({ target: null });
});

async function settled(card: StructuredCard | null) {
  const hook = renderHook(() => useBookingCalendar(card, EMAIL));
  await waitFor(() => expect(hook.current.status).not.toBe('loading'));
  return hook;
}

describe('useBookingCalendar', () => {
  it('offers to add a booking the calendar lacks, and adds each live leg once', async () => {
    const booking = await bookingFrom([OUT, BACK]);
    const hook = await settled(booking);
    expect(hook.current.status).toBe('add');
    expect(findEventsByUid).toHaveBeenCalledTimes(2);

    await hook.current.add('cal-default');
    expect(createEvent).toHaveBeenCalledTimes(2);
    const [first, calendarId] = createEvent.mock.calls[0];
    const wanted = bookingToEvents(booking, { senderDomain: 'lufthansa.com' })[0];
    expect(calendarId).toBe('cal-default');
    expect(first).toMatchObject({
      uid: wanted.uid, title: 'LH 400 FRA → JFK',
      start: '2026-12-01T10:15:00', timeZone: 'Europe/Berlin', duration: 'PT8H50M',
    });
    expect(first).not.toHaveProperty('participants');
    // No options: never scheduling messages.
    expect(createEvent.mock.calls[0]).toHaveLength(2);
    expect(hook.current.status).toBe('in-calendar');
    expect(hook.current.notice).toBe('added');
  });

  it('says the booking is in the calendar when every leg is there unchanged', async () => {
    const booking = await bookingFrom([OUT, BACK]);
    const [a, b] = bookingToEvents(booking, { senderDomain: 'lufthansa.com' });
    calendarHolds([stored(a, 'e1'), stored(b, 'e2')]);
    const hook = await settled(booking);
    expect(hook.current.status).toBe('in-calendar');
    expect(useCalendarStore.getState().events.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
  });

  it('updates the found event after a schedule change and never creates a second one', async () => {
    const [old] = bookingToEvents(await bookingFrom([OUT]), { senderDomain: 'lufthansa.com' });
    calendarHolds([stored(old, 'e1')]);
    const hook = await settled(await bookingFrom([OUT_MOVED]));
    expect(hook.current.status).toBe('update');

    await hook.current.update();
    expect(createEvent).not.toHaveBeenCalled();
    expect(updateEvent).toHaveBeenCalledTimes(1);
    const [id, patch, options] = updateEvent.mock.calls[0];
    expect(id).toBe('e1');
    expect(patch).toMatchObject({ start: '2026-12-01T12:40:00', timeZone: 'Europe/Berlin', duration: 'PT8H55M' });
    // The stored description isn't the generated one any more: title and notes stay the user's.
    expect(patch).not.toHaveProperty('title');
    expect(patch).not.toHaveProperty('description');
    expect(options).toBeUndefined();
    expect(hook.current.status).toBe('in-calendar');
  });

  it('adds a missing leg next to the others, in their calendar, as an update', async () => {
    useCalendarStore.setState({ calendars: [cal('cal-default', { isDefault: true }), cal('cal-travel')] });
    const booking = await bookingFrom([OUT, BACK]);
    const [a] = bookingToEvents(booking, { senderDomain: 'lufthansa.com' });
    calendarHolds([stored(a, 'e1', 'cal-travel')]);
    const hook = await settled(booking);
    expect(hook.current.status).toBe('update');
    await hook.current.update();
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent.mock.calls[0][0]).toMatchObject({ title: 'LH 401 JFK → FRA' });
    expect(createEvent.mock.calls[0][1]).toBe('cal-travel');
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('offers to remove a cancelled booking that is in the calendar, and removes it', async () => {
    const [old] = bookingToEvents(await bookingFrom([OUT]), { senderDomain: 'lufthansa.com' });
    calendarHolds([stored(old, 'e1')]);
    const hook = await settled(await bookingFrom([OUT_CANCELLED]));
    expect(hook.current.status).toBe('remove');
    await hook.current.remove();
    expect(deleteEvent).toHaveBeenCalledWith('e1');
    expect(createEvent).not.toHaveBeenCalled();
    expect(hook.current.status).toBe('cancelled');
    expect(hook.current.notice).toBe('removed');
  });

  it('offers nothing for a cancelled booking the calendar never had', async () => {
    const hook = await settled(await bookingFrom([OUT_CANCELLED]));
    expect(hook.current.status).toBe('cancelled');
  });

  it('never adds a cancelled leg, and removes its event along with the update', async () => {
    const booking = await bookingFrom([OUT, BACK_CANCELLED]);
    const hook = await settled(booking);
    expect(hook.current.status).toBe('add');
    await hook.current.add();
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent.mock.calls[0][0]).toMatchObject({ title: 'LH 400 FRA → JFK' });

    const [a, b] = bookingToEvents(await bookingFrom([OUT, BACK]), { senderDomain: 'lufthansa.com' });
    calendarHolds([stored(a, 'e1'), stored(b, 'e2')]);
    useCalendarStore.setState({ events: [] });
    createEvent.mockClear();
    const second = await settled(booking);
    expect(second.current.status).toBe('update');
    await second.current.update();
    expect(deleteEvent).toHaveBeenCalledWith('e2');
    expect(createEvent).not.toHaveBeenCalled();
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('does not find events another sender domain made', async () => {
    const booking = await bookingFrom([OUT]);
    const [foreign] = bookingToEvents(booking, { senderDomain: 'lufthansa-deals.com' });
    calendarHolds([stored(foreign, 'e9')]);
    const hook = await settled(booking);
    expect(hook.current.status).toBe('add');
  });

  it('shows nothing for a booking that is over', async () => {
    vi.setSystemTime(new Date('2026-12-02T12:00:00Z'));
    expect(renderHook(() => useBookingCalendar(null, EMAIL)).current.status).toBe('hidden');
    const booking = await bookingFrom([OUT]);
    expect(renderHook(() => useBookingCalendar(booking, EMAIL)).current.status).toBe('hidden');
    expect(findEventsByUid).not.toHaveBeenCalled();
  });

  it('shows nothing for shipments', () => {
    const shipment: StructuredCard = { kind: 'shipment', key: 'shipment|order:1', orderNumber: '1', items: [], parcels: [], source: 'json-ld' };
    expect(renderHook(() => useBookingCalendar(shipment, EMAIL)).current.status).toBe('hidden');
  });

  it('shows nothing when the lookup fails, rather than risk a duplicate', async () => {
    findEventsByUid.mockRejectedValue(new Error('offline'));
    const hook = await settled(await bookingFrom([OUT]));
    expect(hook.current.status).toBe('hidden');
  });

  it('shows nothing to add without a calendar it may write to', async () => {
    useCalendarStore.setState({ calendars: [cal('ro', { myRights: rights(false) })] });
    const hook = await settled(await bookingFrom([OUT]));
    expect(hook.current.status).toBe('hidden');
  });

  it('says why an add failed and looks the events up again', async () => {
    createEvent.mockRejectedValue(new Error('Failed to create event'));
    const hook = await settled(await bookingFrom([OUT]));
    await hook.current.add();
    expect(hook.current.error).toBe("Couldn't change your calendar. Try again.");
    expect(hook.current.status).toBe('add');
    await waitFor(() => expect(findEventsByUid).toHaveBeenCalledTimes(2));
  });

  it('shows a booking added from another card for the same booking as in the calendar', async () => {
    const first = await settled(await bookingFrom([OUT]));
    const second = await settled(await bookingFrom([OUT]));
    expect(first.current.status).toBe('add');
    expect(second.current.status).toBe('add');
    await second.current.add();
    expect(second.current.status).toBe('in-calendar');
    await waitFor(() => expect(first.current.status).toBe('in-calendar'));
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it('shows a booking removed from another card as gone', async () => {
    const [old] = bookingToEvents(await bookingFrom([OUT]), { senderDomain: 'lufthansa.com' });
    calendarHolds([stored(old, 'e1')]);
    deleteEvent.mockImplementation(async (id: string) => {
      useCalendarStore.setState((s) => ({ events: s.events.filter((e) => e.id !== id) }));
    });
    const first = await settled(await bookingFrom([OUT_CANCELLED]));
    const second = await settled(await bookingFrom([OUT_CANCELLED]));
    expect(first.current.status).toBe('remove');
    await second.current.remove();
    await waitFor(() => expect(first.current.status).toBe('cancelled'));
  });

  describe('account switches', () => {
    it('drops a lookup that lands after the account changed', async () => {
      let answer: (events: CalendarEvent[]) => void = () => undefined;
      findEventsByUid.mockImplementation(() => new Promise<CalendarEvent[]>((resolve) => { answer = resolve; }));
      const hook = renderHook(() => useBookingCalendar(OUT_BOOKING!, EMAIL));
      expect(hook.current.status).toBe('loading');
      useCalendarStore.getState().reset();
      useCalendarStore.setState({ calendars: [cal('cal-default', { isDefault: true })], createEvent, updateEvent, deleteEvent });
      answer([]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(hook.current.status).toBe('loading');
    });

    it('stops a multi-leg add at the switch, and says nothing failed', async () => {
      const hook = await settled(await bookingFrom([OUT, BACK]));
      createEvent.mockImplementationOnce(async (event: Partial<CalendarEvent>, calendarId: string) => {
        const created = { ...event, id: 'new-1', calendarIds: { [calendarId]: true } } as CalendarEvent;
        // The account changes while the first leg is being written.
        useCalendarStore.getState().reset();
        useCalendarStore.setState({ createEvent, updateEvent, deleteEvent });
        return created;
      });
      await hook.current.add('cal-default');
      // The second leg never went out to the next account.
      expect(createEvent).toHaveBeenCalledTimes(1);
      expect(hook.current.error).toBeNull();
    });

    it('shows no error when the store refuses a write the switch overtook', async () => {
      createEvent.mockRejectedValue(new CalendarAccountChangedError());
      const hook = await settled(await bookingFrom([OUT]));
      await hook.current.add();
      expect(hook.current.error).toBeNull();
      expect(hook.current.notice).toBeNull();
    });
  });
});

let OUT_BOOKING: Booking | null = null;
beforeEach(async () => {
  OUT_BOOKING ??= await bookingFrom([OUT]);
});

/** BookingCalendarActions with its own state; the tree is rendered from the latest output. */
function mountActions(booking: Booking) {
  const hook = renderHook(() => BookingCalendarActions({ booking, email: EMAIL }));
  return { hook, tree: (): HostNode => render(hook.current ?? createElement('View')) };
}

const buttonText = (tree: HostNode) => findAll(tree, (n) => n.type === 'Pressable').map(textOf);

describe('BookingCalendarActions', () => {
  it('lists only writable event calendars of the own account, the default first', async () => {
    useCalendarStore.setState({
      calendars: [
        cal('Work'),
        cal('Personal', { isDefault: true }),
        cal('Tasks'),
        cal('Holidays', { myRights: rights(false) }),
        cal('Team', { isShared: true, accountId: 'other' }),
        cal('Feed'),
      ],
      taskOnlyCalendarIds: ['Tasks'],
    });
    useCalendarSubscriptionsStore.setState({ subscriptions: [{ id: 'sub', calendarId: 'Feed' } as never] });
    const { hook, tree } = mountActions(await bookingFrom([OUT]));
    await waitFor(() => expect(byTestId(tree(), 'booking-calendar-add')).toHaveLength(1));
    byTestId(tree(), 'booking-calendar-add')[0].props.onPress();
    const choices = byTestId(tree(), 'booking-calendar-choice');
    expect(choices.map(textOf)).toEqual(['Personal', 'Work']);
    choices[1].props.onPress();
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent.mock.calls[0][1]).toBe('Work');
    await waitFor(() => expect(textOf(byTestId(tree(), 'booking-calendar-notice')[0])).toBe('Added to your calendar'));
    hook.unmount();
  });

  it('adds straight away when there is one calendar to choose, then shows the pill and the way to the calendar', async () => {
    const booking = await bookingFrom([OUT]);
    const { tree } = mountActions(booking);
    await waitFor(() => expect(byTestId(tree(), 'booking-calendar-add')).toHaveLength(1));
    byTestId(tree(), 'booking-calendar-add')[0].props.onPress();
    expect(byTestId(tree(), 'booking-calendar-picker')).toHaveLength(0);
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent.mock.calls[0][1]).toBe('cal-default');

    const [wanted] = bookingToEvents(booking, { senderDomain: 'lufthansa.com' });
    calendarHolds([stored(wanted, 'e1')]);
    useCalendarStore.setState({ events: [] });
    const again = mountActions({ ...booking });
    await waitFor(() => expect(textOf(again.tree())).toContain('In your calendar'));
    expect(buttonText(again.tree())).toEqual(['View in calendar']);
    byTestId(again.tree(), 'booking-calendar-view')[0].props.onPress();
    expect(usePendingCalendarOpen.getState().target).toMatchObject({ kind: 'event', eventId: 'e1', serverId: 'e1', startMs: Date.parse('2026-12-01T09:15:00Z') });
    expect(navigate).toHaveBeenCalledWith('MainTabs', { screen: 'Calendar' });
  });

  it('shows the error under the buttons when a change fails', async () => {
    createEvent.mockRejectedValue(new Error('nope'));
    const { tree } = mountActions(await bookingFrom([OUT]));
    await waitFor(() => expect(byTestId(tree(), 'booking-calendar-add')).toHaveLength(1));
    byTestId(tree(), 'booking-calendar-add')[0].props.onPress();
    await waitFor(() => expect(textOf(byTestId(tree(), 'booking-calendar-error')[0])).toBe("Couldn't change your calendar. Try again."));
  });

  it('renders nothing for a booking that is over', async () => {
    const booking = await bookingFrom([OUT]);
    vi.setSystemTime(new Date('2026-12-02T12:00:00Z'));
    const { hook } = mountActions(booking);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hook.current).toBeNull();
    expect(findEventsByUid).not.toHaveBeenCalled();
  });
});
