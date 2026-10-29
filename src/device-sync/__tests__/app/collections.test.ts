import { describe, it, expect, beforeEach } from 'vitest';
import {
  CollectionsError,
  forgetSyncCollections,
  listSyncCollections,
  onSyncCollectionsLoaded,
  otherAccountsSyncing,
  type CollectionsClient,
} from '../../app/collections';
import { CALENDAR_AUTHORITY, CONTACTS_AUTHORITY, JMAP_CALENDARS, JMAP_CONTACTS } from '../../types';
import { useDeviceSyncStore, waitForDeviceSyncHydration } from '../../../stores/device-sync-store';
import type { JMAPMethodCall } from '../../../api/types';

type Handler = (args: Record<string, any>, calls: JMAPMethodCall[]) => any;

// A client for one account with the personal JMAP account `c` and a shared
// account `team`, answering the calls the listing makes.
function fakeClient(handlers: Record<string, Handler>, options: { loaded?: boolean | Error; maxCalls?: number } = {}) {
  const requests: JMAPMethodCall[][] = [];
  const client: CollectionsClient = {
    async loadAccount() {
      if (options.loaded instanceof Error) throw options.loaded;
      return options.loaded ?? true;
    },
    get currentSession() {
      return {
        primaryAccounts: { [JMAP_CONTACTS]: 'c', [JMAP_CALENDARS]: 'c' },
        accounts: {
          c: { name: 'alice@example.org', isPersonal: true, accountCapabilities: { [JMAP_CONTACTS]: {}, [JMAP_CALENDARS]: {} } },
          team: { name: 'Team', isPersonal: false, accountCapabilities: { [JMAP_CONTACTS]: {}, [JMAP_CALENDARS]: {} } },
          mailonly: { name: 'Archive', isPersonal: false, accountCapabilities: {} },
        },
      };
    },
    async request(calls) {
      requests.push(calls);
      const responses: Array<[string, any, string]> = [];
      for (const [name, args, id] of calls) {
        const handler = handlers[`${name} ${args.accountId}`] ?? handlers[name];
        if (!handler) {
          responses.push(['error', { type: 'unknownMethod' }, id]);
          continue;
        }
        const body = handler(args, calls);
        responses.push(body === null ? ['error', { type: 'forbidden' }, id] : [name, body, id]);
      }
      return { methodResponses: responses };
    },
    getMaxCallsInRequest: () => options.maxCalls ?? 16,
  };
  return { client, requests };
}

beforeEach(async () => {
  await waitForDeviceSyncHydration();
  useDeviceSyncStore.setState({ accounts: {} });
  forgetSyncCollections();
});

