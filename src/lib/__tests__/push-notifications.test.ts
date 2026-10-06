import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSettingsStore } from '../../stores/settings-store';

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
    PermissionsAndroid: {
      RESULTS: { GRANTED: 'granted' },
      request: vi.fn(async () => 'granted'),
      check: vi.fn(async () => true),
    },
  };
});

// What createPushSubscription resolves to: the new id and the expiry the
// server settled on (unknown here unless a test says otherwise).
const { CREATED } = vi.hoisted(() => ({
  CREATED: { id: 'new-server-id', expires: null as string | null },
}));

// A client of another signed-in account (device sync patches its push types
// and the resume renewal its expiry without the singleton), on a server with
// contacts and calendars unless a test says otherwise. `granted` is the expiry
// the server reports back for an update that changed it (null: as asked), and
// `gone` leaves the subscription out of /get, and `down` makes every request
// fail.
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
      expires: null as string | null,
      granted: null as string | null,
      gone: false,
      down: false,
      log: [] as unknown[],
      session: SYNC_SESSION,
      // The filter the server holds (null: none) and what the account's own
      // client sees as folders.
      emailPush: null as unknown,
      mailboxes: [{ id: 'bob-inbox', role: 'inbox' }, { id: 'bob-junk', role: 'junk' }] as unknown[],
      failEmailPushWrite: false,
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
    get accountId() {
      return 'bob-jmap';
    }
    getSharedMailAccounts() {
      return [];
    }
    async loadAccount(id: string) {
      DETACHED.log.push(['load', id]);
      return DETACHED.loaded;
    }
    async request(calls: Array<[string, Record<string, any>, string]>) {
      const [name, args, id] = calls[0];
      DETACHED.log.push([name, args]);
      if (DETACHED.down) throw new Error('server unreachable');
      if (name === 'Mailbox/get') {
        return { methodResponses: [[name, { list: DETACHED.mailboxes }, id]] };
      }
      if (name === 'PushSubscription/set' && DETACHED.failEmailPushWrite && 'emailPush' in (Object.values(args.update)[0] as object)) {
        return { methodResponses: [['error', { type: 'forbidden' }, id]] };
      }
      if (name === 'PushSubscription/get') {
        const list = DETACHED.gone ? [] : [{ id: args.ids[0], types: DETACHED.types, expires: DETACHED.expires, emailPush: DETACHED.emailPush }];
        return {
          methodResponses: [[name, { list }, id]],
        };
      }
      const updated = DETACHED.granted ? { expires: DETACHED.granted } : null;
      return { methodResponses: [[name, { updated: { [Object.keys(args.update)[0]]: updated } }, id]] };
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
  hasNotificationPermission,
  isValidRelayUrl,
  notificationTapJmapAccountId,
  readPushAccountIds,
  readPushJmapAccountIds,
  PushSetupError,
  pushTypesFor,
  refreshPushSubscriptionTypes,
  renewDetachedPushSubscription,
  resyncPushNotifications,
  revokePushDevice,
  teardownPushNotificationsForAccount,
} from '../push-notifications';
import { getMailboxes } from '../../api/email';
import {
  listPushSubscriptions,
  createPushSubscription,
  destroyPushSubscription,
  updatePushSubscription,
  verifyPushSubscription,
} from '../../api/push';
import { getSharedMailboxes } from '../../api/email';
import { JMAPMethodError } from '../../api/jmap-result';
import type { EmailPushConfig, JMAPSession } from '../../api/types';
import { jmapClient } from '../../api/jmap-client';
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { readLastRenewAttempt, recordRenewAttempt } from '../push-renewal-state';
import { generateAccountId } from '../account-utils';

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

