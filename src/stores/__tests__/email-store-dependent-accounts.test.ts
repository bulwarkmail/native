import { describe, it, expect, vi, beforeEach } from 'vitest';

// The usual cold start: the persisted email state already names the account
// restoreSession points at, so setActiveAccount has no view to swap. The
// outbox and the offline cache are not persisted that way and start on no
// account; they must still be pointed at it, or every move, flag and delete
// is dropped ("enqueue with no active account") and the offline cache reads
// nothing.

const outbox = vi.hoisted(() => ({ activeAccountId: null as string | null }));
const offline = vi.hoisted(() => ({ activeAccountId: null as string | null }));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { isConnected: false, connectedAccountId: null, username: '', serverUrl: '', currentSession: null },
}));
vi.mock('../locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
  useLocaleStore: { getState: () => ({ locale: 'en', t: (_k: string, f?: string) => f ?? _k }) },
}));
vi.mock('../outbox-store', () => ({
  useOutboxStore: {
    getState: () => ({
      activeAccountId: outbox.activeAccountId,
      setAccount: vi.fn(async (id: string | null) => { outbox.activeAccountId = id; }),
      flush: vi.fn(async () => undefined),
    }),
  },
}));
vi.mock('../settings-store', () => ({ useSettingsStore: { getState: () => ({ restoreLastFolder: false }) } }));
vi.mock('../offline-cache-store', () => ({
  useOfflineCacheStore: {
    getState: () => ({
      activeAccountId: offline.activeAccountId,
      hydrated: true,
      hydrate: vi.fn(),
      setAccount: vi.fn(async (id: string | null) => { offline.activeAccountId = id; }),
      totalCount: () => 0,
    }),
  },
}));

import { useEmailStore } from '../email-store';

beforeEach(() => {
  outbox.activeAccountId = null;
  offline.activeAccountId = null;
  useEmailStore.getState().reset();
});

describe('a cold start on the account the persisted state already names', () => {
  it('points the outbox and the offline cache at it', () => {
    useEmailStore.setState({ activeAccountId: 'A' });
    useEmailStore.getState().setActiveAccount('A');
    expect(outbox.activeAccountId).toBe('A');
    expect(offline.activeAccountId).toBe('A');
  });

  it('leaves them alone when they already serve it', () => {
    outbox.activeAccountId = 'A';
    offline.activeAccountId = 'A';
    useEmailStore.setState({ activeAccountId: 'A' });
    useEmailStore.getState().setActiveAccount('A');
    expect(outbox.activeAccountId).toBe('A');
    expect(offline.activeAccountId).toBe('A');
  });
});
