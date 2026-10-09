import { describe, it, expect, vi, beforeEach } from 'vitest';

// A share from a new owner refreshes the session so its collections can be
// fetched. The fresh session is only ever applied to the account it was
// asked for: a switch or a client serving another account changes nothing.

const client = vi.hoisted(() => ({
  username: 'user@example.com' as string | null,
  serverUrl: 'https://mail.example.com' as string | null,
  session: { apiUrl: 'https://mail.example.com/jmap/', accounts: { 'acc-1': {} } } as Record<string, unknown>,
  refreshSession: vi.fn(),
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connect: vi.fn(async () => client.session),
    snapshot: vi.fn(() => ({ session: null, credentials: null, accountId: null })),
    restoreSnapshot: vi.fn(),
    onAuthFailure: vi.fn(() => () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
    hasAccountCapability: vi.fn(() => true),
    getAccountName: () => undefined,
    getSharedMailAccounts: () => [],
    request: vi.fn(async () => { throw new Error('offline'); }),
    refreshSession: client.refreshSession,
    accountId: 'acc-1',
    connectedAccountId: 'acc-1',
    isConnected: true,
    get currentSession() { return client.session; },
    get username() { return client.username; },
    get serverUrl() { return client.serverUrl; },
  },
  AuthenticationError: class AuthenticationError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
  clearStoredRelayBaseUrl: vi.fn(async () => undefined),
}));

vi.mock('../../lib/push-inbox-only', async () => ({
  gainedMailAccounts: (await vi.importActual<typeof import('../../lib/push-inbox-only')>('../../lib/push-inbox-only')).gainedMailAccounts,
  resyncPushAfterSessionChange: vi.fn(async () => undefined),
}));

import { useAuthStore } from '../auth-store';
import { resyncPushAfterSessionChange } from '../../lib/push-inbox-only';

const ID = 'user@example.com@mail.example.com';
const shared = { apiUrl: 'https://mail.example.com/jmap/', accounts: { 'acc-1': {}, dana: {} } };
const ACTIVE = ID;
const MAIL = { 'urn:ietf:params:jmap:mail': {} };
const own = { apiUrl: 'https://mail.example.com/jmap/', accounts: { 'acc-1': { accountCapabilities: MAIL } } };
const sharedMail = { apiUrl: 'https://mail.example.com/jmap/', accounts: { 'acc-1': { accountCapabilities: MAIL }, dana: { accountCapabilities: MAIL } } };

beforeEach(async () => {
  client.username = 'user@example.com';
  client.serverUrl = 'https://mail.example.com';
  client.session = { apiUrl: 'https://mail.example.com/jmap/', accounts: { 'acc-1': {} } };
  client.refreshSession.mockReset();
  vi.mocked(resyncPushAfterSessionChange).mockClear();
  await useAuthStore.getState().login('https://mail.example.com', 'user@example.com', 'pass');
});

describe('refreshSessionFor', () => {
  it('sets the fresh session for the active account the client serves', async () => {
    client.refreshSession.mockImplementation(async () => { client.session = shared; return shared; });
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(true);
    expect(useAuthStore.getState().session).toBe(shared);
  });

  it('changes nothing when the account was switched away mid-fetch', async () => {
    const before = useAuthStore.getState().session;
    client.refreshSession.mockImplementation(async () => {
      useAuthStore.setState({ activeAccountId: 'other@example.com@mail.example.com' });
      client.session = shared;
      return shared;
    });
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(false);
    expect(useAuthStore.getState().session).toBe(before);
  });

  it('never fetches while the client serves another account, or for an account not active', async () => {
    expect(await useAuthStore.getState().refreshSessionFor('other@example.com@mail.example.com')).toBe(false);
    client.username = 'other@example.com';
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(false);
    expect(client.refreshSession).not.toHaveBeenCalled();
  });

  it('keeps the live session when the fetch fails or is overtaken', async () => {
    const before = useAuthStore.getState().session;
    client.refreshSession.mockImplementation(async () => { throw new Error('offline'); });
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(false);
    client.refreshSession.mockImplementation(async () => null);
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(false);
    expect(useAuthStore.getState().session).toBe(before);
  });

  it('changes nothing when the client holds another session by the time the fetch lands', async () => {
    const before = useAuthStore.getState().session;
    // The client swapped in something else after this refresh resolved.
    client.refreshSession.mockImplementation(async () => shared);
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(false);
    expect(useAuthStore.getState().session).toBe(before);
  });

  it('resyncs push once when the refreshed session names a new mail account', async () => {
    useAuthStore.setState({ session: own as never });
    client.refreshSession.mockImplementation(async () => { client.session = sharedMail; return sharedMail; });
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(true);
    expect(resyncPushAfterSessionChange).toHaveBeenCalledTimes(1);
    expect(resyncPushAfterSessionChange).toHaveBeenCalledWith(ACTIVE);
  });

  it('does not resync push when the refreshed session has the same accounts, or the refresh was overtaken', async () => {
    useAuthStore.setState({ session: own as never });
    const same = { ...own, accounts: { ...own.accounts } };
    client.refreshSession.mockImplementation(async () => { client.session = same; return same; });
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(true);
    // A non-mail share (calendars only) is no new mail account either.
    const calendarShare = { ...own, accounts: { ...own.accounts, cal: { accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } } } };
    client.refreshSession.mockImplementation(async () => { client.session = calendarShare; return calendarShare; });
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(true);
    // Overtaken by a switch: the new mail account never reaches this store.
    client.refreshSession.mockImplementation(async () => {
      useAuthStore.setState({ activeAccountId: 'other@example.com@mail.example.com' });
      client.session = sharedMail;
      return sharedMail;
    });
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(false);
    // Overtaken by the client swapping its session.
    useAuthStore.setState({ activeAccountId: ID, session: own as never });
    client.session = own;
    client.refreshSession.mockImplementation(async () => sharedMail);
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(false);
    expect(resyncPushAfterSessionChange).not.toHaveBeenCalled();
  });

  it('waits out a sign-in or switch in progress, before and after the fetch', async () => {
    const before = useAuthStore.getState().session;
    useAuthStore.setState({ isLoading: true });
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(false);
    expect(client.refreshSession).not.toHaveBeenCalled();

    useAuthStore.setState({ isLoading: false });
    client.refreshSession.mockImplementation(async () => {
      useAuthStore.setState({ isLoading: true });
      client.session = shared;
      return shared;
    });
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(false);
    expect(useAuthStore.getState().session).toBe(before);
    useAuthStore.setState({ isLoading: false });
  });
});
