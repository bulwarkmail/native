import { describe, it, expect } from 'vitest';
import { isSenderContentTrusted, isTrustedSendersSyncOn } from '../trusted-senders';

const local = (list: string[]) => (email: string) => list.includes(email.toLowerCase());

describe('isTrustedSendersSyncOn', () => {
  it('is on unless the user opted out', () => {
    expect(isTrustedSendersSyncOn(null, true)).toBe(true);
    expect(isTrustedSendersSyncOn(undefined, true)).toBe(true);
    expect(isTrustedSendersSyncOn(true, true)).toBe(true);
    expect(isTrustedSendersSyncOn(false, true)).toBe(false);
  });

  it('is off on a server without contacts', () => {
    for (const setting of [null, true, false]) {
      expect(isTrustedSendersSyncOn(setting, false)).toBe(false);
    }
  });
});

describe('isSenderContentTrusted', () => {
  it('trusts senders on the local allow-list whatever the sync setting', () => {
    for (const syncEnabled of [false, true]) {
      expect(isSenderContentTrusted('Alice@Example.com', {
        isLocallyTrusted: local(['alice@example.com']),
        syncEnabled,
        trustedBookEmails: [],
        senderAuthenticated: true,
      })).toBe(true);
    }
  });

  it('trusts the Trusted Senders book only while sync is on', () => {
    const opts = { isLocallyTrusted: local([]), trustedBookEmails: ['bob@example.com'], senderAuthenticated: true };
    expect(isSenderContentTrusted('Bob@Example.com', { ...opts, syncEnabled: true })).toBe(true);
    expect(isSenderContentTrusted('bob@example.com', { ...opts, syncEnabled: false })).toBe(false);
  });

  it('does not trust a sender just because some other list knows them', () => {
    // An ordinary contact (e.g. in the personal book) is not in either list,
    // so a spoofed From with their address still gets remote content blocked.
    expect(isSenderContentTrusted('carol@example.com', {
      isLocallyTrusted: local(['alice@example.com']),
      syncEnabled: true,
      trustedBookEmails: ['bob@example.com'],
      senderAuthenticated: true,
    })).toBe(false);
  });

  it('never trusts a missing sender', () => {
    const opts = { isLocallyTrusted: () => true, syncEnabled: true, trustedBookEmails: [''], senderAuthenticated: true };
    expect(isSenderContentTrusted(undefined, opts)).toBe(false);
    expect(isSenderContentTrusted(null, opts)).toBe(false);
    expect(isSenderContentTrusted('  ', opts)).toBe(false);
  });

  // A trusted address is only an address: anyone can write it in From. Its
  // remote content loads only when the server's checks tie this message to
  // the From domain; with no verdict, or no results to judge by, it waits
  // for a tap like anyone else's.
  it('loads a trusted address\'s content only on a passing sender check', () => {
    const opts = { isLocallyTrusted: local(['ceo@bank.example']), syncEnabled: true, trustedBookEmails: ['ceo@bank.example'] };
    expect(isSenderContentTrusted('ceo@bank.example', { ...opts, senderAuthenticated: true })).toBe(true);
    expect(isSenderContentTrusted('ceo@bank.example', { ...opts, senderAuthenticated: false })).toBe(false);
    expect(isSenderContentTrusted('ceo@bank.example', { ...opts, senderAuthenticated: undefined })).toBe(false);
  });
});
