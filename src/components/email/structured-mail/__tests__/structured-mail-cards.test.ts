// Port of webmail components/email/structured-mail/__tests__/
// structured-mail-cards.test.tsx at 972e5f621, on the app's views: the same
// cards from the reviewed fixtures, read back from the rendered tree. The
// strings are the English fallbacks (the vendored catalog predates these
// keys), so the assertions read like the cards do.
import { createElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => (await import('./render-native')).reactNativeMock());
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }));
const setStringAsync = vi.fn(async (_value: string) => true);
vi.mock('expo-clipboard', () => ({ setStringAsync: (value: string) => setStringAsync(value) }));
const toastSuccess = vi.fn();
vi.mock('../../../../stores/toast-store', () => ({ toast: { success: (m: string) => toastSuccess(m), error: vi.fn() } }));
const openExternalUrl = vi.fn(async (_url: string) => true);
vi.mock('../../../../lib/open-url', () => ({ openExternalUrl: (url: string) => openExternalUrl(url) }));

import { I18nManager } from 'react-native';
import expectedCards from '../../../../lib/structured-mail/__tests__/fixtures/expected-cards.json';
import type { Booking, Shipment, StructuredCard, TransportBooking } from '../../../../lib/structured-mail/types';
import { useSettingsStore } from '../../../../stores/settings-store';
import { StructuredMailCards, type StructuredMailCardsProps } from '../structured-mail-cards';
import { byLabel, byTestId, findAll, oneByTestId, rawTextOf, render, styleOf, textOf, type HostNode } from './render-native';

const fixtures = expectedCards as unknown as Record<string, StructuredCard[]>;
const card = <T extends StructuredCard = StructuredCard>(id: string, index = 0) => structuredClone(fixtures[id][index]) as T;
const initialSettings = useSettingsStore.getState();

beforeAll(() => {
  // Only Date is faked: "now" decides whether a year is shown.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  useSettingsStore.setState({ timeFormat: '24h', calendarTimeZone: 'Europe/Berlin' });
});
afterEach(() => {
  useSettingsStore.setState(initialSettings, true);
  setStringAsync.mockClear();
  toastSuccess.mockClear();
  openExternalUrl.mockClear();
  (I18nManager as { isRTL: boolean }).isRTL = false;
});

function show(cards: StructuredCard[], extra: Partial<StructuredMailCardsProps> = {}): HostNode {
  return render(createElement(StructuredMailCards, { cards, allowRemoteImages: false, ...extra }));
}

/** The card with this accessible name (one of them). */
function region(tree: HostNode, name: string, index = 0): HostNode {
  const found = findAll(tree, (n) => n.type === 'View' && n.props.accessibilityLabel === name && /^structured-mail-card-/.test(n.props.testID ?? ''));
  if (!found[index]) throw new Error(`no card named ${name}`);
  return found[index];
}

const title = (node: HostNode) => oneByTestId(node, 'structured-mail-title');
const pressables = (node: HostNode) => findAll(node, (n) => n.type === 'Pressable');

