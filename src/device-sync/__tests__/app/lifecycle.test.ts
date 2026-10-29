import { describe, it, expect, vi, beforeEach } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CALENDAR_AUTHORITY,
  CONTACTS_AUTHORITY,
  type Authority,
} from '../../types';

// A fake of the native module: Android's accounts of our type and their sync
// settings, with every call logged in order.
const h = vi.hoisted(() => {
  type Settings = { automatic: boolean; periodicSeconds: number };
  const state = {
    available: true,
    permitted: true,
    master: true,
    accounts: [] as Array<{ name: string; registryId: string | null; sync: Record<string, Settings> }>,
    log: [] as string[],
    failSetSyncEnabled: false,
  };
  const find = (name: string) => state.accounts.find((a) => a.name === name);
  const settingsOf = (name: string, authority: string) => {
    const account = find(name);
    if (!account) return { automatic: false, periodicSeconds: 0 };
    account.sync[authority] ??= { automatic: false, periodicSeconds: 0 };
    return account.sync[authority];
  };
  const teardown = async (
    _registryId: string,
    name: string,
    authority: string,
    options?: { uploadFirst?: boolean; timeoutMs?: number; force?: boolean },
  ) => {
    state.log.push(`teardown ${name} ${authority} ${JSON.stringify(options ?? {})}`);
    return { pending: 0 };
  };
  return { state, find, settingsOf, teardown };
});

vi.mock('../../native', () => ({
  isDeviceSyncAvailable: () => h.state.available,
  listAndroidAccounts: vi.fn(async () => h.state.accounts.map((a) => ({ name: a.name, registryId: a.registryId }))),
  ensureAndroidAccount: vi.fn(async (name: string, registryId: string) => {
    h.state.log.push(`ensure ${name}`);
    const existing = h.find(name);
    // As the native module rejects (DeviceSyncAccounts.ensure → AccountConflictException).
    if (existing && existing.registryId !== registryId) throw Object.assign(new Error(`${name} belongs to another app account`), { code: 'conflict' });
    if (existing) return false;
    h.state.accounts.push({ name, registryId, sync: {} });
    return true;
  }),
  removeAndroidAccount: vi.fn(async (name: string) => {
    h.state.log.push(`remove ${name}`);
    h.state.accounts = h.state.accounts.filter((a) => a.name !== name);
    return true;
  }),
  getSyncSettings: vi.fn(async (name: string) => ({
    masterAutomatic: h.state.master,
    authorities: {
      'com.android.contacts': { syncable: 1, active: false, pending: false, ...h.settingsOf(name, 'com.android.contacts') },
      'com.android.calendar': { syncable: 1, active: false, pending: false, ...h.settingsOf(name, 'com.android.calendar') },
    },
  })),
  setSyncEnabled: vi.fn(async (name: string, authority: string, enabled: boolean) => {
    if (h.state.failSetSyncEnabled) throw new Error('boom');
    h.state.log.push(`auto ${name} ${authority} ${enabled}`);
    h.settingsOf(name, authority).automatic = enabled;
  }),
  setPeriodicSync: vi.fn(async (name: string, authority: string, seconds: number) => {
    h.state.log.push(`periodic ${name} ${authority} ${seconds}`);
    h.settingsOf(name, authority).periodicSeconds = seconds;
  }),
  requestSync: vi.fn(async (name: string, authority: string, options?: Record<string, unknown>) => {
    h.state.log.push(`sync ${name} ${authority} ${JSON.stringify(options ?? {})}`);
  }),
  openAccountSettings: vi.fn(async () => undefined),
  setPushRoutes: vi.fn(async () => undefined),
  showSyncProblem: vi.fn(async (name: string) => { h.state.log.push(`problem ${name}`); }),
  clearSyncProblem: vi.fn(async (name: string) => { h.state.log.push(`clear ${name}`); }),
  onAccountsChanged: vi.fn(() => () => undefined),
}));

vi.mock('../../task', () => ({ teardownAuthority: vi.fn(h.teardown) }));

vi.mock('../../app/permissions', () => ({
  hasSyncPermissions: vi.fn(async () => h.state.permitted),
}));

