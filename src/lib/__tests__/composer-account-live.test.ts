import { describe, it, expect, vi } from 'vitest';

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    onAuthFailure: vi.fn(() => () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
    accountId: 'jmap-a',
    isConnected: false,
  },
  AuthenticationError: class AuthenticationError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));

vi.mock('../push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
}));

import { useAuthStore } from '../../stores/auth-store';
import { useEmailStore } from '../../stores/email-store';
import { liveComposerOwnerCheck } from '../composer-account';

describe('liveComposerOwnerCheck', () => {
  const owner = { appAccountId: 'app-a', jmapAccountId: 'jmap-a' };

  it('reflects an account switch made after it was created', () => {
    useAuthStore.setState({ activeAccountId: 'app-a' });
    useEmailStore.setState({ activeAccountId: 'app-a' });
    const ownerActiveNow = liveComposerOwnerCheck(owner, { auth: useAuthStore, view: useEmailStore });
    expect(ownerActiveNow()).toBe(true);

    // The email store swaps its view first, before the client has switched.
    useEmailStore.setState({ activeAccountId: 'app-b' });
    expect(ownerActiveNow()).toBe(false);

    useAuthStore.setState({ activeAccountId: 'app-b' });
    expect(ownerActiveNow()).toBe(false);

    useAuthStore.setState({ activeAccountId: 'app-a' });
    useEmailStore.setState({ activeAccountId: 'app-a' });
    expect(ownerActiveNow()).toBe(true);
  });
});
