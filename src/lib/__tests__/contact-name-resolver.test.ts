import { describe, it, expect } from 'vitest';
import type { ContactCard } from '../../api/types';
import { buildContactNameResolver } from '../contact-name-resolver';

// A bare address in the event data must display the contact card's name,
// while names the event already carries stay authoritative — the resolver
// only ever fills (webmail #738).

function makeContact(emails: string[], name?: string, overrides: Partial<ContactCard> = {}): ContactCard {
  return {
    id: Math.random().toString(36).slice(2),
    addressBookIds: { ab1: true },
    emails: Object.fromEntries(emails.map((address, i) => [`${i}`, { address }])),
    ...(name ? { name: { full: name } } : {}),
    ...overrides,
  } as ContactCard;
}

describe('buildContactNameResolver', () => {
  it('maps every address of a contact to its display name, case-insensitively', () => {
    const resolver = buildContactNameResolver([
      makeContact(['alice@example.com', 'alice.smith@example.com'], 'Alice'),
    ]);
    expect(resolver('alice@example.com')).toBe('Alice');
    expect(resolver('  ALICE.SMITH@EXAMPLE.COM ')).toBe('Alice');
  });

  it('keeps the first contact when several hold the same address', () => {
    const resolver = buildContactNameResolver([
      makeContact(['bob@example.com'], 'First Bob'),
      makeContact(['bob@example.com'], 'Second Bob'),
    ]);
    expect(resolver('bob@example.com')).toBe('First Bob');
  });

  it('skips cards whose only name is an address, and unknown or blank addresses', () => {
    const resolver = buildContactNameResolver([makeContact(['noname@example.com'])]);
    expect(resolver('noname@example.com')).toBeUndefined();
    expect(resolver('unknown@example.com')).toBeUndefined();
    expect(resolver('   ')).toBeUndefined();
  });

  it('falls back to a card with the same local part on a related domain', () => {
    const resolver = buildContactNameResolver([
      makeContact(['zhang@example.com'], 'Zhang'),
      makeContact(['carol@node-example.com'], 'Carol'),
    ]);
    expect(resolver('zhang@node-example.com')).toBe('Zhang');
    expect(resolver('zhang@mail.example.com')).toBe('Zhang');
    expect(resolver('carol@example.com')).toBe('Carol');
  });

  it('does not fall back across unrelated or merely string-suffixed domains', () => {
    const resolver = buildContactNameResolver([makeContact(['dave@example.com'], 'Dave')]);
    expect(resolver('dave@gmail.com')).toBeUndefined();
    expect(resolver('dave@xexample.com')).toBeUndefined();
  });

  it('returns nothing when related-domain cards disagree on the name', () => {
    const disagree = buildContactNameResolver([
      makeContact(['eve@example.com'], 'Eve One'),
      makeContact(['eve@mail.example.com'], 'Eve Two'),
    ]);
    expect(disagree('eve@x.mail.example.com')).toBeUndefined();
    const agree = buildContactNameResolver([
      makeContact(['eve@example.com'], 'Eve'),
      makeContact(['eve@mail.example.com'], 'Eve'),
    ]);
    expect(agree('eve@x.mail.example.com')).toBe('Eve');
  });

  it('uses the account name, then the identity name, for the user\'s own addresses', () => {
    const resolver = buildContactNameResolver(
      [],
      [{ name: 'Old Name', email: 'zhang@node-example.com' }, { name: 'Ident', email: 'z@other.example' }],
      [
        { name: 'New Name', email: 'zhang@node-example.com', username: 'zhang' },
        { name: 'Login', email: undefined, username: 'login@example.com' },
      ],
    );
    expect(resolver('zhang@node-example.com')).toBe('New Name');
    expect(resolver('z@other.example')).toBe('Ident');
    expect(resolver('login@example.com')).toBe('Login');
    // A short username is not an address.
    expect(resolver('zhang@elsewhere.example')).toBeUndefined();
  });

  it('skips account names that are just the address', () => {
    const resolver = buildContactNameResolver([], [], [
      { name: 'zhang@node-example.com', email: 'zhang@node-example.com' },
    ]);
    expect(resolver('zhang@node-example.com')).toBeUndefined();
  });

  it('ranks contact cards (exact, then related-domain) above account and identity names', () => {
    const exact = buildContactNameResolver(
      [makeContact(['zhang@node-example.com'], 'Card')],
      [{ name: 'Identity', email: 'zhang@node-example.com' }],
      [{ name: 'Account', email: 'zhang@node-example.com' }],
    );
    expect(exact('zhang@node-example.com')).toBe('Card');
    const related = buildContactNameResolver(
      [makeContact(['zhang@example.com'], 'Card remark')],
      [],
      [{ name: 'Account', email: 'zhang@node-example.com' }],
    );
    expect(related('zhang@node-example.com')).toBe('Card remark');
  });
});