vi.mock('../../../lib/push-notifications', () => ({
  refreshPushSubscriptionTypes: vi.fn(async () => undefined),
}));

import * as native from '../../native';
import * as task from '../../task';
import { refreshPushSubscriptionTypes } from '../../../lib/push-notifications';
import { useAccountStore, type AccountEntry } from '../../../stores/account-store';
import {
  accountDeviceSync,
  useDeviceSyncStore,
  waitForDeviceSyncHydration,
} from '../../../stores/device-sync-store';
import {
  changeReminderOwner,
  changeSyncInterval,
  deviceSyncSignedIn,
  disableDeviceSync,
  enableDeviceSync,
  preferredAndroidAccountName,
  reconcileDeviceAccounts,
  releaseDeviceSyncBeforeSignOut,
  removeSuspendedAccount,
  resolveDeletions,
  resumeDeviceSync,
  TEARDOWN_TIMEOUT_MS,
} from '../../app/lifecycle';

const ALICE = 'alice@mail.example.org';
const ALICE2 = 'alice@other.example.net';
const BOB = 'bob@mail.example.org';

function entry(id: string, username: string): AccountEntry {
  return {
    id,
    serverUrl: `https://${id.split('@').pop()}`,
    username,
    displayName: username,
    email: `${username}@example.org`,
    avatarColor: '#000',
    lastLoginAt: 0,
    isConnected: true,
    hasError: false,
    isDefault: false,
  };
}

async function ready(registry: AccountEntry[]): Promise<void> {
  await waitForDeviceSyncHydration();
  if (!useAccountStore.persist.hasHydrated()) {
    await new Promise<void>((resolve) => {
      const off = useAccountStore.persist.onFinishHydration(() => { off(); resolve(); });
    });
  }
  useAccountStore.setState({ accounts: registry, activeAccountId: registry[0]?.id ?? null });
}

const teardown = vi.mocked(task.teardownAuthority);
const setSyncEnabled = vi.mocked(native.setSyncEnabled);

beforeEach(async () => {
  vi.clearAllMocks();
  h.state.available = true;
  h.state.permitted = true;
  h.state.master = true;
  h.state.accounts = [];
  h.state.log = [];
  h.state.failSetSyncEnabled = false;
  teardown.mockImplementation(h.teardown);
  await AsyncStorage.clear();
  useDeviceSyncStore.setState({ accounts: {} });
  await ready([entry(ALICE, 'alice'), entry(BOB, 'bob')]);
});

