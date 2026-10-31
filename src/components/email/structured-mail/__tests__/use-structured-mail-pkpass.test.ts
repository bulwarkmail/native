// Port of webmail components/email/structured-mail/__tests__/
// use-structured-mail-pkpass.test.tsx at 66c73d0f4. App: messages carry
// raw headers only, the gate is mocked, and the download goes through the
// JMAP client (mocked) from the account the reader passes.
import { afterEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ on: true }));
vi.mock('../../../../lib/structured-mail/gate', () => ({
  isStructuredMailEnabled: () => gate.on,
  useStructuredMailEnabled: () => gate.on,
}));
const blobs = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array<ArrayBufferLike>, urls: [] as string[] }));
vi.mock('../../../../api/jmap-client', () => ({
  BLOB_TIMEOUT_MS: 300_000,
  jmapClient: {
    getBlobDownloadUrl: (blobId: string, name?: string, type?: string, accountId?: string) => `${accountId}|${blobId}|${name}|${type}`,
    authenticatedFetch: async (url: string) => {
      blobs.urls.push(url);
      const b = blobs.bytes;
      return new Response(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, { status: 200 });
    },
  },
}));

import type { Email } from '../../../../api/types';
import type { TransportBooking } from '../../../../lib/structured-mail';
import { AIR_SEMANTICS, MAIL_DATE, TRAIN_SEMANTICS, boardingPass, zipPass } from '../../../../lib/structured-mail/__tests__/pkpass-fixtures';
import { useStructuredMail } from '../use-structured-mail';
import { renderHook, waitFor } from './render-native';

const PASS = 'mx.example.org; dkim=pass header.d=swiss.example; spf=pass smtp.mailfrom=bounce@swiss.example; dmarc=pass header.from=swiss.example';
const RECEIVED = 'from mail.swiss.example (mail.swiss.example [192.0.2.1]) by mx.example.org (Stalwart SMTP) with ESMTPS id 1';
const PLAIN = '<html><body><p>Your boarding pass is attached.</p></body></html>';
const ld = (...blocks: unknown[]) => `<html><head>${blocks.map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join('')}</head><body><p>Your boarding pass is attached.</p></body></html>`;

/** The flight of AIR_SEMANTICS as the booking mail's markup. */
function flightMarkup(fields: { departureTime?: string; status?: string } = {}) {
  const { departureTime = '2026-12-03T07:40:00+01:00', status = 'http://schema.org/ReservationConfirmed' } = fields;
  return {
    '@context': 'http://schema.org', '@type': 'FlightReservation', reservationNumber: 'PK7Q2Z',
    reservationStatus: status, underName: { '@type': 'Person', name: 'Jana Beispiel' },
    reservationFor: {
      '@type': 'Flight', flightNumber: 'LX1072', airline: { '@type': 'Airline', name: 'Swiss', iataCode: 'LX' },
      departureAirport: { '@type': 'Airport', name: 'Zurich Airport', iataCode: 'ZRH' }, departureTime,
      arrivalAirport: { '@type': 'Airport', name: 'Berlin Brandenburg', iataCode: 'BER' }, arrivalTime: '2026-12-03T09:05:00+01:00',
    },
  };
}

/** The train of TRAIN_SEMANTICS, as the markup writes it ("ICE597", full station names). */
const TRAIN_MARKUP = {
  '@context': 'http://schema.org', '@type': 'TrainReservation', reservationNumber: 'ZUG4471', underName: { '@type': 'Person', name: 'Jana Beispiel' },
  reservationFor: {
    '@type': 'TrainTrip', trainNumber: 'ICE597', provider: { '@type': 'Organization', name: 'DB Fernverkehr' },
    departureStation: { '@type': 'TrainStation', name: 'Hamburg Hauptbahnhof' }, departureTime: '2026-12-05T08:46:00+01:00',
    arrivalStation: { '@type': 'TrainStation', name: 'Köln Hauptbahnhof' }, arrivalTime: '2026-12-05T12:50:00+01:00',
  },
};

function mail(id: string, options: { ar?: string | null; html?: string | null; htmlLoaded?: boolean } = {}): Email {
  const { ar = PASS, html = PLAIN, htmlLoaded = true } = options;
  return {
    id, threadId: 't', mailboxIds: {}, keywords: {}, size: 1, hasAttachment: true,
    receivedAt: MAIL_DATE.toISOString(), subject: 'Your boarding pass',
    from: [{ email: 'boarding@swiss.example' }],
    headers: [{ name: 'Received', value: RECEIVED }, ...(ar ? [{ name: 'Authentication-Results', value: ar }] : [])],
    htmlBody: [{ partId: '1', type: html === null ? 'text/plain' : 'text/html' }],
    bodyValues: htmlLoaded ? { '1': { value: html ?? 'Your boarding pass is attached.', isTruncated: false } } : {},
    attachments: [{ blobId: 'blob-pass', size: 3000, name: 'BoardingPass.pkpass', type: 'application/vnd.apple.pkpass' }],
  };
}

