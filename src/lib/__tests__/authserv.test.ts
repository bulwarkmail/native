import { describe, it, expect } from 'vitest';
import { authservIdOf, isTrustedAuthservId, pinAuthenticationResults, serverHostOf } from '../authserv';

describe('authservIdOf', () => {
  it('reads the authserv-id, dropping a version, comments and the trailing dot', () => {
    expect(authservIdOf('MX.Example.com 1; spf=pass')).toBe('mx.example.com');
    expect(authservIdOf('(by us) mx.example.com.; dkim=pass')).toBe('mx.example.com');
    expect(authservIdOf('; spf=pass')).toBeNull();
  });

  it('reads no id from a header with no results part or no plain token', () => {
    expect(authservIdOf('mx.example.com')).toBeNull();
    expect(authservIdOf('spf=pass smtp.mailfrom=a.example')).toBeNull();
    expect(authservIdOf('mx.example.com (; spf=pass)')).toBeNull();
    expect(authservIdOf('"mx.example.com"; spf=pass')).toBeNull();
  });

  it('reads no id past the length cap, in linear time', () => {
    expect(authservIdOf('(' + 'x'.repeat(20_000) + ') mx.example.com; spf=pass')).toBeNull();
    expect(authservIdOf('mx.example.com; dkim=pass ' + 'x'.repeat(20_000))).toBe('mx.example.com');
    const started = performance.now();
    authservIdOf('('.repeat(1_000_000) + 'mx; spf=pass');
    authservIdOf('"\\'.repeat(500_000));
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('isTrustedAuthservId', () => {
  it('trusts the server host, its registrable domain and their subdomains only', () => {
    expect(isTrustedAuthservId('mx1.example.com', 'jmap.example.com')).toBe(true);
    expect(isTrustedAuthservId('example.com', 'jmap.example.com')).toBe(true);
    expect(isTrustedAuthservId('example.com.evil.example', 'jmap.example.com')).toBe(false);
    expect(isTrustedAuthservId('mx.other.co.uk', 'mail.example.co.uk')).toBe(false);
    expect(isTrustedAuthservId('192.0.2.1', '192.0.2.1')).toBe(true);
    expect(isTrustedAuthservId('evil.192.0.2.1', '10.0.0.1')).toBe(false);
  });

  it('never trusts a lookalike or a shared suffix', () => {
    expect(isTrustedAuthservId('notexample.com', 'jmap.example.com')).toBe(false);
    expect(isTrustedAuthservId('co.uk', 'mail.example.co.uk')).toBe(false);
    expect(isTrustedAuthservId('evil.github.io', 'alice.github.io')).toBe(false);
    expect(isTrustedAuthservId('', 'jmap.example.com')).toBe(false);
    expect(isTrustedAuthservId('mx', '')).toBe(false);
  });

  it('trusts only an exact match when the host has no registrable domain', () => {
    // An IP or a single label has no parent to vouch for its "subdomains".
    expect(isTrustedAuthservId('evil.192.0.2.1', '192.0.2.1')).toBe(false);
    expect(isTrustedAuthservId('x.localhost', 'localhost')).toBe(false);
    expect(isTrustedAuthservId('evil.mx', 'mx')).toBe(false);
    expect(isTrustedAuthservId('localhost', 'localhost')).toBe(true);
    expect(isTrustedAuthservId('mx', 'mx')).toBe(true);
  });
});

describe('pinAuthenticationResults', () => {
  it('keeps a trusted topmost header and the ones below it', () => {
    expect(pinAuthenticationResults(['mx.example.com; dkim=fail', 'x; spf=fail'], 'jmap.example.com'))
      .toEqual(['mx.example.com; dkim=fail', 'x; spf=fail']);
    expect(pinAuthenticationResults(['evil.example; dmarc=pass'], 'jmap.example.com')).toEqual([]);
    expect(pinAuthenticationResults(['mx.example.com; dmarc=pass'], null)).toEqual([]);
  });

  it('judges the topmost header only: a trusted id lower down proves nothing', () => {
    // A sender can write a header under the server's id anywhere in the message.
    expect(pinAuthenticationResults(['evil.example; dkim=pass', 'mx.example.com; dkim=fail', 'x; spf=fail'], 'jmap.example.com'))
      .toEqual([]);
    expect(pinAuthenticationResults(['relay.other.example; spf=pass', 'mx.example.com; dmarc=pass header.from=bank.example'], 'jmap.example.com'))
      .toEqual([]);
  });

  it('gives nothing for no headers, or a top header with no authserv-id', () => {
    expect(pinAuthenticationResults([], 'jmap.example.com')).toEqual([]);
    expect(pinAuthenticationResults(['; dmarc=pass header.from=bank.example', 'mx.example.com; dmarc=pass header.from=bank.example'], 'jmap.example.com'))
      .toEqual([]);
    expect(pinAuthenticationResults(['dmarc=pass header.from=bank.example'], 'jmap.example.com')).toEqual([]);
  });

  it('matches the host however the URL spelled it', () => {
    expect(pinAuthenticationResults(['MX.Example.COM.; dmarc=pass'], serverHostOf('https://JMAP.example.com.:443/'))).toEqual(['MX.Example.COM.; dmarc=pass']);
  });
});

describe('serverHostOf', () => {
  it('takes the host from a server URL', () => {
    expect(serverHostOf('https://Mail.Example.com:8443/jmap')).toBe('mail.example.com');
    expect(serverHostOf('https://[2001:db8::1]/')).toBe('2001:db8::1');
    expect(serverHostOf('mail.example.com')).toBeNull();
  });

  it('drops userinfo, a trailing dot, a query or fragment, and refuses other schemes', () => {
    expect(serverHostOf('http://user:pw@mail.example.com./')).toBe('mail.example.com');
    expect(serverHostOf('https://mail.example.com?x=1')).toBe('mail.example.com');
    expect(serverHostOf('https://mail.example.com#top')).toBe('mail.example.com');
    expect(serverHostOf('ftp://mail.example.com/')).toBeNull();
    expect(serverHostOf('https:///jmap')).toBeNull();
    expect(serverHostOf('https://[2001:db8::1/')).toBeNull();
    expect(serverHostOf(null)).toBeNull();
    expect(serverHostOf(undefined)).toBeNull();
  });

  it('ends the authority at a backslash, as WHATWG URL parsing does', () => {
    expect(serverHostOf('https://mail.example.com\\@evil.example/')).toBe('mail.example.com');
    expect(serverHostOf('https://mail.example.com\\jmap')).toBe('mail.example.com');
  });
});
