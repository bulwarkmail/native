// The one-line mount for MessageContent: cards for a verified sender's
// booking or order mail, nothing for anything else, and product images only
// when the body's remote content would load.
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => (await import('./render-native')).reactNativeMock());
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
// The calendar row has its own tests (use-booking-calendar.test.ts); here only
// whether each booking gets one.
vi.mock('../booking-calendar-actions', async () => {
  const { createElement: h } = await import('react');
  return { BookingCalendarActions: ({ booking }: { booking: { kind: string } }) => h('Text', { testID: 'calendar-actions' }, booking.kind) };
});

import type { Email } from '../../../../api/types';
import { useSettingsStore } from '../../../../stores/settings-store';
import { StructuredMailBanner } from '../StructuredMailBanner';
import { byTestId, render, textOf } from './render-native';

const ORDER = {
  '@context': 'http://schema.org', '@type': 'Order', orderNumber: 'SO-1', merchant: 'Shop',
  orderedItem: { '@type': 'Product', name: 'Boots', image: 'https://img.shop.example/boots.jpg' },
};
const PASS = 'mx.example.org; dkim=pass header.d=shop.example; spf=pass smtp.mailfrom=bounce@shop.example; dmarc=pass header.from=shop.example';
const RECEIVED = 'from mail.shop.example (mail.shop.example [192.0.2.1]) by mx.example.org (Stalwart SMTP) with ESMTPS id 1';

function mail(ar: string | null, subject = 'Your order'): Email {
  return {
    id: 'm1', threadId: 't', mailboxIds: {}, keywords: {}, size: 1, hasAttachment: false,
    receivedAt: '2026-10-30T09:00:00Z', subject, from: [{ email: 'orders@shop.example' }],
    headers: [{ name: 'Received', value: RECEIVED }, ...(ar ? [{ name: 'Authentication-Results', value: ar }] : [])],
    htmlBody: [{ partId: '1', type: 'text/html' }],
    bodyValues: { '1': { value: `<script type="application/ld+json">${JSON.stringify(ORDER)}</script><p>Thanks</p>` } },
  };
}

const initialSettings = useSettingsStore.getState();
afterEach(() => useSettingsStore.setState(initialSettings, true));

describe('StructuredMailBanner', () => {
  it('shows the order card of a verified mail', () => {
    const tree = render(createElement(StructuredMailBanner, { email: mail(PASS) }));
    const [card] = byTestId(tree, 'structured-mail-card-shipment');
    expect(textOf(card)).toContain('Order number');
    expect(textOf(card)).toContain('SO-1');
  });

  it('shows nothing for an unverified sender or a forward', () => {
    expect(render(createElement(StructuredMailBanner, { email: mail(null) })).children).toEqual([]);
    expect(render(createElement(StructuredMailBanner, { email: mail(PASS, 'Fwd: Your order') })).children).toEqual([]);
  });

  it('gives a booking card the calendar row, and an order none', () => {
    const train = {
      '@context': 'http://schema.org', '@type': 'TrainReservation', reservationNumber: 'ZUG1',
      reservationFor: {
        '@type': 'TrainTrip', trainNumber: 'ICE 1', departureStation: { name: 'Hamburg Hbf' }, departureTime: '2026-12-05T08:46:00+01:00',
        arrivalStation: { name: 'Berlin Hbf' }, arrivalTime: '2026-12-05T10:50:00+01:00',
      },
    };
    const email = mail(PASS);
    email.bodyValues = { '1': { value: `<script type="application/ld+json">${JSON.stringify(train)}</script>` } };
    expect(byTestId(render(createElement(StructuredMailBanner, { email })), 'calendar-actions').map(textOf)).toEqual(['train']);
    expect(byTestId(render(createElement(StructuredMailBanner, { email: mail(PASS) })), 'calendar-actions')).toHaveLength(0);
  });

  it('loads product images only when remote content would load', () => {
    useSettingsStore.setState({ externalContentPolicy: 'block', trustedSenders: [] });
    expect(byTestId(render(createElement(StructuredMailBanner, { email: mail(PASS) })), 'structured-mail-item-image')).toHaveLength(0);
    useSettingsStore.setState({ trustedSenders: ['orders@shop.example'] });
    expect(byTestId(render(createElement(StructuredMailBanner, { email: mail(PASS) })), 'structured-mail-item-image')).toHaveLength(1);
    useSettingsStore.setState({ externalContentPolicy: 'allow', trustedSenders: [] });
    expect(byTestId(render(createElement(StructuredMailBanner, { email: mail(PASS) })), 'structured-mail-item-image')).toHaveLength(1);
  });
});
