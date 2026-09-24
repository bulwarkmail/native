import { describe, it, expect, vi } from 'vitest';

// The display-name sync on every sign-in and start read the Stalwart
// principal with x:Account/get, which is refused to everyone but admins
// (PF6). The full name lives in x:AccountSettings, which every user reads.

const request = vi.fn(async (calls: Array<[string, Record<string, unknown>, string]>) => ({
  methodResponses: calls.map(([name, , id]) => {
    if (name === 'Identity/get') return [name, { list: [{ id: 'i1', name: 'Old Name', email: 'user@example.com' }] }, id];
    if (name === 'x:AccountSettings/get') return [name, { list: [{ description: 'Ada Lovelace' }] }, id];
    return ['error', { type: 'forbidden' }, id];
  }),
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connect: vi.fn(async () => ({ apiUrl: 'https://mail.example.com/jmap/' })),
    snapshot: vi.fn(() => ({ session: null, credentials: null, accountId: null })),
    restoreSnapshot: vi.fn(),
    onAuthFailure: vi.fn(() => () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
    hasAccountCapability: vi.fn(() => true),
    request: (calls: Array<[string, Record<string, unknown>, string]>) => request(calls),
    accountId: 'acc-1',
    isConnected: true,
    currentSession: { apiUrl: 'https://mail.example.com/jmap/' },
    username: 'user@example.com',
    serverUrl: 'https://mail.example.com',
  },
  AuthenticationError: class AuthenticationError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
}));

import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';

describe('display name sync on sign-in', () => {
  it('reads the full name without asking for the principal', async () => {
    await useAuthStore.getState().login('https://mail.example.com', 'user@example.com', 'pass');

    await vi.waitFor(() => {
      expect(useAccountStore.getState().getActiveAccount()?.displayName).toBe('Ada Lovelace');
    });
    const methods = request.mock.calls.flatMap(([calls]) => calls.map(([name]) => name));
    expect(methods).toContain('x:AccountSettings/get');
    expect(methods).not.toContain('x:Account/get');
  });
});