describe('listSyncCollections', () => {
  it('lists the personal address books first, then the shared ones, and marks read-only ones', async () => {
    const { client, requests } = fakeClient({
      'AddressBook/get c': () => ({ list: [
        { id: 'b2', name: 'Work', sortOrder: 2, myRights: { mayWrite: true } },
        { id: 'b1', name: 'Personal', isDefault: true, sortOrder: 1, myRights: { mayWrite: true } },
      ] }),
      'AddressBook/get team': () => ({ list: [{ id: 'b1', name: 'Team contacts', myRights: { mayWrite: false } }] }),
    });
    const list = await listSyncCollections('alice@x', CONTACTS_AUTHORITY, { client });
    expect(list.map((c) => [c.key, c.name, c.isPersonal, c.readOnly, c.isDefault])).toEqual([
      ['c/b1', 'Personal', true, false, true],
      ['c/b2', 'Work', true, false, false],
      ['team/b1', 'Team contacts', false, true, false],
    ]);
    expect(list[2].accountName).toBe('Team');
    // Explicit properties, the contacts capability, and never the mail-only account.
    const [calls] = requests;
    expect(calls.map(([name, args]) => `${name} ${args.accountId}`)).toEqual(['AddressBook/get c', 'AddressBook/get team']);
    expect(calls[0][1].properties).toEqual(expect.arrayContaining(['id', 'name', 'myRights']));
  });

  it('tells every view of the account when a fresh list arrived', async () => {
    const { client } = fakeClient({
      'AddressBook/get c': () => ({ list: [{ id: 'b1', name: 'Personal' }] }),
      'AddressBook/get team': () => ({ list: [] }),
    });
    const seen: string[][] = [];
    const stop = onSyncCollectionsLoaded((id, authority, list) => seen.push([id, authority, ...list.map((c) => c.key)]));
    await listSyncCollections('alice@x', CONTACTS_AUTHORITY, { client });
    stop();
    await listSyncCollections('alice@x', CONTACTS_AUTHORITY, { client, force: true });
    expect(seen).toEqual([['alice@x', CONTACTS_AUTHORITY, 'c/b1']]);
  });

  it('remembers the personal JMAP account for the push routes', async () => {
    const { client } = fakeClient({ 'AddressBook/get': () => ({ list: [] }) });
    await listSyncCollections('alice@x', CONTACTS_AUTHORITY, { client });
    expect(useDeviceSyncStore.getState().accounts['alice@x']?.primaryJmapAccounts).toEqual({ [CONTACTS_AUTHORITY]: 'c' });
  });

  it('keeps the list when a shared account refuses', async () => {
    const { client } = fakeClient({
      'AddressBook/get c': () => ({ list: [{ id: 'b1', name: 'Personal' }] }),
      'AddressBook/get team': () => null,
    });
    const list = await listSyncCollections('alice@x', CONTACTS_AUTHORITY, { client });
    expect(list.map((c) => c.key)).toEqual(['c/b1']);
  });

  it('leaves out calendars it may not read and calendars holding only tasks', async () => {
    // What each calendar's scan finds: `todo` holds only tasks, `empty` nothing.
    const scans: Record<string, any[]> = {
      cal1: [{ id: 'e', '@type': 'Event' }],
      todo: [{ id: 't', '@type': 'Task' }, { id: 'u', due: '2026-10-01T00:00:00' }],
      empty: [],
    };
    const { client } = fakeClient({
      'Calendar/get c': () => ({ list: [
        { id: 'cal1', name: 'Personal', color: '#ff0000', myRights: { mayReadItems: true, mayWriteAll: true } },
        { id: 'todo', name: 'Tasks', myRights: { mayReadItems: true, mayWriteAll: true } },
        { id: 'empty', name: 'New', myRights: { mayReadItems: true, mayWriteAll: true } },
        { id: 'hidden', name: 'Free/busy only', myRights: { mayReadItems: false } },
      ] }),
      'Calendar/get team': () => ({ list: [
        { id: 'cal1', name: 'Team', myRights: { mayReadItems: true, mayWriteAll: false, mayWriteOwn: false } },
      ] }),
      'CalendarEvent/query': (args) => ({ ids: (scans[args.filter.inCalendar] ?? []).map((o) => o.id) }),
      'CalendarEvent/get': (args, calls) => {
        // The get reads the ids of the query it references.
        const query = calls.find(([, , id]) => id === args['#ids'].resultOf)!;
        return { list: scans[(query[1].filter as { inCalendar: string }).inCalendar] ?? [] };
      },
    });
    const list = await listSyncCollections('alice@x', CALENDAR_AUTHORITY, { client });
    // By name within an account (no sort order given).
    expect(list.map((c) => [c.key, c.readOnly])).toEqual([
      ['c/empty', false],
      ['c/cal1', false],
      ['team/cal1', true],
    ]);
    expect(list.find((c) => c.key === 'c/cal1')?.color).toBe('#ff0000');
  });

  it('marks calendars mirroring a subscribed feed read-only', async () => {
    const { client } = fakeClient({
      'Calendar/get c': () => ({ list: [
        { id: 'feed', name: 'Holidays', myRights: { mayReadItems: true, mayWriteAll: true } },
      ] }),
      'Calendar/get team': () => ({ list: [] }),
      'CalendarEvent/query': () => ({ ids: [] }),
      'CalendarEvent/get': () => ({ list: [] }),
    });
    const list = await listSyncCollections('alice@x', CALENDAR_AUTHORITY, { client, feeds: [{ calendarId: 'feed' }] });
    expect(list.map((c) => [c.key, c.readOnly])).toEqual([['c/feed', true]]);
  });

  it('keeps a query and the get that reads it in one request', async () => {
    const { client, requests } = fakeClient({
      'Calendar/get': () => ({ list: [
        { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' },
      ] }),
      'CalendarEvent/query': () => ({ ids: [] }),
      'CalendarEvent/get': () => ({ list: [] }),
    }, { maxCalls: 5 });
    await listSyncCollections('alice@x', CALENDAR_AUTHORITY, { client });
    const scanRequests = requests.filter((calls) => calls[0][0] === 'CalendarEvent/query');
    for (const calls of scanRequests) {
      expect(calls.length % 2).toBe(0);
      expect(calls.length).toBeLessThanOrEqual(5);
    }
  });

  it('says why the list could not be loaded', async () => {
    const signedOut = fakeClient({}, { loaded: false }).client;
    await expect(listSyncCollections('alice@x', CONTACTS_AUTHORITY, { client: signedOut }))
      .rejects.toMatchObject({ kind: 'signedOut' });
    const auth = Object.assign(new Error('Invalid credentials'), { name: 'AuthenticationError' });
    await expect(listSyncCollections('alice@x', CONTACTS_AUTHORITY, { client: fakeClient({}, { loaded: auth }).client }))
      .rejects.toBeInstanceOf(CollectionsError);
    await expect(listSyncCollections('alice@x', CONTACTS_AUTHORITY, { client: fakeClient({}, { loaded: auth }).client }))
      .rejects.toMatchObject({ kind: 'auth' });
    const offline = Object.assign(new Error('Server unreachable'), { name: 'NetworkError' });
    await expect(listSyncCollections('alice@x', CONTACTS_AUTHORITY, { client: fakeClient({}, { loaded: offline }).client }))
      .rejects.toMatchObject({ kind: 'network' });
  });
});

describe('otherAccountsSyncing', () => {
  const registry = [
    { id: 'alice@mail.example.org', serverUrl: 'https://mail.example.org', email: 'alice@example.org', username: 'alice' },
    { id: 'bob@mail.example.org', serverUrl: 'https://mail.example.org/', email: 'bob@example.org', username: 'bob' },
    { id: 'bob@other.example.net', serverUrl: 'https://other.example.net', email: 'bob@example.net', username: 'bob' },
  ];

  it('names the other accounts on the same server that sync the same collection', () => {
    const accounts = {
      'bob@mail.example.org': {
        contactsSelection: { 'team/b1': true },
        calendarSelection: {},
        reminderOwner: null,
        intervalSeconds: {},
        lastRun: {},
        enabled: { [CONTACTS_AUTHORITY]: true },
      },
      // Another server: the same JMAP ids mean other data.
      'bob@other.example.net': {
        contactsSelection: { 'team/b1': true },
        calendarSelection: {},
        reminderOwner: null,
        intervalSeconds: {},
        lastRun: {},
        enabled: { [CONTACTS_AUTHORITY]: true },
      },
    };
    const collection = { key: 'team/b1', jmapAccountId: 'team' };
    expect(otherAccountsSyncing('alice@mail.example.org', CONTACTS_AUTHORITY, collection, registry, accounts))
      .toEqual(['bob@example.org']);
    // Not for another authority, nor once Bob's contacts sync is off.
    expect(otherAccountsSyncing('alice@mail.example.org', CALENDAR_AUTHORITY, collection, registry, accounts)).toEqual([]);
    accounts['bob@mail.example.org'].enabled = { [CONTACTS_AUTHORITY]: false };
    expect(otherAccountsSyncing('alice@mail.example.org', CONTACTS_AUTHORITY, collection, registry, accounts)).toEqual([]);
  });

  it("counts the other account's own collections, which sync by default", () => {
    const accounts = {
      'bob@mail.example.org': {
        contactsSelection: {},
        calendarSelection: {},
        reminderOwner: null,
        intervalSeconds: {},
        lastRun: {},
        enabled: { [CALENDAR_AUTHORITY]: true },
        primaryJmapAccounts: { [CALENDAR_AUTHORITY]: 'bobacct' },
      },
    };
    expect(otherAccountsSyncing(
      'alice@mail.example.org',
      CALENDAR_AUTHORITY,
      { key: 'bobacct/cal1', jmapAccountId: 'bobacct' },
      registry,
      accounts,
    )).toEqual(['bob@example.org']);
  });
});
