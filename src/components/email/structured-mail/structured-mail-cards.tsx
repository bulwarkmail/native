// Port of webmail components/email/structured-mail/structured-mail-cards.tsx
// at 972e5f621. App: links need no message id (the app has no plugin link
// hook), so the cards don't take the email.
import React from 'react';
import { View } from 'react-native';
import type { Booking, StructuredCard } from '../../../lib/structured-mail/types';
import { EventCard, LodgingCard, RentalCarCard, RestaurantCard, TransportCard } from './booking-cards';
import { useCardStyles } from './card-parts';
import { ShipmentCard } from './shipment-card';

export interface StructuredMailCardsProps {
  /** Resolved cards from useStructuredMail; nothing renders for an empty list. */
  cards: StructuredCard[];
  /** Whether remote content may load for this message: product images show only then. */
  allowRemoteImages: boolean;
  /** Rendered in each booking card's action row ("Add to calendar"); nothing when undefined. */
  calendarActions?: (booking: Booking) => React.ReactNode;
}

/** The booking, parcel and order cards shown above an open message. */
export function StructuredMailCards({ cards, allowRemoteImages, calendarActions }: StructuredMailCardsProps) {
  const { styles } = useCardStyles();
  if (cards.length === 0) return null;
  return (
    <View style={styles.list} testID="structured-mail-cards">
      {cards.map((card, i) => {
        const key = `${card.key}-${i}`;
        switch (card.kind) {
          case 'flight':
          case 'train':
          case 'bus':
            return <TransportCard key={key} booking={card} calendarActions={calendarActions} />;
          case 'lodging':
            return <LodgingCard key={key} booking={card} calendarActions={calendarActions} />;
          case 'rentalcar':
            return <RentalCarCard key={key} booking={card} calendarActions={calendarActions} />;
          case 'event':
            return <EventCard key={key} booking={card} calendarActions={calendarActions} />;
          case 'restaurant':
            return <RestaurantCard key={key} booking={card} calendarActions={calendarActions} />;
          case 'shipment':
            return <ShipmentCard key={key} shipment={card} allowRemoteImages={allowRemoteImages} />;
          default:
            return null;
        }
      })}
    </View>
  );
}
