import { describe, it, expect } from 'vitest';
import {
  parseAuthenticationResults, parseSpamScore, parseSpamLLM, extractListHeaders,
  isAuthenticationSpoofed, headersToRecord, deriveHeaderInfo, deliveryDeltaMs, formatDelta,
  findReceivingIdentity, getSenderVerification, hasAlignedAuthenticationPass,
  describeSenderVerification, senderVerificationOf,
} from '../email-headers';

describe('parseAuthenticationResults', () => {
  it('parses spf/dkim/dmarc/iprev', () => {
    const r = parseAuthenticationResults(
      'mx.example; spf=pass smtp.mailfrom=news.example; dkim=pass header.d=news.example header.s=s1; dmarc=pass header.from=news.example policy.dmarc=none; iprev=pass policy.iprev=1.2.3.4',
    );
    expect(r.spf).toEqual({ result: 'pass', identity: 'mailfrom', domain: 'news.example' });
    expect(r.dkim).toEqual({ result: 'pass', domain: 'news.example', selector: 's1' });
    expect(r.dmarc).toEqual({ result: 'pass', domain: 'news.example', policy: 'none' });
    expect(r.iprev).toEqual({ result: 'pass', ip: '1.2.3.4' });
  });

  it('escalates a HELO hard fail over a MAIL FROM pass, but not a HELO none (#650)', () => {
    const fail = parseAuthenticationResults('spf=pass smtp.mailfrom=a.example; spf=fail smtp.helo=b.example');
    expect(fail.spf?.result).toBe('fail');
    expect(fail.spf?.all).toHaveLength(2);
    const none = parseAuthenticationResults('spf=pass smtp.mailfrom=a.example; spf=none smtp.helo=b.example');
    expect(none.spf?.result).toBe('pass');
  });

  // The envelope address and comments are sender-chosen text: a result
  // counts only where its method opens a `;`-separated part.
  it('ignores dkim= and dmarc= written into an envelope address or a comment', () => {
    const r = parseAuthenticationResults(
      'mx.example; spf=pass smtp.mailfrom="dkim=pass;dmarc=pass"@evil.example; '
      + 'dkim=none (no signature; dkim=pass header.d=bank.example); dmarc=none header.from=bank.example',
    );
    expect(r.dkim?.result).toBe('none');
    expect(r.dmarc?.result).toBe('none');
    const local = parseAuthenticationResults('mx; spf=pass smtp.mailfrom=dmarc=pass@evil.example');
    expect(local.dmarc).toBeUndefined();
  });

  it("takes DKIM and DMARC from the receiving server's own (topmost) header only", () => {
    const r = parseAuthenticationResults([
      'mx.example; spf=pass smtp.mailfrom=evil.example; dkim=none; dmarc=none header.from=bank.example',
      'forged.example; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example',
    ]);
    expect(r.dkim?.result).toBe('none');
    expect(r.dmarc?.result).toBe('none');
  });

  it('lets a lower header escalate SPF to a failure but never pass it', () => {
    const r = parseAuthenticationResults([
      'mx.example; spf=none smtp.mailfrom=a.example',
      'other; spf=pass smtp.mailfrom=a.example; spf=fail smtp.mailfrom=b.example',
    ]);
    expect(r.spf?.result).toBe('fail');
    expect(r.spf?.all?.map((e) => e.result)).toEqual(['none', 'fail']);
  });

  it('keeps every DKIM signature so a later pass still counts', () => {
    const r = parseAuthenticationResults('mx; dkim=fail header.d=esp.example; dkim=pass header.d=shop.example');
    expect(r.dkim?.result).toBe('fail');
    expect(r.dkim?.all?.map((e) => e.domain)).toEqual(['esp.example', 'shop.example']);
  });
});

