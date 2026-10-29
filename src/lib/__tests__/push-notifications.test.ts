import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Provide the Android native FCM surface setupPushNotifications needs. The
// global test-setup mocks react-native with an empty NativeModules, so override
// it here with a BulwarkFcm module and a pre-33 Platform.Version (which skips
// the runtime permission request).
vi.mock('react-native', () => {
  class NativeEventEmitter {
    addListener() {
      return { remove: () => undefined };
    }
  }
  return {
    Platform: { OS: 'android', Version: 30, select: <T,>(s: { default?: T; android?: T }) => s.android ?? s.default },
    NativeModules: {
      BulwarkFcm: {
        getToken: vi.fn(async () => 'fcm-token-xyz'),
        deleteToken: vi.fn(async () => undefined),
      },
      BulwarkUnifiedPush: {
        getDistributors: vi.fn(async () => ['io.heckel.ntfy']),
        getSavedDistributor: vi.fn(async () => 'io.heckel.ntfy'),
        getAckDistributor: vi.fn(async () => 'io.heckel.ntfy'),
        saveDistributor: vi.fn(async () => undefined),
        register: vi.fn(async () => undefined),
        unregister: vi.fn(async () => undefined),
        getEndpoint: vi.fn(async () => ({
          url: 'https://ntfy.sh/upAbCdEf?up=1',
          p256dh: 'B'.repeat(87),
          auth: 'a'.repeat(22),
        })),
      },
    },
    NativeEventEmitter,
    PermissionsAndroid: { RESULTS: { GRANTED: 'granted' }, request: vi.fn(async () => 'granted') },
    // What the stores the server check drops from need at load.
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove: () => undefined }) },
    Linking: { openURL: async () => undefined },
  };
});

// What createPushSubscription resolves to: the new id and the expiry the
// server settled on (unknown here unless a test says otherwise).
const { CREATED } = vi.hoisted(() => ({
  CREATED: { id: 'new-server-id', expires: null as string | null },
}));

// A client of another signed-in account (device sync patches its push types
// without the singleton), on a server with contacts and calendars unless a
// test says otherwise.
const { DETACHED, SYNC_SESSION } = vi.hoisted(() => {
  const SYNC_SESSION = {
    capabilities: {
      'urn:ietf:params:jmap:core': {},
      'urn:ietf:params:jmap:contacts': {},
      'urn:ietf:params:jmap:calendars': {},
    } as Record<string, unknown>,
  };
  return {
    SYNC_SESSION,
    DETACHED: {
      loaded: true,
      types: ['EmailDelivery'] as string[],
      deviceClientId: null as string | null,
      // The subscription's expiry, and what an update of it settles on.
      expires: null as string | null,
      settles: null as string | null,
      log: [] as unknown[],
      session: SYNC_SESSION,
    },
  };
});

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    username: 'user@example.com',
    serverUrl: 'https://mail.example.com',
    accountId: 'jmap-primary',
    currentSession: { capabilities: { 'urn:ietf:params:jmap:core': {} } },
  },
  JMAPClient: class {
    get currentSession() {
      return DETACHED.session;
    }
    async loadAccount(id: string) {
      DETACHED.log.push(['load', id]);
      return DETACHED.loaded;
    }
    get username() {
      return 'bob';
    }
    get accountId() {
      return 'bob-jmap';
    }
    async request(calls: Array<[string, Record<string, any>, string]>) {
      const methodResponses = calls.map(([name, args, id]) => {
        DETACHED.log.push([name, args]);
        if (name === 'PushSubscription/get') {
          const listed = {
            id: args.ids[0],
            types: DETACHED.types,
            ...(DETACHED.deviceClientId ? { deviceClientId: DETACHED.deviceClientId } : {}),
            ...(DETACHED.expires ? { expires: DETACHED.expires } : {}),
          };
          return [name, { list: [listed] }, id];
        }
        const target = Object.keys(args.update)[0];
        if (args.update[target].expires && DETACHED.settles) DETACHED.expires = DETACHED.settles;
        return [name, { updated: { [target]: null } }, id];
      });
      return { methodResponses };
    }
  },
}));

vi.mock('../../api/email', () => ({
  getMailboxes: vi.fn(async () => [
    { id: 'inbox', role: 'inbox', accountId: 'jmap-primary' },
    { id: 'junk', role: 'junk', accountId: 'jmap-primary' },
  ]),
  getSharedMailboxes: vi.fn(async () => []),
}));

vi.mock('../../api/push', () => ({
  listPushSubscriptions: vi.fn(async () => []),
  createPushSubscription: vi.fn(async () => CREATED),
  verifyPushSubscription: vi.fn(async () => undefined),
  destroyPushSubscription: vi.fn(async () => undefined),
  updatePushSubscription: vi.fn(async () => undefined),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  setupPushNotifications,
  deviceClientIdKey,
  disablePushForAccount,
  enablePushFromSettings,
  forgetPushServerState,
  isValidRelayUrl,
  mailAccountsWithoutPush,
  notificationTapJmapAccountId,
  readPushAccountIds,
  readPushJmapAccountIds,
  PushSetupError,
  pushTypesFor,
  readPushAccountStates,
  refreshPushSubscriptionTypes,
  renewOtherPushAccounts,
  resyncPushNotifications,
  revokePushDevice,
  teardownPushNotificationsForAccount,
} from '../push-notifications';
import {
  listPushSubscriptions,
  createPushSubscription,
  destroyPushSubscription,
  updatePushSubscription,
  verifyPushSubscription,
} from '../../api/push';
import { getSharedMailboxes } from '../../api/email';
import { JMAPMethodError, JMAPSetError } from '../../api/jmap-result';
import type { EmailPushConfig, JMAPSession } from '../../api/types';
import { jmapClient } from '../../api/jmap-client';
import { NativeModules } from 'react-native';
import { generateAccountId } from '../account-utils';
import { reconcileServerFingerprint } from '../server-change';

const OUR_DCID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ACCOUNT_ID = generateAccountId('user@example.com', 'https://mail.example.com');
const RELAY = 'https://relay.example.com';

// State the fake relay reports for each foreign deviceClientId's /active probe.
type RelayState = 'dead' | 'live' | 'unknown';

function installFetch(states: Record<string, RelayState>): void {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/push/register')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }
    if (url.includes('/api/push/verify/')) {
      return { ok: true, status: 200, json: async () => ({ verificationCode: 'CODE' }) } as Response;
    }
    const active = url.match(/\/api\/push\/active\/([^/?]+)$/);
    if (active) {
      const dcid = decodeURIComponent(active[1]);
      const state = states[dcid] ?? 'unknown';
      if (state === 'unknown') {
        return { ok: false, status: 404, json: async () => ({ error: 'Unknown subscription' }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ active: state === 'live' }) } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

const destroyMock = destroyPushSubscription as ReturnType<typeof vi.fn>;
const listMock = listPushSubscriptions as ReturnType<typeof vi.fn>;
const createMock = createPushSubscription as ReturnType<typeof vi.fn>;
const updateMock = updatePushSubscription as ReturnType<typeof vi.fn>;
const SUB_KEY = 'push:subscriptionId:v2:' + ACCOUNT_ID;

function sub(id: string, deviceClientId: string) {
  return { id, deviceClientId, expires: new Date(Date.now() + 86400000).toISOString(), types: ['Email'] };
}

describe('setupPushNotifications leftover reaping', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    // Pin our deviceClientId so we control which leftovers are "ours".
    await AsyncStorage.setItem(deviceClientIdKey(ACCOUNT_ID), OUR_DCID);
  });

  it('reaps our own and relay-confirmed-dead leftovers, keeps live and unverifiable ones', async () => {
    listMock.mockResolvedValue([
      sub('own-old', OUR_DCID), // our own previous attempt -> reap
      sub('foreign-dead', 'deaddeaddeaddeaddeaddeaddeaddead'), // relay: dead -> reap
      sub('foreign-live', 'livelivelivelivelivelivelivelive'), // relay: live -> keep
      sub('foreign-unknown', 'unknwunknwunknwunknwunknwunknwun'), // relay: 404 -> keep
    ]);
    installFetch({
      deaddeaddeaddeaddeaddeaddeaddead: 'dead',
      livelivelivelivelivelivelivelive: 'live',
      unknwunknwunknwunknwunknwunknwun: 'unknown',
    });

    const result = await setupPushNotifications({ relayBaseUrl: RELAY });

    expect(result.verified).toBe(true);
    const reaped = destroyMock.mock.calls.map((c) => c[0]);
    expect(reaped).toContain('own-old');
    expect(reaped).toContain('foreign-dead');
    expect(reaped).not.toContain('foreign-live');
    expect(reaped).not.toContain('foreign-unknown');
  });

  it('keeps foreign subs when the relay probe fails (network error)', async () => {
    listMock.mockResolvedValue([sub('foreign-x', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')]);
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/push/register')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      if (url.includes('/api/push/verify/')) {
        return { ok: true, status: 200, json: async () => ({ verificationCode: 'CODE' }) } as Response;
      }
      if (url.includes('/api/push/active/')) throw new Error('network down');
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await setupPushNotifications({ relayBaseUrl: RELAY });

    expect(destroyMock.mock.calls.map((c) => c[0])).not.toContain('foreign-x');
  });

  it('coalesces concurrent setups into a single flow (no subscription swarm)', async () => {
    listMock.mockResolvedValue([]);
    installFetch({});

    // Fire several overlapping setups, as App.tsx does while auth settles and
    // on FCM token refresh. Only one underlying JMAP subscription must be made.
    const results = await Promise.all([
      setupPushNotifications({ relayBaseUrl: RELAY }),
      setupPushNotifications({ relayBaseUrl: RELAY }),
      setupPushNotifications({ relayBaseUrl: RELAY }),
    ]);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.subscriptionId)).size).toBe(1);
  });
});