describe('enable', () => {
  it('creates the Android account under the login, turns automatic and periodic sync on and syncs', async () => {
    useDeviceSyncStore.getState().setIntervalSeconds(ALICE, CONTACTS_AUTHORITY, 1800);
    const outcome = await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    expect(outcome).toEqual({ kind: 'enabled', accountName: 'alice' });
    expect(h.state.log).toEqual([
      'ensure alice',
      `auto alice ${CONTACTS_AUTHORITY} true`,
      `periodic alice ${CONTACTS_AUTHORITY} 1800`,
      `sync alice ${CONTACTS_AUTHORITY} {"manual":true}`,
    ]);
    const stored = accountDeviceSync(ALICE);
    expect(stored.androidAccountName).toBe('alice');
    expect(stored.enabled).toEqual({ [CONTACTS_AUTHORITY]: true });
    await vi.waitFor(() => expect(refreshPushSubscriptionTypes).toHaveBeenCalledWith(ALICE));
  });

  it('uses the default hourly interval', async () => {
    await enableDeviceSync(ALICE, CALENDAR_AUTHORITY);
    expect(h.state.log).toContain(`periodic alice ${CALENDAR_AUTHORITY} 3600`);
  });

  it('does nothing without the runtime permissions', async () => {
    h.state.permitted = false;
    expect(await enableDeviceSync(ALICE, CONTACTS_AUTHORITY)).toEqual({ kind: 'permission' });
    expect(h.state.log).toEqual([]);
    expect(accountDeviceSync(ALICE).enabled).toBeUndefined();
  });

  it('reuses the Android account of the app account', async () => {
    h.state.accounts.push({ name: 'alice', registryId: ALICE, sync: {} });
    await enableDeviceSync(ALICE, CALENDAR_AUTHORITY);
    expect(h.state.log.filter((l) => l.startsWith('ensure'))).toEqual([]);
    expect(accountDeviceSync(ALICE).androidAccountName).toBe('alice');
  });

  it('names the account after its registry id when another app account has the login', async () => {
    await ready([entry(ALICE, 'alice'), entry(ALICE2, 'alice')]);
    h.state.accounts.push({ name: 'alice', registryId: ALICE, sync: {} });
    expect(preferredAndroidAccountName(ALICE2, await native.listAndroidAccounts())).toBe(ALICE2);
    const outcome = await enableDeviceSync(ALICE2, CONTACTS_AUTHORITY);
    expect(outcome).toEqual({ kind: 'enabled', accountName: ALICE2 });
  });

  it('falls back to the registry id when the login turns out to be taken', async () => {
    const list = vi.mocked(native.listAndroidAccounts);
    // A stale list: the clash only shows when the account is added.
    list.mockResolvedValueOnce([]);
    h.state.accounts.push({ name: 'alice', registryId: ALICE2, sync: {} });
    const outcome = await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    expect(outcome).toEqual({ kind: 'enabled', accountName: ALICE });
  });

  it('adds no second account named after the registry id when adding the account fails for another reason', async () => {
    for (const code of ['failed', 'permission']) {
      vi.mocked(native.ensureAndroidAccount).mockClear();
      vi.mocked(native.ensureAndroidAccount).mockRejectedValueOnce(Object.assign(new Error(`AccountManager said no (${code})`), { code }));
      const outcome = await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
      expect(outcome).toEqual({ kind: 'failed', message: `AccountManager said no (${code})` });
      expect(native.ensureAndroidAccount).toHaveBeenCalledTimes(1);
      expect(h.state.accounts).toEqual([]);
      expect(accountDeviceSync(ALICE).androidAccountName).toBeUndefined();
    }
  });

  it('leaves no account behind when turning sync on fails', async () => {
    h.state.failSetSyncEnabled = true;
    const outcome = await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    expect(outcome.kind).toBe('failed');
    expect(h.state.accounts).toEqual([]);
    expect(accountDeviceSync(ALICE).enabled).toBeUndefined();
  });

  it('keeps the account of the other authority when turning one on fails', async () => {
    await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    vi.mocked(native.setPeriodicSync).mockRejectedValueOnce(new Error('boom'));
    expect((await enableDeviceSync(ALICE, CALENDAR_AUTHORITY)).kind).toBe('failed');
    expect(h.find('alice')?.sync[CALENDAR_AUTHORITY].automatic).toBe(false);
    expect(h.find('alice')?.sync[CONTACTS_AUTHORITY].automatic).toBe(true);
    expect(accountDeviceSync(ALICE)).toMatchObject({
      androidAccountName: 'alice',
      enabled: { [CONTACTS_AUTHORITY]: true },
    });
  });

  it('is a no-op where device sync is not available', async () => {
    h.state.available = false;
    expect((await enableDeviceSync(ALICE, CONTACTS_AUTHORITY)).kind).toBe('failed');
    expect(h.state.log).toEqual([]);
  });
});

