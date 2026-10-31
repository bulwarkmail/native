// Port of webmail components/email/structured-mail/booking-cards.tsx at
// b0782af2d (same cards and rows, React Native views). App difference: the
// route title is one line of text with isolated stops and an arrow that
// points the reading direction, where the webmail draws arrow icons.
import React from 'react';
import { I18nManager, Text, View } from 'react-native';
import { ArrowRight, Clock, MapPin, Phone, Users } from '../../icons';
import {
  formatAddress,
  formatMomentDate,
  formatMomentTime,
  formatPlace,
  isOtherZone,
  isWebLink,
  legPlaceLabel,
  legService,
  nightsBetween,
  routeRuns,
  routeTitle,
  sameLocalDate,
} from '../../../lib/structured-mail/format';
import type {
  Booking,
  EventBooking,
  Link,
  LodgingBooking,
  Moment,
  RentalCarBooking,
  RestaurantBooking,
  TransportBooking,
  TransportLeg,
} from '../../../lib/structured-mail/types';
import { useLocaleStore } from '../../../stores/locale-store';
import {
  BookingStatusPill,
  CardLink,
  CardShell,
  LocalTimeHint,
  MetaRow,
  Pill,
  When,
  eyebrowText,
  isolate,
  ltr,
  useCardFormat,
  useCardStyles,
} from './card-parts';
import { CopyValueChip } from './copy-value-chip';
import { Bed, Bus, Car, Plane, Restaurant, Ticket, Train } from './icons';

export interface BookingCardProps<B extends Booking = Booking> {
  booking: B;
  /** Slot in the action row, for "Add to calendar". */
  calendarActions?: (booking: Booking) => React.ReactNode;
}

const TRANSPORT_ICON = { flight: Plane, train: Train, bus: Bus } as const;

interface CardLinkSpec {
  link?: Link;
  label: string;
}

/**
 * The action row: reference chip, the links this card shows and the
 * calendar slot. Undefined when there is none of them, so no empty row.
 */
function bookingActions(booking: Booking, calendarActions: BookingCardProps['calendarActions'], links: CardLinkSpec[]): React.ReactNode {
  const shown = links.filter((l) => isWebLink(l.link));
  if (!booking.reference && !calendarActions && shown.length === 0) return undefined;
  return (
    <BookingActions booking={booking} calendarActions={calendarActions}>
      {shown.map((l) => <CardLink key={l.label} link={l.link} label={l.label} />)}
    </BookingActions>
  );
}

function BookingActions({ booking, calendarActions, children }: Pick<BookingCardProps, 'booking' | 'calendarActions'> & { children: React.ReactNode }) {
  const t = useLocaleStore((s) => s.t);
  return (
    <>
      {booking.reference ? (
        <CopyValueChip
          value={booking.reference}
          label={t('email_viewer.structured_mail.reference', 'Booking reference')}
          copyLabel={t('email_viewer.structured_mail.copy_reference', 'Copy booking reference {value}', { value: booking.reference })}
          copiedMessage={t('email_viewer.structured_mail.copied_reference', 'Booking reference copied')}
          inActions
        />
      ) : null}
      {children}
      {calendarActions?.(booking)}
    </>
  );
}

function PassengersRow({ names }: { names: string[] }) {
  const t = useLocaleStore((s) => s.t);
  if (names.length === 0) return null;
  return (
    <View accessibilityLabel={`${t('email_viewer.structured_mail.passengers', 'Passengers')}: ${names.join(', ')}`}>
      <MetaRow icon={Users}>{names.map(isolate).join(', ')}</MetaRow>
    </View>
  );
}

