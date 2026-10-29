import { describe, it, expect } from 'vitest';
import { composerLoginMoved, servedLoginOf } from '../draft-login';
import { generateAccountId } from '../account-utils';

// Real formats: the registry names logins `username@host`, the session names
// JMAP accounts with short ids that never equal a registry id.
const A = generateAccountId('usera@example.org', 'https://mail.example.org');
const B = generateAccountId('userb@example.org', 'https://other.example.net');
const client = (username: string, serverUrl: string, isConnected = true) => ({ username, serverUrl, isConnected });

describe('servedLoginOf', () => {
  it('names the login a client serves by its registry id, not its JMAP account id', () => {
    expect(servedLoginOf(client('usera@example.org', 'https://mail.example.org'))).toBe(A);
    expect(servedLoginOf(client('usera@example.org', 'https://mail.example.org', false))).toBeNull();
  });
});

describe('composerLoginMoved', () => {
  it('stays put while the login the composer opened in is active', () => {
    expect(composerLoginMoved(A, { activeAccountId: A, servedLogin: servedLoginOf(client('usera@example.org', 'https://mail.example.org')) })).toBe(false);
    // Offline cold start: the client is not connected yet.
    expect(composerLoginMoved(A, { activeAccountId: A, servedLogin: null })).toBe(false);
  });

  it('moves once another login is active or the client serves another one', () => {
    expect(composerLoginMoved(A, { activeAccountId: B, servedLogin: B })).toBe(true);
    // Mid-switch: the registry still names A, the client already serves B.
    expect(composerLoginMoved(A, { activeAccountId: A, servedLogin: servedLoginOf(client('userb@example.org', 'https://other.example.net')) })).toBe(true);
  });

  it('never blocks a composer opened without a login', () => {
    expect(composerLoginMoved(null, { activeAccountId: B, servedLogin: B })).toBe(false);
  });
});
