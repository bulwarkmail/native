import { describe, it, expect, vi, beforeEach } from 'vitest';

// Not connected: nothing here may reach a server, and the outbox must not
// flush what the tests queue.
vi.mock('../../api/jmap-client', () => ({
  jmapClient: { isConnected: false, accountId: 'f' },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Email, JMAPSession } from '../../api/types';
import { reconcileServerFingerprint } from '../../lib/server-change';
import {
  readServerFingerprint,
  readServerPrimaryAccountId,
  sessionFingerprint,
  writeServerFingerprint,
} from '../../lib/server-fingerprint';
import { useCalendarStore } from '../calendar-store';
import { useCalendarSubscriptionsStore, type CalendarSubscription } from '../calendar-subscriptions-store';
import { useContactsStore } from '../contacts-store';
import { useEmailStore, type AccountSnapshot } from '../email-store';
import { useOfflineCacheStore } from '../offline-cache-store';
import { useOutboxStore } from '../outbox-store';
import { useSettingsStore } from '../settings-store';
import { useToastStore } from '../toast-store';

// Stalwart 1.0 has no migration from 0.16: the way there is a fresh install
// at the same address, where ids start over ("a", "b", ...) and the account's
// persisted states, ids and queued ops mean other things.
const ACCOUNT = 'userc@mail.example.org';
const OTHER = 'usera@other.example.org';

// The server gives the account's own data JMAP id `primary` ("f" on both
// test servers for userc; a reinstall can hand out another).
function session(version: '0.16.23' | '1.0', primary = 'f'): JMAPSession {
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
    accountCaps['urn:ietf:params:jmap:principals:owner'] = { accountIdForPrincipal: primary, principalId: primary };
    capabilities['urn:ietf:params:jmap:metadata'] = {};
  }
  return {
    apiUrl: 'https://mail.example.org/jmap/',
    downloadUrl: '',
    uploadUrl: '',
    eventSourceUrl: '',
    primaryAccounts: { 'urn:ietf:params:jmap:mail': primary },
    accounts: { [primary]: { name: 'userc@example.org', isPersonal: true, isReadOnly: false, accountCapabilities: accountCaps } },
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

// iCal subscriptions whose mirror calendars live on the 0.16.23 server.
const SUBSCRIPTIONS: CalendarSubscription[] = [
  {
    id: 'sub-mine', name: 'Holidays', url: 'https://feeds.example/holidays.ics', color: '#ff0000',
    calendarId: 'c', accountId: 'f', localAccountId: ACCOUNT, refreshIntervalMinutes: 360, lastSyncAt: 1, lastError: null,
  },
  // Made before subscriptions recorded their account.
  { id: 'sub-legacy', name: 'Moon', url: 'https://feeds.example/moon.ics', calendarId: 'd', accountId: 'f', lastSyncAt: 1, lastError: null },
  {
    id: 'sub-other', name: 'Sports', url: 'https://feeds.example/sports.ics', calendarId: 'c', accountId: 'b',
    localAccountId: OTHER, lastSyncAt: 1, lastError: null,
  },
];

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
    await AsyncStorage.setItem(`webmail:outbox:v1:${account}:failed`, JSON.stringify([
      { id: 'x', op: { kind: 'mailboxes', emailId: 'd', mailboxIds: { e: true } }, createdAt: 1, attempts: 5 },
    ]));
    await useOutboxStore.getState().setAccount(account);
    useOutboxStore.getState().enqueue({ kind: 'destroy', emailId: 'b' });
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'c', patch: { $seen: true } });
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
  useCalendarSubscriptionsStore.setState({ subscriptions: SUBSCRIPTIONS.map((sub) => ({ ...sub })) });
  // Identity "b" was userc@ on 0.16.23; on 1.0 it can be a group's address.
  useSettingsStore.setState({ preferredIdentityIds: { f: 'b', b: 'c' } });
  useCalendarStore.setState({ hiddenCalendarIds: ['c'] });
  await AsyncStorage.setItem('webmail:calendar:hidden:v1', JSON.stringify(['c']));
  useToastStore.setState({ toasts: [] });

  await writeServerFingerprint(ACCOUNT, sessionFingerprint(session('0.16.23')), 'f');
}

const subscription = (id: string) => useCalendarSubscriptionsStore.getState().subscriptions.find((s) => s.id === id)!;

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
    expect(await readServerPrimaryAccountId(ACCOUNT)).toBe('f');
  });

  it('keeps the iCal subscriptions of the account without their mirror calendars (0.16.23 to 1.0)', async () => {
    await seed(ACCOUNT);

    await reconcileServerFingerprint(ACCOUNT, session('1.0'));

    // "c" and "d" may name other calendars on 1.0: the next sync makes new ones.
    expect(subscription('sub-mine')).toEqual({ ...SUBSCRIPTIONS[0], calendarId: null, lastSyncAt: null });
    expect(subscription('sub-legacy')).toMatchObject({ calendarId: null, localAccountId: ACCOUNT, accountId: 'f' });
    expect(subscription('sub-other')).toEqual(SUBSCRIPTIONS[2]);
  });

  it('forgets the preferred identity and the hidden calendars (0.16.23 to 1.0)', async () => {
    await seed(ACCOUNT);

    await reconcileServerFingerprint(ACCOUNT, session('1.0'));

    expect(useSettingsStore.getState().preferredIdentityIds).toEqual({ b: 'c' });
    expect(useCalendarStore.getState().hiddenCalendarIds).toEqual([]);
    expect(await AsyncStorage.getItem('webmail:calendar:hidden:v1')).toBe('[]');
  });

  it('follows the account to the JMAP id the new server gave it', async () => {
    await seed(ACCOUNT);

    await reconcileServerFingerprint(ACCOUNT, session('1.0', 'h'));

    expect(subscription('sub-mine')).toMatchObject({ calendarId: null, accountId: 'h', localAccountId: ACCOUNT });
    expect(subscription('sub-legacy')).toMatchObject({ calendarId: null, accountId: 'h', localAccountId: ACCOUNT });
    expect(subscription('sub-other').calendarId).toBe('c');
    expect(useSettingsStore.getState().preferredIdentityIds).toEqual({ b: 'c' });
    expect(await readServerPrimaryAccountId(ACCOUNT)).toBe('h');
  });

  it('tells the user once how many offline changes it discarded', async () => {
    await seed(ACCOUNT);

    await reconcileServerFingerprint(ACCOUNT, session('1.0'));
    // A later check of the same server has nothing left to drop.
    await reconcileServerFingerprint(ACCOUNT, session('1.0'));

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('warning');
    // Two queued and one failed op.
    expect(toasts[0].title).toBe('3 offline changes were discarded because the mail server changed');
  });

  it('says nothing about an empty outbox', async () => {
    await seed(ACCOUNT);
    await useOutboxStore.getState().clearAccount(ACCOUNT);

    await reconcileServerFingerprint(ACCOUNT, session('1.0'));

    expect(useToastStore.getState().toasts).toEqual([]);
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
    expect(useCalendarSubscriptionsStore.getState().subscriptions).toEqual(SUBSCRIPTIONS);
    expect(useSettingsStore.getState().preferredIdentityIds).toEqual({ f: 'b', b: 'c' });
    expect(useCalendarStore.getState().hiddenCalendarIds).toEqual(['c']);
    expect(useToastStore.getState().toasts).toEqual([]);
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
