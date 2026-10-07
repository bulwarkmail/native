import { describe, it, expect, vi } from 'vitest';

// A cold start (the app opened from a notification) draws the rows saved from
// the last session before the client has connected. Rows stamped with their
// account ask which account they belong to while they render (attachment
// chips, search highlights); that must not throw, or the app dies.

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    isConnected: false,
    connectedAccountId: null,
    get accountId(): string {
      throw new Error('Not authenticated - call connect() first');
    },
    username: null,
    serverUrl: null,
    currentSession: null,
  },
}));

vi.mock('../../api/unified-inbox', () => ({ invalidateUnifiedMailboxes: vi.fn() }));

vi.mock('../locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
  useLocaleStore: { getState: () => ({ locale: 'en', t: (_k: string, f?: string) => f ?? _k }) },
}));

import { accountIdOfRow, snippetForRow } from '../email-store';
import type { Email } from '../../api/types';

const row = { id: 'm1', jmapAccountId: 'team', mailboxIds: { 'in': true } } as unknown as Email;

describe('rows drawn before the client connects', () => {
  it('names a stamped row\'s account without throwing', () => {
    expect(() => accountIdOfRow(row)).not.toThrow();
    expect(accountIdOfRow(row)).toBe('team');
  });

  it('looks up a row\'s highlights without throwing', () => {
    expect(() => snippetForRow({}, row)).not.toThrow();
    expect(snippetForRow({}, { ...row, jmapAccountId: undefined } as Email)).toBeUndefined();
  });
});
