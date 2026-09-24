import { describe, it, expect, vi } from 'vitest';

// What a sign-in sends (PF6, PF7): the display-name sync read the Stalwart
// principal with x:Account/get, which is refused to everyone but admins (the
// full name lives in x:AccountSettings, which every user reads), and the
// folder list only started loading once the mail screen had mounted.

const request = vi.fn(async (calls: Array<[string, Record<string, unknown>, string]>) => ({
  methodResponses: calls.map(([name, , id]) => {
    if (name === 'Identity/get') return [name, { list: [{ id: 'i1', name: 'Old Name', email: 'user@example.com' }] }, id];
    if (name === 'x:AccountSettings/get') return [name, { list: [{ description: 'Ada Lovelace' }] }, id];
    if (name === 'Mailbox/get') return [name, { list: [{ id: 'mb-in', name: 'Inbox', role: 'inbox' }], state: 'mbs-1' }, id];
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
    getAccountName: () => undefined,
    getSharedMailAccounts: () => [],
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
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';

describe('display name sync on sign-in', () => {
  it('reads the full name without asking for the principal', async () => {
    await useAuthStore.getState().login('https://mail.example.com', 'user@example.com', 'pass');

    await vi.waitFor(() => {
      expect(useAccountStore.getState().getActiveAccount()?.displayName).toBe('Ada Lovelace');
    });
    const methods = request.mock.calls.flatMap(([calls]) => calls.map(([name]) => name));
    expect(methods).toContain('x:AccountSettings/get');
    expect(methods).not.toContain('x:Account/get');

    // The first message open reuses the identities this read.
    await useSettingsStore.getState().ensureIdentities();
    const identityGets = request.mock.calls.filter(([calls]) => calls.some(([name]) => name === 'Identity/get'));
    expect(identityGets).toHaveLength(1);
    expect(useSettingsStore.getState().identities.map((i) => i.id)).toEqual(['i1']);
  });

  it('starts on the folder list at once, and the mail screen joins that load', async () => {
    request.mockClear();
    useEmailStore.getState().clearAllAccounts();
    await useAuthStore.getState().login('https://mail.example.com', 'user@example.com', 'pass');
    const mailboxGets = () => request.mock.calls.filter(([calls]) => calls.some(([name]) => name.startsWith('Mailbox/')));
    expect(mailboxGets()).toHaveLength(1);

    // The mail screen mounts while that load is still on its way.
    await useEmailStore.getState().ensureMailboxes();
    expect(mailboxGets()).toHaveLength(1);
    expect(useEmailStore.getState().mailboxes.map((m) => m.id)).toEqual(['mb-in']);
    await useEmailStore.getState().ensureMailboxes();
    expect(mailboxGets()).toHaveLength(1);
  });
});
