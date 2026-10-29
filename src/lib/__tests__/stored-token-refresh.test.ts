import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSecureFetch, store } = vi.hoisted(() => ({
  mockSecureFetch: vi.fn(),
  store: new Map<string, unknown>(),
}));

vi.mock('../client-cert', () => ({ secureFetch: mockSecureFetch }));
vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    getStoredCredentials: vi.fn(async (id: string) => (store.has(id) ? structuredClone(store.get(id)) : null)),
    setStoredCredentials: vi.fn(async (id: string, creds: unknown) => { store.set(id, structuredClone(creds)); }),
  },
}));

import { jmapClient, type StoredCredentials } from '../../api/jmap-client';
import { resetRefreshRotations } from '../oauth';
import { freshStoredCredentials } from '../stored-token-refresh';

const ID = 'u@example.org@https://mail.example.com';

function bundle(generation: number, expiresAt = Date.now() + 5_000): StoredCredentials {
  return {
    serverUrl: 'https://mail.example.com',
    username: 'u@example.org',
    password: '',
    accessToken: `a${generation}`,
    refreshToken: `r${generation}`,
    expiresAt,
    tokenEndpoint: 'https://mail.example.com/auth/token',
    clientId: 'swc1.x',
    tokenSource: 'totp',
  };
}

// A token endpoint that rotates: r<n> buys a<n+1>/r<n+1>, once.
function rotatingServer() {
  const spent = new Set<string>();
  mockSecureFetch.mockImplementation(async (_url: string, init: RequestInit) => {
    const presented = new URLSearchParams(String(init.body)).get('refresh_token')!;
    if (spent.has(presented)) return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) } as Response;
    spent.add(presented);
    const n = Number(presented.slice(1)) + 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 3600 }),
    } as Response;
  });
}

const presented = () => mockSecureFetch.mock.calls.map(([, init]) => new URLSearchParams(String(init.body)).get('refresh_token'));

describe('freshStoredCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    resetRefreshRotations();
    rotatingServer();
  });

  it('refreshes an expiring bundle and stores the successor', async () => {
    store.set(ID, bundle(1));
    const next = await freshStoredCredentials(ID, bundle(1));

    expect(next.accessToken).toBe('a2');
    expect((store.get(ID) as StoredCredentials).refreshToken).toBe('r2');
  });

  it('takes the newer stored bundle instead of spending a replaced refresh token', async () => {
    // The live client refreshed meanwhile and stored r2.
    store.set(ID, bundle(2, Date.now() + 3_600_000));
    const next = await freshStoredCredentials(ID, bundle(1));

    expect(next.accessToken).toBe('a2');
    expect(mockSecureFetch).not.toHaveBeenCalled();
  });

  it('shares one refresh with a holder refreshing at the same moment', async () => {
    store.set(ID, bundle(1));
    const [a, b] = await Promise.all([freshStoredCredentials(ID, bundle(1)), freshStoredCredentials(ID, bundle(1))]);

    expect(presented()).toEqual(['r1']);
    expect(a.accessToken).toBe('a2');
    expect(b.accessToken).toBe('a2');
  });

  it('writes nothing back for an account that signed out', async () => {
    // A copy taken before the sign-out; the live client had rotated r1 -> r2,
    // which the rotation memory still knows.
    store.set(ID, bundle(1));
    await freshStoredCredentials(ID, bundle(1));
    store.delete(ID);
    vi.mocked(jmapClient.setStoredCredentials).mockClear();

    await freshStoredCredentials(ID, bundle(1));

    expect(store.has(ID)).toBe(false);
    expect(jmapClient.setStoredCredentials).not.toHaveBeenCalled();
  });

  it('does not overwrite a newer bundle stored while the refresh ran', async () => {
    store.set(ID, bundle(1));
    // The iOS notification extension rotates the grant meanwhile (it can't
    // share this process's memory) and stores its own bundle.
    const newer = { ...bundle(7, Date.now() + 3_600_000) };
    mockSecureFetch.mockImplementationOnce(async () => {
      store.set(ID, newer);
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }),
      } as Response;
    });

    await freshStoredCredentials(ID, bundle(1));

    expect((store.get(ID) as StoredCredentials).refreshToken).toBe('r7');
  });

  it('leaves password credentials alone', async () => {
    const basic: StoredCredentials = { serverUrl: 'https://mail.example.com', username: 'u', password: 'pw' };
    expect(await freshStoredCredentials(ID, basic)).toBe(basic);
    expect(jmapClient.getStoredCredentials).not.toHaveBeenCalled();
  });
});
