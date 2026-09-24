import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as WebBrowser from 'expo-web-browser';

vi.mock('../client-cert', () => ({
  secureFetch: vi.fn(),
}));

import { loginWithPkce, type OAuthMetadata } from '../oauth-native';
import { HandoffCancelledError } from '../oauth';

const mockOpenAuthSession = WebBrowser.openAuthSessionAsync as ReturnType<typeof vi.fn>;

const metadata: OAuthMetadata = {
  authorization_endpoint: 'https://mail.example.com/authorize/code',
  token_endpoint: 'https://mail.example.com/auth/token',
};

// The browser mock answers every session with `cancel`, so the flow stops
// right after opening the authorization URL - which is all these tests need.
async function openedSession(meta: OAuthMetadata, addAccount?: boolean) {
  await expect(loginWithPkce('https://mail.example.com', meta, { addAccount })).rejects.toBeInstanceOf(
    HandoffCancelledError,
  );
  expect(mockOpenAuthSession).toHaveBeenCalledTimes(1);
  const [authUrl, redirectUri, options] = mockOpenAuthSession.mock.calls[0];
  return { params: new URL(authUrl as string).searchParams, redirectUri, options };
}

describe('loginWithPkce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses the browser session and sends no prompt for the first sign-in', async () => {
    const { params, redirectUri, options } = await openedSession(metadata);

    expect(params.get('prompt')).toBeNull();
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(redirectUri).toBe('bulwarkmobile://auth/callback');
    expect(options).toBeUndefined();
  });

  it('asks for the account picker in a private session when adding an account', async () => {
    const { params, options } = await openedSession(metadata, true);

    expect(params.get('prompt')).toBe('select_account');
    expect(options).toEqual({ preferEphemeralSession: true });
  });

  it('asks for a fresh login when the server advertises no account picker', async () => {
    const keycloak = { ...metadata, prompt_values_supported: ['none', 'login', 'consent'] };
    const { params } = await openedSession(keycloak, true);

    expect(params.get('prompt')).toBe('login');
  });

  it('keeps the account picker when the server advertises it', async () => {
    const picker = { ...metadata, prompt_values_supported: ['none', 'login', 'select_account'] };
    const { params } = await openedSession(picker, true);

    expect(params.get('prompt')).toBe('select_account');
  });
});
