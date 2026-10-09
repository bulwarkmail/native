import { describe, it, expect } from 'vitest';
import { registrableDomain, domainsAlign } from '../registrable-domain';

describe('registrableDomain', () => {
  it('finds the registrable domain under ICANN and private suffixes', () => {
    expect(registrableDomain('mx1.mail.example.com')).toBe('example.com');
    expect(registrableDomain('Mail.Example.CO.UK.')).toBe('example.co.uk');
    expect(registrableDomain('alice.github.io')).toBe('alice.github.io');
    for (const h of ['co.uk', '192.0.2.1', 'localhost', 'mx', 'a'.repeat(254)]) expect(registrableDomain(h)).toBeNull();
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
