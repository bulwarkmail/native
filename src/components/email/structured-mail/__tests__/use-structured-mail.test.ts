// Port of webmail components/email/structured-mail/__tests__/
// use-structured-mail.test.tsx at ba6d5e448. App: messages carry raw
// headers only, and the gate is the app's (on until an org policy exists),
// switched here through a mock.
import { afterEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ on: true }));
vi.mock('../../../../lib/structured-mail/gate', () => ({
  isStructuredMailEnabled: () => gate.on,
  useStructuredMailEnabled: () => gate.on,
}));

import type { Email } from '../../../../api/types';
import { CARD_SOURCES } from '../sources';
import { useStructuredMail } from '../use-structured-mail';
import { renderHook, waitFor } from './render-native';

const ld = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const ORDER = { '@context': 'http://schema.org', '@type': 'Order', orderNumber: 'SO-1', merchant: 'Shop' };
const FLIGHT = {
  '@context': 'http://schema.org', '@type': 'FlightReservation', reservationNumber: 'QX7K2M', underName: 'Erika Mustermann',
  reservationFor: {
    '@type': 'Flight', flightNumber: '400', airline: { name: 'Lufthansa', iataCode: 'LH' },
    departureAirport: { iataCode: 'FRA' }, departureTime: '2026-12-01T10:15:00+01:00',
    arrivalAirport: { iataCode: 'JFK' }, arrivalTime: '2026-12-01T13:05:00-05:00',
  },
};
const PASS = 'mx.example.org; dkim=pass header.d=shop.example; spf=pass smtp.mailfrom=bounce@shop.example; dmarc=pass header.from=shop.example';
const RECEIVED = 'from mail.shop.example (mail.shop.example [192.0.2.1]) by mx.example.org (Stalwart SMTP) with ESMTPS id 1';

function mail(id: string, body: string, ar: string | null = PASS): Email {
  return {
    id, threadId: 't', mailboxIds: {}, keywords: {}, size: 1, hasAttachment: false,
    receivedAt: '2026-10-30T09:00:00Z', subject: 'Booking',
    from: [{ email: 'orders@shop.example' }],
    headers: [{ name: 'Received', value: RECEIVED }, ...(ar ? [{ name: 'Authentication-Results', value: ar }] : [])],
    htmlBody: [{ partId: '1', type: 'text/html' }],
    bodyValues: { '1': { value: `<html><head>${body}</head><body></body></html>`, isTruncated: false } },
  };
}

afterEach(() => {
  gate.on = true;
  CARD_SOURCES.length = 0;
});

describe('useStructuredMail', () => {
  it('returns the cards of a trusted message', () => {
    const hook = renderHook(() => useStructuredMail(mail('a', ld(ORDER))));
    expect(hook.current).toMatchObject([{ kind: 'shipment', orderNumber: 'SO-1' }]);
  });

  it('returns nothing for an untrusted message or with the gate off', () => {
    expect(renderHook(() => useStructuredMail(mail('b', ld(ORDER), null))).current).toEqual([]);
    gate.on = false;
    expect(renderHook(() => useStructuredMail(mail('c', ld(ORDER)))).current).toEqual([]);
  });

  it('shows a flight only once the airport zones are resolved', async () => {
    const hook = renderHook(() => useStructuredMail(mail('d', ld(FLIGHT))));
    expect(hook.current).toEqual([]);
    await waitFor(() => expect(hook.current).toHaveLength(1));
    expect(hook.current[0]).toMatchObject({ kind: 'flight', legs: [{ departure: { at: { zone: 'Europe/Berlin' } } }] });
  });

  it('merges cards from attachment sources, and never asks them about untrusted mail', async () => {
    let asked = 0;
    const accounts: (string | undefined)[] = [];
    CARD_SOURCES.push(async ({ accountId }) => {
      asked++;
      accounts.push(accountId);
      return [{ kind: 'shipment', key: 'shipment|order:so-2', orderNumber: 'SO-2', merchant: 'Shop', items: [], parcels: [], source: 'pkpass' }];
    });
    const hook = renderHook(() => useStructuredMail(mail('e', ld(ORDER)), 'shared-acc'));
    await waitFor(() => expect(hook.current).toHaveLength(2));
    renderHook(() => useStructuredMail(mail('f', ld(ORDER), null)));
    expect(asked).toBe(1);
    // The blobs are fetched from the account the message lives in.
    expect(accounts).toEqual(['shared-acc']);
  });
});
