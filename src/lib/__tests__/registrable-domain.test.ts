import { describe, it, expect } from 'vitest';
import { registrableDomain, domainsAlign } from '../registrable-domain';

describe('registrableDomain', () => {
  it('finds the registrable domain under ICANN and private suffixes', () => {
    expect(registrableDomain('mx1.mail.example.com')).toBe('example.com');
    expect(registrableDomain('Mail.Example.CO.UK.')).toBe('example.co.uk');
    expect(registrableDomain('alice.github.io')).toBe('alice.github.io');
    for (const h of ['co.uk', '192.0.2.1', 'localhost', 'mx', 'a'.repeat(254)]) expect(registrableDomain(h)).toBeNull();
  });

  it('reads nothing from a URL, or from a host tldts would read as one', () => {
    for (const h of [
      'https://bank.example', 'user@bank.example', 'bank.example:443', 'bank.example/x',
      'bank.example?x', 'bank.example#x', 'bank.example\\x', 'bank%2eexample', '[::1]', 'bank example',
    ]) expect(registrableDomain(h)).toBeNull();
  });

  it('reads nothing from a host with a control character or an empty label', () => {
    for (const h of ['bank.example\u0000', 'bank\u0001.example', 'bank.example\u007f', 'mx..bank.example', '.bank.example', 'mx.bank.example..']) {
      expect(registrableDomain(h)).toBeNull();
    }
  });
});

describe('domainsAlign', () => {
  it('aligns siblings under one registrable domain, never across a shared suffix', () => {
    expect(domainsAlign('news.bank.example', 'mailer.bank.example')).toBe(true);
    expect(domainsAlign('bank.example', 'bank.example')).toBe(true);
    expect(domainsAlign('alice.github.io', 'bob.github.io')).toBe(false);
    expect(domainsAlign('evil.co.uk', 'bank.co.uk')).toBe(false);
    expect(domainsAlign('mx', 'mx')).toBe(true);
  });
});