describe('setupPushNotifications subscription shape', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(deviceClientIdKey(ACCOUNT_ID), OUR_DCID);
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: { 'urn:ietf:params:jmap:core': {} },
    };
    listMock.mockResolvedValue([]);
    updateMock.mockResolvedValue(true);
    installFetch({});
  });

  it('subscribes to EmailDelivery only', async () => {
    await setupPushNotifications({ relayBaseUrl: RELAY });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].types).toEqual(['EmailDelivery']);
    expect(createMock.mock.calls[0][0].emailPush).toBeUndefined();
  });

  it('records the JMAP account id so pushes can be routed per account', async () => {
    await setupPushNotifications({ relayBaseUrl: RELAY });
    expect(await readPushJmapAccountIds()).toEqual({ [ACCOUNT_ID]: 'jmap-primary' });
  });

  it('adds a junk-excluding emailPush filter when the server advertises emailpush', async () => {
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: { 'urn:ietf:params:jmap:emailpush': {} },
    };
    await setupPushNotifications({ relayBaseUrl: RELAY });
    const emailPush = createMock.mock.calls[0][0].emailPush;
    expect(emailPush['jmap-primary']).toEqual({
      filter: {
        operator: 'AND',
        conditions: [{ notKeyword: '$junk' }, { inMailboxOtherThan: ['junk'] }],
      },
      properties: ['id', 'threadId'],
      urgency: 'high',
    });
  });

  it('patches types on an existing subscription that still listens to Email/Mailbox', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([
      { id: 'existing', deviceClientId: OUR_DCID, expires: new Date(Date.now() + 80 * 86400000).toISOString(), types: ['Email', 'EmailDelivery', 'Mailbox'] },
    ]);
    const result = await setupPushNotifications({ relayBaseUrl: RELAY });
    expect(result.subscriptionId).toBe('existing');
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][1].types).toEqual(['EmailDelivery']);
  });

  it('leaves a healthy subscription alone', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([
      { id: 'existing', deviceClientId: OUR_DCID, expires: new Date(Date.now() + 80 * 86400000).toISOString(), types: ['EmailDelivery'] },
    ]);
    await setupPushNotifications({ relayBaseUrl: RELAY });
    expect(updateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('leaves an emailPush filter alone when the server already holds it', async () => {
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: { 'urn:ietf:params:jmap:emailpush': {} },
    };
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([
      {
        id: 'existing',
        deviceClientId: OUR_DCID,
        expires: new Date(Date.now() + 80 * 86400000).toISOString(),
        types: ['EmailDelivery'],
        // As the server echoes it back: same content, its own key order.
        emailPush: {
          'jmap-primary': {
            urgency: 'high',
            properties: ['id', 'threadId'],
            filter: { conditions: [{ notKeyword: '$junk' }, { inMailboxOtherThan: ['junk'] }], operator: 'AND' },
          },
        },
      },
    ]);
    await setupPushNotifications({ relayBaseUrl: RELAY });
    expect(updateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('re-patches an emailPush filter that has drifted', async () => {
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: { 'urn:ietf:params:jmap:emailpush': {} },
    };
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([
      {
        id: 'existing',
        deviceClientId: OUR_DCID,
        expires: new Date(Date.now() + 80 * 86400000).toISOString(),
        types: ['EmailDelivery'],
        emailPush: {
          'jmap-primary': {
            filter: { operator: 'AND', conditions: [{ notKeyword: '$junk' }, { inMailboxOtherThan: ['old-junk'] }] },
            properties: ['id', 'threadId'],
            urgency: 'high',
          },
        },
      },
    ]);
    await setupPushNotifications({ relayBaseUrl: RELAY });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][1].emailPush['jmap-primary'].filter.conditions[1]).toEqual({
      inMailboxOtherThan: ['junk'],
    });
  });

  it('forceRecreate destroys the recorded subscription and creates a new one', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([
      { id: 'existing', deviceClientId: OUR_DCID, expires: new Date(Date.now() + 80 * 86400000).toISOString(), types: ['EmailDelivery'] },
    ]);
    const result = await setupPushNotifications({ relayBaseUrl: RELAY, forceRecreate: true });
    expect(destroyMock.mock.calls.map((c) => c[0])).toContain('existing');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.subscriptionId).toBe('new-server-id');
  });

  it('says the mail server refuses a relay that is not on a public domain (Stalwart 1.0)', async () => {
    const relay = 'https://relay.home.lan';
    createMock.mockRejectedValueOnce(new JMAPSetError(
      'invalidProperties',
      'Failed to create push subscription new: invalidProperties – properties=[url] – Host is not a public domain name',
      ['url'],
    ));
    const err = await setupPushNotifications({ relayBaseUrl: relay }).catch((e) => e);
    expect(err).toBeInstanceOf(PushSetupError);
    expect(err.phase).toBe('jmap');
    expect(err.message).toContain(relay);
    expect(err.message).toContain('public domain name');
    expect(err.message).not.toContain('properties=[url]');
  });

  it('keeps the relay a working registration goes through when the server refuses the new one', async () => {
    await AsyncStorage.setItem('push:relayBaseUrl:v1', RELAY);
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([{ id: 'existing', deviceClientId: OUR_DCID, expires: new Date(Date.now() + 5 * 86400000).toISOString(), types: ['EmailDelivery'] }]);
    createMock.mockRejectedValueOnce(new JMAPSetError('invalidProperties', 'Host is not a public domain name', ['url']));
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;

    const err = await setupPushNotifications({ relayBaseUrl: 'https://relay.home.lan', forceRecreate: true }).catch((e) => e);

    expect(err).toBeInstanceOf(PushSetupError);
    expect(await AsyncStorage.getItem('push:relayBaseUrl:v1')).toBe(RELAY);
    expect(await AsyncStorage.getItem(SUB_KEY)).toBe('existing');
    expect(destroyMock).not.toHaveBeenCalledWith('existing');
    const relayCalls = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/api/push/register'))
      .map((c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${String(c[0])}`);
    // The refused URL may be another name of the relay in use: after dropping
    // the record there, this device registers with the previous relay again.
    expect(relayCalls).toEqual([
      'POST https://relay.home.lan/api/push/register',
      `DELETE https://relay.home.lan/api/push/register/${OUR_DCID}`,
      `POST ${RELAY}/api/push/register`,
    ]);
    const restored = fetchMock.mock.calls.filter((c) => String(c[0]) === `${RELAY}/api/push/register`);
    expect(JSON.parse(String((restored[0][1] as RequestInit).body))).toMatchObject({ subscriptionId: OUR_DCID, fcmToken: 'fcm-token-xyz' });

    // The same relay refused (a server that tightened its rules) stays as it is.
    fetchMock.mockClear();
    createMock.mockRejectedValueOnce(new JMAPSetError('invalidProperties', 'Host is not a public domain name', ['url']));
    await setupPushNotifications({ relayBaseUrl: RELAY, forceRecreate: true }).catch(() => undefined);
    expect(await AsyncStorage.getItem('push:relayBaseUrl:v1')).toBe(RELAY);
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });

  it('hands the settings the relay in use back after the server refused a new one', async () => {
    await AsyncStorage.setItem('push:relayBaseUrl:v1', RELAY);
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([{ id: 'existing', deviceClientId: OUR_DCID, expires: new Date(Date.now() + 5 * 86400000).toISOString(), types: ['EmailDelivery'] }]);
    createMock.mockRejectedValueOnce(new JMAPSetError('invalidProperties', 'Host is not a public domain name', ['url']));

    const outcome = await enablePushFromSettings({ relayBaseUrl: 'https://relay.home.lan/', forceRecreate: true });

    expect(outcome.error).toBeInstanceOf(PushSetupError);
    expect(outcome.relayBaseUrl).toBe(RELAY);
    expect(outcome.enabled).toBe(true);

    // Nothing in use yet: the typed relay stays, so it can be corrected.
    await AsyncStorage.clear();
    await AsyncStorage.setItem(deviceClientIdKey(ACCOUNT_ID), OUR_DCID);
    listMock.mockResolvedValue([]);
    createMock.mockRejectedValueOnce(new JMAPSetError('invalidProperties', 'Host is not a public domain name', ['url']));
    expect(await enablePushFromSettings({ relayBaseUrl: 'https://relay.home.lan/' }))
      .toMatchObject({ relayBaseUrl: 'https://relay.home.lan', enabled: false });

    // A run that works shows the relay it registered with.
    expect(await enablePushFromSettings({ relayBaseUrl: 'https://relay.example.com/' }))
      .toEqual({ error: null, relayBaseUrl: RELAY, enabled: true });
  });

  it('rejects plain-http relay URLs', async () => {
    await expect(setupPushNotifications({ relayBaseUrl: 'http://relay.example.com' })).rejects.toMatchObject({ phase: 'relay' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('surfaces the relay error body and phase when registration fails', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'Invalid fcmToken' }),
    })) as unknown as typeof fetch;
    const err = await setupPushNotifications({ relayBaseUrl: RELAY }).catch((e) => e);
    expect(err).toBeInstanceOf(PushSetupError);
    expect(err.phase).toBe('relay');
    expect(err.message).toContain('Invalid fcmToken');
  });

  it('tags a Firebase token failure with the token phase', async () => {
    const native = (NativeModules as { BulwarkFcm: { getToken: ReturnType<typeof vi.fn> } }).BulwarkFcm;
    native.getToken.mockRejectedValueOnce(new Error('SERVICE_NOT_AVAILABLE'));
    const err = await setupPushNotifications({ relayBaseUrl: RELAY }).catch((e) => e);
    expect(err.phase).toBe('token');
    expect(err.message).toContain('SERVICE_NOT_AVAILABLE');
  });
});