async function passBlob(semantics: Record<string, unknown> = AIR_SEMANTICS, transitType = 'PKTransitTypeAir') {
  blobs.bytes = await zipPass(boardingPass(semantics, transitType));
}

/** Let effects and the airport-table import settle when nothing is expected to show. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

afterEach(() => {
  gate.on = true;
  blobs.urls = [];
});

describe('useStructuredMail with a Wallet pass attached', () => {
  it('shows the resolved flight card of a trusted mail without booking markup, and downloads nothing for an untrusted one', async () => {
    await passBlob();
    const untrusted = renderHook(() => useStructuredMail(mail('u', { ar: null }), 'acc-1'));
    const hook = renderHook(() => useStructuredMail(mail('t'), 'acc-1'));
    await waitFor(() => expect(hook.current).toHaveLength(1));
    const [card] = hook.current as TransportBooking[];
    expect(card).toMatchObject({ kind: 'flight', reference: 'PK7Q2Z', source: 'pkpass' });
    expect(card.legs[0].departure.at).toMatchObject({ time: '07:40:00', zone: 'Europe/Zurich' });
    expect(card.legs[0].arrival?.at).toMatchObject({ time: '09:05:00', zone: 'Europe/Berlin' });
    expect(blobs.urls).toEqual(['acc-1|blob-pass|BoardingPass.pkpass|application/vnd.apple.pkpass']);
    expect(untrusted.current).toEqual([]);
  });

  it('reads the pass of a plain-text mail too', async () => {
    await passBlob();
    const hook = renderHook(() => useStructuredMail(mail('p', { html: null })));
    await waitFor(() => expect(hook.current).toMatchObject([{ kind: 'flight', source: 'pkpass' }]));
  });

  it('downloads nothing and shows nothing with the gate off', async () => {
    gate.on = false;
    await passBlob();
    const hook = renderHook(() => useStructuredMail(mail('g')));
    await settle();
    expect(hook.current).toEqual([]);
    expect(blobs.urls).toEqual([]);
  });

  it('waits for the HTML before asking for passes, as it may hold booking markup', async () => {
    await passBlob();
    const hook = renderHook(() => useStructuredMail(mail('w', { htmlLoaded: false })));
    await settle();
    expect(hook.current).toEqual([]);
    expect(blobs.urls).toEqual([]);
  });

  describe('when the HTML has booking markup, the markup alone counts and nothing is downloaded', () => {
    it('keeps a cancelled markup booking cancelled', async () => {
      await passBlob();
      const hook = renderHook(() => useStructuredMail(mail('c', { html: ld(flightMarkup({ status: 'http://schema.org/ReservationCancelled' })) })));
      await waitFor(() => expect(hook.current).toHaveLength(1));
      await settle();
      expect(hook.current).toMatchObject([{ kind: 'flight', status: 'cancelled', source: 'json-ld' }]);
      expect(blobs.urls).toEqual([]);
    });

    it('shows nothing when the markup booking was rejected', async () => {
      await passBlob();
      const html = ld(flightMarkup(), flightMarkup({ departureTime: '2026-12-03T08:10:00+01:00' }));
      const hook = renderHook(() => useStructuredMail(mail('r', { html })));
      await settle();
      expect(hook.current).toEqual([]);
      expect(blobs.urls).toEqual([]);
    });

    it('shows one train card with the markup leg when the pass writes number and station differently', async () => {
      await passBlob(TRAIN_SEMANTICS, 'PKTransitTypeTrain');
      const hook = renderHook(() => useStructuredMail(mail('i', { html: ld(TRAIN_MARKUP) })));
      await waitFor(() => expect(hook.current).toHaveLength(1));
      await settle();
      const cards = hook.current as TransportBooking[];
      expect(cards).toHaveLength(1);
      expect(cards[0].legs).toHaveLength(1);
      expect(cards[0].legs[0]).toMatchObject({ number: 'ICE597', departure: { place: { name: 'Hamburg Hauptbahnhof' } } });
      expect(blobs.urls).toEqual([]);
    });

    it('shows one flight card when the pass has no confirmation number', async () => {
      const { confirmationNumber: _ref, ...noRef } = AIR_SEMANTICS;
      await passBlob(noRef);
      const hook = renderHook(() => useStructuredMail(mail('f', { html: ld(flightMarkup()) })));
      await waitFor(() => expect(hook.current).toHaveLength(1));
      await settle();
      expect(hook.current).toMatchObject([{ kind: 'flight', source: 'json-ld', reference: 'PK7Q2Z' }]);
      expect(blobs.urls).toEqual([]);
    });
  });
});