describe('setupPushNotifications and the Inbox-only setting', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(deviceClientIdKey(ACCOUNT_ID), OUR_DCID);
    listMock.mockResolvedValue([]);
    installFetch({});
    useSettingsStore.setState({ hydrated: true, pushNotifyInboxOnly: false });
  });
  afterEach(() => {
    createMock.mockImplementation(async () => CREATED);
    useSettingsStore.setState({
      pushNotifyInboxOnly: false,
      hydrate: useSettingsStore.getInitialState().hydrate,
    });
  });

  // Holds the first subscription write until released.
  function holdFirstCreate() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    createMock.mockImplementation(async () => {
      if (first) { first = false; await gate; }
      return CREATED;
    });
    return release;
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('re-runs once with the new value when the setting flips during a run', async () => {
    const release = holdFirstCreate();
    const first = setupPushNotifications({ relayBaseUrl: RELAY });
    await settle();
    useSettingsStore.setState({ pushNotifyInboxOnly: true });
    const joined = setupPushNotifications({ relayBaseUrl: RELAY });
    await settle();
    expect(createMock).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, joined]);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('does not re-run when a joiner sees the same value', async () => {
    const release = holdFirstCreate();
    const first = setupPushNotifications({ relayBaseUrl: RELAY });
    await settle();
    const joined = setupPushNotifications({ relayBaseUrl: RELAY });
    release();
    await Promise.all([first, joined]);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('waits for settings to hydrate before reading the setting', async () => {
    const hydrate = vi.fn(async () => {
      useSettingsStore.setState({ hydrated: true, pushNotifyInboxOnly: true });
    });
    useSettingsStore.setState({ hydrated: false, pushNotifyInboxOnly: false, hydrate });
    const first = setupPushNotifications({ relayBaseUrl: RELAY });
    await first;
    expect(hydrate).toHaveBeenCalled();
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
      ['PushSubscription/get', { ids: ['bob-sub'], properties: ['id', 'types'] }],
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

  it('leaves the subscription of an account that turned push off alone', async () => {
    await AsyncStorage.setItem(SUB_KEY, 'existing');
    await AsyncStorage.setItem(`push:optedOut:v1:${ACCOUNT_ID}`, '1');
    listMock.mockResolvedValue([healthy(['EmailDelivery'])]);
    await syncing({ [CONTACTS]: true });
    await refreshPushSubscriptionTypes(ACCOUNT_ID);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('setupPushNotifications with ACL-shared accounts (B18)', () => {
  const REFUSED_KEY = 'push:emailPushRefused:v1:' + ACCOUNT_ID;
  const sharedMock = getSharedMailboxes as ReturnType<typeof vi.fn>;
  const verifyMock = verifyPushSubscription as ReturnType<typeof vi.fn>;
  const calendars = (mayCreateCalendar: boolean) => ({
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
  const forbidden = () =>
    new JMAPMethodError('forbidden', 'No access to one of the accounts in the emailPush map.');
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

  it('narrows a refused emailPush map over UnifiedPush as well', async () => {
    installUpFetch();
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: { 'urn:ietf:params:jmap:emailpush': {} },
      accounts: { 'jmap-primary': { name: 'user', isPersonal: true, isReadOnly: false } },
    };
    (getSharedMailboxes as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'acl-b:inbox', originalId: 'inbox', role: 'inbox', accountId: 'acl-b' },
    ]);
    createMock.mockImplementation(async (params: { emailPush?: Record<string, EmailPushConfig> }) => {
      if (params.emailPush && 'acl-b' in params.emailPush) {
        throw new JMAPMethodError('forbidden', 'No access to one of the accounts in the emailPush map.');
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

describe('renewDetachedPushSubscription', () => {
  const OTHER = 'bob@other.example.net';
  const OTHER_EXPIRES_KEY = `push:subscriptionExpires:v1:${OTHER}`;
  const DAY = 86400000;

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(`push:subscriptionId:v2:${OTHER}`, 'bob-sub');
    DETACHED.log = [];
    DETACHED.loaded = true;
    DETACHED.down = false;
    DETACHED.gone = false;
    DETACHED.granted = null;
    DETACHED.session = SYNC_SESSION;
    DETACHED.emailPush = null;
    DETACHED.failEmailPushWrite = false;
  });

  afterEach(() => {
    DETACHED.session = SYNC_SESSION;
    DETACHED.expires = null;
    DETACHED.granted = null;
    DETACHED.gone = false;
    DETACHED.down = false;
  });

  it("renews a non-active account's subscription close to expiry", async () => {
    DETACHED.expires = new Date(Date.now() + 2 * DAY).toISOString();
    // Stalwart clamps the 90 days asked for to its own ceiling.
    DETACHED.granted = new Date(Date.now() + 7 * DAY).toISOString();
    const before = Date.now();
    expect(await renewDetachedPushSubscription(OTHER)).toBe('renewed');
    expect(DETACHED.log.slice(0, 2)).toEqual([
      ['load', OTHER],
      ['PushSubscription/get', { ids: ['bob-sub'], properties: ['id', 'expires'] }],
    ]);
    const [name, args] = DETACHED.log[2] as [string, { update: Record<string, { expires: string }> }];
    expect(name).toBe('PushSubscription/set');
    expect(Object.keys(args.update)).toEqual(['bob-sub']);
    expect(Object.keys(args.update['bob-sub'])).toEqual(['expires']);
    const asked = Date.parse(args.update['bob-sub'].expires);
    expect(asked).toBeGreaterThanOrEqual(before + 90 * DAY);
    expect(asked).toBeLessThanOrEqual(Date.now() + 90 * DAY);
    // What the server settled on, for the revocation check.
    expect(await AsyncStorage.getItem(OTHER_EXPIRES_KEY)).toBe(DETACHED.granted);
    // The singleton's subscriptions were not touched.
    expect(updateMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('records the expiry it asked for when the server took it as is', async () => {
    DETACHED.expires = null;
    expect(await renewDetachedPushSubscription(OTHER)).toBe('renewed');
    const [, args] = DETACHED.log[2] as [string, { update: Record<string, { expires: string }> }];
    expect(await AsyncStorage.getItem(OTHER_EXPIRES_KEY)).toBe(args.update['bob-sub'].expires);
  });

  it('leaves a subscription with time to spare alone', async () => {
    DETACHED.expires = new Date(Date.now() + 30 * DAY).toISOString();
    expect(await renewDetachedPushSubscription(OTHER)).toBe('fine');
    expect(DETACHED.log.map((entry) => (entry as unknown[])[0])).toEqual(['load', 'PushSubscription/get']);
    expect(await AsyncStorage.getItem(OTHER_EXPIRES_KEY)).toBe(DETACHED.expires);
  });

  it('skips opted-out accounts', async () => {
    DETACHED.expires = new Date(Date.now() + 2 * DAY).toISOString();
    await AsyncStorage.setItem(`push:optedOut:v1:${OTHER}`, '1');
    expect(await renewDetachedPushSubscription(OTHER)).toBe('fine');
    expect(DETACHED.log).toEqual([]);
  });

  it('skips an account without a subscription', async () => {
    expect(await renewDetachedPushSubscription('someone@else.example')).toBe('fine');
    expect(DETACHED.log).toEqual([]);
  });

  it('settles on a subscription the server no longer has', async () => {
    // Re-created only when the account is active again; nothing to retry.
    DETACHED.gone = true;
    expect(await renewDetachedPushSubscription(OTHER)).toBe('fine');
    expect(DETACHED.log.map((entry) => (entry as unknown[])[0])).toEqual(['load', 'PushSubscription/get']);
  });

  describe('the email filter', () => {
    const withEmailPush = {
      capabilities: { ...SYNC_SESSION.capabilities, 'urn:ietf:params:jmap:emailpush': {} },
    };
    const filterOf = (conditions: unknown[]) => ({
      'bob-jmap': {
        filter: { operator: 'AND', conditions },
        properties: ['id', 'threadId'],
        urgency: 'high',
      },
    });
    const sets = () =>
      DETACHED.log.filter((e) => (e as unknown[])[0] === 'PushSubscription/set') as Array<
        [string, { update: Record<string, Record<string, unknown>> }]
      >;

    beforeEach(() => {
      DETACHED.session = withEmailPush as typeof SYNC_SESSION;
      DETACHED.expires = new Date(Date.now() + 2 * DAY).toISOString();
    });

    it('detached renewal rewrites a changed filter', async () => {
      DETACHED.emailPush = filterOf([{ notKeyword: '$junk' }, { inMailboxOtherThan: ['bob-junk'] }]);
      useSettingsStore.setState({ pushNotifyInboxOnly: true });
      expect(await renewDetachedPushSubscription(OTHER)).toBe('renewed');
      expect(sets()).toHaveLength(1);
      const patch = sets()[0][1].update['bob-sub'];
      expect(Object.keys(patch).sort()).toEqual(['emailPush', 'expires']);
      expect(patch.emailPush).toEqual(filterOf([{ notKeyword: '$junk' }, { inMailbox: 'bob-inbox' }]));
    });

    it('writes only the expiry when the filter is unchanged', async () => {
      useSettingsStore.setState({ pushNotifyInboxOnly: true });
      DETACHED.emailPush = filterOf([{ notKeyword: '$junk' }, { inMailbox: 'bob-inbox' }]);
      expect(await renewDetachedPushSubscription(OTHER)).toBe('renewed');
      expect(Object.keys(sets()[0][1].update['bob-sub'])).toEqual(['expires']);
    });

    it('rewrites a changed filter even with time to spare', async () => {
      useSettingsStore.setState({ pushNotifyInboxOnly: true });
      DETACHED.expires = new Date(Date.now() + 30 * DAY).toISOString();
      DETACHED.emailPush = filterOf([{ notKeyword: '$junk' }, { inMailboxOtherThan: ['bob-junk'] }]);
      expect(await renewDetachedPushSubscription(OTHER)).toBe('renewed');
      expect(sets()).toHaveLength(1);
    });

    it('keeps the never-matching rule for an account with no visible Inbox', async () => {
      useSettingsStore.setState({ pushNotifyInboxOnly: true });
      DETACHED.mailboxes = [{ id: 'bob-junk', role: 'junk' }];
      // Its own primary account must have an Inbox: failing to see it is a
      // load failure, so the expiry is renewed and the filter left alone.
      expect(await renewDetachedPushSubscription(OTHER)).toBe('renewed');
      expect(Object.keys(sets()[0][1].update['bob-sub'])).toEqual(['expires']);
      DETACHED.mailboxes = [{ id: 'bob-inbox', role: 'inbox' }, { id: 'bob-junk', role: 'junk' }];
    });

    it('still renews the expiry when the server refuses the filter', async () => {
      useSettingsStore.setState({ pushNotifyInboxOnly: true });
      DETACHED.failEmailPushWrite = true;
      expect(await renewDetachedPushSubscription(OTHER)).toBe('renewed');
      expect(sets().map((s) => Object.keys(s[1].update['bob-sub']))).toEqual([['expires', 'emailPush'], ['expires']]);
    });

    it("never reads the active account's folders", async () => {
      useSettingsStore.setState({ pushNotifyInboxOnly: true });
      await renewDetachedPushSubscription(OTHER);
      expect(getMailboxes).not.toHaveBeenCalled();
    });
  });

  it('swallows a server it cannot reach', async () => {
    DETACHED.down = true;
    expect(await renewDetachedPushSubscription(OTHER)).toBe('failed');
    expect(await AsyncStorage.getItem(OTHER_EXPIRES_KEY)).toBeNull();
  });
});

describe('hasNotificationPermission', () => {
  afterEach(() => {
    (Platform as { Version: number }).Version = 30;
  });

  it('checks the permission without asking for it', async () => {
    (Platform as { Version: number }).Version = 33;
    const check = PermissionsAndroid.check as ReturnType<typeof vi.fn>;
    const request = PermissionsAndroid.request as ReturnType<typeof vi.fn>;
    request.mockClear();
    check.mockResolvedValueOnce(false);
    expect(await hasNotificationPermission()).toBe(false);
    check.mockResolvedValueOnce(true);
    expect(await hasNotificationPermission()).toBe(true);
    expect(check).toHaveBeenCalledWith('android.permission.POST_NOTIFICATIONS');
    expect(request).not.toHaveBeenCalled();
  });

  it('needs none before Android 13', async () => {
    expect(await hasNotificationPermission()).toBe(true);
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
    // The expiry the server reported is what a later resync measures against.
    expect(await AsyncStorage.getItem(EXPIRES_KEY)).toBe(expires);
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
    listMock.mockResolvedValue([
      { id: 'new-server-id', deviceClientId: OUR_DCID, expires: inDays(7), types: ['EmailDelivery'] },
    ]);
    expect((await resyncPushNotifications({ relayBaseUrl: RELAY }))?.subscriptionId).toBe('new-server-id');
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

  it('forgets when the account was last renewed', async () => {
    recordRenewAttempt(ACCOUNT_ID, Date.now());
    await vi.waitFor(async () => expect(await AsyncStorage.getItem(`push:lastRenewAttempt:v1:${ACCOUNT_ID}`)).not.toBeNull());
    await teardownPushNotificationsForAccount(ACCOUNT_ID);
    expect(await AsyncStorage.getItem(`push:lastRenewAttempt:v1:${ACCOUNT_ID}`)).toBeNull();
    expect(await readLastRenewAttempt(ACCOUNT_ID)).toBeNull();
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