describe('push types for device sync (#34)', () => {
  const DEVICE_SYNC_KEY = 'device-sync:v1';
  const CONTACTS = 'com.android.contacts';
  const CALENDAR = 'com.android.calendar';
  const healthy = (types: string[]) => ({
    id: 'existing',
    deviceClientId: OUR_DCID,
    expires: new Date(Date.now() + 80 * 86400000).toISOString(),
    types,
  });

  async function syncing(enabled: Record<string, boolean>, extra: Record<string, unknown> = {}): Promise<void> {
    await AsyncStorage.setItem(DEVICE_SYNC_KEY, JSON.stringify({
      state: { accounts: { [ACCOUNT_ID]: { enabled, ...extra } } },
      version: 0,
    }));
  }

  // A server that does not know a type refuses the whole write.
  const refuseUnknownTypes = (types: string[] | undefined) => {
    const unknown = (types ?? []).filter((type) => type !== 'EmailDelivery');
    if (unknown.length > 0) throw new JMAPMethodError('invalidProperties', `Unknown types: ${unknown.join(', ')}`);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(deviceClientIdKey(ACCOUNT_ID), OUR_DCID);
    (jmapClient as { currentSession: unknown }).currentSession = SYNC_SESSION;
    DETACHED.session = SYNC_SESSION;
    listMock.mockResolvedValue([]);
    updateMock.mockResolvedValue(true);
    installFetch({});
  });

  afterEach(() => {
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: { 'urn:ietf:params:jmap:core': {} },
    };
    DETACHED.session = SYNC_SESSION;
    createMock.mockImplementation(async () => CREATED);
    updateMock.mockImplementation(async () => undefined);
  });

  it('adds the contact and calendar types of what the account syncs to the device', async () => {
    expect(await pushTypesFor(ACCOUNT_ID, SYNC_SESSION as unknown as JMAPSession)).toEqual(['EmailDelivery']);
    await syncing({ [CONTACTS]: true, [CALENDAR]: false });
    expect(await pushTypesFor(ACCOUNT_ID, SYNC_SESSION as unknown as JMAPSession))
      .toEqual(['EmailDelivery', 'ContactCard', 'AddressBook']);
    expect(await pushTypesFor('someone@else.example', SYNC_SESSION as unknown as JMAPSession)).toEqual(['EmailDelivery']);
    // Removed in Android Settings: nothing to route any more.
    await syncing({ [CONTACTS]: true }, { removedInAndroidSettings: true });
    expect(await pushTypesFor(ACCOUNT_ID, SYNC_SESSION as unknown as JMAPSession)).toEqual(['EmailDelivery']);
  });

  it('adds only the types of what the server offers', async () => {
    await syncing({ [CONTACTS]: true, [CALENDAR]: true });
    const calendarsOnly = { capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:calendars': {} } };
    expect(await pushTypesFor(ACCOUNT_ID, calendarsOnly as unknown as JMAPSession))
      .toEqual(['EmailDelivery', 'CalendarEvent', 'Calendar']);
    expect(await pushTypesFor(ACCOUNT_ID, null)).toEqual(['EmailDelivery']);

    // Sync was turned on while another account's server was served; this one
    // has neither: its subscription stays mail-only.
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: { 'urn:ietf:params:jmap:core': {} },
    };
    createMock.mockImplementation(async (params: { types: string[] }) => {
      refuseUnknownTypes(params.types);
      return CREATED;
    });
    const result = await setupPushNotifications({ relayBaseUrl: RELAY });
    expect(result.subscriptionId).toBe('new-server-id');
    expect(createMock.mock.calls.map((c) => c[0].types)).toEqual([['EmailDelivery']]);
  });

  it("does not add types another account's server does not offer", async () => {
    const OTHER = 'bob@other.example.net';
    await AsyncStorage.setItem(`push:subscriptionId:v2:${OTHER}`, 'bob-sub');
    await AsyncStorage.setItem(DEVICE_SYNC_KEY, JSON.stringify({
      state: { accounts: { [OTHER]: { enabled: { [CONTACTS]: true } } } },
      version: 0,
    }));
    DETACHED.session = { capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:calendars': {} } };
    DETACHED.log = [];
    DETACHED.types = ['EmailDelivery'];
    await refreshPushSubscriptionTypes(OTHER);
    expect(DETACHED.log.map((entry) => (entry as unknown[])[0])).toEqual(['load', 'PushSubscription/get']);
  });

  it('keeps mail push on a server that refuses the device sync types', async () => {
    await syncing({ [CONTACTS]: true });
    createMock.mockImplementation(async (params: { types: string[] }) => {
      refuseUnknownTypes(params.types);
      return CREATED;
    });
    updateMock.mockImplementation(async (_id: string, patch: { types?: string[] }) => refuseUnknownTypes(patch.types));

    // A new subscription: mail-only rather than none.
    const created = await setupPushNotifications({ relayBaseUrl: RELAY });
    expect(created).toEqual({ subscriptionId: 'new-server-id', verified: true });
    expect(createMock.mock.calls.map((c) => c[0].types))
      .toEqual([['EmailDelivery', 'ContactCard', 'AddressBook'], ['EmailDelivery']]);

    // The working subscription is kept and its expiry pushed forward, never
    // replaced by one the server refuses as well.
    vi.clearAllMocks();
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([healthy(['EmailDelivery'])]);
    const refreshed = await setupPushNotifications({ relayBaseUrl: RELAY });
    expect(refreshed.subscriptionId).toBe('existing');
    expect(updateMock.mock.calls.map((c) => c[1].types)).toEqual([['EmailDelivery', 'ContactCard', 'AddressBook'], undefined]);
    expect(updateMock.mock.calls[1][1].expires).toBeDefined();
    expect(createMock).not.toHaveBeenCalled();
    expect(destroyMock).not.toHaveBeenCalled();
  });

  it("retries with the mail types alone when Stalwart refuses the types property", async () => {
    await syncing({ [CONTACTS]: true });
    // Stalwart's own answer to a type it doesn't know.
    createMock.mockRejectedValueOnce(new JMAPSetError('invalidProperties', 'Invalid data type.', ['types']));
    await setupPushNotifications({ relayBaseUrl: RELAY });
    expect(createMock.mock.calls.map((c) => c[0].types))
      .toEqual([['EmailDelivery', 'ContactCard', 'AddressBook'], ['EmailDelivery']]);
  });

  it('does not drop the device sync types over a failure that is not about them', async () => {
    await syncing({ [CONTACTS]: true });
    for (const failure of [
      new Error('Network request failed'),
      new JMAPSetError('invalidProperties', 'Host is not a public domain name', ['url']),
      new JMAPSetError('overQuota', 'There are too many subscriptions'),
    ]) {
      createMock.mockClear();
      createMock.mockRejectedValueOnce(failure);
      const err = await setupPushNotifications({ relayBaseUrl: RELAY }).catch((e) => e);
      expect(err).toBeInstanceOf(PushSetupError);
      expect(createMock.mock.calls.map((c) => c[0].types)).toEqual([['EmailDelivery', 'ContactCard', 'AddressBook']]);
    }

    // The next attempt (the next launch) subscribes with them.
    createMock.mockClear();
    await setupPushNotifications({ relayBaseUrl: RELAY });
    expect(createMock.mock.calls.map((c) => c[0].types)).toEqual([['EmailDelivery', 'ContactCard', 'AddressBook']]);
  });

  it('subscribes with them', async () => {
    await syncing({ [CALENDAR]: true });
    await setupPushNotifications({ relayBaseUrl: RELAY });
    expect(createMock.mock.calls[0][0].types).toEqual(['EmailDelivery', 'CalendarEvent', 'Calendar']);
  });

  it('patches a subscription made before sync was turned on', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([healthy(['EmailDelivery'])]);
    await syncing({ [CONTACTS]: true, [CALENDAR]: true });
    await setupPushNotifications({ relayBaseUrl: RELAY });
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock.mock.calls[0][1].types)
      .toEqual(['EmailDelivery', 'ContactCard', 'AddressBook', 'CalendarEvent', 'Calendar']);
  });

  it('re-applies the types after a toggle', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([healthy(['EmailDelivery'])]);
    await syncing({ [CONTACTS]: true });
    await refreshPushSubscriptionTypes(ACCOUNT_ID);
    expect(updateMock).toHaveBeenCalledWith('existing', { types: ['EmailDelivery', 'ContactCard', 'AddressBook'] });

    // An account without a push subscription has nothing to patch.
    updateMock.mockClear();
    DETACHED.log = [];
    await refreshPushSubscriptionTypes('someone@else.example');
    expect(updateMock).not.toHaveBeenCalled();
    expect(DETACHED.log).toEqual([]);

    // Already what it should be, in another order: nothing to send.
    listMock.mockResolvedValue([healthy(['AddressBook', 'EmailDelivery', 'ContactCard'])]);
    await refreshPushSubscriptionTypes(ACCOUNT_ID);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("patches another account's subscription through a client of its own", async () => {
    const OTHER = 'bob@other.example.net';
    await AsyncStorage.setItem(`push:subscriptionId:v2:${OTHER}`, 'bob-sub');
    await AsyncStorage.setItem(DEVICE_SYNC_KEY, JSON.stringify({
      state: { accounts: { [OTHER]: { enabled: { [CALENDAR]: true } } } },
      version: 0,
    }));
    DETACHED.log = [];
    DETACHED.types = ['EmailDelivery'];
    await refreshPushSubscriptionTypes(OTHER);
    expect(DETACHED.log).toEqual([
      ['load', OTHER],
      ['PushSubscription/get', { ids: ['bob-sub'], properties: ['id', 'deviceClientId', 'types'] }],
      ['PushSubscription/set', { update: { 'bob-sub': { types: ['EmailDelivery', 'CalendarEvent', 'Calendar'] } } }],
    ]);
    // The singleton's subscriptions were not touched.
    expect(updateMock).not.toHaveBeenCalled();

    // Already right: read, nothing written.
    DETACHED.log = [];
    DETACHED.types = ['Calendar', 'CalendarEvent', 'EmailDelivery'];
    await refreshPushSubscriptionTypes(OTHER);
    expect(DETACHED.log.map((entry) => (entry as unknown[])[0])).toEqual(['load', 'PushSubscription/get']);
  });

  it("leaves alone another client's subscription that reuses the recorded id", async () => {
    // Stalwart gives a destroyed subscription's id to the next one, such as
    // the webmail's on the same account.
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([{ ...healthy(['EmailDelivery']), deviceClientId: 'webmailwebmailwebmailwebmailwebm' }]);
    await syncing({ [CONTACTS]: true });
    await refreshPushSubscriptionTypes(ACCOUNT_ID);
    expect(updateMock).not.toHaveBeenCalled();

    // The same through another account's client.
    const OTHER = 'bob@other.example.net';
    await AsyncStorage.setItem(`push:subscriptionId:v2:${OTHER}`, 'b');
    await AsyncStorage.setItem(deviceClientIdKey(OTHER), 'bobsphonebobsphonebobsphonebobsp');
    await AsyncStorage.setItem(DEVICE_SYNC_KEY, JSON.stringify({
      state: { accounts: { [OTHER]: { enabled: { [CALENDAR]: true } } } },
      version: 0,
    }));
    DETACHED.log = [];
    DETACHED.types = ['EmailDelivery'];
    DETACHED.deviceClientId = 'webmailwebmailwebmailwebmailwebm';
    try {
      await refreshPushSubscriptionTypes(OTHER);
      expect(DETACHED.log.map((entry) => (entry as unknown[])[0])).toEqual(['load', 'PushSubscription/get']);

      // Its own subscription still gets the types.
      DETACHED.log = [];
      DETACHED.deviceClientId = 'bobsphonebobsphonebobsphonebobsp';
      await refreshPushSubscriptionTypes(OTHER);
      expect(DETACHED.log.map((entry) => (entry as unknown[])[0])).toEqual(['load', 'PushSubscription/get', 'PushSubscription/set']);
    } finally {
      DETACHED.deviceClientId = null;
    }
  });

  it('leaves the subscription of an account that turned push off alone', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    await AsyncStorage.setItem(`push:optedOut:v1:${ACCOUNT_ID}`, '1');
    listMock.mockResolvedValue([healthy(['EmailDelivery'])]);
    await syncing({ [CONTACTS]: true });
    await refreshPushSubscriptionTypes(ACCOUNT_ID);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('setupPushNotifications with ACL-shared accounts on Stalwart 0.16.16-0.16.23 (B18)', () => {
  const REFUSED_KEY = 'push:emailPushRefused:v1:' + ACCOUNT_ID;
  const sharedMock = getSharedMailboxes as ReturnType<typeof vi.fn>;
  const verifyMock = verifyPushSubscription as ReturnType<typeof vi.fn>;
  // 0.16.16 to 0.16.23 list emailpush on every account, ACL shares included.
  const calendars = (mayCreateCalendar: boolean) => ({
    'urn:ietf:params:jmap:emailpush': {},
    'urn:ietf:params:jmap:calendars': { mayCreateCalendar },
  });
  // What Stalwart puts in the session: a group the user belongs to and a
  // mailbox another user shared by ACL look alike except for the create flags.
  const SESSION = {
    capabilities: { 'urn:ietf:params:jmap:emailpush': {} },
    accounts: {
      'jmap-primary': { name: 'user', isPersonal: true, isReadOnly: false, accountCapabilities: calendars(true) },
      team: { name: 'team', isPersonal: false, isReadOnly: false, accountCapabilities: calendars(true) },
      'acl-b': { name: 'userb', isPersonal: false, isReadOnly: false, accountCapabilities: calendars(false) },
    },
  };
  // The refusal is a SetError on the subscription (`notCreated` /
  // `notUpdated`), not a method error.
  const forbidden = () =>
    new JMAPSetError('forbidden', 'No access to one of the accounts in the emailPush map.');
  // Stalwart refuses the whole map as soon as it names an account the user
  // doesn't own; `allowed` is what it accepts.
  const refuseUnless = (allowed: string[]) => (emailPush?: Record<string, EmailPushConfig>) => {
    if (emailPush && Object.keys(emailPush).some((id) => !allowed.includes(id))) throw forbidden();
  };
  const healthy = () => ({
    id: 'existing',
    deviceClientId: OUR_DCID,
    expires: new Date(Date.now() + 80 * 86400000).toISOString(),
    types: ['EmailDelivery'],
  });
  const mapKeys = (emailPush: Record<string, EmailPushConfig> | undefined) =>
    Object.keys(emailPush ?? {}).sort();

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(deviceClientIdKey(ACCOUNT_ID), OUR_DCID);
    (jmapClient as { currentSession: unknown }).currentSession = SESSION;
    sharedMock.mockResolvedValue([
      { id: 'team:inbox', originalId: 'inbox', role: 'inbox', accountId: 'team' },
      { id: 'acl-b:inbox', originalId: 'inbox', role: 'inbox', accountId: 'acl-b' },
    ]);
    listMock.mockResolvedValue([]);
    installFetch({});
  });

  afterEach(() => {
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: { 'urn:ietf:params:jmap:core': {} },
    };
    sharedMock.mockResolvedValue([]);
    createMock.mockImplementation(async () => CREATED);
    updateMock.mockImplementation(async () => undefined);
  });

  it('narrows a refused map on refresh instead of destroying the working subscription', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([healthy()]);
    const accept = refuseUnless(['jmap-primary', 'team']);
    updateMock.mockImplementation(async (_id: string, patch: { emailPush?: Record<string, EmailPushConfig> }) =>
      accept(patch.emailPush),
    );

    const result = await setupPushNotifications({ relayBaseUrl: RELAY });

    expect(result.subscriptionId).toBe('existing');
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(mapKeys(updateMock.mock.calls[0][1].emailPush)).toEqual(['acl-b', 'jmap-primary', 'team']);
    // The group keeps its junk filter; only the ACL share is dropped.
    expect(mapKeys(updateMock.mock.calls[1][1].emailPush)).toEqual(['jmap-primary', 'team']);
    expect(destroyMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(SUB_KEY)).toBe('existing');
    expect(JSON.parse((await AsyncStorage.getItem(REFUSED_KEY))!)).toEqual(['acl-b']);
  });

  it('leaves a remembered refusal out of the map on the next run', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    await AsyncStorage.setItem(REFUSED_KEY, JSON.stringify(['acl-b']));
    listMock.mockResolvedValue([healthy()]);
    const accept = refuseUnless(['jmap-primary', 'team']);
    updateMock.mockImplementation(async (_id: string, patch: { emailPush?: Record<string, EmailPushConfig> }) =>
      accept(patch.emailPush),
    );

    await setupPushNotifications({ relayBaseUrl: RELAY });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(mapKeys(updateMock.mock.calls[0][1].emailPush)).toEqual(['jmap-primary', 'team']);
  });

  it('falls back to the primary account alone when the group is refused too', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([healthy()]);
    const accept = refuseUnless(['jmap-primary']);
    updateMock.mockImplementation(async (_id: string, patch: { emailPush?: Record<string, EmailPushConfig> }) =>
      accept(patch.emailPush),
    );

    const result = await setupPushNotifications({ relayBaseUrl: RELAY });

    expect(result.subscriptionId).toBe('existing');
    expect(updateMock).toHaveBeenCalledTimes(3);
    expect(mapKeys(updateMock.mock.calls[2][1].emailPush)).toEqual(['jmap-primary']);
    expect(JSON.parse((await AsyncStorage.getItem(REFUSED_KEY))!).sort()).toEqual(['acl-b', 'team']);
  });

  it('narrows a refused map when creating a subscription', async () => {
    const accept = refuseUnless(['jmap-primary', 'team']);
    createMock.mockImplementation(async (params: { emailPush?: Record<string, EmailPushConfig> }) => {
      accept(params.emailPush);
      return CREATED;
    });

    const result = await setupPushNotifications({ relayBaseUrl: RELAY });

    expect(result).toEqual({ subscriptionId: 'new-server-id', verified: true });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(mapKeys(createMock.mock.calls[1][0].emailPush)).toEqual(['jmap-primary', 'team']);
    expect(await AsyncStorage.getItem(SUB_KEY)).toBe('new-server-id');
  });

  it('does not retry other refusals with a narrower map', async () => {
    createMock.mockImplementation(async () => {
      throw new JMAPMethodError('overQuota', 'There are too many subscriptions.');
    });

    const err = await setupPushNotifications({ relayBaseUrl: RELAY }).catch((e) => e);

    expect(err).toBeInstanceOf(PushSetupError);
    expect(err.phase).toBe('jmap');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('destroys the replaced subscription only after the new one is verified', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([healthy()]);

    await setupPushNotifications({ relayBaseUrl: RELAY, forceRecreate: true });

    const destroyOrder = destroyMock.mock.invocationCallOrder[
      destroyMock.mock.calls.findIndex((c) => c[0] === 'existing')
    ];
    expect(destroyOrder).toBeGreaterThan(verifyMock.mock.invocationCallOrder[0]);
    expect(await AsyncStorage.getItem(SUB_KEY)).toBe('new-server-id');
  });

  it('keeps the working subscription when its replacement is refused', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([healthy()]);
    createMock.mockImplementation(async () => {
      throw forbidden();
    });

    const err = await setupPushNotifications({ relayBaseUrl: RELAY, forceRecreate: true }).catch((e) => e);

    expect(err.phase).toBe('jmap');
    expect(destroyMock.mock.calls.map((c) => c[0])).not.toContain('existing');
    expect(await AsyncStorage.getItem(SUB_KEY)).toBe('existing');
  });

  it('does not narrow the map when the whole call is refused as forbidden', async () => {
    // A method-level `forbidden` (no permission to subscribe at all) says
    // nothing about the accounts in the map.
    createMock.mockImplementation(async () => {
      throw new JMAPMethodError('forbidden', 'You do not have enough permissions.');
    });

    const err = await setupPushNotifications({ relayBaseUrl: RELAY }).catch((e) => e);

    expect(err).toBeInstanceOf(PushSetupError);
    expect(err.phase).toBe('jmap');
    expect(err.message).toBe("The mail server doesn't allow background notifications for this account.");
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(REFUSED_KEY)).toBeNull();
  });

  it('explains a refused create when the server has too many subscriptions', async () => {
    createMock.mockImplementation(async () => {
      throw new JMAPSetError('overQuota', 'There are too many push subscriptions, please delete some.');
    });

    const err = await setupPushNotifications({ relayBaseUrl: RELAY }).catch((e) => e);

    expect(err.phase).toBe('jmap');
    expect(err.message).toContain('too many push registrations on the mail server');
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe('setupPushNotifications with ACL-shared accounts on Stalwart 1.0', () => {
  const REFUSED_KEY = 'push:emailPushRefused:v1:' + ACCOUNT_ID;
  const sharedMock = getSharedMailboxes as ReturnType<typeof vi.fn>;
  const OWNER = { accountIdForPrincipal: 'jmap-primary', principalId: 'jmap-primary' };
  // 1.0 lists emailpush on the user's own account and their groups only; an
  // ACL share lacks it (and Submission, Sieve, VacationResponse, Quota), and
  // every account carries principals:owner (jmap/src/api/session.rs).
  const SESSION_1_0 = {
    capabilities: { 'urn:ietf:params:jmap:emailpush': {}, 'urn:ietf:params:jmap:metadata': {} },
    accounts: {
      'jmap-primary': {
        name: 'user',
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {
          'urn:ietf:params:jmap:mail': {},
          'urn:ietf:params:jmap:emailpush': {},
          'urn:ietf:params:jmap:principals:owner': OWNER,
        },
      },
      team: {
        name: 'team',
        isPersonal: false,
        isReadOnly: false,
        accountCapabilities: {
          'urn:ietf:params:jmap:mail': {},
          'urn:ietf:params:jmap:emailpush': {},
          'urn:ietf:params:jmap:principals:owner': { ...OWNER, principalId: 'team' },
        },
      },
      'acl-b': {
        name: 'userb',
        isPersonal: false,
        isReadOnly: true,
        accountCapabilities: {
          'urn:ietf:params:jmap:mail': {},
          'urn:ietf:params:jmap:principals:owner': { ...OWNER, principalId: 'acl-b' },
        },
      },
    },
  };
  const mapKeys = (emailPush: Record<string, EmailPushConfig> | undefined) =>
    Object.keys(emailPush ?? {}).sort();

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(deviceClientIdKey(ACCOUNT_ID), OUR_DCID);
    (jmapClient as { currentSession: unknown }).currentSession = SESSION_1_0;
    sharedMock.mockResolvedValue([
      { id: 'team:inbox', originalId: 'inbox', role: 'inbox', accountId: 'team' },
      { id: 'acl-b:inbox', originalId: 'inbox', role: 'inbox', accountId: 'acl-b' },
    ]);
    listMock.mockResolvedValue([]);
    installFetch({});
  });

  afterEach(() => {
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: { 'urn:ietf:params:jmap:core': {} },
    };
    sharedMock.mockResolvedValue([]);
  });

  it('leaves the ACL share out of the map up front, without a refused call', async () => {
    const result = await setupPushNotifications({ relayBaseUrl: RELAY });

    expect(result.verified).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(mapKeys(createMock.mock.calls[0][0].emailPush)).toEqual(['jmap-primary', 'team']);
    expect(await AsyncStorage.getItem(REFUSED_KEY)).toBeNull();
  });

  it('ignores accounts remembered as refused while the server was on 0.16', async () => {
    await AsyncStorage.setItem(REFUSED_KEY, JSON.stringify(['team']));

    await setupPushNotifications({ relayBaseUrl: RELAY });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(mapKeys(createMock.mock.calls[0][0].emailPush)).toEqual(['jmap-primary', 'team']);
  });

  it('adds the group to an existing map in one update, leaving the ACL share out', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    const filter = { filter: { operator: 'AND', conditions: [{ notKeyword: '$junk' }] }, properties: ['id', 'threadId'], urgency: 'high' };
    listMock.mockResolvedValue([{
      id: 'existing',
      deviceClientId: OUR_DCID,
      expires: new Date(Date.now() + 80 * 86400000).toISOString(),
      types: ['EmailDelivery'],
      emailPush: { 'jmap-primary': filter },
    }]);

    const result = await setupPushNotifications({ relayBaseUrl: RELAY });

    expect(result.subscriptionId).toBe('existing');
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(mapKeys(updateMock.mock.calls[0][1].emailPush)).toEqual(['jmap-primary', 'team']);
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('setupPushNotifications when the server cannot be asked', () => {
  const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
  const dueForRefresh = () => ({ id: 'existing', deviceClientId: OUR_DCID, expires: inDays(3), types: ['EmailDelivery'] });
  const named = (name: string, message: string) => Object.assign(new Error(message), { name });

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(deviceClientIdKey(ACCOUNT_ID), OUR_DCID);
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: { 'urn:ietf:params:jmap:core': {} },
    };
    installFetch({});
  });

  afterEach(() => {
    listMock.mockImplementation(async () => []);
    updateMock.mockImplementation(async () => undefined);
  });

  it.each([false, true])('keeps the subscription and its key when listing fails (forceRecreate: %s)', async (forceRecreate) => {
    listMock.mockRejectedValue(named('NetworkError', 'Network request failed'));

    const err = await setupPushNotifications({ relayBaseUrl: RELAY, forceRecreate }).catch((e) => e);

    expect(err).toBeInstanceOf(PushSetupError);
    expect(err.phase).toBe('jmap');
    expect(err.message).toContain('Network request failed');
    expect(createMock).not.toHaveBeenCalled();
    expect(destroyMock).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(SUB_KEY)).toBe('existing');
  });

  it.each([
    ['a network error', named('NetworkError', 'Network request failed')],
    ['a timeout', named('RequestTimeoutError', 'Request timed out after 30s')],
    ['rate limiting', named('RateLimitError', 'Rate limited by server')],
    ['a refused method call', new JMAPMethodError('serverFail', 'Store unavailable')],
  ])('keeps a working subscription when its refresh fails with %s', async (_what, error) => {
    listMock.mockResolvedValue([dueForRefresh()]);
    updateMock.mockRejectedValue(error);

    const err = await setupPushNotifications({ relayBaseUrl: RELAY }).catch((e) => e);

    expect(err).toBeInstanceOf(PushSetupError);
    expect(err.phase).toBe('jmap');
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
    expect(destroyMock).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(SUB_KEY)).toBe('existing');
  });

  it('replaces the subscription when the server says it is gone, destroying it after verification', async () => {
    listMock.mockResolvedValue([dueForRefresh()]);
    updateMock.mockRejectedValue(new JMAPSetError('notFound'));
    const verifyMock = verifyPushSubscription as ReturnType<typeof vi.fn>;

    const result = await setupPushNotifications({ relayBaseUrl: RELAY });

    expect(result.subscriptionId).toBe('new-server-id');
    expect(createMock).toHaveBeenCalledTimes(1);
    const destroyOrder = destroyMock.mock.invocationCallOrder[
      destroyMock.mock.calls.findIndex((c) => c[0] === 'existing')
    ];
    expect(destroyOrder).toBeGreaterThan(verifyMock.mock.invocationCallOrder[0]);
    expect(await AsyncStorage.getItem(SUB_KEY)).toBe('new-server-id');
  });
});

