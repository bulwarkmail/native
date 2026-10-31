// The trust gate on the app's Email shape: only the raw `headers` list from
// Email/get, no pre-parsed Authentication-Results (the webmail's full fetch
// adds those; the ported trust tests pass them in).
import { describe, expect, it } from 'vitest';
import type { Email } from '../../../api/types';
import { getStructuredMailTrust } from '../trust';
import { isStructuredMailEnabled } from '../gate';

const HTML = '<script type="application/ld+json">{"@context":"http://schema.org","@type":"Order","orderNumber":"SO-1"}</script>';
const RECEIVED = { name: 'Received', value: 'from mail.shop.example (mail.shop.example [192.0.2.1]) by mx.example.org (Stalwart SMTP) with ESMTPS id 1' };
const PASS = 'mx.example.org; dkim=pass header.d=shop.example header.s=s1; spf=pass smtp.mailfrom=bounce@shop.example; dmarc=pass header.from=shop.example';

function mail(headers: { name: string; value: string }[], from = 'orders@shop.example'): Email {
  return {
    id: 'm1', threadId: 't1', mailboxIds: {}, keywords: {}, size: 1, hasAttachment: false,
    receivedAt: '2026-10-30T09:00:00Z', subject: 'Your order SO-1', from: [{ email: from }], headers,
    htmlBody: [{ partId: '2', type: 'text/html' }], textBody: [],
    bodyValues: { '2': { value: HTML } },
  };
}

const reason = (email: Email) => {
  const trust = getStructuredMailTrust(email);
  return trust.trusted ? 'trusted' : trust.reason;
};

describe('getStructuredMailTrust from raw headers', () => {
  it('trusts a delivered mail whose topmost Authentication-Results pass for the From domain', () => {
    expect(reason(mail([RECEIVED, { name: 'Authentication-Results', value: PASS }]))).toBe('trusted');
    // Header names come in any case.
    expect(reason(mail([{ name: 'received', value: RECEIVED.value }, { name: 'authentication-results', value: PASS }]))).toBe('trusted');
  });

  it('refuses without results, with failing ones, or when only a lower header passes', () => {
    expect(reason(mail([RECEIVED]))).toBe('no_authentication_results');
    expect(reason(mail([RECEIVED, { name: 'Authentication-Results', value: 'mx.example.org; spf=fail smtp.mailfrom=shop.example; dmarc=fail header.from=shop.example' }])))
      .toBe('sender_not_verified');
    // The receiving server's header is the topmost; one below it may be the sender's own.
    expect(reason(mail([
      RECEIVED,
      { name: 'Authentication-Results', value: 'mx.example.org; spf=none smtp.mailfrom=shop.example; dmarc=none' },
      { name: 'Authentication-Results', value: PASS },
    ]))).toBe('sender_not_verified');
  });

  it('refuses results the sender wrote above every Received line', () => {
    expect(reason(mail([{ name: 'Authentication-Results', value: PASS }, RECEIVED]))).toBe('not_written_on_receipt');
  });

  it('is on while the app has no admin policy', () => {
    expect(isStructuredMailEnabled()).toBe(true);
  });
});