describe('disable', () => {
  beforeEach(async () => {
    await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    await enableDeviceSync(ALICE, CALENDAR_AUTHORITY);
    await changeReminderOwner(ALICE, 'bulwark');
    h.state.log = [];
  });

  it('turns automatic sync off before the teardown uploads and deletes', async () => {
    const result = await disableDeviceSync(ALICE, CALENDAR_AUTHORITY);
    expect(result).toEqual({ done: true, pending: 0 });
    expect(h.state.log).toEqual([
      `auto alice ${CALENDAR_AUTHORITY} false`,
      `teardown alice ${CALENDAR_AUTHORITY} {"uploadFirst":true,"timeoutMs":${TEARDOWN_TIMEOUT_MS}}`,
    ]);
    const stored = accountDeviceSync(ALICE);
    expect(stored.enabled).toEqual({ [CONTACTS_AUTHORITY]: true, [CALENDAR_AUTHORITY]: false });
    // Contacts still sync: the account stays; the reminder question comes again next time.
    expect(h.find('alice')).toBeDefined();
    expect(stored.reminderOwner).toBeNull();
  });

  it('lets a turn-on wait for a turn-off that is still tearing down, instead of being undone by it', async () => {
    await disableDeviceSync(ALICE, CALENDAR_AUTHORITY);
    let finishTeardown: () => void = () => undefined;
    teardown.mockImplementationOnce(async (_registryId, name, authority, options) => {
      h.state.log.push(`teardown ${name} ${authority} ${JSON.stringify(options ?? {})}`);
      await new Promise<void>((resolve) => { finishTeardown = resolve; });
      return { pending: 0 };
    });
    const turningOff = disableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    await vi.waitFor(() => expect(h.state.log).toContain(`teardown alice ${CONTACTS_AUTHORITY} {"uploadFirst":true,"timeoutMs":${TEARDOWN_TIMEOUT_MS}}`));
    // The user opens the settings again and turns contacts sync back on.
    const turningOn = enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    finishTeardown();
    expect(await turningOff).toEqual({ done: true, pending: 0 });
    expect(await turningOn).toMatchObject({ kind: 'enabled' });
    expect(h.find('alice')?.sync[CONTACTS_AUTHORITY]?.automatic).toBe(true);
    expect(accountDeviceSync(ALICE).enabled?.[CONTACTS_AUTHORITY]).toBe(true);
    expect(accountDeviceSync(ALICE).androidAccountName).toBe('alice');
  });

  it('removes the Android account once both authorities are off', async () => {
    await disableDeviceSync(ALICE, CALENDAR_AUTHORITY);
    await disableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    expect(h.state.accounts).toEqual([]);
    expect(h.state.log).toContain('remove alice');
    expect(accountDeviceSync(ALICE).androidAccountName).toBeUndefined();
  });

  it('deletes nothing and reports the waiting changes when they could not be uploaded', async () => {
    teardown.mockResolvedValueOnce({ pending: 3 });
    const result = await disableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    expect(result).toEqual({ done: false, pending: 3 });
    expect(accountDeviceSync(ALICE).enabled?.[CONTACTS_AUTHORITY]).toBe(true);

    // The user keeps syncing: automatic sync comes back.
    h.state.log = [];
    await resumeDeviceSync(ALICE, CONTACTS_AUTHORITY);
    expect(h.state.log).toEqual([
      `auto alice ${CONTACTS_AUTHORITY} true`,
      `sync alice ${CONTACTS_AUTHORITY} {"manual":true}`,
    ]);
  });

  it('deletes on the user\'s word with force', async () => {
    teardown.mockResolvedValueOnce({ pending: 2 });
    await disableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    h.state.log = [];
    const result = await disableDeviceSync(ALICE, CONTACTS_AUTHORITY, { force: true });
    expect(result.done).toBe(true);
    expect(h.state.log).toContain(`teardown alice ${CONTACTS_AUTHORITY} {"force":true,"timeoutMs":5000}`);
    expect(accountDeviceSync(ALICE).enabled?.[CONTACTS_AUTHORITY]).toBe(false);
  });

  it('reports a failed teardown as unknown changes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    teardown.mockRejectedValueOnce(new Error('provider gone'));
    expect(await disableDeviceSync(ALICE, CONTACTS_AUTHORITY)).toEqual({ done: false, pending: 0, failed: true });
    warn.mockRestore();
  });
});