describe('mailAccountsWithoutPush', () => {
  const REFUSED_KEY = 'push:emailPushRefused:v1:' + ACCOUNT_ID;
  const account = (isPersonal: boolean, caps: Record<string, unknown>, isReadOnly = false) => ({
    name: 'x', isPersonal, isReadOnly, accountCapabilities: caps,
  });
  const owned = { 'urn:ietf:params:jmap:calendars': { mayCreateCalendar: true } };
  const aclShared = { 'urn:ietf:params:jmap:calendars': { mayCreateCalendar: false } };
  const emailPush = { 'urn:ietf:params:jmap:emailpush': {} };

  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  afterEach(() => {
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: { 'urn:ietf:params:jmap:core': {} },
    };
  });

  it('names the accounts without emailpush on Stalwart 1.0', async () => {
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: emailPush,
      accounts: {
        'jmap-primary': account(true, { ...owned, ...emailPush }),
        team: account(false, { ...owned, ...emailPush }),
        'acl-b': account(false, aclShared, true),
      },
    };
    expect(await mailAccountsWithoutPush(['team', 'acl-b', 'acl-b', 'jmap-primary'])).toEqual(['acl-b']);
  });

  it('falls back to refused and not-owned accounts on Stalwart 0.16.16-0.16.23', async () => {
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: emailPush,
      accounts: {
        'jmap-primary': account(true, { ...owned, ...emailPush }),
        team: account(false, { ...owned, ...emailPush }),
        'acl-b': account(false, { ...aclShared, ...emailPush }),
        'acl-c': account(false, { ...owned, ...emailPush }),
      },
    };
    expect(await mailAccountsWithoutPush(['team', 'acl-b'])).toEqual(['acl-b']);
    // An account the server refused in the map, whatever it looks like.
    await AsyncStorage.setItem(REFUSED_KEY, JSON.stringify(['acl-c']));
    expect(await mailAccountsWithoutPush(['team', 'acl-b', 'acl-c'])).toEqual(['acl-b', 'acl-c']);
  });

  it('judges by ownership alone on Stalwart 0.16.6-0.16.15, which has no emailpush', async () => {
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: {},
      accounts: {
        'jmap-primary': account(true, owned),
        team: account(false, owned),
        'acl-b': account(false, aclShared),
      },
    };
    expect(await mailAccountsWithoutPush(['team', 'acl-b'])).toEqual(['acl-b']);
  });

  it('names nothing for the user\'s own mailboxes', async () => {
    expect(await mailAccountsWithoutPush(['jmap-primary'])).toEqual([]);
    expect(await mailAccountsWithoutPush([])).toEqual([]);
  });

  it('takes the emailpush capability as the whole answer on Stalwart 1.0 (principals:owner)', async () => {
    const owner = (principalId: string) => ({
      'urn:ietf:params:jmap:principals:owner': { accountIdForPrincipal: 'jmap-primary', principalId },
    });
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: emailPush,
      accounts: {
        'jmap-primary': account(true, { ...owned, ...emailPush, ...owner('jmap-primary') }),
        // A group with mail only: no calendars, contacts or files to tell
        // that the user belongs to it.
        'mail-group': account(false, { ...emailPush, ...owner('mail-group') }),
      },
    };
    expect(await mailAccountsWithoutPush(['mail-group'])).toEqual([]);
    // Nor does a refusal remembered while the server was on 0.16 count.
    await AsyncStorage.setItem(REFUSED_KEY, JSON.stringify(['mail-group']));
    expect(await mailAccountsWithoutPush(['mail-group'])).toEqual([]);
  });
});

