import { afterEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ id: null as string | null }));
vi.mock('../../../api/jmap-client', () => ({
  jmapClient: {
    get accountId(): string {
      if (!client.id) throw new Error('Not authenticated - call connect() first');
      return client.id;
    },
    get connectedAccountId(): string | null {
      return client.id;
    },
  },
}));
vi.mock('../../../api/archived-items', () => ({
  advertisesArchivedItems: vi.fn(() => true),
  queryArchivedItemIds: vi.fn(async () => ({ ids: [], total: 0 })),
  hasArchivedEmail: vi.fn(async () => false),
}));
const auth = vi.hoisted(() => ({ state: { session: {} as unknown, activeAccountId: 'a@host' } }));
vi.mock('../../../stores/auth-store', () => ({
  useAuthStore: (selector: (s: typeof auth.state) => unknown) => selector(auth.state),
}));

import { renderHook } from '../../../components/email/structured-mail/__tests__/render-native';
import { useDeletedItemsRecovery } from '../use-deleted-items-recovery';

afterEach(() => {
  client.id = null;
});

describe('useDeletedItemsRecovery', () => {
  it('renders without a connected client while an account switch reconnects', () => {
    // The auth store still holds a session (the account being left, or the
    // target one restored), but the client has no account id yet.
    client.id = null;
    const hook = renderHook(() => useDeletedItemsRecovery());
    expect(hook.current).toEqual({ available: false, accountId: null, key: null });
  });

  it('names the connected account once the client is in', () => {
    client.id = 'u1';
    const hook = renderHook(() => useDeletedItemsRecovery());
    expect(hook.current.accountId).toBe('u1');
    expect(hook.current.key).not.toBeNull();
  });
});