describe('sign-out', () => {
  it('lets an account without device sync go at once', async () => {
    const confirm = vi.fn(async () => true);
    expect(await releaseDeviceSyncBeforeSignOut([BOB], confirm)).toBe(true);
    expect(teardown).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('uploads, deletes and removes the Android account before the credentials go', async () => {
    await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    h.state.log = [];
    const confirm = vi.fn(async () => true);
    expect(await releaseDeviceSyncBeforeSignOut([ALICE], confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(teardown).toHaveBeenCalledWith(ALICE, 'alice', CONTACTS_AUTHORITY, { uploadFirst: true, timeoutMs: TEARDOWN_TIMEOUT_MS });
    expect(teardown).toHaveBeenCalledWith(ALICE, 'alice', CALENDAR_AUTHORITY, { uploadFirst: true, timeoutMs: TEARDOWN_TIMEOUT_MS });
    expect(h.state.accounts).toEqual([]);
    expect(useDeviceSyncStore.getState().accounts[ALICE]).toBeUndefined();
    // Automatic sync went off before the first teardown.
    expect(h.state.log.indexOf(`auto alice ${CONTACTS_AUTHORITY} false`))
      .toBeLessThan(h.state.log.findIndex((l) => l.startsWith('teardown')));
  });

  it('asks before losing changes, and keeps syncing when the user stays', async () => {
    await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    teardown.mockImplementation(async (_r: string, _n: string, authority: string) => ({ pending: authority === CONTACTS_AUTHORITY ? 4 : 0 }));
    const confirm = vi.fn(async () => false);
    expect(await releaseDeviceSyncBeforeSignOut([ALICE], confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(4);
    expect(h.find('alice')?.sync[CONTACTS_AUTHORITY].automatic).toBe(true);
    expect(accountDeviceSync(ALICE).androidAccountName).toBe('alice');
  });

  it('deletes what is left once the user agrees', async () => {
    await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    teardown.mockImplementation(async (_r: string, _n: string, authority: string, options?: { force?: boolean }) =>
      ({ pending: authority === CONTACTS_AUTHORITY && !options?.force ? 4 : 0 }));
    const confirm = vi.fn(async () => true);
    expect(await releaseDeviceSyncBeforeSignOut([ALICE], confirm)).toBe(true);
    expect(teardown).toHaveBeenCalledWith(ALICE, 'alice', CONTACTS_AUTHORITY, { force: true, timeoutMs: 5_000 });
    expect(h.state.accounts).toEqual([]);
  });

  it('asks once for several accounts', async () => {
    await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    await enableDeviceSync(BOB, CALENDAR_AUTHORITY);
    teardown.mockImplementation(async (_r: string, _n: string, _a: string, options?: { force?: boolean }) => ({ pending: options?.force ? 0 : 1 }));
    const confirm = vi.fn(async () => true);
    expect(await releaseDeviceSyncBeforeSignOut([ALICE, BOB], confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(4);
    expect(h.state.accounts).toEqual([]);
  });

  it('waits for a turn-on in progress, then releases what it set up', async () => {
    let finishEnsure: () => void = () => undefined;
    vi.mocked(native.ensureAndroidAccount).mockImplementationOnce(async (name: string, registryId: string) => {
      h.state.log.push(`ensure ${name}`);
      await new Promise<void>((resolve) => { finishEnsure = resolve; });
      h.state.accounts.push({ name, registryId, sync: {} });
      return true;
    });
    const turningOn = enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    await vi.waitFor(() => expect(h.state.log).toContain('ensure alice'));

    const signingOut = releaseDeviceSyncBeforeSignOut([ALICE], vi.fn(async () => true));
    finishEnsure();

    expect(await signingOut).toBe(true);
    await turningOn;
    expect(teardown).toHaveBeenCalledWith(ALICE, 'alice', CONTACTS_AUTHORITY, { uploadFirst: true, timeoutMs: TEARDOWN_TIMEOUT_MS });
    expect(h.state.accounts).toEqual([]);
    expect(useDeviceSyncStore.getState().accounts[ALICE]).toBeUndefined();
  });

  it('lets a turn-on or turn-off asked for during the sign-out set nothing up for the account', async () => {
    await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    let finishTeardown: () => void = () => undefined;
    teardown.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishTeardown = resolve; });
      return { pending: 0 };
    });
    const signingOut = releaseDeviceSyncBeforeSignOut([ALICE], vi.fn(async () => true));
    await vi.waitFor(() => expect(teardown).toHaveBeenCalled());

    const turningOn = enableDeviceSync(ALICE, CALENDAR_AUTHORITY);
    const turningOff = disableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    finishTeardown();

    expect(await signingOut).toBe(true);
    expect((await turningOn).kind).toBe('failed');
    expect(await turningOff).toEqual({ done: true, pending: 0 });
    expect(h.state.accounts).toEqual([]);
    expect(h.state.log.filter((l) => l.startsWith('ensure') || l.startsWith('sync'))).toEqual(['ensure alice', `sync alice ${CONTACTS_AUTHORITY} {"manual":true}`]);
    expect(useDeviceSyncStore.getState().accounts[ALICE]).toBeUndefined();
  });

  it('lets a turn-on asked for during the sign-out go ahead once the user chose to stay signed in', async () => {
    await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    teardown.mockImplementation(async (_r: string, _n: string, authority: string) => ({ pending: authority === CONTACTS_AUTHORITY ? 1 : 0 }));
    let answer: (signOut: boolean) => void = () => undefined;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const signingOut = releaseDeviceSyncBeforeSignOut([ALICE], confirm);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());

    const turningOn = enableDeviceSync(ALICE, CALENDAR_AUTHORITY);
    answer(false);

    expect(await signingOut).toBe(false);
    expect(await turningOn).toEqual({ kind: 'enabled', accountName: 'alice' });
    expect(h.find('alice')?.sync[CALENDAR_AUTHORITY].automatic).toBe(true);
  });
});

describe('reconcile', () => {
  it('suspends an Android account whose app account the registry dropped, once', async () => {
    h.state.accounts.push({
      name: 'carol',
      registryId: 'carol@mail.example.org',
      sync: { [CONTACTS_AUTHORITY]: { automatic: true, periodicSeconds: 3600 } },
    });
    await reconcileDeviceAccounts();
    expect(h.find('carol')?.sync[CONTACTS_AUTHORITY].automatic).toBe(false);
    expect(h.find('carol')).toBeDefined();
    expect(native.showSyncProblem).toHaveBeenCalledTimes(1);
    expect(vi.mocked(native.showSyncProblem).mock.calls[0][3]).toBe('bulwarkmobile://settings/account');
    const carol = accountDeviceSync('carol@mail.example.org');
    expect(carol.suspended).toBe(true);
    expect(carol.enabled).toEqual({ [CONTACTS_AUTHORITY]: true });

    await reconcileDeviceAccounts();
    expect(native.showSyncProblem).toHaveBeenCalledTimes(1);
  });

  it('drops a suspended account and its data when the user removes it', async () => {
    h.state.accounts.push({ name: 'carol', registryId: 'carol@mail.example.org', sync: {} });
    await reconcileDeviceAccounts();
    h.state.log = [];
    await removeSuspendedAccount('carol@mail.example.org');
    expect(h.state.log).toEqual(['remove carol', 'clear carol']);
    expect(useDeviceSyncStore.getState().accounts['carol@mail.example.org']).toBeUndefined();
  });

  it('never acts on an empty registry', async () => {
    await ready([]);
    h.state.accounts.push({ name: 'carol', registryId: 'carol@mail.example.org', sync: {} });
    await reconcileDeviceAccounts();
    expect(native.showSyncProblem).not.toHaveBeenCalled();
    expect(setSyncEnabled).not.toHaveBeenCalled();
  });

  it('shows sync off for an account removed in Android Settings and never recreates it', async () => {
    await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    h.state.accounts = [];
    vi.mocked(native.ensureAndroidAccount).mockClear();
    await reconcileDeviceAccounts();
    const alice = accountDeviceSync(ALICE);
    expect(alice.removedInAndroidSettings).toBe(true);
    expect(alice.androidAccountName).toBeUndefined();
    expect(alice.enabled).toEqual({});
    await reconcileDeviceAccounts();
    expect(native.ensureAndroidAccount).not.toHaveBeenCalled();
    expect(h.state.accounts).toEqual([]);
  });

  it('forgets an account that is neither signed in nor on the device', async () => {
    useDeviceSyncStore.getState().update('gone@mail.example.org', { androidAccountName: 'gone', enabled: { [CONTACTS_AUTHORITY]: true } });
    await reconcileDeviceAccounts();
    expect(useDeviceSyncStore.getState().accounts['gone@mail.example.org']).toBeUndefined();
  });

  it('takes an authority turned on in Android Settings as on', async () => {
    h.state.accounts.push({
      name: 'alice',
      registryId: ALICE,
      sync: { [CALENDAR_AUTHORITY]: { automatic: true, periodicSeconds: 3600 } },
    });
    await reconcileDeviceAccounts();
    const alice = accountDeviceSync(ALICE);
    expect(alice.androidAccountName).toBe('alice');
    expect(alice.enabled).toEqual({ [CALENDAR_AUTHORITY]: true });
  });

  it('hands the push router the accounts that feed each Android account', async () => {
    await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    useDeviceSyncStore.getState().rememberPrimaryJmapAccount(ALICE, CONTACTS_AUTHORITY, 'c');
    await reconcileDeviceAccounts();
    expect(native.setPushRoutes).toHaveBeenLastCalledWith({
      c: [{ accountName: 'alice', authorities: [CONTACTS_AUTHORITY] }],
    });
  });
});

describe('sign-in', () => {
  it('clears the sign-in notice and resumes a suspended account where it synced', async () => {
    h.state.accounts.push({
      name: 'alice',
      registryId: ALICE,
      sync: { [CONTACTS_AUTHORITY]: { automatic: false, periodicSeconds: 3600 } },
    });
    useDeviceSyncStore.getState().update(ALICE, {
      androidAccountName: 'alice',
      suspended: true,
      enabled: { [CONTACTS_AUTHORITY]: true },
    });
    await deviceSyncSignedIn(ALICE);
    expect(h.state.log).toEqual([
      'clear alice',
      `auto alice ${CONTACTS_AUTHORITY} true`,
      `sync alice ${CONTACTS_AUTHORITY} {"manual":true}`,
    ]);
    expect(accountDeviceSync(ALICE).suspended).toBeUndefined();
  });

  it('does nothing for an account without an Android account', async () => {
    await deviceSyncSignedIn(BOB);
    expect(h.state.log).toEqual([]);
  });
});

describe('settings actions', () => {
  it('deletes held-back deletions on the server, or brings the items back, with a sync', async () => {
    await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    h.state.log = [];
    expect(await resolveDeletions(ALICE, CONTACTS_AUTHORITY, 'delete')).toBe(true);
    expect(await resolveDeletions(ALICE, CONTACTS_AUTHORITY, 'restore')).toBe(true);
    expect(h.state.log).toEqual([
      `sync alice ${CONTACTS_AUTHORITY} {"manual":true,"overrideTooManyDeletions":true}`,
      `sync alice ${CONTACTS_AUTHORITY} {"manual":true,"discardLocalDeletions":true}`,
    ]);
    // Without an Android account there is nothing to resolve.
    expect(await resolveDeletions(BOB, CONTACTS_AUTHORITY, 'delete')).toBe(false);
  });

  it('applies a new interval to Android while the authority syncs', async () => {
    await enableDeviceSync(ALICE, CONTACTS_AUTHORITY);
    h.state.log = [];
    await changeSyncInterval(ALICE, CONTACTS_AUTHORITY, 0);
    expect(h.state.log).toEqual([`periodic alice ${CONTACTS_AUTHORITY} 0`]);
    await changeSyncInterval(ALICE, CALENDAR_AUTHORITY, 900);
    expect(h.state.log).toEqual([`periodic alice ${CONTACTS_AUTHORITY} 0`]);
    expect(accountDeviceSync(ALICE).intervalSeconds[CALENDAR_AUTHORITY as Authority]).toBe(900);
  });

  it('syncs the calendar when the reminder owner changes', async () => {
    await enableDeviceSync(ALICE, CALENDAR_AUTHORITY);
    h.state.log = [];
    await changeReminderOwner(ALICE, 'device');
    expect(h.state.log).toEqual([`sync alice ${CALENDAR_AUTHORITY} {"manual":true}`]);
    h.state.log = [];
    await changeReminderOwner(ALICE, 'device');
    expect(h.state.log).toEqual([]);
  });
});
