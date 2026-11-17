import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSecureFetch } = vi.hoisted(() => ({
  mockSecureFetch: vi.fn(),
}));

vi.mock('../client-cert', () => ({
  secureFetch: mockSecureFetch,
  fetchWithoutForeignRedirect: mockSecureFetch,
}));

import {
  forgetRefreshRotations,
  HandoffError,
  refreshOAuthAccessToken,
  resetRefreshRotations,
  TransientRefreshError,
  type OAuthTokens,
} from '../oauth';

describe('oauth token refresh deduplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRefreshRotations();
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

    // A holder that still has the rotated-away token later gets its
    // successor: presenting it again would revoke the grant on Stalwart 1.0.
    mockSecureFetch.mockClear();
    const res3 = await refreshOAuthAccessToken(tokens);
    expect(mockSecureFetch).not.toHaveBeenCalled();
    expect(res3.accessToken).toBe('new-access-token');
    expect(res3.refreshToken).toBe('rotated-refresh-token');
  });

  it('refreshes again with the successor once its access token runs out, never with the old token', async () => {
    const tokens: OAuthTokens = {
      accessToken: 'a1',
      refreshToken: 'r1',
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'swc1.x',
    };
    let generation = 1;
    mockSecureFetch.mockImplementation(async () => {
      generation += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: `a${generation}`, refresh_token: `r${generation}`, expires_in: 30 }),
      } as Response;
    });

    await refreshOAuthAccessToken(tokens);
    // 30 s left on the successor: not enough to hand out, so it is renewed.
    const res = await refreshOAuthAccessToken(tokens);

    const presented = mockSecureFetch.mock.calls.map(([, init]) => new URLSearchParams(String(init.body)).get('refresh_token'));
    expect(presented).toEqual(['r1', 'r2']);
    expect(res.refreshToken).toBe('r3');
  });

  it('forgets the whole chain of a signed-out account, from any of its tokens', async () => {
    const tokens: OAuthTokens = {
      accessToken: 'a1',
      refreshToken: 'r1',
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'swc1.x',
    };
    let generation = 1;
    mockSecureFetch.mockImplementation(async () => {
      generation += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: `a${generation}`, refresh_token: `r${generation}`, expires_in: 3600 }),
      } as Response;
    });
    // Another account's chain: q1 -> r2.
    const other = await refreshOAuthAccessToken({ ...tokens, accessToken: 'b1', refreshToken: 'q1' });
    // This account's: r1 -> r3 -> r4.
    await refreshOAuthAccessToken(tokens);
    await refreshOAuthAccessToken({ ...tokens, accessToken: 'a3', refreshToken: 'r3', expiresAt: Date.now() });

    // Sign-out reads the stored bundle, which may sit anywhere in the chain.
    forgetRefreshRotations('r3');
    mockSecureFetch.mockClear();
    mockSecureFetch.mockResolvedValue({ ok: false, status: 400 } as Response);

    // A stale copy no longer gets a successor out of memory.
    await expect(refreshOAuthAccessToken(tokens)).rejects.toThrow('400');
    expect(mockSecureFetch).toHaveBeenCalledTimes(1);
    // The other account's chain stays.
    mockSecureFetch.mockClear();
    expect((await refreshOAuthAccessToken({ ...tokens, accessToken: 'b1', refreshToken: 'q1' })).accessToken).toBe(other.accessToken);
    expect(mockSecureFetch).not.toHaveBeenCalled();
  });

  it('does not bring back a chain forgotten while its refresh was in flight', async () => {
    const tokens: OAuthTokens = {
      accessToken: 'a1',
      refreshToken: 'r1',
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'bulwark-webmail',
    };
    let answer!: () => void;
    mockSecureFetch.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { answer = resolve; });
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }),
      } as Response;
    });

    const inFlight = refreshOAuthAccessToken(tokens);
    await vi.waitFor(() => expect(mockSecureFetch).toHaveBeenCalledTimes(1));
    // The account signs out before the token endpoint answers.
    forgetRefreshRotations('r1');
    answer();
    await inFlight;

    // A stale copy refreshed later doesn't get the signed-out account's
    // successor, nor one of the successor's.
    mockSecureFetch.mockResolvedValue({ ok: false, status: 400 } as Response);
    await expect(refreshOAuthAccessToken(tokens)).rejects.toThrow('400');
    await expect(refreshOAuthAccessToken({ ...tokens, accessToken: 'a2', refreshToken: 'r2' })).rejects.toThrow('400');
    expect(mockSecureFetch).toHaveBeenCalledTimes(3);
  });

  it('keeps refreshing with the same token on a server that does not rotate', async () => {
    const tokens: OAuthTokens = {
      accessToken: 'a1',
      refreshToken: 'stable',
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'bulwark-webmail',
    };
    mockSecureFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'a2', expires_in: 3600 }),
    }) as Response);

    await refreshOAuthAccessToken(tokens);
    await refreshOAuthAccessToken(tokens);

    expect(mockSecureFetch).toHaveBeenCalledTimes(2);
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

