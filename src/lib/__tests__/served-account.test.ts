import { describe, it, expect, vi, beforeEach } from 'vitest';

// The editor and the calendar settings key the identities by the JMAP account
// id, which repeats across accounts: they read it only once the client serves
// the shown account, and re-run when it does.

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    isConnected: true,
    accountId: 'c',
    username: 'alice@a.example',
    serverUrl: 'https://a.example',
  },
}));

// The hook's stores aren't exercised here (no render harness).
vi.mock('../../stores/auth-store', () => ({ useAuthStore: vi.fn() }));
vi.mock('../../stores/email-store', () => ({ useEmailStore: vi.fn() }));

import { jmapClient } from '../../api/jmap-client';
import { useAccountStore } from '../../stores/account-store';
import { generateAccountId } from '../account-utils';
import { servedJmapAccountId } from '../served-account';

const client = jmapClient as unknown as { isConnected: boolean; username: string; serverUrl: string };
const A = generateAccountId('alice@a.example', 'https://a.example');
const B = generateAccountId('bob@b.example', 'https://b.example');
const entry = (id: string, username: string, serverUrl: string) => ({
  id, serverUrl, username, displayName: username, email: username, avatarColor: '#000000',
  lastLoginAt: 0, isConnected: true, hasError: false, isDefault: false,
});

beforeEach(() => {
  client.isConnected = true;
  client.username = 'alice@a.example';
  client.serverUrl = 'https://a.example';
  useAccountStore.setState({
    accounts: [entry(A, 'alice@a.example', 'https://a.example'), entry(B, 'bob@b.example', 'https://b.example')],
    activeAccountId: A,
  });
});

describe('servedJmapAccountId', () => {
  it('is the JMAP account while the client serves the app account', () => {
    expect(servedJmapAccountId(A)).toBe('c');
  });

  it('is empty while the client still serves the account being left', () => {
    expect(servedJmapAccountId(B)).toBe('');
  });

  it('is the new account\'s once the client serves it', () => {
    client.username = 'bob@b.example';
    client.serverUrl = 'https://b.example';
    expect(servedJmapAccountId(B)).toBe('c');
    expect(servedJmapAccountId(A)).toBe('');
  });

  it('is empty without an account or a connection', () => {
    expect(servedJmapAccountId(null)).toBe('');
    client.isConnected = false;
    expect(servedJmapAccountId(A)).toBe('');
  });
});
