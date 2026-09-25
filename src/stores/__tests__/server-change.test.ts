import { describe, it, expect, vi, beforeEach } from 'vitest';

// Not connected: nothing here may reach a server, and the outbox must not
// flush what the tests queue.
vi.mock('../../api/jmap-client', () => ({
  jmapClient: { isConnected: false, accountId: 'f' },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Email, JMAPSession } from '../../api/types';
import { reconcileServerFingerprint } from '../../lib/server-change';
import { readServerFingerprint, sessionFingerprint, writeServerFingerprint } from '../../lib/server-fingerprint';
import { useCalendarStore } from '../calendar-store';
import { useContactsStore } from '../contacts-store';
import { useEmailStore, type AccountSnapshot } from '../email-store';
import { useOfflineCacheStore } from '../offline-cache-store';
import { useOutboxStore } from '../outbox-store';

// Stalwart 1.0 has no migration from 0.16: the way there is a fresh install
// at the same address, where ids start over ("a", "b", ...) and the account's
// persisted states, ids and queued ops mean other things.
const ACCOUNT = 'userc@mail.example.org';
const OTHER = 'usera@other.example.org';

function session(version: '0.16.23' | '1.0'): JMAPSession {
  const accountCaps: Record<string, unknown> = {
    'urn:ietf:params:jmap:mail': {},
    'urn:ietf:params:jmap:emailpush': {},
    'urn:stalwart:jmap': {},
  };
  const capabilities: Record<string, unknown> = {
    'urn:ietf:params:jmap:core': {},
    'urn:ietf:params:jmap:mail': {},
    'urn:ietf:params:jmap:emailpush': {},
  };
  if (version === '1.0') {
    accountCaps['urn:ietf:params:jmap:metadata'] = {};
    accountCaps['urn:ietf:params:jmap:principals:owner'] = { accountIdForPrincipal: 'f', principalId: 'f' };
    capabilities['urn:ietf:params:jmap:metadata'] = {};
  }
  return {
    apiUrl: 'https://mail.example.org/jmap/',
    downloadUrl: '',
    uploadUrl: '',
    eventSourceUrl: '',
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'f' },
    accounts: { f: { name: 'userc@example.org', isPersonal: true, isReadOnly: false, accountCapabilities: accountCaps } },
    capabilities,
    state: 'b3bed0bb',
  };
}

const email = (id: string): Email => ({
  id,
  threadId: `t-${id}`,
  mailboxIds: { a: true },
  keywords: { $seen: true },
  size: 100,
  receivedAt: '2026-09-20T10:00:00Z',
  subject: `Message ${id}`,
} as unknown as Email);

const INBOX = {
  id: 'a', name: 'Inbox', role: 'inbox', totalEmails: 1, unreadEmails: 0, totalThreads: 1, unreadThreads: 0,
  myRights: {} as never, accountId: 'f', isShared: false,
};

const otherSnapshot: AccountSnapshot = {
  mailboxes: [{ ...INBOX, accountId: 'b' }],
  mailboxState: 'sae',
  emailStates: { a: 'sae' },
  currentMailboxId: 'a',
  mailboxSnapshots: { a: { emails: [email('z')], total: 1, queryState: 'sae' } },
};

async function seed(active: string): Promise<void> {
  await AsyncStorage.clear();
  // What the 0.16.23 server left behind, for ACCOUNT and for another account.
  useEmailStore.setState({
    accountSnapshots: { [OTHER]: otherSnapshot, [ACCOUNT]: {
      mailboxes: [INBOX], mailboxState: 's1iaq', emailStates: { a: 's1iaq' }, currentMailboxId: 'a',
      mailboxSnapshots: { a: { emails: [email('b')], total: 1, queryState: 's1iaq' } },
    } },
    activeAccountId: null,
  });
  useEmailStore.getState().setActiveAccount(active);

  for (const account of [OTHER, ACCOUNT]) {
    await useOfflineCacheStore.getState().setAccount(account);
    await useOfflineCacheStore.getState().put({ ...email('b'), bodyValues: {} } as Email, 500);
    await useOutboxStore.getState().setAccount(account);
    useOutboxStore.getState().enqueue({ kind: 'destroy', emailId: 'b' });
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'c', patch: { $seen: true } });
    await AsyncStorage.setItem(`webmail:outbox:v1:${account}:failed`, JSON.stringify([
      { id: 'x', op: { kind: 'mailboxes', emailId: 'd', mailboxIds: { e: true } }, createdAt: 1, attempts: 5 },
    ]));
    await AsyncStorage.setItem(`push:notifiedIds:v1:${account}`, JSON.stringify(['b', 'a']));
    await AsyncStorage.setItem(`push:lastNotifiedEmailId:v2:${account}`, 'b');
    await AsyncStorage.setItem(`push:emailPushRefused:v1:${account}`, JSON.stringify(['d']));
    await AsyncStorage.setItem(`push:subscriptionId:v2:${account}`, 'a');
  }
  await useOfflineCacheStore.getState().setAccount(active);
  await useOutboxStore.getState().setAccount(active);

  useCalendarStore.setState({
    calendars: [{ id: 'a', name: 'Calendar' } as never],
    events: [{ id: 'b', title: 'Standup', calendarIds: { a: true } } as never],
    loadedRange: { start: '2026-09-01', end: '2026-10-01' } as never,
  });
  useContactsStore.setState({
    addressBooks: [{ id: 'a', name: 'Personal' } as never],
    contacts: [{ id: 'b', name: { full: 'Ann' } } as never],
  });

  await writeServerFingerprint(ACCOUNT, sessionFingerprint(session('0.16.23')));
}

