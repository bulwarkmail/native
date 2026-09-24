import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as WebBrowser from 'expo-web-browser';

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    snapshot: vi.fn(() => ({ session: null, credentials: null, accountId: null })),
    restoreSnapshot: vi.fn(),
    onAuthFailure: vi.fn(() => () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
  },
  AuthenticationError: class AuthenticationError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
}));

vi.mock('../../lib/oauth-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/oauth-native')>()),
  discoverOAuthMetadata: vi.fn(),
  loginWithPkce: vi.fn(),
  probeWebmail: vi.fn(),
}));

import { discoverOAuthMetadata, loginWithPkce, probeWebmail } from '../../lib/oauth-native';
import { HandoffCancelledError } from '../../lib/oauth';
import { useAuthStore } from '../auth-store';

const metadata = {
  authorization_endpoint: 'https://mail.example.com/authorize/code',
  token_endpoint: 'https://mail.example.com/auth/token',
};

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, error: null });
  (discoverOAuthMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(metadata);
  (loginWithPkce as ReturnType<typeof vi.fn>).mockRejectedValue(new HandoffCancelledError());
  (probeWebmail as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

describe('adding another OAuth account', () => {
  it('tells the PKCE flow it is adding an account', async () => {
    await useAuthStore.getState().loginViaOAuth('https://mail.example.com/', { addAccount: true });

    expect(loginWithPkce).toHaveBeenCalledWith('https://mail.example.com', metadata, { addAccount: true });
  });

  it('does not ask for another account on a first sign-in', async () => {
    await useAuthStore.getState().loginViaOAuth('https://mail.example.com');

    expect(loginWithPkce).toHaveBeenCalledWith('https://mail.example.com', metadata, { addAccount: undefined });
  });

  it('opens the webmail hand-off in a private browser session', async () => {
    await useAuthStore.getState().loginViaWebmail('https://mail.example.com', { addAccount: true });

    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
      expect.stringContaining('https://mail.example.com/login?'),
      'bulwarkmobile://auth/callback',
      { preferEphemeralSession: true },
    );
  });

  it('keeps the shared browser session for a first webmail sign-in', async () => {
    await useAuthStore.getState().loginViaWebmail('https://mail.example.com');

    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
      expect.stringContaining('https://mail.example.com/login?'),
      'bulwarkmobile://auth/callback',
      undefined,
    );
  });
});
