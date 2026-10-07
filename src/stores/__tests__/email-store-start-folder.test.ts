import { describe, it, expect, vi, beforeEach } from 'vitest';

// A cold start opens the Inbox of the active account; with "reopen the last
// folder" on it opens the folder remembered for that account, if it is still
// there. Stalwart ids repeat across accounts, so the remembered folder is the
// one in the account's own snapshot, never one looked up by id alone.

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { isConnected: false, accountId: null, username: '', serverUrl: '', currentSession: null },
}));
vi.mock('../locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
  useLocaleStore: { getState: () => ({ locale: 'en', t: (_k: string, f?: string) => f ?? _k }) },
}));
vi.mock('../outbox-store', () => ({
  useOutboxStore: { getState: () => ({ setAccount: vi.fn(async () => undefined), flush: vi.fn(async () => undefined) }) },
}));
vi.mock('../settings-store', () => ({ useSettingsStore: { getState: () => ({}) } }));
vi.mock('../offline-cache-store', () => ({
  useOfflineCacheStore: { getState: () => ({ hydrated: true, hydrate: vi.fn(), setAccount: vi.fn(async () => undefined), totalCount: () => 0 }) },
}));

import { useEmailStore, type AccountSnapshot } from '../email-store';
import type { Email, Mailbox } from '../../api/types';

const mb = (id: string, role: string | null): Mailbox => ({
  id, name: role ?? id, role, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
  myRights: {} as Mailbox['myRights'], isShared: false,
});
const row = (id: string) => ({ id } as Email);

// Same folder ids in both accounts: 'm1' is the Inbox of A and Sent of B.
function snapshot(mailboxes: Mailbox[], current: string | null): AccountSnapshot {
  return {
    mailboxes, emailStates: {}, currentMailboxId: current,
    mailboxSnapshots: {
      m1: { emails: [row('in-1')], total: 1 },
      m2: { emails: [row('other-1')], total: 1 },
    },
  };
}

beforeEach(() => {
  useEmailStore.getState().reset();
  useEmailStore.setState({ accountSnapshots: {}, activeAccountId: null });
});

function start(accountId: string, snaps: Record<string, AccountSnapshot>) {
  useEmailStore.setState({ accountSnapshots: snaps, activeAccountId: null });
  useEmailStore.getState().setActiveAccount(accountId);
}

describe('opening folder on start', () => {
  const a = snapshot([mb('m1', 'inbox'), mb('m2', 'sent')], 'm2');

  it('opens the Inbox, not the last folder, by default', () => {
    start('A', { A: a });
    useEmailStore.getState().openStartFolder(false);
    const s = useEmailStore.getState();
    expect(s.currentMailboxId).toBe('m1');
    expect(s.emails.map((e) => e.id)).toEqual(['in-1']);
    expect(s.totalEmails).toBe(1);
  });

  it('reopens the remembered folder when asked to', () => {
    start('A', { A: a });
    useEmailStore.getState().openStartFolder(true);
    expect(useEmailStore.getState().currentMailboxId).toBe('m2');
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['other-1']);
  });

  it('falls back to the Inbox when the remembered folder is gone', () => {
    start('A', { A: snapshot([mb('m1', 'inbox')], 'm2') });
    useEmailStore.getState().openStartFolder(true);
    expect(useEmailStore.getState().currentMailboxId).toBe('m1');
  });

  it('uses the active account\'s own memory when ids repeat across accounts', () => {
    // B remembers m1 (its Sent); A remembers m2 (its Sent). Same ids, other folders.
    const b = snapshot([mb('m2', 'inbox'), mb('m1', 'sent')], 'm1');
    start('B', { A: a, B: b });
    useEmailStore.getState().openStartFolder(true);
    expect(useEmailStore.getState().currentMailboxId).toBe('m1');
    expect(useEmailStore.getState().mailboxes.find((m) => m.id === 'm1')?.role).toBe('sent');
  });

  it('opens the active account\'s own Inbox when ids repeat across accounts', () => {
    const b = snapshot([mb('m2', 'inbox'), mb('m1', 'sent')], 'm1');
    start('B', { A: a, B: b });
    useEmailStore.getState().openStartFolder(false);
    expect(useEmailStore.getState().currentMailboxId).toBe('m2');
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['other-1']);
  });

  it('leaves the view alone when no folders are cached yet', () => {
    start('A', { A: snapshot([], null) });
    useEmailStore.getState().openStartFolder(false);
    expect(useEmailStore.getState().currentMailboxId).toBeNull();
  });

  it('does not override a folder chosen since (a deep link or notification tap)', async () => {
    start('A', { A: a });
    void useEmailStore.getState().selectMailbox('m2');
    useEmailStore.getState().openStartFolder(false);
    expect(useEmailStore.getState().currentMailboxId).toBe('m2');
  });

  it('only acts once per launch', () => {
    start('A', { A: a });
    useEmailStore.getState().openStartFolder(false);
    useEmailStore.setState({ currentMailboxId: 'm2' });
    useEmailStore.getState().openStartFolder(false);
    expect(useEmailStore.getState().currentMailboxId).toBe('m2');
  });
});