function Leg({ leg, kind, bookingCancelled }: { leg: TransportLeg; kind: TransportBooking['kind']; bookingCancelled: boolean }) {
  const t = useLocaleStore((s) => s.t);
  const { c, styles } = useCardStyles();
  const cancelled = leg.status === 'cancelled';
  const service = legService(leg);
  const Icon = TRANSPORT_ICON[kind];
  const arrival = leg.arrival;

  return (
    <View style={styles.leg} testID={cancelled ? 'structured-mail-leg-cancelled' : 'structured-mail-leg'}>
      {(service || (cancelled && !bookingCancelled)) ? (
        <View style={styles.legHead}>
          {service ? (
            <View style={styles.legService}>
              <Icon size={14} color={cancelled ? c.textMuted : c.text} />
              <Text style={[styles.legServiceText, cancelled && styles.titleCancelled]}>{service}</Text>
            </View>
          ) : null}
          {cancelled && !bookingCancelled ? (
            <Pill label={t('email_viewer.structured_mail.status_cancelled', 'Cancelled')} tone="error" />
          ) : null}
        </View>
      ) : null}
      <MetaRow icon={Clock}>
        <When at={leg.departure.at} struck={cancelled} />
        <Text style={cancelled ? styles.struck : undefined}> · {isolate(legPlaceLabel(leg.departure.place, kind))}</Text>
      </MetaRow>
      {arrival ? (
        <MetaRow icon={ArrowRight}>
          {arrival.at ? <When at={arrival.at} timeOnly={sameLocalDate(arrival.at, leg.departure.at)} struck={cancelled} /> : null}
          <Text style={cancelled ? styles.struck : undefined}>{arrival.at ? ' · ' : ''}{isolate(legPlaceLabel(arrival.place, kind))}</Text>
        </MetaRow>
      ) : null}
      {leg.seats.length > 0 ? (
        <MetaRow icon={Ticket} testID="structured-mail-seats">
          {t('email_viewer.structured_mail.seats', 'Seats')}:{' '}
          {leg.seats.map((seat) => `${seat.passenger ? `${isolate(seat.passenger)} ` : ''}${ltr(seat.seat)}`).join(', ')}
        </MetaRow>
      ) : null}
    </View>
  );
}

/** "FRA → JFK → FRA", every stop isolated, the arrow pointing the reading direction. */
export function routeText(runs: string[][], rtl: boolean): string {
  const arrow = rtl ? ' ← ' : ' → ';
  return runs.map((run) => run.map(isolate).join(arrow)).join(', ');
}

export function TransportCard({ booking, calendarActions }: BookingCardProps<TransportBooking>) {
  const t = useLocaleStore((s) => s.t);
  const { styles } = useCardStyles();
  const kindLabel = booking.kind === 'flight'
    ? t('email_viewer.structured_mail.kind_flight', 'Flight')
    : booking.kind === 'train'
      ? t('email_viewer.structured_mail.kind_train', 'Train')
      : t('email_viewer.structured_mail.kind_bus', 'Bus');
  const name = booking.kind === 'flight'
    ? t('email_viewer.structured_mail.region_flight', 'Flight booking')
    : booking.kind === 'train'
      ? t('email_viewer.structured_mail.region_train', 'Train booking')
      : t('email_viewer.structured_mail.region_bus', 'Bus booking');
  const runs = routeRuns(booking);
  const title = routeText(runs, I18nManager.isRTL);
  const cancelled = booking.status === 'cancelled';
  return (
    <CardShell
      kind={booking.kind}
      name={name}
      icon={TRANSPORT_ICON[booking.kind]}
      cancelled={cancelled}
      eyebrow={eyebrowText(kindLabel, booking.provider, routeTitle(booking))}
      title={title}
      titleLabel={runs.map((run) => run.reduce((from, to) => t('email_viewer.structured_mail.route', '{from} to {to}', { from, to }))).join(', ')}
      pills={booking.status && booking.status !== 'confirmed' ? <BookingStatusPill status={booking.status} /> : undefined}
      actions={bookingActions(booking, calendarActions, [
        { link: booking.links.checkin, label: t('email_viewer.structured_mail.link_check_in', 'Check in') },
        { link: booking.links.manage, label: t('email_viewer.structured_mail.link_manage', 'Manage booking') },
        { link: booking.links.ticket, label: t('email_viewer.structured_mail.link_ticket', 'Ticket') },
      ])}
    >
      <View style={styles.legs}>
        {booking.legs.map((leg, i) => (
          <Leg key={`${leg.departure.at.date}-${leg.number ?? ''}-${i}`} leg={leg} kind={booking.kind} bookingCancelled={cancelled} />
        ))}
      </View>
      <PassengersRow names={booking.passengers} />
    </CardShell>
  );
}