const storedKeys = async () => (await AsyncStorage.getAllKeys()) as string[];

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('reconcileServerFingerprint', () => {
  it('drops what Stalwart 0.16.23 left behind when 1.0 answers at the same address', async () => {
    await seed(ACCOUNT);

    expect(await reconcileServerFingerprint(ACCOUNT, session('1.0'))).toBe(true);

    // Mail: folders, lists, JMAP states and query states of the account.
    const mail = useEmailStore.getState();
    expect(mail.activeAccountId).toBe(ACCOUNT);
    expect(mail.mailboxes).toEqual([]);
    expect(mail.mailboxState).toBeUndefined();
    expect(mail.emailStates).toEqual({});
    expect(mail.mailboxSnapshots).toEqual({});
    expect(mail.emails).toEqual([]);
    expect(mail.queryState).toBeUndefined();
    expect(mail.currentMailboxId).toBeNull();
    expect(mail.accountSnapshots[ACCOUNT]).toBeUndefined();
    // ... and on disk, not just in memory.
    expect(await AsyncStorage.getItem('email-cache')).not.toContain('s1iaq');

    // Offline bodies, queued and failed ops, push de-dupe state.
    const keys = await storedKeys();
    expect(keys.filter((k) => k.includes(`offline-cache:entry:v2:${ACCOUNT}:`))).toEqual([]);
    expect(keys).not.toContain(`webmail:offline-cache:index:v2:${ACCOUNT}`);
    expect(useOfflineCacheStore.getState().totalCount()).toBe(0);
    expect(keys).not.toContain(`webmail:outbox:v1:${ACCOUNT}`);
    expect(keys).not.toContain(`webmail:outbox:v1:${ACCOUNT}:failed`);
    expect(useOutboxStore.getState().entries).toEqual([]);
    expect(useOutboxStore.getState().failed).toEqual([]);
    for (const key of ['push:notifiedIds:v1:', 'push:lastNotifiedEmailId:v2:', 'push:emailPushRefused:v1:']) {
      expect(keys).not.toContain(key + ACCOUNT);
    }
    // The registration stays for the resync to check against the server.
    expect(await AsyncStorage.getItem(`push:subscriptionId:v2:${ACCOUNT}`)).toBe('a');

    // Calendar and contacts caches (they hold the account being signed in).
    expect(useCalendarStore.getState().events).toEqual([]);
    expect(useCalendarStore.getState().loadedRange).toBeNull();
    expect(useContactsStore.getState().contacts).toEqual([]);

    expect(await readServerFingerprint(ACCOUNT)).toBe(sessionFingerprint(session('1.0')));
  });

  it('leaves every other account alone', async () => {
    await seed(ACCOUNT);

    await reconcileServerFingerprint(ACCOUNT, session('1.0'));

    expect(useEmailStore.getState().accountSnapshots[OTHER]).toEqual(otherSnapshot);
    const keys = await storedKeys();
    expect(keys).toContain(`webmail:offline-cache:index:v2:${OTHER}`);
    expect(keys).toContain(`webmail:offline-cache:entry:v2:${OTHER}:b`);
    expect(JSON.parse((await AsyncStorage.getItem(`webmail:outbox:v1:${OTHER}`))!)).toHaveLength(2);
    expect(keys).toContain(`webmail:outbox:v1:${OTHER}:failed`);
    expect(keys).toContain(`push:notifiedIds:v1:${OTHER}`);
    expect(keys).toContain(`push:emailPushRefused:v1:${OTHER}`);
  });

  it('drops a changed account that is not on screen from its tucked-away snapshot', async () => {
    // Signing in to ACCOUNT while OTHER is shown: the check runs before the
    // email store switches over.
    await seed(OTHER);

    await reconcileServerFingerprint(ACCOUNT, session('1.0'));

    const mail = useEmailStore.getState();
    expect(mail.accountSnapshots[ACCOUNT]).toBeUndefined();
    expect(mail.activeAccountId).toBe(OTHER);
    expect(mail.mailboxState).toBe('sae');
    expect(mail.emails.map((e) => e.id)).toEqual(['z']);
    const keys = await storedKeys();
    expect(keys).not.toContain(`webmail:offline-cache:entry:v2:${ACCOUNT}:b`);
    expect(keys).not.toContain(`webmail:outbox:v1:${ACCOUNT}`);
    expect(useOutboxStore.getState().entries).toHaveLength(2); // OTHER's queue, loaded
  });

  it('changes nothing while the server stays the same (Stalwart 0.16.23)', async () => {
    await seed(ACCOUNT);

    expect(await reconcileServerFingerprint(ACCOUNT, session('0.16.23'))).toBe(false);

    expect(useEmailStore.getState().mailboxState).toBe('s1iaq');
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['b']);
    expect(useOutboxStore.getState().entries).toHaveLength(2);
    expect(useCalendarStore.getState().events).toHaveLength(1);
    expect(await AsyncStorage.getItem(`push:notifiedIds:v1:${ACCOUNT}`)).not.toBeNull();
  });

  it('only records the first server it sees for an account', async () => {
    await seed(ACCOUNT);
    await AsyncStorage.removeItem(`server-fingerprint:v1:${ACCOUNT}`);

    expect(await reconcileServerFingerprint(ACCOUNT, session('1.0'))).toBe(false);

    expect(useEmailStore.getState().mailboxState).toBe('s1iaq');
    expect(useOutboxStore.getState().entries).toHaveLength(2);
    expect(await readServerFingerprint(ACCOUNT)).toBe(sessionFingerprint(session('1.0')));
  });

  it('tries again with the next session when dropping failed part-way', async () => {
    await seed(ACCOUNT);
    const multiRemove = AsyncStorage.multiRemove as ReturnType<typeof vi.fn>;
    multiRemove.mockRejectedValueOnce(new Error('disk full'));

    await expect(reconcileServerFingerprint(ACCOUNT, session('1.0'))).rejects.toThrow('disk full');

    // The rest went anyway, but the old fingerprint stays so the next check
    // repeats the drop.
    expect(useEmailStore.getState().mailboxState).toBeUndefined();
    expect(useOutboxStore.getState().entries).toEqual([]);
    expect(await readServerFingerprint(ACCOUNT)).toBe(sessionFingerprint(session('0.16.23')));

    expect(await reconcileServerFingerprint(ACCOUNT, session('1.0'))).toBe(true);
    expect(await AsyncStorage.getItem(`push:notifiedIds:v1:${ACCOUNT}`)).toBeNull();
    expect(await readServerFingerprint(ACCOUNT)).toBe(sessionFingerprint(session('1.0')));
  });
});
