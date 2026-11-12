import { describe, it, expect } from 'vitest';
import { defaultSenderIdentity, emailMatchesLogin, sortIdentities } from '../identity-order';
import type { Identity } from '../../api/types';

// Port of the webmail's lib/__tests__/identity-order.test.ts.
const identity = (id: string, email: string, mayDelete = false): Identity => ({ id, name: id, email, mayDelete });

describe('sortIdentities', () => {
  // Seen on live 1.0 and 1.1 servers: for a member of team@example.org,
  // Identity/get lists the group's identity first (both deletable on 1.1).
  it("puts the login's own identity ahead of the group's on Stalwart 1.x, whatever the login's case", () => {
    const fromServer = [identity('team', 'team@example.org', true), identity('usera', 'usera@example.org', true)];

    expect(sortIdentities(fromServer, 'UserA@Example.ORG').map((i) => i.id)).toEqual(['usera', 'team']);
    expect(sortIdentities(fromServer, 'usera@example.org').map((i) => i.id)).toEqual(['usera', 'team']);
    // The server's list is left as it was.
    expect(fromServer.map((i) => i.id)).toEqual(['team', 'usera']);
  });

  it('keeps the order Stalwart 0.16 sends, which already has the own identity first', () => {
    const fromServer = [identity('usera', 'usera@example.org'), identity('team', 'team@example.org')];
    expect(sortIdentities(fromServer, 'USERA@example.org').map((i) => i.id)).toEqual(['usera', 'team']);
  });

  it('prefers the canonical identity over an alias of the same address', () => {
    const fromServer = [identity('alias', 'UserA@example.org', true), identity('canonical', 'usera@example.org')];
    expect(sortIdentities(fromServer, 'usera@example.org').map((i) => i.id)).toEqual(['canonical', 'alias']);
  });

  it('leaves the rest in server order', () => {
    const fromServer = [identity('b', 'b@example.org'), identity('me', 'me@example.org'), identity('a', 'a@example.org')];
    expect(sortIdentities(fromServer, 'me@example.org').map((i) => i.id)).toEqual(['me', 'b', 'a']);
  });
});

describe('emailMatchesLogin', () => {
  it('ignores case in the local part and the domain', () => {
    expect(emailMatchesLogin('usera@example.org', 'UserA@EXAMPLE.org')).toBe(true);
    expect(emailMatchesLogin('usera@example.org', 'userb@example.org')).toBe(false);
  });

  it('matches a bare login name against the local part', () => {
    expect(emailMatchesLogin('usera@example.org', 'UserA')).toBe(true);
    expect(emailMatchesLogin('team@example.org', 'usera')).toBe(false);
  });

  it('matches an internationalized domain in either form', () => {
    // Stalwart stores the ASCII form; the login may have been typed in Unicode.
    expect(emailMatchesLogin('anna@xn--bcher-kva.de', 'Anna@Bücher.de')).toBe(true);
    expect(emailMatchesLogin('anna@bücher.de', 'anna@xn--bcher-kva.de')).toBe(true);
    expect(emailMatchesLogin('anna@xn--bcher-kva.de', 'anna@bucher.de')).toBe(false);
  });
});

describe('defaultSenderIdentity', () => {
  const fromServer = [identity('team', 'team@example.org', true), identity('usera', 'usera@example.org', true)];

  it("picks the login's own identity for a new message, though the group's comes first", () => {
    expect(defaultSenderIdentity(fromServer, 'usera@example.org')?.id).toBe('usera');
    expect(defaultSenderIdentity(fromServer, 'usera')?.id).toBe('usera');
  });

  it('picks the "Use as default" identity over the own one', () => {
    expect(defaultSenderIdentity(fromServer, 'usera@example.org', 'team')?.id).toBe('team');
  });

  it("falls back to the first that can't be deleted, then the first", () => {
    expect(defaultSenderIdentity([identity('a', 'a@example.org', true), identity('b', 'b@example.org')], 'x@example.org')?.id).toBe('b');
    expect(defaultSenderIdentity(fromServer, null)?.id).toBe('team');
    expect(defaultSenderIdentity([], 'usera@example.org')).toBeUndefined();
  });
});