/** "Fri, Dec 4, from 15:00" / "Sun, Dec 6, until 11:00" / the date alone. */
function StayEnd({ label, at, edge }: { label: string; at: Moment; edge: 'from' | 'until' }) {
  const t = useLocaleStore((s) => s.t);
  const { styles } = useCardStyles();
  const { opts, readerZone } = useCardFormat();
  const time = formatMomentTime(at, opts);
  return (
    <MetaRow icon={Clock}>
      {label}{' '}
      <Text style={styles.strong}>{formatMomentDate(at, opts)}</Text>
      {time ? (
        <>
          {', '}
          <Text style={styles.strong}>
            {edge === 'from'
              ? t('email_viewer.structured_mail.from_time', 'from {time}', { time })
              : t('email_viewer.structured_mail.until_time', 'until {time}', { time })}
          </Text>
          {isOtherZone(at, readerZone) ? <LocalTimeHint /> : null}
        </>
      ) : null}
    </MetaRow>
  );
}

export function LodgingCard({ booking, calendarActions }: BookingCardProps<LodgingBooking>) {
  const t = useLocaleStore((s) => s.t);
  const { opts } = useCardFormat();
  const nights = nightsBetween(booking.checkin, booking.checkout);
  const address = formatAddress(booking.address, opts.locale);
  return (
    <CardShell
      kind="lodging"
      name={t('email_viewer.structured_mail.region_lodging', 'Hotel booking')}
      icon={Bed}
      cancelled={booking.status === 'cancelled'}
      eyebrow={eyebrowText(t('email_viewer.structured_mail.kind_lodging', 'Hotel'), booking.provider, booking.name)}
      title={booking.name}
      pills={booking.status && booking.status !== 'confirmed' ? <BookingStatusPill status={booking.status} /> : undefined}
      actions={bookingActions(booking, calendarActions, [
        { link: booking.links.manage, label: t('email_viewer.structured_mail.link_manage', 'Manage booking') },
        { link: booking.links.checkin, label: t('email_viewer.structured_mail.link_check_in', 'Check in') },
      ])}
    >
      {address ? <MetaRow icon={MapPin}>{address}</MetaRow> : null}
      <StayEnd label={t('email_viewer.structured_mail.check_in_label', 'Check-in')} at={booking.checkin} edge="from" />
      <StayEnd label={t('email_viewer.structured_mail.check_out_label', 'Check-out')} at={booking.checkout} edge="until" />
      {nights !== undefined ? (
        <MetaRow icon={Bed}>{t('email_viewer.structured_mail.nights', '{count, plural, one {# night} other {# nights}}', { count: nights })}</MetaRow>
      ) : null}
      {booking.phone ? <MetaRow icon={Phone}>{ltr(booking.phone)}</MetaRow> : null}
      <PassengersRow names={booking.passengers} />
    </CardShell>
  );
}

export function RentalCarCard({ booking, calendarActions }: BookingCardProps<RentalCarBooking>) {
  const t = useLocaleStore((s) => s.t);
  const title = booking.company?.trim() || t('email_viewer.structured_mail.kind_rentalcar', 'Rental car');
  const pickupPlace = formatPlace(booking.pickup.place);
  const dropoffPlace = formatPlace(booking.dropoff.place);
  return (
    <CardShell
      kind="rentalcar"
      name={t('email_viewer.structured_mail.region_rentalcar', 'Rental car booking')}
      icon={Car}
      cancelled={booking.status === 'cancelled'}
      eyebrow={eyebrowText(t('email_viewer.structured_mail.kind_rentalcar', 'Rental car'), booking.provider, title)}
      title={title}
      pills={booking.status && booking.status !== 'confirmed' ? <BookingStatusPill status={booking.status} /> : undefined}
      actions={bookingActions(booking, calendarActions, [
        { link: booking.links.manage, label: t('email_viewer.structured_mail.link_manage', 'Manage booking') },
      ])}
    >
      <MetaRow icon={Clock}>
        {t('email_viewer.structured_mail.pickup', 'Pick-up')}{' '}
        <When at={booking.pickup.at} />
        {pickupPlace ? ` · ${pickupPlace}` : null}
      </MetaRow>
      <MetaRow icon={ArrowRight}>
        {t('email_viewer.structured_mail.dropoff', 'Return')}{' '}
        <When at={booking.dropoff.at} />
        {dropoffPlace ? ` · ${dropoffPlace}` : null}
      </MetaRow>
      {booking.car ? <MetaRow icon={Car}>{booking.car}</MetaRow> : null}
      <PassengersRow names={booking.passengers} />
    </CardShell>
  );
}