describe('setupPushNotifications at the server\'s subscription limit', () => {
  const overQuota = () => new JMAPSetError('overQuota', 'There are too many push subscriptions, please delete some.');
  const recorded = (expiresInDays: number) => ({
    id: 'existing',
    deviceClientId: OUR_DCID,
    expires: new Date(Date.now() + expiresInDays * 86400000).toISOString(),
    types: ['EmailDelivery'],
  });
  const verifyMock = verifyPushSubscription as ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(deviceClientIdKey(ACCOUNT_ID), OUR_DCID);
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    await AsyncStorage.setItem('push:relayBaseUrl:v1', RELAY);
    listMock.mockResolvedValue([recorded(80)]);
    installFetch({});
  });

  afterEach(() => {
    listMock.mockImplementation(async () => []);
    createMock.mockImplementation(async () => CREATED);
    updateMock.mockImplementation(async () => undefined);
  });

  it('keeps the working record when a forced re-register moves to another relay', async () => {
    // Stalwart answers overQuota before it looks at the URL; freeing a place
    // would only lead to the new relay being refused with the old record gone.
    let attempts = 0;
    createMock.mockImplementation(async () => {
      attempts += 1;
      throw attempts === 1
        ? overQuota()
        : new JMAPSetError('invalidProperties', 'Host is not a public domain name', ['url']);
    });

    const err = await setupPushNotifications({ relayBaseUrl: 'https://relay.home.lan', forceRecreate: true }).catch((e) => e);

    expect(err).toBeInstanceOf(PushSetupError);
    expect(err.message).toContain('too many push registrations on the mail server');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(destroyMock.mock.calls.map((c) => c[0])).not.toContain('existing');
    expect(await AsyncStorage.getItem(SUB_KEY)).toBe('existing');
  });

  it('a forced re-register frees the old record\'s place and tries once more', async () => {
    createMock.mockRejectedValueOnce(overQuota());

    const result = await setupPushNotifications({ relayBaseUrl: RELAY, forceRecreate: true });

    expect(result).toEqual({ subscriptionId: 'new-server-id', verified: true });
    expect(createMock).toHaveBeenCalledTimes(2);
    const oldDestroys = destroyMock.mock.calls.flatMap((c, i) => (c[0] === 'existing' ? [destroyMock.mock.invocationCallOrder[i]] : []));
    // Once, between the refused create and the retry - not again after verification.
    expect(oldDestroys).toHaveLength(1);
    expect(oldDestroys[0]).toBeGreaterThan(createMock.mock.invocationCallOrder[0]);
    expect(oldDestroys[0]).toBeLessThan(createMock.mock.invocationCallOrder[1]);
    expect(verifyMock).toHaveBeenCalledWith('new-server-id', 'CODE');
    expect(await AsyncStorage.getItem(SUB_KEY)).toBe('new-server-id');
  });

  it('retries only once, and says why when the limit still refuses', async () => {
    createMock.mockImplementation(async () => {
      throw overQuota();
    });

    const err = await setupPushNotifications({ relayBaseUrl: RELAY, forceRecreate: true }).catch((e) => e);

    expect(err).toBeInstanceOf(PushSetupError);
    expect(err.phase).toBe('jmap');
    expect(err.message).toContain('too many push registrations on the mail server');
    expect(createMock).toHaveBeenCalledTimes(2);
    // The old record is gone, and so is its key.
    expect(await AsyncStorage.getItem(SUB_KEY)).toBeNull();
  });

  it('keeps the old record when its removal fails', async () => {
    createMock.mockRejectedValueOnce(overQuota());
    destroyMock.mockRejectedValueOnce(new Error('Network request failed'));

    const err = await setupPushNotifications({ relayBaseUrl: RELAY, forceRecreate: true }).catch((e) => e);

    expect(err).toBeInstanceOf(PushSetupError);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(SUB_KEY)).toBe('existing');
  });

  it('never gives up a working record for a replacement the user did not ask for', async () => {
    // The refresh is refused, so the setup replaces the record by itself.
    listMock.mockResolvedValue([recorded(1)]);
    updateMock.mockRejectedValue(new JMAPSetError('invalidProperties'));
    createMock.mockImplementation(async () => {
      throw overQuota();
    });

    const err = await setupPushNotifications({ relayBaseUrl: RELAY }).catch((e) => e);

    expect(err.phase).toBe('jmap');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(destroyMock.mock.calls.map((c) => c[0])).not.toContain('existing');
    expect(await AsyncStorage.getItem(SUB_KEY)).toBe('existing');
  });
});

