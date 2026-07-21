import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSecureFetch } = vi.hoisted(() => ({
  mockSecureFetch: vi.fn(),
}));

vi.mock('../client-cert', () => ({
  secureFetch: mockSecureFetch,
}));

import { refreshOAuthAccessToken, type OAuthTokens } from '../oauth';

describe('oauth token refresh deduplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should only send a single HTTP request when refreshOAuthAccessToken is called concurrently with the same refresh token', async () => {
    const tokens: OAuthTokens = {
      accessToken: 'old-access',
      refreshToken: 'same-refresh-token',
      expiresAt: 123456,
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-id-123',
    };

    // Set up a mock response that takes a brief moment to resolve
    mockSecureFetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'rotated-refresh-token',
          expires_in: 3600,
        }),
      } as Response;
    });

    // Fire two refreshes concurrently
    const [res1, res2] = await Promise.all([
      refreshOAuthAccessToken(tokens),
      refreshOAuthAccessToken(tokens),
    ]);

    // Check that secureFetch was called exactly once
    expect(mockSecureFetch).toHaveBeenCalledTimes(1);

    // Verify both calls received the exact same updated token bundle
    expect(res1.accessToken).toBe('new-access-token');
    expect(res1.refreshToken).toBe('rotated-refresh-token');
    expect(res2.accessToken).toBe('new-access-token');
    expect(res2.refreshToken).toBe('rotated-refresh-token');

    // Fire another refresh after the first completes (now the map should be empty for this token)
    mockSecureFetch.mockClear();
    const res3 = await refreshOAuthAccessToken(tokens);
    expect(mockSecureFetch).toHaveBeenCalledTimes(1);
    expect(res3.accessToken).toBe('new-access-token');
  });

  it('should propagate errors to all waiters if the HTTP request fails', async () => {
    const tokens: OAuthTokens = {
      accessToken: 'old-access',
      refreshToken: 'failing-refresh-token',
      expiresAt: 123456,
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-id-123',
    };

    mockSecureFetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        ok: false,
        status: 400,
      } as Response;
    });

    // Fire two refreshes concurrently and check that both reject with the same error
    const promise1 = refreshOAuthAccessToken(tokens);
    const promise2 = refreshOAuthAccessToken(tokens);

    await expect(promise1).rejects.toThrow('Token refresh failed: 400');
    await expect(promise2).rejects.toThrow('Token refresh failed: 400');

    expect(mockSecureFetch).toHaveBeenCalledTimes(1);
  });
});