describe('getSenderVerification', () => {
  it("flags mail whose SPF passes only for the sender's own envelope domain", () => {
    const auth = parseAuthenticationResults('mx; spf=pass smtp.mailfrom=evil.example; dkim=none; dmarc=none');
    expect(hasAlignedAuthenticationPass(auth, 'ceo@bank.example')).toBe(false);
    expect(getSenderVerification(auth, 'ceo@bank.example'))
      .toEqual({ status: 'unverified', domain: 'bank.example', sentFrom: 'evil.example' });
  });

  it('reports a DMARC fail as failed', () => {
    const auth = parseAuthenticationResults('mx; spf=fail smtp.mailfrom=bank.example; dmarc=fail header.from=bank.example');
    expect(getSenderVerification(auth, 'ceo@bank.example')?.status).toBe('failed');
  });

  it('accepts an aligned pass, a subdomain included, and judges nothing without results', () => {
    const spf = parseAuthenticationResults('mx; spf=pass smtp.mailfrom=bounce.bank.example; dmarc=none');
    expect(getSenderVerification(spf, 'ceo@bank.example')).toBeNull();
    const dkim = parseAuthenticationResults('mx; dkim=fail header.d=esp.example; dkim=pass header.d=bank.example');
    expect(getSenderVerification(dkim, 'ceo@bank.example')).toBeNull();
    expect(getSenderVerification(parseAuthenticationResults('mx; iprev=pass'), 'a@bank.example')).toBeNull();
    expect(getSenderVerification(undefined, 'a@bank.example')).toBeNull();
  });

  it('takes the signing domain from header.i when the receiver writes no header.d (bulwarkmail/webmail#1420)', () => {
    const from = 'noreply@example.org';
    expect(getSenderVerification(parseAuthenticationResults('mx.example.net; dkim=pass header.i=@example.org'), from)).toBeNull();
    expect(getSenderVerification(parseAuthenticationResults('mx; dkim=pass header.i=bounce@mail.example.org'), from)).toBeNull();
    expect(getSenderVerification(parseAuthenticationResults('mx; dkim=pass header.i=@other.example'), from))
      .toEqual({ status: 'unverified', domain: 'example.org' });
    // header.d still wins when both are there.
    expect(parseAuthenticationResults('mx; dkim=pass header.d=a.example header.i=@b.example').dkim?.domain).toBe('a.example');
  });

  it('does not count a HELO pass', () => {
    const auth = parseAuthenticationResults('mx; spf=pass smtp.helo=bank.example; spf=none smtp.mailfrom=bank.example');
    expect(getSenderVerification(auth, 'a@bank.example')?.status).toBe('unverified');
    // Nor a HELO pass that is the only SPF result.
    const only = parseAuthenticationResults('mx; spf=pass smtp.helo=bank.example; dkim=none; dmarc=none');
    expect(hasAlignedAuthenticationPass(only, 'a@bank.example')).toBe(false);
    expect(getSenderVerification(only, 'a@bank.example')?.status).toBe('unverified');
  });
});

describe('isAuthenticationSpoofed', () => {
  it('flags dmarc fail and spf fail without dkim', () => {
    expect(isAuthenticationSpoofed({ dmarc: { result: 'fail' } })).toBe(true);
    expect(isAuthenticationSpoofed({ spf: { result: 'fail' } })).toBe(true);
    expect(isAuthenticationSpoofed({ spf: { result: 'fail' }, dkim: { result: 'pass' } })).toBe(false);
    expect(isAuthenticationSpoofed(undefined)).toBe(false);
  });
});

describe('parseSpamScore / parseSpamLLM', () => {
  it('reads Stalwart and SpamAssassin formats', () => {
    expect(parseSpamScore('ham, score=-0.25')).toEqual({ status: 'ham', score: -0.25 });
    expect(parseSpamScore('No, score=1.5 required=5.0')).toEqual({ status: 'no', score: 1.5 });
    expect(parseSpamScore('score: 7.2')).toEqual({ status: 'spam', score: 7.2 });
    expect(parseSpamScore('nonsense')).toBeNull();
    expect(parseSpamLLM(' LEGITIMATE (Looks like a receipt) ')).toEqual({ verdict: 'LEGITIMATE', explanation: 'Looks like a receipt' });
    expect(parseSpamLLM('???')).toBeNull();
  });
});