describe('setupPushNotifications over UnifiedPush', () => {
  type UpNative = {
    getDistributors: ReturnType<typeof vi.fn>;
    getSavedDistributor: ReturnType<typeof vi.fn>;
    register: ReturnType<typeof vi.fn>;
    getEndpoint: ReturnType<typeof vi.fn>;
  };
  const upNative = () => (NativeModules as { BulwarkUnifiedPush: UpNative }).BulwarkUnifiedPush;

  // Like installFetch, plus the two UnifiedPush relay endpoints; captures the
  // registration body so tests can assert on it.
  function installUpFetch(): { body: () => Record<string, unknown> | null } {
    let captured: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/push/vapid-public-key')) {
        return { ok: true, status: 200, json: async () => ({ publicKey: 'VAPID-PUB' }) } as Response;
      }
      if (url.includes('/api/push/register/unifiedpush')) {
        captured = JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>;
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      if (url.includes('/api/push/verify/')) {
        return { ok: true, status: 200, json: async () => ({ verificationCode: 'CODE' }) } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    return { body: () => captured };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(deviceClientIdKey(ACCOUNT_ID), OUR_DCID);
    await AsyncStorage.setItem('push:transport:v1', 'unifiedpush');
    listMock.mockResolvedValue([]);
  });

  it('registers the distributor endpoint with the relay instead of an FCM token', async () => {
    const relayReg = installUpFetch();

    const result = await setupPushNotifications({ relayBaseUrl: RELAY });

    expect(result.verified).toBe(true);
    const native = (NativeModules as { BulwarkFcm: { getToken: ReturnType<typeof vi.fn> } }).BulwarkFcm;
    expect(native.getToken).not.toHaveBeenCalled();
    // The relay's VAPID key is handed to the distributor at registration.
    expect(upNative().register).toHaveBeenCalledWith('VAPID-PUB');
    expect(relayReg.body()).toEqual({
      subscriptionId: OUR_DCID,
      endpoint: 'https://ntfy.sh/upAbCdEf?up=1',
      keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
      accountLabel: undefined,
    });
    // The JMAP subscription flow is transport-independent.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('narrows a refused emailPush map over UnifiedPush as well (Stalwart 0.16.16+)', async () => {
    installUpFetch();
    const emailPush = { 'urn:ietf:params:jmap:emailpush': {} };
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: emailPush,
      accounts: {
        'jmap-primary': { name: 'user', isPersonal: true, isReadOnly: false, accountCapabilities: emailPush },
        'acl-b': { name: 'userb', isPersonal: false, isReadOnly: false, accountCapabilities: emailPush },
      },
    };
    (getSharedMailboxes as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'acl-b:inbox', originalId: 'inbox', role: 'inbox', accountId: 'acl-b' },
    ]);
    createMock.mockImplementation(async (params: { emailPush?: Record<string, EmailPushConfig> }) => {
      if (params.emailPush && 'acl-b' in params.emailPush) {
        throw new JMAPSetError('forbidden', 'No access to one of the accounts in the emailPush map.');
      }
      return CREATED;
    });

    try {
      const result = await setupPushNotifications({ relayBaseUrl: RELAY });
      expect(result.verified).toBe(true);
      expect(createMock).toHaveBeenCalledTimes(2);
      expect(Object.keys(createMock.mock.calls[1][0].emailPush)).toEqual(['jmap-primary']);
    } finally {
      (jmapClient as { currentSession: unknown }).currentSession = {
        capabilities: { 'urn:ietf:params:jmap:core': {} },
      };
      createMock.mockImplementation(async () => CREATED);
    }
  });

  it("puts the distributor back on the previous relay's VAPID key when the server refuses the new relay", async () => {
    await AsyncStorage.setItem('push:relayBaseUrl:v1', RELAY);
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([{ id: 'existing', deviceClientId: OUR_DCID, expires: new Date(Date.now() + 5 * 86400000).toISOString(), types: ['EmailDelivery'] }]);
    createMock.mockRejectedValueOnce(new JMAPSetError('invalidProperties', 'Host is not a public domain name', ['url']));
    const registered: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/push/vapid-public-key')) {
        const publicKey = url.startsWith(RELAY) ? 'VAPID-PUB' : 'VAPID-LAN';
        return { ok: true, status: 200, json: async () => ({ publicKey }) } as Response;
      }
      if (url.includes('/api/push/register')) {
        registered.push(`${init?.method ?? 'GET'} ${url}`);
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const err = await setupPushNotifications({ relayBaseUrl: 'https://relay.home.lan', forceRecreate: true }).catch((e) => e);

    expect(err).toBeInstanceOf(PushSetupError);
    expect(upNative().register.mock.calls.map((c) => c[0])).toEqual(['VAPID-LAN', 'VAPID-PUB']);
    expect(registered).toEqual([
      'POST https://relay.home.lan/api/push/register/unifiedpush',
      `DELETE https://relay.home.lan/api/push/register/${OUR_DCID}`,
      `POST ${RELAY}/api/push/register/unifiedpush`,
    ]);
    expect(await AsyncStorage.getItem('push:relayBaseUrl:v1')).toBe(RELAY);
  });

  it('sends keys: null for a legacy distributor without Web Push keys', async () => {
    upNative().getEndpoint.mockResolvedValue({
      url: 'https://legacy.example/up123456',
      p256dh: null,
      auth: null,
    });
    const relayReg = installUpFetch();

    await setupPushNotifications({ relayBaseUrl: RELAY });

    expect(relayReg.body()).toMatchObject({
      endpoint: 'https://legacy.example/up123456',
      keys: null,
    });
  });

  it('fails with the distributor phase when no distributor is installed', async () => {
    upNative().getDistributors.mockResolvedValue([]);
    installUpFetch();

    const err = await setupPushNotifications({ relayBaseUrl: RELAY }).catch((e) => e);

    expect(err).toBeInstanceOf(PushSetupError);
    expect(err.phase).toBe('distributor');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('requires an explicit choice when several distributors are installed', async () => {
    upNative().getDistributors.mockResolvedValue(['io.heckel.ntfy', 'org.unifiedpush.distributor.sunup']);
    upNative().getSavedDistributor.mockResolvedValue(null);
    installUpFetch();

    const err = await setupPushNotifications({ relayBaseUrl: RELAY }).catch((e) => e);

    expect(err.phase).toBe('distributor');
    expect(err.message).toContain('choose one');
  });
});