export function EventCard({ booking, calendarActions }: BookingCardProps<EventBooking>) {
  const t = useLocaleStore((s) => s.t);
  const { styles } = useCardStyles();
  const { opts } = useCardFormat();
  const venueName = booking.venue?.name?.trim();
  const venueAddress = formatAddress(booking.venue?.address, opts.locale);
  // "Stadtpark, Parkweg 2, Hamburg"; the name alone, or the address alone, when that's all there is.
  const venue = venueName && venueAddress
    ? (venueAddress.includes(venueName) ? venueAddress : `${venueName}, ${venueAddress}`)
    : venueName || venueAddress || formatPlace(booking.venue);
  const end = booking.end;
  return (
    <CardShell
      kind="event"
      name={t('email_viewer.structured_mail.region_event', 'Event booking')}
      icon={Ticket}
      cancelled={booking.status === 'cancelled'}
      eyebrow={eyebrowText(t('email_viewer.structured_mail.kind_event', 'Event'), booking.provider, booking.name)}
      title={booking.name}
      pills={booking.status && booking.status !== 'confirmed' ? <BookingStatusPill status={booking.status} /> : undefined}
      actions={bookingActions(booking, calendarActions, [
        { link: booking.links.ticket, label: t('email_viewer.structured_mail.link_ticket', 'Ticket') },
        { link: booking.links.manage, label: t('email_viewer.structured_mail.link_manage', 'Manage booking') },
      ])}
    >
      <MetaRow icon={Clock}>
        <When at={booking.start} />
        {end && (end.time || !sameLocalDate(end, booking.start)) ? (
          <>
            {' – '}
            <When at={end} timeOnly={sameLocalDate(end, booking.start) && !!booking.start.time} />
          </>
        ) : null}
      </MetaRow>
      {venue ? <MetaRow icon={MapPin}>{venue}</MetaRow> : null}
      {booking.tickets.length > 0 ? (
        <MetaRow icon={Ticket} testID="structured-mail-tickets">
          {t('email_viewer.structured_mail.tickets', 'Tickets')}:{' '}
          <Text style={styles.mono}>{ltr(booking.tickets.join(', '))}</Text>
        </MetaRow>
      ) : null}
      <PassengersRow names={booking.passengers} />
    </CardShell>
  );
}

export function RestaurantCard({ booking, calendarActions }: BookingCardProps<RestaurantBooking>) {
  const t = useLocaleStore((s) => s.t);
  const { opts } = useCardFormat();
  const address = formatAddress(booking.address, opts.locale);
  return (
    <CardShell
      kind="restaurant"
      name={t('email_viewer.structured_mail.region_restaurant', 'Restaurant reservation')}
      icon={Restaurant}
      cancelled={booking.status === 'cancelled'}
      eyebrow={eyebrowText(t('email_viewer.structured_mail.kind_restaurant', 'Restaurant'), booking.provider, booking.name)}
      title={booking.name}
      pills={booking.status && booking.status !== 'confirmed' ? <BookingStatusPill status={booking.status} /> : undefined}
      actions={bookingActions(booking, calendarActions, [
        { link: booking.links.manage, label: t('email_viewer.structured_mail.link_manage', 'Manage booking') },
      ])}
    >
      <MetaRow icon={Clock}><When at={booking.start} /></MetaRow>
      {address ? <MetaRow icon={MapPin}>{address}</MetaRow> : null}
      {booking.partySize !== undefined && booking.partySize > 0 ? (
        <MetaRow icon={Users}>
          {t('email_viewer.structured_mail.party_size', '{count, plural, one {Table for #} other {Table for #}}', { count: booking.partySize })}
        </MetaRow>
      ) : null}
    </CardShell>
  );
}
