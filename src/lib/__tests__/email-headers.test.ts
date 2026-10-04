import { describe, it, expect } from 'vitest';
import {
  parseAuthenticationResults, parseSpamScore, parseSpamLLM, extractListHeaders,
  isAuthenticationSpoofed, headersToRecord, deriveHeaderInfo, deliveryDeltaMs, formatDelta,
  findReceivingIdentity,
} from '../email-headers';

describe('parseAuthenticationResults', () => {
  it('parses spf/dkim/dmarc/iprev', () => {
    const r = parseAuthenticationResults(
      'mx.example; spf=pass smtp.mailfrom=news.example; dkim=pass header.d=news.example header.s=s1; dmarc=pass header.from=news.example policy.dmarc=none; iprev=pass policy.iprev=1.2.3.4',
    );
    expect(r.spf).toEqual({ result: 'pass', domain: 'news.example' });
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

  it('takes DKIM and DMARC only from the topmost header', () => {
    const r = parseAuthenticationResults([
      'mx.example; spf=fail smtp.mailfrom=evil.example; dmarc=fail header.from=bank.example',
      'evil.example; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example',
    ]);
    expect(r.dmarc?.result).toBe('fail');
    expect(r.dkim).toBeUndefined();
  });

  it('ignores results inside comments and property values', () => {
    const r = parseAuthenticationResults(
      'mx.example; spf=pass smtp.mailfrom="dmarc=pass"@x.example (dkim=pass header.d=bank.example); dmarc=fail',
    );
    expect(r.dmarc?.result).toBe('fail');
    expect(r.dkim).toBeUndefined();
    expect(r.spf?.result).toBe('pass');
  });

  it('lets a lower header escalate SPF to a failure but never supply a pass', () => {
    expect(parseAuthenticationResults(['mx; spf=none smtp.mailfrom=a.example', 'x; spf=fail smtp.mailfrom=a.example']).spf?.result).toBe('fail');
    expect(parseAuthenticationResults(['mx; spf=fail smtp.mailfrom=a.example', 'x; spf=pass smtp.mailfrom=a.example']).spf?.result).toBe('fail');
    expect(parseAuthenticationResults(['mx; dkim=none', 'x; spf=pass smtp.mailfrom=a.example']).spf).toBeUndefined();
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
      ],
      messageId: ['abc@x.example'],
    });
    expect(info.readReceiptRequestedBy).toBe('s@x.example');
    expect(info.messageId).toBe('abc@x.example');
    expect(info.spamScore?.score).toBe(0.1);
    expect(isAuthenticationSpoofed(info.auth)).toBe(true);
  });

  it('does not let a lower Authentication-Results header supply a DMARC pass', () => {
    const info = deriveHeaderInfo({
      headers: [
        { name: 'Authentication-Results', value: 'mx; spf=pass smtp.mailfrom=a.example' },
        { name: 'Authentication-Results', value: 'x; dmarc=pass' },
      ],
      messageId: null,
    });
    expect(info.auth?.dmarc).toBeUndefined();
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