describe('resyncPushNotifications', () => {
  const OPTED_OUT_KEY = 'push:optedOut:v1:' + ACCOUNT_ID;
  const EXPIRES_KEY = 'push:subscriptionExpires:v1:' + ACCOUNT_ID;
  const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(deviceClientIdKey(ACCOUNT_ID), OUR_DCID);
    await AsyncStorage.setItem('push:relayBaseUrl:v1', RELAY);
    listMock.mockResolvedValue([]);
    installFetch({});
  });

  afterEach(() => {
    createMock.mockImplementation(async () => CREATED);
  });

  it('keeps a healthy registration up to date', async () => {
    const expires = inDays(3);
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([
      { id: 'existing', deviceClientId: OUR_DCID, expires, types: ['EmailDelivery'] },
    ]);

    const result = await resyncPushNotifications({ relayBaseUrl: RELAY });

    expect(result?.subscriptionId).toBe('existing');
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
    // The expiry the server reported is what a later resync measures against.
    expect(await AsyncStorage.getItem(EXPIRES_KEY)).toBe(expires);
  });

  it('records the expiry the server settled on after a refresh, not the one before it', async () => {
    const before = inDays(1);
    const after = inDays(7);
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValueOnce([{ id: 'existing', deviceClientId: OUR_DCID, expires: before, types: ['EmailDelivery'] }]);
    listMock.mockResolvedValueOnce([{ id: 'existing', deviceClientId: OUR_DCID, expires: after, types: ['EmailDelivery'] }]);

    await resyncPushNotifications({ relayBaseUrl: RELAY });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(EXPIRES_KEY)).toBe(after);
  });

  it('leaves an account alone after the user turned push off for it', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([ACCOUNT_ID]));
    listMock.mockResolvedValue([sub('existing', OUR_DCID)]);

    await disablePushForAccount(ACCOUNT_ID);
    vi.clearAllMocks();
    const result = await resyncPushNotifications({ relayBaseUrl: RELAY });

    expect(result).toBeNull();
    expect(listMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(await readPushAccountIds()).toEqual([]);
  });

  it('leaves push off after this device was revoked from the device list', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([sub('existing', OUR_DCID)]);

    await revokePushDevice({
      accountId: ACCOUNT_ID,
      device: { id: 'existing', deviceClientId: OUR_DCID, isThisDevice: true },
      relayBaseUrl: RELAY,
    });
    const result = await resyncPushNotifications({ relayBaseUrl: RELAY });

    expect(result).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('does not re-register a subscription another device revoked', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    await AsyncStorage.setItem(EXPIRES_KEY, inDays(5));
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([ACCOUNT_ID]));
    listMock.mockResolvedValue([]);

    const result = await resyncPushNotifications({ relayBaseUrl: RELAY });

    expect(result).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(SUB_KEY)).toBeNull();
    expect(await readPushAccountIds()).toEqual([]);
    expect(await AsyncStorage.getItem(OPTED_OUT_KEY)).not.toBeNull();
  });

  it("takes a recorded subscription whose id now names another client's for revoked", async () => {
    // Revoked here, then the webmail on the same account subscribed and got
    // the freed id.
    await AsyncStorage.setItem(SUB_KEY, 'b');
    await AsyncStorage.setItem(EXPIRES_KEY, inDays(5));
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([ACCOUNT_ID]));
    listMock.mockResolvedValue([
      { id: 'b', deviceClientId: 'webmailwebmailwebmailwebmailwebm', expires: inDays(7), types: ['EmailDelivery'] },
    ]);

    const result = await resyncPushNotifications({ relayBaseUrl: RELAY });

    expect(result).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
    expect(destroyMock.mock.calls.map((c) => c[0])).not.toContain('b');
    expect(await AsyncStorage.getItem(OPTED_OUT_KEY)).not.toBeNull();
  });

  it('re-creates the subscription once the server behind the account was replaced (0.16.23 to 1.0)', async () => {
    // A server reinstalled for Stalwart 1.0 holds none of the subscriptions,
    // which looks exactly like a revocation from elsewhere; the fingerprint
    // check tells them apart and forgets the recorded expiry.
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    await AsyncStorage.setItem(EXPIRES_KEY, inDays(5));
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([ACCOUNT_ID]));
    listMock.mockResolvedValue([]);

    await forgetPushServerState(ACCOUNT_ID);
    const result = await resyncPushNotifications({ relayBaseUrl: RELAY });

    expect(result?.subscriptionId).toBe('new-server-id');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(SUB_KEY)).toBe('new-server-id');
    expect(await readPushAccountIds()).toEqual([ACCOUNT_ID]);
    expect(await AsyncStorage.getItem(OPTED_OUT_KEY)).toBeNull();
  });

  it('re-creates the subscription when this build first sees a server replaced before it ran (0.16.23 to 1.0)', async () => {
    // Left by the released build, which recorded the expiry but no server
    // fingerprint, against the 0.16 server; the fresh 1.0 install holds no
    // subscriptions. The first check can't tell a replacement from none.
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    await AsyncStorage.setItem(EXPIRES_KEY, inDays(60));
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([ACCOUNT_ID]));
    listMock.mockResolvedValue([]);
    const session10 = {
      apiUrl: 'https://mail.example.com/jmap/',
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'jmap-primary' },
      accounts: {
        'jmap-primary': {
          name: 'user', isPersonal: true, isReadOnly: false,
          accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:principals:owner': {} },
        },
      },
      capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:metadata': {} },
    };

    expect(await reconcileServerFingerprint(ACCOUNT_ID, session10 as never)).toBe(false);
    const result = await resyncPushNotifications({ relayBaseUrl: RELAY });

    expect(result?.subscriptionId).toBe('new-server-id');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(await readPushAccountIds()).toEqual([ACCOUNT_ID]);
    expect(await AsyncStorage.getItem(OPTED_OUT_KEY)).toBeNull();
  });

  it('does not take over another device\'s subscription that reuses the recorded id', async () => {
    // Stalwart's ids are short and sequential: after a reinstall another
    // device's subscription can come back under the id this device recorded.
    await AsyncStorage.setItem(SUB_KEY, 'b');
    listMock.mockResolvedValue([
      { id: 'b', deviceClientId: 'otherotherotherotherotherotherot', expires: inDays(3), types: ['Email'] },
    ]);

    const result = await resyncPushNotifications({ relayBaseUrl: RELAY });

    expect(result?.subscriptionId).toBe('new-server-id');
    expect(updateMock).not.toHaveBeenCalled();
    // The relay can't vouch for it either way, so it stays.
    expect(destroyMock.mock.calls.map((c) => c[0])).not.toContain('b');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(SUB_KEY)).toBe('new-server-id');
  });

  it('still reuses a recorded subscription the server lists without a device client id', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([{ id: 'existing', expires: inDays(80), types: ['EmailDelivery'] }]);

    const result = await resyncPushNotifications({ relayBaseUrl: RELAY });

    expect(result?.subscriptionId).toBe('existing');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('re-creates a subscription that simply lapsed', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    await AsyncStorage.setItem(EXPIRES_KEY, inDays(-1));
    listMock.mockResolvedValue([]);

    const result = await resyncPushNotifications({ relayBaseUrl: RELAY });

    expect(result?.subscriptionId).toBe('new-server-id');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('re-creates a missing subscription whose expiry it never learned', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    listMock.mockResolvedValue([]);

    const result = await resyncPushNotifications({ relayBaseUrl: RELAY });

    expect(result?.subscriptionId).toBe('new-server-id');
  });

  it('changes nothing when the server cannot be asked', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    await AsyncStorage.setItem(EXPIRES_KEY, inDays(5));
    listMock.mockRejectedValueOnce(new Error('network down'));

    await expect(resyncPushNotifications({ relayBaseUrl: RELAY })).rejects.toThrow('network down');

    expect(await AsyncStorage.getItem(SUB_KEY)).toBe('existing');
    expect(await AsyncStorage.getItem(OPTED_OUT_KEY)).toBeNull();
  });

  it('turns push back on when the user enables it again', async () => {
    await disablePushForAccount(ACCOUNT_ID);
    createMock.mockImplementation(async () => ({ id: 'new-server-id', expires: inDays(7) }));

    await setupPushNotifications({ relayBaseUrl: RELAY });

    expect(await AsyncStorage.getItem(OPTED_OUT_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(EXPIRES_KEY)).not.toBeNull();
    vi.clearAllMocks();
    // Turning push off forgot the device client id, so the new subscription
    // carries a new one.
    const deviceClientId = await AsyncStorage.getItem(deviceClientIdKey(ACCOUNT_ID));
    expect(deviceClientId).not.toBe(OUR_DCID);
    listMock.mockResolvedValue([
      { id: 'new-server-id', deviceClientId, expires: inDays(7), types: ['EmailDelivery'] },
    ]);
    expect((await resyncPushNotifications({ relayBaseUrl: RELAY }))?.subscriptionId).toBe('new-server-id');
  });
});