describe('extractListHeaders / headersToRecord', () => {
  it('collects list headers case-insensitively', () => {
    const rec = headersToRecord([
      { name: 'List-ID', value: '<news.list.example>' },
      { name: 'list-unsubscribe', value: '<mailto:u@list.example>, <https://list.example/u>' },
      { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
      { name: 'Received', value: 'a' },
      { name: 'Received', value: 'b' },
    ]);
    expect(rec.Received).toEqual(['a', 'b']);
    const list = extractListHeaders(rec);
    expect(list.listId).toBe('<news.list.example>');
    expect(list.listUnsubscribe?.preferred).toBe('http');
    expect(list.listUnsubscribePost).toBe('List-Unsubscribe=One-Click');
  });
});

describe('deriveHeaderInfo', () => {
  it('pulls the receipt request, message id and spam score out of raw headers', () => {
    const info = deriveHeaderInfo({
      headers: [
        { name: 'Disposition-Notification-To', value: 'Sender <s@x.example>' },
        { name: 'X-Spam-Status', value: 'No, score=0.1' },
        { name: 'Authentication-Results', value: 'mx; dmarc=fail header.from=x.example' },
        { name: 'Authentication-Results', value: 'relay; dmarc=pass header.from=x.example' },
      ],
      messageId: ['abc@x.example'],
    });
    expect(info.readReceiptRequestedBy).toBe('s@x.example');
    expect(info.messageId).toBe('abc@x.example');
    expect(info.spamScore?.score).toBe(0.1);
    expect(isAuthenticationSpoofed(info.auth)).toBe(true);
  });

  it('copes with no headers', () => {
    const info = deriveHeaderInfo({ headers: undefined, messageId: null });
    expect(info.readReceiptRequestedBy).toBeNull();
    expect(info.auth).toBeUndefined();
    expect(info.list).toEqual({});
  });
});

describe('deliveryDeltaMs / formatDelta', () => {
  it('computes the routing delta and formats it', () => {
    expect(deliveryDeltaMs({ sentAt: '2026-01-01T10:00:00Z', receivedAt: '2026-01-01T12:05:00Z' })).toBe(125 * 60000);
    expect(deliveryDeltaMs({ sentAt: undefined, receivedAt: '2026-01-01T12:05:00Z' })).toBeNull();
    expect(formatDelta(125 * 60000)).toBe('2 h 5 min');
    expect(formatDelta(30 * 1000)).toBe('1 min');
    expect(formatDelta(26 * 3600000)).toBe('1 d 2 h');
  });
});

describe('findReceivingIdentity', () => {
  const ids = [
    { id: 'a', name: 'A', email: 'a@x.example', mayDelete: true },
    { id: 'b', name: 'B', email: 'b@x.example', mayDelete: true },
  ];
  it('matches exact and +tag recipients, else the first identity', () => {
    expect(findReceivingIdentity(ids, { to: [{ email: 'b@x.example' }] })?.id).toBe('b');
    expect(findReceivingIdentity(ids, { cc: [{ email: 'b+news@x.example' }] })?.id).toBe('b');
    expect(findReceivingIdentity(ids, { to: [{ email: 'other@y.example' }] })?.id).toBe('a');
    expect(findReceivingIdentity([], { to: [] })).toBeUndefined();
  });
});

describe('describeSenderVerification / senderVerificationOf', () => {
  const t = (_key: string, fallback?: string, params?: Record<string, string | number>) =>
    (fallback ?? '').replace(/\{(\w+)\}/g, (_m, k: string) => String(params?.[k] ?? ''));

  it('names the claimed domain and the sending host', () => {
    const unverified = describeSenderVerification({ status: 'unverified', domain: 'bank.example', sentFrom: 'evil.example' }, t);
    expect(unverified.label).toBe('Unverified sender');
    expect(unverified.message).toContain('bank.example');
    expect(unverified.message).toContain('evil.example');
    const failed = describeSenderVerification({ status: 'failed', domain: 'bank.example' }, t);
    expect(failed.label).toBe('Sender check failed');
    expect(failed.message).toContain('may be forged');
  });

  it('reads the check from the raw headers of a message', () => {
    const forged = {
      from: [{ email: 'ceo@bank.example' }],
      headers: [{ name: 'Authentication-Results', value: 'mx; spf=pass smtp.mailfrom=evil.example; dkim=none; dmarc=none' }],
    };
    expect(senderVerificationOf(forged)?.status).toBe('unverified');
    const genuine = {
      from: [{ email: 'ceo@bank.example' }],
      headers: [{ name: 'Authentication-Results', value: 'mx; spf=pass smtp.mailfrom=bank.example; dkim=pass header.d=bank.example; dmarc=pass' }],
    };
    expect(senderVerificationOf(genuine)).toBeNull();
    expect(senderVerificationOf({ from: [{ email: 'a@b.example' }], headers: [] })).toBeNull();
  });
});
