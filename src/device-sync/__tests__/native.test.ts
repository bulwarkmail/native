import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import {
  clearSyncProblem,
  createProviderPort,
  ensureAndroidAccount,
  finishRun,
  getDeviceSyncModule,
  getSyncSettings,
  isDeviceSyncAvailable,
  isRunCancelled,
  listAndroidAccounts,
  onAccountsChanged,
  openAccountSettings,
  removeAndroidAccount,
  requestSync,
  setPeriodicSync,
  setPushRoutes,
  setSyncEnabled,
  showSyncProblem,
} from '../native';
import {
  ACCOUNTS_CHANGED_EVENT,
  CALENDAR_AUTHORITY,
  CONTACTS_AUTHORITY,
  type AccountSyncSettings,
  type Authority,
  type ProviderOp,
  type RunReport,
} from '../types';

const modules = NativeModules as Record<string, unknown>;
const ACCOUNT = 'alice@example.org';

const SETTINGS: AccountSyncSettings = {
  masterAutomatic: true,
  authorities: {
    [CONTACTS_AUTHORITY]: { syncable: 1, automatic: true, periodicSeconds: 3600, active: false, pending: false },
    [CALENDAR_AUTHORITY]: { syncable: 1, automatic: false, periodicSeconds: 0, active: false, pending: true },
  },
};

/** Installs a BulwarkDeviceSync module whose methods resolve like the Kotlin one. */
function installModule(overrides: Record<string, unknown> = {}) {
  const module = {
    getInfo: vi.fn(async () => ({ accountType: 'com.anonymous.bulwarkmobile.account', sdkInt: 34 })),
    listAccounts: vi.fn(async () => [{ name: ACCOUNT, registryId: 'alice@example.org@mail.example.org' }]),
    ensureAccount: vi.fn(async () => true),
    removeAccount: vi.fn(async () => true),
    getSyncSettings: vi.fn(async () => SETTINGS),
    setSyncEnabled: vi.fn(async () => undefined),
    setPeriodicSync: vi.fn(async () => undefined),
    requestSync: vi.fn(async () => undefined),
    openAccountSettings: vi.fn(async () => undefined),
    finishRun: vi.fn(async () => true),
    isRunCancelled: vi.fn(async () => false),
    setPushRoutes: vi.fn(async () => undefined),
    query: vi.fn(async () => JSON.stringify({ columns: ['_id', 'sourceid'], rows: [[1, 'c/a'], [2, null]] })),
    applyBatch: vi.fn(async () => JSON.stringify({ ok: true, results: [{ id: 5 }, { count: 1 }] })),
    readSyncState: vi.fn(async (): Promise<string | null> => null),
    readPhoto: vi.fn(async (): Promise<string | null> => null),
    showSyncProblem: vi.fn(async () => undefined),
    clearSyncProblem: vi.fn(async () => undefined),
    addListener: vi.fn(),
    removeListeners: vi.fn(),
    ...overrides,
  };
  modules.BulwarkDeviceSync = module;
  return module;
}

const TWO_OPS: ProviderOp[] = [
  { op: 'insert', table: 'raw_contacts', values: { sourceid: null } },
  { op: 'update', table: 'data', id: 7, values: { data1: 'x' } },
];

afterEach(() => {
  delete modules.BulwarkDeviceSync;
  (Platform as { OS: string }).OS = 'android';
  vi.restoreAllMocks();
});

