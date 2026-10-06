import { describe, it, expect } from 'vitest';
import {
  parseUnsubscribeUrls, isValidUnsubscribeUrl, parseMailtoUrl, isOneClickUnsubscribe,
  parseUnsubscribeMailto, unsubscribeConfirmDetails,
} from '../unsubscribe';

describe('parseUnsubscribeUrls', () => {
  it('prefers http over mailto and validates both', () => {
    const r = parseUnsubscribeUrls('<mailto:unsub@list.example?subject=stop>, <https://list.example/u?x=1>');
    expect(r.preferred).toBe('http');
    expect(r.http).toBe('https://list.example/u?x=1');
    expect(r.mailto).toBe('mailto:unsub@list.example?subject=stop');
  });

  it('falls back to mailto and ignores junk', () => {
    expect(parseUnsubscribeUrls('<mailto:a@b.co>').preferred).toBe('mailto');
    expect(parseUnsubscribeUrls('<ftp://x>').preferred).toBeUndefined();
    expect(parseUnsubscribeUrls('')).toEqual({});
  });
});

describe('parseUnsubscribeUrls schemes and candidates', () => {
  it('matches the scheme case-insensitively', () => {
    expect(parseUnsubscribeUrls('<HTTPS://x.example/u>').http).toBe('HTTPS://x.example/u');
    expect(parseUnsubscribeUrls('<MAILTO:leave@x.example>').mailto).toBe('MAILTO:leave@x.example');
    expect(isValidUnsubscribeUrl('MAILTO:a@b.co')).toBe(true);
    expect(isValidUnsubscribeUrl('Http://x.example')).toBe(true);
  });
  it('uses the first valid mailto when an earlier one fails the strict parse', () => {
    const r = parseUnsubscribeUrls('<mailto:a@x.example,b@y.example>, <mailto:x%3E%2C%3Cvictim@evil.com>, <mailto:leave@list.example>');
    expect(r.mailto).toBe('mailto:leave@list.example');
    expect(r.preferred).toBe('mailto');
    expect(parseUnsubscribeUrls('<mailto:a@x.example,b@y.example>').preferred).toBeUndefined();
  });
  it('uses the first valid http url', () => {
    expect(parseUnsubscribeUrls('<ftp://x>, <https://ok.example/u>').http).toBe('https://ok.example/u');
  });
  it('parses a 200 KB header in linear time', () => {
    const big = (unit: string) => unit.repeat(Math.ceil(200_000 / unit.length));
    for (const header of [big('<'), big('<mailto:a'), big('<mailto:a.a@'), big('<mailto:' + 'a.'.repeat(50) + '@a-'), `<mailto:${big('a,')}@x.example>`]) {
      const start = performance.now();
      parseUnsubscribeUrls(header);
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });
});

describe('isValidUnsubscribeUrl', () => {
  it('accepts http(s) and mailto with a valid address only', () => {
    expect(isValidUnsubscribeUrl('https://x.example/u')).toBe(true);
    expect(isValidUnsubscribeUrl('mailto:a@b.co?subject=x')).toBe(true);
    expect(isValidUnsubscribeUrl('mailto:not-an-address')).toBe(false);
    expect(isValidUnsubscribeUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('parseMailtoUrl', () => {
  it('parses recipients, subject and body without turning + into spaces', () => {
    const r = parseMailtoUrl('mailto:a+tag@b.co,c@d.co?subject=Hi%20there&body=Line%0Atwo&cc=e@f.co');
    expect(r).toEqual({ to: ['a+tag@b.co', 'c@d.co'], cc: ['e@f.co'], subject: 'Hi there', body: 'Line\ntwo' });
  });

  it('returns null without a recipient', () => {
    expect(parseMailtoUrl('mailto:?subject=x')).toBeNull();
    expect(parseMailtoUrl('https://x')).toBeNull();
  });
});

describe('isOneClickUnsubscribe', () => {
  it('requires the RFC 8058 header and an https URL', () => {
    expect(isOneClickUnsubscribe('List-Unsubscribe=One-Click', 'https://x/u')).toBe(true);
    expect(isOneClickUnsubscribe('List-Unsubscribe=One-Click', 'http://x/u')).toBe(false);
    expect(isOneClickUnsubscribe(undefined, 'https://x/u')).toBe(false);
  });
});

describe('parseUnsubscribeMailto', () => {
  it('takes exactly one recipient from the address part', () => {
    expect(parseUnsubscribeMailto('mailto:leave@list.example?subject=unsubscribe')).toEqual({ to: ['leave@list.example'], subject: 'unsubscribe' });
  });
  it('refuses a list of addresses', () => {
    expect(parseUnsubscribeMailto('mailto:a@x.example,b@y.example')).toBeNull();
  });
  it('ignores to= and cc= query fields', () => {
    expect(parseUnsubscribeMailto('mailto:leave@list.example?to=ceo@corp.example&cc=boss@corp.example'))
      .toEqual({ to: ['leave@list.example'] });
  });
  it('returns null without an address part, even with a to= field', () => {
    expect(parseUnsubscribeMailto('mailto:?to=a@x.example')).toBeNull();
    expect(parseUnsubscribeMailto('https://x')).toBeNull();
  });
  it('keeps the subject on one line and caps subject and body', () => {
    const r = parseUnsubscribeMailto(`mailto:l@x.example?subject=a%0D%0Ab&body=${'x'.repeat(600)}`)!;
    expect(r.subject).toBe('a b');
    expect(r.body).toHaveLength(500);
    expect(parseUnsubscribeMailto(`mailto:l@x.example?subject=${'s'.repeat(300)}`)!.subject).toHaveLength(200);
  });
  it('refuses an address that a server could split into several recipients', () => {
    for (const url of [
      'mailto:unsub@news.example%2Call-staff',
      'mailto:x%3E%2C%3Cvictim@evil.com',
      'mailto:x:ceo@corp.example;',
      'mailto:a%2Cb@x.com',
      'mailto:hr%E2%80%AE@corp.example',
    ]) expect(parseUnsubscribeMailto(url)).toBeNull();
  });
  it('ignores repeated to= fields and refuses a non-address with a valid to=', () => {
    expect(parseUnsubscribeMailto('mailto:boss@corp.example?to=hr@corp.example&to=press@news.example&subject=I%20resign')?.to)
      .toEqual(['boss@corp.example']);
    expect(parseUnsubscribeMailto('mailto:nobody?to=victim@corp.example')).toBeNull();
  });
  it('strips bidi and invisible characters from the subject', () => {
    expect(parseUnsubscribeMailto('mailto:l@x.example?subject=un%E2%80%AEsub%E2%80%8Bscribe')?.subject).toBe('unsubscribe');
  });
  it('parseMailtoUrl still accepts several addresses', () => {
    expect(parseMailtoUrl('mailto:a@x.example,b@y.example')?.to).toEqual(['a@x.example', 'b@y.example']);
  });
});

describe('unsubscribeConfirmDetails', () => {
  it('lists the recipient, then subject and body on their own lines', () => {
    expect(unsubscribeConfirmDetails({ to: ['l@x.example'], subject: 'stop', body: 'please' })).toBe('l@x.example\nstop\nplease');
    expect(unsubscribeConfirmDetails({ to: ['l@x.example'] })).toBe('l@x.example');
  });
});