describe('oauth token refresh after a transient failure (#166)', () => {
  const tokens: OAuthTokens = {
    accessToken: 'a1',
    refreshToken: 'r1',
    expiresAt: 0,
    tokenEndpoint: 'https://auth.example.com/token',
    clientId: 'client-id-123',
  };
  const failure = (status: number, retryAfter?: string) =>
    ({ ok: false, status, headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}) }) as Response;
  const success = (refreshToken: string) =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: `access-${refreshToken}`, refresh_token: refreshToken, expires_in: 3600 }),
    }) as Response;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
    resetRefreshRotations();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not ask the token endpoint again until the wait is over, doubling it on each failure', async () => {
    mockSecureFetch.mockResolvedValue(failure(500));

    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    expect(mockSecureFetch).toHaveBeenCalledTimes(1);

    // Every caller during the wait fails at once, without a request.
    for (let i = 0; i < 20; i++) {
      await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    }
    expect(mockSecureFetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(29_000);
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    expect(mockSecureFetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    expect(mockSecureFetch).toHaveBeenCalledTimes(2);

    // Second failure in a row: 60 s.
    vi.advanceTimersByTime(59_000);
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    expect(mockSecureFetch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1_000);
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    expect(mockSecureFetch).toHaveBeenCalledTimes(3);
  });

  it('caps the wait at 30 minutes', async () => {
    mockSecureFetch.mockResolvedValue(failure(503));
    for (let i = 0; i < 10; i++) {
      await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
      vi.advanceTimersByTime(30 * 60_000);
    }
    // 30 s, 1, 2, 4, 8, 16 min, then 30 min each: every one of the 10 waits was over.
    expect(mockSecureFetch).toHaveBeenCalledTimes(10);
    // And it is the full 30 min, not less.
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    vi.advanceTimersByTime(30 * 60_000 - 1_000);
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    expect(mockSecureFetch).toHaveBeenCalledTimes(11);
  });

  it('waits as long as Retry-After asks when that is longer', async () => {
    mockSecureFetch.mockResolvedValue(failure(429, '300'));
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    vi.advanceTimersByTime(299_000);
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    expect(mockSecureFetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    mockSecureFetch.mockResolvedValue(success('r2'));
    expect((await refreshOAuthAccessToken(tokens)).accessToken).toBe('access-r2');
    expect(mockSecureFetch).toHaveBeenCalledTimes(2);
  });

  it('waits after a token endpoint answer that is not JSON', async () => {
    mockSecureFetch.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('<html>'); } } as unknown as Response);
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    expect(mockSecureFetch).toHaveBeenCalledTimes(1);
  });

  it('starts no wait when there was no answer, so the first request back online refreshes', async () => {
    mockSecureFetch.mockRejectedValue(new TypeError('Network request failed'));
    for (let i = 0; i < 5; i++) {
      await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    }
    expect(mockSecureFetch).toHaveBeenCalledTimes(5);
    mockSecureFetch.mockResolvedValue(success('r2'));
    expect((await refreshOAuthAccessToken(tokens)).accessToken).toBe('access-r2');
  });

  it('starts from 30 s again after a refresh that worked', async () => {
    mockSecureFetch.mockResolvedValue(failure(500));
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    vi.advanceTimersByTime(30_000);
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    vi.advanceTimersByTime(60_000);
    // A server that does not rotate refresh tokens hands back the same one.
    mockSecureFetch.mockResolvedValue(success('r1'));
    await refreshOAuthAccessToken(tokens);
    expect(mockSecureFetch).toHaveBeenCalledTimes(3);

    mockSecureFetch.mockResolvedValue(failure(500));
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    vi.advanceTimersByTime(30_000);
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    expect(mockSecureFetch).toHaveBeenCalledTimes(5);
  });

  it('does not hold back another refresh token, such as one from a new sign-in', async () => {
    mockSecureFetch.mockResolvedValue(failure(500));
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);
    mockSecureFetch.mockResolvedValue(success('q2'));
    expect((await refreshOAuthAccessToken({ ...tokens, refreshToken: 'q1' })).accessToken).toBe('access-q2');
    expect(mockSecureFetch).toHaveBeenCalledTimes(2);
  });

  it('still reports a refused refresh token as a dead sign-in, with no wait', async () => {
    mockSecureFetch.mockResolvedValue(failure(400));
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(HandoffError);
    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(HandoffError);
    expect(mockSecureFetch).toHaveBeenCalledTimes(2);
  });
});