describe('module lookup', () => {
  it('reads NativeModules on every call instead of caching the module', () => {
    expect(getDeviceSyncModule()).toBeNull();
    const first = installModule();
    expect(getDeviceSyncModule()).toBe(first);
    const second = installModule();
    expect(getDeviceSyncModule()).toBe(second);
    delete modules.BulwarkDeviceSync;
    expect(getDeviceSyncModule()).toBeNull();
  });

  it('is off on iOS even if a module of that name exists', () => {
    installModule();
    (Platform as { OS: string }).OS = 'ios';
    expect(getDeviceSyncModule()).toBeNull();
    expect(isDeviceSyncAvailable()).toBe(false);
  });

  it('is available on Android with the module', () => {
    expect(isDeviceSyncAvailable()).toBe(false);
    installModule();
    expect(isDeviceSyncAvailable()).toBe(true);
  });

  it('rejects everything, and subscribes nothing, without the module', async () => {
    const calls: Array<() => Promise<unknown>> = [
      () => listAndroidAccounts(),
      () => ensureAndroidAccount(ACCOUNT, 'r'),
      () => removeAndroidAccount(ACCOUNT),
      () => getSyncSettings(ACCOUNT),
      () => setSyncEnabled(ACCOUNT, CONTACTS_AUTHORITY, true),
      () => setPeriodicSync(ACCOUNT, CONTACTS_AUTHORITY, 3600),
      () => requestSync(ACCOUNT, CONTACTS_AUTHORITY),
      () => openAccountSettings(ACCOUNT),
      () => finishRun('run', {} as RunReport),
      () => isRunCancelled('run'),
      () => setPushRoutes({}),
      () => showSyncProblem(ACCOUNT, 't', 'x', 'bulwarkmobile://login'),
      () => clearSyncProblem(ACCOUNT),
      () => createProviderPort(ACCOUNT, CONTACTS_AUTHORITY).query({ table: 'raw_contacts', columns: ['_id'] }),
      () => createProviderPort(ACCOUNT, CONTACTS_AUTHORITY).applyBatch([]),
      () => createProviderPort(ACCOUNT, CONTACTS_AUTHORITY).readSyncState(),
      () => createProviderPort(ACCOUNT, CONTACTS_AUTHORITY).readPhoto(1, 512),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: 'unavailable' });
    }
    const unsubscribe = onAccountsChanged(() => undefined);
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe('createProviderPort', () => {
  it('is bound to its account and authority', () => {
    const port = createProviderPort(ACCOUNT, CALENDAR_AUTHORITY);
    expect(port.accountName).toBe(ACCOUNT);
    expect(port.authority).toBe(CALENDAR_AUTHORITY);
  });

  it('sends a query as JSON and parses the rows', async () => {
    const module = installModule();
    const port = createProviderPort(ACCOUNT, CONTACTS_AUTHORITY);
    const rows = await port.query({ table: 'raw_contacts', columns: ['_id', 'sourceid'], where: 'dirty = ?', args: [1] });
    expect(rows).toEqual({ columns: ['_id', 'sourceid'], rows: [[1, 'c/a'], [2, null]] });
    expect(module.query).toHaveBeenCalledWith(
      ACCOUNT,
      CONTACTS_AUTHORITY,
      JSON.stringify({ table: 'raw_contacts', columns: ['_id', 'sourceid'], where: 'dirty = ?', args: [1] }),
    );
  });

  it('throws on query replies that are not ProviderRows', async () => {
    const port = createProviderPort(ACCOUNT, CONTACTS_AUTHORITY);
    const q = { table: 'raw_contacts' as const, columns: ['_id'] };
    for (const reply of [
      'not json',
      JSON.stringify({ columns: ['_id'] }),
      JSON.stringify({ columns: ['_id'], rows: [[1, 2]] }),
      JSON.stringify({ columns: ['_id'], rows: [[{ b64: 'AA' }]] }),
      JSON.stringify({ columns: [7], rows: [] }),
      42,
    ]) {
      installModule({ query: vi.fn(async () => reply) });
      await expect(port.query(q)).rejects.toThrow(/BulwarkDeviceSync\.query/);
    }
  });

  it('passes native rejections through with their code', async () => {
    const scope = Object.assign(new Error('Table instances is not part of com.android.calendar'), { code: 'scope' });
    installModule({ query: vi.fn(async () => Promise.reject(scope)) });
    await expect(
      createProviderPort(ACCOUNT, CALENDAR_AUTHORITY).query({ table: 'events', columns: ['_id'] }),
    ).rejects.toBe(scope);
  });

  it('sends ops as JSON and returns the batch result', async () => {
    const module = installModule();
    const result = await createProviderPort(ACCOUNT, CONTACTS_AUTHORITY).applyBatch(TWO_OPS);
    expect(result).toEqual({ ok: true, results: [{ id: 5 }, { count: 1 }] });
    expect(module.applyBatch).toHaveBeenCalledWith(ACCOUNT, CONTACTS_AUTHORITY, JSON.stringify(TWO_OPS));
  });

  it('returns failed batches as results', async () => {
    installModule({
      applyBatch: vi.fn(async () => JSON.stringify({ ok: false, reason: 'assert', message: 'Expected 1 rows but actual 0' })),
    });
    await expect(createProviderPort(ACCOUNT, CONTACTS_AUTHORITY).applyBatch(TWO_OPS)).resolves.toEqual({
      ok: false,
      reason: 'assert',
      message: 'Expected 1 rows but actual 0',
    });
  });

  it('throws on batch replies that are not BatchResults', async () => {
    const port = createProviderPort(ACCOUNT, CONTACTS_AUTHORITY);
    for (const reply of [
      JSON.stringify({ ok: false, reason: 'weird', message: 'x' }),
      JSON.stringify({ ok: true, results: [{ id: 'five' }, {}] }),
      JSON.stringify({ ok: true, results: [{ id: 5 }] }),
      JSON.stringify({ ok: true }),
      '[]',
    ]) {
      installModule({ applyBatch: vi.fn(async () => reply) });
      await expect(port.applyBatch(TWO_OPS)).rejects.toThrow(/BulwarkDeviceSync\.applyBatch/);
    }
  });

  it('reads the SyncState as text', async () => {
    const module = installModule();
    const port = createProviderPort(ACCOUNT, CALENDAR_AUTHORITY);
    await expect(port.readSyncState()).resolves.toBeNull();
    module.readSyncState.mockResolvedValueOnce('{"v":1}');
    await expect(port.readSyncState()).resolves.toBe('{"v":1}');
    expect(module.readSyncState).toHaveBeenCalledWith(ACCOUNT, CALENDAR_AUTHORITY);
  });

  it('reads photos of contacts only', async () => {
    const module = installModule();
    const port = createProviderPort(ACCOUNT, CONTACTS_AUTHORITY);
    await expect(port.readPhoto(3, 512)).resolves.toBeNull();
    module.readPhoto.mockResolvedValueOnce(JSON.stringify({ jpegBase64: '/9j/', fileId: 12 }));
    await expect(port.readPhoto(3, 512)).resolves.toEqual({ jpegBase64: '/9j/', fileId: 12 });
    expect(module.readPhoto).toHaveBeenLastCalledWith(ACCOUNT, 3, 512);
    module.readPhoto.mockResolvedValueOnce(JSON.stringify({ jpegBase64: '/9j/' }));
    await expect(port.readPhoto(3, 512)).rejects.toThrow(/readPhoto/);
    await expect(createProviderPort(ACCOUNT, CALENDAR_AUTHORITY).readPhoto(3, 512)).rejects.toThrow(/contacts/);
  });
});

describe('accounts and sync settings', () => {
  it('passes account calls through', async () => {
    const module = installModule();
    await expect(listAndroidAccounts()).resolves.toEqual([{ name: ACCOUNT, registryId: 'alice@example.org@mail.example.org' }]);
    await expect(ensureAndroidAccount(ACCOUNT, 'reg')).resolves.toBe(true);
    expect(module.ensureAccount).toHaveBeenCalledWith(ACCOUNT, 'reg');
    await expect(removeAndroidAccount(ACCOUNT)).resolves.toBe(true);
    expect(module.removeAccount).toHaveBeenCalledWith(ACCOUNT);
    await expect(getSyncSettings(ACCOUNT)).resolves.toEqual(SETTINGS);
    await setSyncEnabled(ACCOUNT, CALENDAR_AUTHORITY, false);
    expect(module.setSyncEnabled).toHaveBeenCalledWith(ACCOUNT, CALENDAR_AUTHORITY, false);
    await openAccountSettings(ACCOUNT);
    expect(module.openAccountSettings).toHaveBeenCalledWith(ACCOUNT);
  });

  it('lets a registry id conflict reject with its code', async () => {
    const conflict = Object.assign(new Error('belongs to another app account'), { code: 'conflict' });
    installModule({ ensureAccount: vi.fn(async () => Promise.reject(conflict)) });
    await expect(ensureAndroidAccount(ACCOUNT, 'other')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('sends whole seconds for periodic syncs and refuses nonsense', async () => {
    const module = installModule();
    await setPeriodicSync(ACCOUNT, CONTACTS_AUTHORITY, 899.6);
    expect(module.setPeriodicSync).toHaveBeenCalledWith(ACCOUNT, CONTACTS_AUTHORITY, 900);
    await setPeriodicSync(ACCOUNT, CONTACTS_AUTHORITY, 0);
    expect(module.setPeriodicSync).toHaveBeenLastCalledWith(ACCOUNT, CONTACTS_AUTHORITY, 0);
    await expect(setPeriodicSync(ACCOUNT, CONTACTS_AUTHORITY, -1)).rejects.toBeInstanceOf(RangeError);
    await expect(setPeriodicSync(ACCOUNT, CONTACTS_AUTHORITY, Number.NaN)).rejects.toBeInstanceOf(RangeError);
  });

  it('sends sync request options as JSON', async () => {
    const module = installModule();
    await requestSync(ACCOUNT, CONTACTS_AUTHORITY);
    expect(module.requestSync).toHaveBeenLastCalledWith(ACCOUNT, CONTACTS_AUTHORITY, '{}');
    await requestSync(ACCOUNT, CALENDAR_AUTHORITY, { manual: true, expedited: true });
    expect(module.requestSync).toHaveBeenLastCalledWith(
      ACCOUNT,
      CALENDAR_AUTHORITY,
      JSON.stringify({ manual: true, expedited: true }),
    );
  });
});

describe('run handshake', () => {
  it('sends the report as JSON and returns whether it was accepted', async () => {
    const module = installModule({ finishRun: vi.fn(async () => false) });
    const report = { v: 1, runId: 'r1', authority: CONTACTS_AUTHORITY, outcome: 'ok' } as RunReport;
    await expect(finishRun('r1', report)).resolves.toBe(false);
    expect(module.finishRun).toHaveBeenCalledWith('r1', JSON.stringify(report));
  });

  it('asks whether a run was cancelled', async () => {
    const module = installModule({ isRunCancelled: vi.fn(async () => true) });
    await expect(isRunCancelled('r1')).resolves.toBe(true);
    expect(module.isRunCancelled).toHaveBeenCalledWith('r1');
  });
});

describe('push routes and notifications', () => {
  it('stores push routes as JSON', async () => {
    const module = installModule();
    const routes: Record<string, Array<{ accountName: string; authorities: Authority[] }>> = {
      c: [{ accountName: ACCOUNT, authorities: [CONTACTS_AUTHORITY, CALENDAR_AUTHORITY] }],
    };
    await setPushRoutes(routes);
    expect(module.setPushRoutes).toHaveBeenCalledWith(JSON.stringify(routes));
  });

  it('posts and clears the sync problem notification', async () => {
    const module = installModule();
    await showSyncProblem(ACCOUNT, 'Sign in again', 'Contacts stopped syncing', 'bulwarkmobile://login');
    expect(module.showSyncProblem).toHaveBeenLastCalledWith(
      ACCOUNT,
      'Sign in again',
      'Contacts stopped syncing',
      'bulwarkmobile://login',
      null,
    );
    await showSyncProblem(ACCOUNT, 'Erneut anmelden', 'Kontakte', 'bulwarkmobile://login', 'Synchronisierungsprobleme');
    expect(module.showSyncProblem).toHaveBeenLastCalledWith(
      ACCOUNT,
      'Erneut anmelden',
      'Kontakte',
      'bulwarkmobile://login',
      'Synchronisierungsprobleme',
    );
    await clearSyncProblem(ACCOUNT);
    expect(module.clearSyncProblem).toHaveBeenCalledWith(ACCOUNT);
  });

  it('listens for account changes until unsubscribed', () => {
    installModule();
    const remove = vi.fn();
    let handler: (() => void) | undefined;
    const addListener = vi
      .spyOn(NativeEventEmitter.prototype, 'addListener')
      .mockImplementation(((event: string, h: () => void) => {
        expect(event).toBe(ACCOUNTS_CHANGED_EVENT);
        handler = h;
        return { remove };
      }) as never);
    const listener = vi.fn();
    const unsubscribe = onAccountsChanged(listener);
    expect(addListener).toHaveBeenCalledTimes(1);
    handler?.();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
