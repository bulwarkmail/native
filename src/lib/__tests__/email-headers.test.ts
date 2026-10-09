import { describe, it, expect } from 'vitest';
import {
  isFromDomainAuthenticated,
  parseAuthenticationResults, parseSpamScore, parseSpamLLM, extractListHeaders,
  isAuthenticationSpoofed, headersToRecord, deriveHeaderInfo, deliveryDeltaMs, formatDelta,
  findReceivingIdentity, getSenderVerification,
} from '../email-headers';

describe('parseAuthenticationResults', () => {
  it('parses spf/dkim/dmarc/iprev', () => {
    const r = parseAuthenticationResults(
      'mx.example; spf=pass smtp.mailfrom=news.example; dkim=pass header.d=news.example header.s=s1; dmarc=pass header.from=news.example policy.dmarc=none; iprev=pass policy.iprev=1.2.3.4',
    );
    expect(r.spf).toEqual({ result: 'pass', domain: 'news.example', identity: 'mailfrom' });
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

  it('honours a passing signature that is not the first one', () => {
    const auth = parseAuthenticationResults('mx; spf=fail smtp.mailfrom=a.example; dkim=fail header.d=a.example; dkim=pass header.d=esp.example');
    expect(auth.dkim?.result).toBe('fail');
    expect(isAuthenticationSpoofed(auth)).toBe(false);
  });
});

describe('parseAuthenticationResults - several DKIM signatures', () => {
  it('keeps the first as the headline and lists them all', () => {
    const auth = parseAuthenticationResults('mx; dkim=fail header.d=shop.example header.s=a; dkim=pass header.d=esp.example header.s=b');
    expect(auth.dkim).toEqual({
      result: 'fail',
      domain: 'shop.example',
      selector: 'a',
      all: [
        { result: 'fail', domain: 'shop.example', selector: 'a' },
        { result: 'pass', domain: 'esp.example', selector: 'b' },
      ],
    });
  });

  it('leaves out the list for a single signature', () => {
    const auth = parseAuthenticationResults('mx; dkim=pass header.d=shop.example');
    expect(auth.dkim).toEqual({ result: 'pass', domain: 'shop.example', selector: undefined });
  });

  it('takes no signature from a lower header', () => {
    const auth = parseAuthenticationResults([
      'mx; dkim=fail header.d=bank.example',
      'forged; dkim=pass header.d=bank.example',
    ]);
    expect(auth.dkim?.all).toBeUndefined();
    expect(getSenderVerification(auth, 'support@bank.example')?.status).toBe('unverified');
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
    }, 'mx');
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
    }, 'mx');
    expect(info.auth?.dmarc).toBeUndefined();
  });

  it('judges the From address by the receiving server\'s results', () => {
    const info = deriveHeaderInfo({
      headers: [
        { name: 'Authentication-Results', value: 'mx; spf=none smtp.mailfrom=www-data@web1.hoster.example; dmarc=none header.from=bank.example' },
        { name: 'Authentication-Results', value: 'forged; dmarc=pass header.from=bank.example; dkim=pass header.d=bank.example' },
      ],
      messageId: null,
      from: [{ name: 'Bank', email: 'support@bank.example' }],
    }, 'mx');
    expect(info.senderVerification).toEqual({ status: 'unverified', domain: 'bank.example', sentFrom: 'web1.hoster.example' });
  });

  it('gives no verdict without results, whatever the body says', () => {
    const info = deriveHeaderInfo({
      headers: [{ name: 'Subject', value: 'Authentication-Results: mx; dmarc=fail' }],
      messageId: null,
      from: [{ email: 'support@bank.example' }],
    }, 'mx');
    expect(info.senderVerification).toBeNull();
    expect(deriveHeaderInfo({ headers: undefined, messageId: null }, 'mx').senderVerification).toBeNull();
  });

  const ar = (...values: string[]) => values.map((value) => ({ name: 'Authentication-Results', value }));

  it('gives no results for a pass under an authserv-id the server does not own', () => {
    const info = deriveHeaderInfo({ headers: ar('evil.example; dmarc=pass header.from=bank.example'), messageId: null, from: [{ email: 'ceo@bank.example' }] }, 'jmap.example.com');
    expect(info.auth).toBeUndefined();
    expect(info.senderVerification).toBeNull();
  });

  it('reads results from a topmost header the server owns, and treats lower ones as foreign', () => {
    const info = deriveHeaderInfo({
      headers: ar(
        'mx1.example.com; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example',
        'mx1.example.com; spf=fail smtp.mailfrom=bank.example',
      ),
      messageId: null,
      from: [{ email: 'ceo@bank.example' }],
    }, 'jmap.example.com');
    expect(info.auth?.dmarc?.result).toBe('pass');
    expect(info.auth?.spf).toMatchObject({ result: 'fail', foreign: true });
  });

  it('gives no results when the server\'s id appears only below an untrusted top header', () => {
    const info = deriveHeaderInfo({
      headers: ar(
        'relay.other.example; spf=none smtp.mailfrom=bank.example',
        'mail.example.com; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example',
      ),
      messageId: null,
      from: [{ email: 'ceo@bank.example' }],
    }, 'jmap.example.com');
    expect(info.auth).toBeUndefined();
    expect(info.senderVerification).toBeNull();
  });

  it('gives no results when the server host is unknown', () => {
    expect(deriveHeaderInfo({ headers: ar('mx; dmarc=pass'), messageId: null }, null).auth).toBeUndefined();
  });

  it('copes with no headers', () => {
    const info = deriveHeaderInfo({ headers: undefined, messageId: null }, 'mx');
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

// Port of the webmail's lib/__tests__/email-headers.test.ts (88893463).
describe('getSenderVerification', () => {
  // Shape of a real phish: forged bank From, sent by a web host's PHP
  // mailer, no signature. mail-auth reports dmarc=none because neither SPF
  // nor DKIM passed, although the From domain publishes a DMARC record.
  const phish = parseAuthenticationResults(
    'mx.example.org;\r\n\tspf=none (mx.example.org: no SPF records found for www-data@web1.hoster.example) smtp.mailfrom=www-data@web1.hoster.example;\r\n\tiprev=permerror policy.iprev=203.0.113.7;\r\n\tdmarc=none header.from=bank.example policy.dmarc=none',
  );

  it('flags a message that passes neither SPF nor DKIM', () => {
    expect(isAuthenticationSpoofed(phish)).toBe(false);
    expect(getSenderVerification(phish, 'support@bank.example')).toEqual({
      status: 'unverified',
      domain: 'bank.example',
      sentFrom: 'web1.hoster.example',
    });
  });

  it('leaves out the envelope host when it is the From domain', () => {
    const auth = parseAuthenticationResults('mx; spf=softfail smtp.mailfrom=billing@Bank.Example; dmarc=none header.from=bank.example');
    expect(getSenderVerification(auth, 'billing@bank.example')).toEqual({ status: 'unverified', domain: 'bank.example' });
  });

  it('reports a DMARC fail as failed', () => {
    const auth = parseAuthenticationResults('mx; spf=pass smtp.mailfrom=bounce@evil.example; dmarc=fail header.from=bank.example');
    expect(getSenderVerification(auth, 'support@bank.example')).toEqual({
      status: 'failed',
      domain: 'bank.example',
      sentFrom: 'evil.example',
    });
  });

  it('accepts a passing SPF, DKIM or DMARC result for the From domain', () => {
    const from = 'news@shop.example';
    expect(getSenderVerification(parseAuthenticationResults('mx; spf=pass smtp.mailfrom=bounce@shop.example'), from)).toBeNull();
    expect(getSenderVerification(parseAuthenticationResults('mx; spf=none smtp.mailfrom=x.example; dkim=pass header.d=shop.example'), from)).toBeNull();
    expect(getSenderVerification(parseAuthenticationResults('mx; dmarc=pass header.from=shop.example'), from)).toBeNull();
  });

  it('accepts a pass for a parent domain or a subdomain of the From domain', () => {
    expect(getSenderVerification(parseAuthenticationResults('mx; spf=pass smtp.mailfrom=bounce@mail.shop.example'), 'news@shop.example')).toBeNull();
    expect(getSenderVerification(parseAuthenticationResults('mx; dkim=pass header.d=Shop.Example.'), 'news@em.shop.example')).toBeNull();
  });

  it('does not let a pass for another domain vouch for the From domain', () => {
    // A spoofer passes SPF and DKIM for their own domain; with no DMARC
    // record at the forged domain, nothing else would flag it.
    const auth = parseAuthenticationResults('mx; spf=pass smtp.mailfrom=bounce@evil.example; dkim=pass header.d=evil.example; dmarc=none header.from=bank.example');
    expect(getSenderVerification(auth, 'support@bank.example')).toEqual({
      status: 'unverified',
      domain: 'bank.example',
      sentFrom: 'evil.example',
    });
    // Nor a domain that merely ends in the same letters.
    expect(getSenderVerification(parseAuthenticationResults('mx; dkim=pass header.d=notbank.example'), 'support@bank.example')?.status).toBe('unverified');
  });

  it('counts a passing signature that is not the first one', () => {
    const auth = parseAuthenticationResults('mx; dkim=fail header.d=esp.example; dkim=pass header.d=shop.example; spf=none smtp.mailfrom=x.example');
    expect(auth.dkim?.result).toBe('fail');
    expect(auth.dkim?.all).toHaveLength(2);
    expect(getSenderVerification(auth, 'news@shop.example')).toBeNull();
  });

  it('does not take a HELO pass for a MAIL FROM pass', () => {
    const auth = parseAuthenticationResults('mx; spf=pass smtp.helo=web1.hoster.example; spf=none smtp.mailfrom=www-data@web1.hoster.example');
    expect(getSenderVerification(auth, 'support@bank.example')?.status).toBe('unverified');
  });

  it('does not take a lone HELO pass for the sender\'s', () => {
    const auth = parseAuthenticationResults('mx; spf=pass smtp.helo=partner.example');
    expect(getSenderVerification(auth, 'bob@partner.example')?.status).toBe('unverified');
  });

  it('takes a DMARC pass only for the From domain, as the invitation banner does', () => {
    const from = 'support@bank.example';
    expect(getSenderVerification(parseAuthenticationResults('mx; dmarc=pass header.from=evil.example'), from)?.status).toBe('unverified');
    expect(getSenderVerification(parseAuthenticationResults('mx; dmarc=pass header.from=mail.bank.example'), from)).toBeNull();
  });

  it('says nothing without results or a From address', () => {
    expect(getSenderVerification(undefined, 'a@b.example')).toBeNull();
    expect(getSenderVerification({}, 'a@b.example')).toBeNull();
    expect(getSenderVerification({ iprev: { result: 'fail' } }, 'a@b.example')).toBeNull();
    expect(getSenderVerification(phish, undefined)).toBeNull();
  });
});

describe('getSenderVerification - sender-written input', () => {
  const from = [{ email: 'support@bank.example' }];
  const derive = (...values: string[]) => deriveHeaderInfo({
    headers: values.map((value) => ({ name: 'Authentication-Results', value })),
    messageId: null,
    from,
  }, 'mx');

  it('reads a hostile envelope address in linear time', () => {
    const hostile = 'x; spf=fail smtp.mailfrom=x@' + 'a.'.repeat(100_000) + '<';
    const started = performance.now();
    const info = derive('mx; dkim=none; dmarc=none', hostile);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(info.senderVerification?.sentFrom).toBeUndefined();
  });

  it('reads a quoted local part as part of the envelope address, not all of it', () => {
    // SPF passed for evil.example; the quoted local part must not pass for the
    // From domain's own envelope.
    const info = derive('mx; spf=pass smtp.mailfrom="support@bank.example"@evil.example; dmarc=none header.from=bank.example');
    expect(info.auth?.spf?.domain).toBe('"support@bank.example"@evil.example');
    expect(info.senderVerification).toEqual({ status: 'unverified', domain: 'bank.example', sentFrom: 'evil.example' });
  });

  it('reads hostile quoting in linear time', () => {
    const hostile = [
      'mx; spf=pass smtp.mailfrom=' + '"a"b'.repeat(50_000) + '"unterminated',
      'mx; spf=pass smtp.mailfrom="' + 'a '.repeat(100_000),
      'mx; spf=pass smtp.mailfrom=' + '"'.repeat(100_001),
      'mx; spf=pass smtp.mailfrom="' + '\\'.repeat(100_000),
      'mx; spf=pass ' + 'k="x '.repeat(50_000),
      'mx' + '; spf=pass k="x'.repeat(50_000),
      'mx; spf=pass k=' + '"(\\'.repeat(50_000),
    ];
    const started = performance.now();
    for (const value of hostile) derive(value);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('rejects an overlong domain', () => {
    const long = 'a'.repeat(250) + '.example';
    expect(getSenderVerification(parseAuthenticationResults('mx; dmarc=none'), `x@${long}`)).toBeNull();
  });

  it('takes the sending host from the server\'s own header only', () => {
    const info = derive('mx; spf=none smtp.helo=web1.hoster.example; dmarc=none', 'forged; spf=fail smtp.mailfrom=x@trusted-looking.example');
    expect(info.senderVerification?.status).toBe('failed');
    expect(info.senderVerification?.sentFrom).toBeUndefined();
    expect(derive('mx; dmarc=none', 'forged; spf=fail smtp.mailfrom=x@trusted-looking.example').senderVerification?.sentFrom).toBeUndefined();
  });

  it('still names the own header\'s envelope host next to a foreign fail', () => {
    const info = derive('mx; spf=none smtp.mailfrom=www-data@web1.hoster.example; dmarc=none', 'forged; spf=fail smtp.mailfrom=x@other.example');
    expect(info.senderVerification?.sentFrom).toBe('web1.hoster.example');
  });
});

describe('isFromDomainAuthenticated', () => {
  const auth = (value: string) => parseAuthenticationResults(value);
  it('takes a DMARC pass, or an SPF or DKIM pass aligned with the From domain', () => {
    expect(isFromDomainAuthenticated(auth('mx; dmarc=pass header.from=example.com'), 'a@example.com')).toBe(true);
    expect(isFromDomainAuthenticated(auth('mx; dkim=pass header.d=mail.example.com'), 'a@example.com')).toBe(true);
    expect(isFromDomainAuthenticated(auth('mx; spf=pass smtp.mailfrom=bounce@example.com'), 'a@example.com')).toBe(true);
  });
  it('never reads a missing result, an unparsable domain or another domain\'s pass as a yes', () => {
    expect(isFromDomainAuthenticated(null, 'a@example.com')).toBe(false);
    expect(isFromDomainAuthenticated(auth('mx; dkim=pass header.d=evil.example'), 'a@example.com')).toBe(false);
    expect(isFromDomainAuthenticated(auth('mx; spf=none; dkim=none; dmarc=none'), 'ian@intranet')).toBe(false);
    expect(isFromDomainAuthenticated(auth('mx; dmarc=pass header.from=intranet'), 'ian@intranet')).toBe(false);
    expect(isFromDomainAuthenticated(auth('mx; dmarc=pass header.from=evil.example'), 'a@example.com')).toBe(false);
    // A HELO pass says nothing about the author.
    expect(isFromDomainAuthenticated(auth('mx; spf=pass smtp.helo=partner.example'), 'bob@partner.example')).toBe(false);
  });
  it('takes a DMARC pass only for the header.from it names', () => {
    expect(isFromDomainAuthenticated(auth('mx; dmarc=pass'), 'a@example.com')).toBe(false);
    expect(isFromDomainAuthenticated(auth('mx; dmarc=pass policy.dmarc=reject'), 'a@example.com')).toBe(false);
    expect(isFromDomainAuthenticated(auth('mx; dmarc=pass header.from='), 'a@example.com')).toBe(false);
    expect(isFromDomainAuthenticated(auth('mx; dmarc=pass header.from=news.example.com'), 'a@example.com')).toBe(true);
  });
  it('keeps passing a Stalwart-written header under the server\'s own authserv-id', () => {
    // Stalwart's layout: its hostname, then one resinfo per line, DMARC with header.from.
    const stalwart = 'mail.example.org;\r\n\tdkim=pass header.d=example.com header.s=sel header.b=AbC123;\r\n'
      + '\tspf=pass (mail.example.org: domain of a@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=a@example.com;\r\n'
      + '\tiprev=pass policy.iprev=192.0.2.1;\r\n\tdmarc=pass header.from=example.com policy.dmarc=none';
    const dmarcOnly = 'mail.example.org;\r\n\tdmarc=pass header.from=example.com policy.dmarc=reject';
    for (const value of [stalwart, dmarcOnly]) {
      const info = deriveHeaderInfo({
        headers: [{ name: 'Authentication-Results', value }],
        messageId: null,
        from: [{ email: 'a@example.com' }],
      }, 'mail.example.org');
      expect(info.auth?.dmarc).toMatchObject({ result: 'pass', domain: 'example.com' });
      expect(isFromDomainAuthenticated(info.auth, 'a@example.com')).toBe(true);
      expect(info.senderVerification).toBeNull();
    }
  });
});