describe('StructuredMailCards', () => {
  it('renders nothing for an empty list', () => {
    expect(show([]).children).toEqual([]);
  });

  it('shows a flight with its route, legs at local time, passengers and seats', () => {
    const r = region(show([card('flight-two-passengers-two-legs')]), 'Flight booking');
    expect(title(r).props.accessibilityLabel).toBe('FRA to JFK to FRA');
    expect(textOf(title(r))).toBe('FRA → JFK → FRA');
    expect(textOf(r)).toContain('Flight · Lufthansa');
    const legs = byTestId(r, 'structured-mail-leg');
    expect(legs).toHaveLength(2);
    // The mail's wall clock at each airport: 10:15 in Frankfurt, 13:05 in New York.
    expect(textOf(legs[0])).toContain('Lufthansa LH 400');
    expect(textOf(legs[0])).toContain('Tue, Dec 1, 10:15 · Frankfurt Airport (FRA)');
    expect(textOf(legs[0])).toContain('13:05 local time · John F. Kennedy International Airport (JFK)');
    // Overnight return: the arrival date is written out.
    expect(textOf(legs[1])).toContain('Tue, Dec 8, 17:30');
    expect(textOf(legs[1])).toContain('Wed, Dec 9, 07:20 · Frankfurt Airport (FRA)');
    expect(textOf(legs[0])).toContain('Seats: Erika Mustermann 12A, Max Mustermann 12B');
    expect(textOf(r)).toContain('Erika Mustermann, Max Mustermann');
  });

  it('marks only the times whose place keeps another clock than the reader', () => {
    const [outbound] = byTestId(show([card('flight-two-passengers-two-legs')]), 'structured-mail-leg');
    // Reader in Berlin: Frankfurt needs no mark, New York does.
    expect(byTestId(outbound, 'local-time-hint')).toHaveLength(1);
  });

  it('never shifts the time to the reader zone', () => {
    useSettingsStore.setState({ calendarTimeZone: 'Asia/Tokyo' });
    const [outbound] = byTestId(show([card('flight-two-passengers-two-legs')]), 'structured-mail-leg');
    expect(textOf(outbound)).toContain('Tue, Dec 1, 10:15');
    expect(textOf(outbound)).toContain('13:05');
    expect(byTestId(outbound, 'local-time-hint')).toHaveLength(2);
  });

  it('writes times on the 12-hour clock when the user picked it', () => {
    useSettingsStore.setState({ timeFormat: '12h' });
    const [outbound] = byTestId(show([card('flight-two-passengers-two-legs')]), 'structured-mail-leg');
    expect(textOf(outbound)).toMatch(/Tue, Dec 1, 10:15\sAM/);
  });

  it('copies the booking reference', async () => {
    const tree = show([card('flight-two-passengers-two-legs')]);
    const [chip] = byLabel(tree, 'Copy booking reference QX7K2M');
    expect(chip.type).toBe('Pressable');
    chip.props.onPress();
    await vi.waitFor(() => expect(setStringAsync).toHaveBeenCalledWith('QX7K2M'));
    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Booking reference copied'));
  });

  it('shows the check-in link with its host and opens it through the URL guard', () => {
    const tree = show([card('flight-two-passengers-two-legs')]);
    const [link] = byTestId(tree, 'structured-mail-link');
    expect(link.props.accessibilityRole).toBe('link');
    expect(textOf(link)).toBe('Check in· airline-a.example.com');
    link.props.onPress();
    expect(openExternalUrl).toHaveBeenCalledWith('https://www.airline-a.example.com/checkin?pnr=QX7K2M');
  });

  it('never renders a link that is not http(s)', () => {
    const flight = card<TransportBooking>('flight-two-passengers-two-legs');
    flight.links = { checkin: { url: 'javascript:alert(1)', host: 'evil.example' }, manage: { url: 'data:text/html,x', host: 'x' } };
    const tree = show([flight]);
    expect(byTestId(tree, 'structured-mail-link')).toHaveLength(0);
    expect(JSON.stringify(textOf(tree))).not.toContain('javascript:');
  });

  it('shows a cancelled booking struck through with a Cancelled pill', () => {
    const r = region(show([card('flight-cancelled')]), 'Flight booking');
    expect(byTestId(r, 'structured-mail-pill').map(textOf)).toEqual(['Cancelled']);
    expect(styleOf(title(r)).textDecorationLine).toBe('line-through');
  });

  it('marks a single cancelled leg of a live booking', () => {
    const flight = card<TransportBooking>('flight-two-passengers-two-legs');
    flight.legs[1].status = 'cancelled';
    const tree = show([flight]);
    expect(byTestId(tree, 'structured-mail-leg')).toHaveLength(1);
    const [cancelled] = byTestId(tree, 'structured-mail-leg-cancelled');
    expect(byTestId(cancelled, 'structured-mail-pill').map(textOf)).toEqual(['Cancelled']);
    expect(styleOf(title(tree)).textDecorationLine).toBeUndefined();
  });

  it('shows Pending and On hold', () => {
    const pending = card<TransportBooking>('train-multiple-types');
    pending.status = 'pending';
    const hold = card<Booking>('graph-hotel');
    hold.status = 'hold';
    const tree = show([pending, hold]);
    expect(textOf(region(tree, 'Train booking'))).toContain('Pending');
    expect(textOf(region(tree, 'Hotel booking'))).toContain('On hold');
  });

  it('titles a train with its towns and lists the stations', () => {
    const r = region(show([card('train-multiple-types')]), 'Train booking');
    expect(title(r).props.accessibilityLabel).toBe('Hamburg to München');
    expect(textOf(r)).toContain('Wed, Nov 18, 08:01 · Hamburg Hbf');
    expect(textOf(r)).toContain('13:58 · München Hbf');
    expect(textOf(r)).toContain('Rail Co ICE 577');
  });

  it('shows a hotel stay with address, check-in and check-out times, nights and the manage link', () => {
    const r = region(show([card('graph-hotel')]), 'Hotel booking');
    expect(textOf(title(r))).toBe('Hotel Am Markt');
    expect(textOf(r)).toContain('Marktplatz 1, 10178 Berlin');
    expect(textOf(r)).toContain('Check-in Fri, Dec 4, from 15:00');
    expect(textOf(r)).toContain('Check-out Sun, Dec 6, until 11:00');
    expect(textOf(r)).toContain('2 nights');
    expect(textOf(byLabel(r, /^Manage booking, /)[0])).toContain('hotel-booking.example.com');
  });

  it('shows a dates-only stay without times', () => {
    const r = region(show([card('hotel-dates-only')]), 'Hotel booking');
    expect(textOf(r)).toContain('Check-in Tue, Jun 1, 2027');
    expect(textOf(r)).toContain('Check-out Tue, Jun 8, 2027');
    expect(textOf(r)).not.toContain('from ');
    expect(textOf(r)).toContain('7 nights');
  });

  it('shows a rental car with pick-up, return and car', () => {
    const r = region(show([card('rental-car')]), 'Rental car booking');
    expect(textOf(title(r))).toBe('Car Rental Co');
    expect(textOf(r)).toContain('Pick-up Fri, Dec 4, 09:00 · Flughafen BER, Schönefeld');
    expect(textOf(r)).toContain('Return Mon, Dec 7, 18:00 · Flughafen BER, Schönefeld');
    expect(textOf(r)).toContain('VW Golf');
  });

  it('shows an event with its times, venue, tickets and ticket link', () => {
    const tree = show([card('eventbrite-trailing-commas'), card('ahoi-event')]);
    const eventbrite = region(tree, 'Event booking', 0);
    const workshop = region(tree, 'Event booking', 1);
    expect(textOf(title(eventbrite))).toBe('Jazz im Park');
    expect(textOf(eventbrite)).toContain('Sat, Nov 14, 19:00 – 22:30');
    expect(textOf(eventbrite)).toContain('Stadtpark, Parkweg 2, Hamburg');
    expect(textOf(byLabel(eventbrite, /^Ticket, /)[0])).toContain('tickets.example.com');
    expect(textOf(workshop)).toContain('Sun, Jul 18, 2021, 14:00');
    expect(textOf(workshop)).toContain('Tickets: AB12CD-1');
  });

  it('shows a restaurant table with time, address and party size', () => {
    const r = region(show([card('restaurant-cafe')]), 'Restaurant reservation');
    expect(textOf(title(r))).toBe('Café Kranzler');
    expect(textOf(r)).toContain('Sat, Nov 7, 19:30');
    expect(textOf(r)).toContain('Kurfürstendamm 18, 10719 Berlin');
    expect(textOf(r)).toContain('Table for 4');
  });

  it('shows an order with its parcel: number, status, items, total, tracking and links', async () => {
    const r = region(show([card('order-and-parcel')]), 'Order and delivery');
    expect(textOf(title(r))).toBe('Outdoor Shop');
    expect(textOf(r)).toContain('Order · DHL');
    expect(byTestId(r, 'structured-mail-pill').map(textOf)).toEqual(['Shipped']);
    expect(textOf(r)).toContain('Wanderschuhe, Socken');
    expect(textOf(oneByTestId(r, 'structured-mail-summary'))).toBe('3 items · Total €129.90');
    expect(textOf(r)).toContain('Arrives by Tue, Nov 3');
    expect(textOf(byLabel(r, /^Track, /)[0])).toBe('Track· dhl.de');
    expect(textOf(byLabel(r, /^View order, /)[0])).toContain('outdoor-shop.example.com');

    byLabel(r, 'Copy tracking number 00340434161234567890')[0].props.onPress();
    await vi.waitFor(() => expect(setStringAsync).toHaveBeenCalledWith('00340434161234567890'));
    byLabel(r, 'Copy order number SO-449120')[0].props.onPress();
    await vi.waitFor(() => expect(setStringAsync).toHaveBeenCalledWith('SO-449120'));
  });

  it('drops the expected date once the order is delivered', () => {
    const shipment = card<Shipment>('order-and-parcel');
    shipment.status = 'delivered';
    const r = region(show([shipment]), 'Order and delivery');
    expect(textOf(r)).toContain('Delivered');
    expect(textOf(r)).not.toContain('Arrives by');
    // Carrier and tracking number stay.
    expect(textOf(r)).toContain('00340434161234567890');
  });

  describe('right-to-left place names and values', () => {
    const hebrewTrain = (): TransportBooking => {
      const train = card<TransportBooking>('train-multiple-types');
      train.legs[0].departure.place = { name: 'תל אביב סבידור מרכז', address: { locality: 'תל אביב', country: 'IL' } };
      train.legs[0].arrival!.place = { name: 'חיפה מרכז השמונה', address: { locality: 'חיפה', country: 'IL' } };
      return train;
    };
    const FSI = String.fromCharCode(0x2068);
    const LRI = String.fromCharCode(0x2066);
    const PDI = String.fromCharCode(0x2069);

    it.each([false, true])('isolates each stop and points the arrow the reading direction (RTL %s)', (rtl) => {
      (I18nManager as { isRTL: boolean }).isRTL = rtl;
      const r = region(show([hebrewTrain()]), 'Train booking');
      // Spoken in reading order, whatever the script.
      expect(title(r).props.accessibilityLabel).toBe('תל אביב to חיפה');
      const arrow = rtl ? '←' : '→';
      expect(rawTextOf(title(r))).toBe(`${FSI}תל אביב${PDI} ${arrow} ${FSI}חיפה${PDI}`);
      // Station names in the leg rows are isolated too.
      const leg = oneByTestId(r, 'structured-mail-leg');
      expect(rawTextOf(leg)).toContain(`${FSI}תל אביב סבידור מרכז${PDI}`);
      expect(rawTextOf(leg)).toContain(`${FSI}חיפה מרכז השמונה${PDI}`);
    });

    it('keeps references, tracking and order numbers, seats and tickets left to right', () => {
      (I18nManager as { isRTL: boolean }).isRTL = true;
      const tree = show([card('flight-two-passengers-two-legs'), card('ahoi-event'), card('order-and-parcel')]);
      const all = rawTextOf(tree);
      for (const value of ['QX7K2M', 'AB12CD', 'SO-449120', '00340434161234567890']) {
        expect(all).toContain(`${LRI}${value}${PDI}`);
      }
      const seats = byTestId(tree, 'structured-mail-seats').map(rawTextOf).join(' ');
      for (const seat of ['12A', '12B', '31K', '31J']) expect(seats).toContain(`${LRI}${seat}${PDI}`);
      expect(rawTextOf(oneByTestId(tree, 'structured-mail-tickets'))).toContain(`${LRI}AB12CD-1${PDI}`);
    });
  });

  it('shows no action row when a card has nothing it would put there', () => {
    const restaurant = card<Booking>('restaurant-cafe');
    delete restaurant.reference;
    // A restaurant card shows no ticket link, so this alone gives no row.
    restaurant.links = { ticket: { url: 'https://tables.example.com/t/1', host: 'tables.example.com' } };
    const r = region(show([restaurant]), 'Restaurant reservation');
    expect(byTestId(r, 'structured-mail-actions')).toHaveLength(0);
    expect(byTestId(r, 'structured-mail-link')).toHaveLength(0);
  });

  it('shows one Track button per tracking page', () => {
    const shipment = card<Shipment>('order-and-parcel');
    const parcel = shipment.parcels[0];
    // The same parcel twice (same number and page), and a second one with its own page.
    shipment.parcels = [parcel, { ...parcel }, { ...parcel, trackingNumber: '00340434169999999999', trackingUrl: { url: 'https://www.dhl.de/x?piececode=00340434169999999999', host: 'dhl.de' } }];
    const r = region(show([shipment]), 'Order and delivery');
    const tracks = byLabel(r, /^Track, /);
    tracks.forEach((track) => track.props.onPress());
    expect(openExternalUrl.mock.calls.map(([url]) => url)).toEqual([parcel.trackingUrl!.url, 'https://www.dhl.de/x?piececode=00340434169999999999']);
  });

  it('lists three items and says how many more there are', () => {
    const shipment: Shipment = {
      kind: 'shipment', key: 's', merchant: 'Shop', orderNumber: 'A-1', source: 'json-ld', parcels: [],
      items: ['One', 'Two', 'Three', 'Four', 'Five'].map((name) => ({ name })),
      total: { amount: '1299.00', currency: 'USD' },
    };
    const r = region(show([shipment]), 'Order and delivery');
    expect(textOf(r)).toContain('One, Two, Three and 2 more');
    expect(textOf(r)).not.toContain('Four');
    expect(textOf(r)).toContain('Total $1,299.00');
  });

  it('loads item images only when remote content is allowed', () => {
    expect(byTestId(show([card('order-and-parcel')]), 'structured-mail-item-image')).toHaveLength(0);
    const images = byTestId(show([card('order-and-parcel')], { allowRemoteImages: true }), 'structured-mail-item-image');
    expect(images).toHaveLength(1);
    expect(images[0].props.source).toEqual({ uri: 'https://img.shop.example.com/p/1.jpg' });
  });

  it('gives each booking to the calendar slot, and none for a shipment', () => {
    const slot = vi.fn((booking: Booking) => createElement('Text', { testID: 'slot' }, `add ${booking.kind}`));
    const tree = show([card('flight-two-passengers-two-legs'), card('graph-hotel'), card('order-and-parcel')], { calendarActions: slot });
    expect(slot).toHaveBeenCalledTimes(2);
    expect(slot.mock.calls.map(([b]) => b.kind)).toEqual(['flight', 'lodging']);
    expect(slot.mock.calls[0][0]).toMatchObject({ reference: 'QX7K2M' });
    expect(byTestId(region(tree, 'Flight booking'), 'slot').map(textOf)).toEqual(['add flight']);
  });

  it('renders no calendar items in the action row when the slot is undefined', () => {
    const r = region(show([card('restaurant-cafe')]), 'Restaurant reservation');
    // Only the reference chip.
    expect(pressables(r)).toHaveLength(1);
  });
});