describe('renewOtherPushAccounts (#1054)', () => {
  const OTHER = 'bob@other.example.net';
  const OTHER_DCID = 'bobsphonebobsphonebobsphonebobsp';
  const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem('push:relayBaseUrl:v1', RELAY);
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([ACCOUNT_ID, OTHER]));
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    await AsyncStorage.setItem(`push:subscriptionId:v2:${OTHER}`, 'b');
    await AsyncStorage.setItem(deviceClientIdKey(OTHER), OTHER_DCID);
    Object.assign(DETACHED, { loaded: true, deviceClientId: OTHER_DCID, expires: inDays(2), settles: inDays(7), log: [] });
    installFetch({});
  });

  afterEach(() => {
    Object.assign(DETACHED, { deviceClientId: null, expires: null, settles: null });
  });

  it("extends another account's subscription through a client of its own and records the server's expiry", async () => {
    const settles = DETACHED.settles;

    await renewOtherPushAccounts();

    const calls = DETACHED.log.map((entry) => (entry as unknown[])[0]);
    // The loaded account is the launch-time resync's; only the other is touched here.
    expect(calls).toEqual(['load', 'PushSubscription/get', 'PushSubscription/set', 'PushSubscription/get']);
    expect(DETACHED.log[0]).toEqual(['load', OTHER]);
    expect(updateMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(`push:subscriptionExpires:v1:${OTHER}`)).toBe(settles);
    // Its relay registration carries this device's current token.
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const registration = fetchMock.mock.calls.find((c) => String(c[0]) === `${RELAY}/api/push/register`);
    expect(JSON.parse(String((registration![1] as RequestInit).body))).toEqual({
      subscriptionId: OTHER_DCID,
      fcmToken: 'fcm-token-xyz',
      accountLabel: 'bob',
    });
  });

  it('only records the expiry of a subscription with more than a week left', async () => {
    DETACHED.expires = inDays(30);
    await renewOtherPushAccounts();
    expect(DETACHED.log.map((entry) => (entry as unknown[])[0])).toEqual(['load', 'PushSubscription/get']);
    expect(await AsyncStorage.getItem(`push:subscriptionExpires:v1:${OTHER}`)).toBe(DETACHED.expires);
  });

  it("leaves alone another client's subscription that reuses the id, and an account push was turned off for", async () => {
    DETACHED.deviceClientId = 'webmailwebmailwebmailwebmailwebm';
    await renewOtherPushAccounts();
    expect(DETACHED.log.map((entry) => (entry as unknown[])[0])).toEqual(['load', 'PushSubscription/get']);

    DETACHED.log = [];
    await AsyncStorage.setItem(`push:optedOut:v1:${OTHER}`, '1');
    await renewOtherPushAccounts();
    expect(DETACHED.log).toEqual([]);
  });

  it('tells the settings which accounts have push on this device', async () => {
    await AsyncStorage.setItem(`push:optedOut:v1:${OTHER}`, '1');
    await AsyncStorage.removeItem(`push:subscriptionId:v2:${OTHER}`);
    expect(await readPushAccountStates([ACCOUNT_ID, OTHER, 'carl@example.org'])).toEqual({
      [ACCOUNT_ID]: { enabled: true, optedOut: false },
      [OTHER]: { enabled: false, optedOut: true },
      'carl@example.org': { enabled: false, optedOut: false },
    });
  });
});

describe('teardownPushNotificationsForAccount', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    installFetch({});
  });

  it('destroys every server subscription for this device but keeps the FCM token', async () => {
    await AsyncStorage.setItem(deviceClientIdKey(ACCOUNT_ID), OUR_DCID);
    await AsyncStorage.setItem(SUB_KEY, 'recorded');
    await AsyncStorage.setItem('push:relayBaseUrl:v1', RELAY);
    listMock.mockResolvedValue([
      sub('recorded', OUR_DCID),
      sub('untracked', OUR_DCID),
      sub('foreign', 'ffffffffffffffffffffffffffffffff'),
    ]);
    await teardownPushNotificationsForAccount(ACCOUNT_ID);
    const destroyed = destroyMock.mock.calls.map((c) => c[0]);
    expect(destroyed).toContain('recorded');
    expect(destroyed).toContain('untracked');
    expect(destroyed).not.toContain('foreign');
    const native = (NativeModules as { BulwarkFcm: { deleteToken: ReturnType<typeof vi.fn> } }).BulwarkFcm;
    expect(native.deleteToken).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(SUB_KEY)).toBeNull();
  });

  it('leaves another device\'s subscription alone when it reuses the recorded id', async () => {
    await AsyncStorage.setItem(deviceClientIdKey(ACCOUNT_ID), OUR_DCID);
    await AsyncStorage.setItem(SUB_KEY, 'b');
    listMock.mockResolvedValue([
      sub('b', 'ffffffffffffffffffffffffffffffff'),
      sub('c', OUR_DCID),
    ]);

    await teardownPushNotificationsForAccount(ACCOUNT_ID);

    expect(destroyMock.mock.calls.map((c) => c[0])).toEqual(['c']);
  });

  it('still destroys the recorded id when the server cannot list its subscriptions', async () => {
    await AsyncStorage.setItem(deviceClientIdKey(ACCOUNT_ID), OUR_DCID);
    await AsyncStorage.setItem(SUB_KEY, 'recorded');
    listMock.mockRejectedValueOnce(new Error('network down'));

    await teardownPushNotificationsForAccount(ACCOUNT_ID);

    expect(destroyMock.mock.calls.map((c) => c[0])).toEqual(['recorded']);
    expect(await AsyncStorage.getItem(SUB_KEY)).toBeNull();
  });
});

describe('notificationTapJmapAccountId', () => {
  const tap = { emailId: 'm1', threadId: 't1', accountId: ACCOUNT_ID };

  it('opens a group mailbox message against the group account', () => {
    expect(notificationTapJmapAccountId({ ...tap, jmapAccountId: 'team' })).toBe('team');
  });

  it('leaves the user\'s own mail on the default account', () => {
    expect(notificationTapJmapAccountId({ ...tap, jmapAccountId: 'jmap-primary' })).toBeUndefined();
  });

  it('keeps notifications posted before the field existed working', () => {
    expect(notificationTapJmapAccountId(tap)).toBeUndefined();
  });
});

describe('isValidRelayUrl', () => {
  it('requires https except for loopback development hosts', () => {
    expect(isValidRelayUrl('https://relay.example.com')).toBe(true);
    expect(isValidRelayUrl('https://relay.example.com/')).toBe(true);
    expect(isValidRelayUrl('http://relay.example.com')).toBe(false);
    expect(isValidRelayUrl('http://localhost:3003')).toBe(true);
    expect(isValidRelayUrl('http://10.0.2.2:3003')).toBe(true);
    expect(isValidRelayUrl('relay.example.com')).toBe(false);
    expect(isValidRelayUrl('')).toBe(false);
  });
});
