/**
 * The engine under test, wired to the fake providers, the fake JMAP server
 * and the toy planners, with helpers to read both sides and inject faults.
 */
import { vi } from 'vitest';
import { Data, MimeType } from '../../android-columns';
import { parseJsonColumn } from '../../common/json';
import { runDeviceSync } from '../../engine/run';
import { teardownAuthority, type TeardownOptions } from '../../engine/teardown';
import type { EngineDeps, JmapConnection, Tuning } from '../../engine/deps';
import { openWithAuthRebuild } from '../../jmap/connection';
import type { SyncState } from '../../engine/sync-state';
import {
  CALENDAR_AUTHORITY,
  CONTACTS_AUTHORITY,
  type AccountSyncPrefs,
  type AndroidAccount,
  type Authority,
  type ProviderOp,
  type ProviderPort,
  type RequestSyncOptions,
  type RunExtras,
  type RunReport,
  type RunStatus,
  type Row,
} from '../../types';
import { FakeDeviceProviders } from '../fakes/fake-provider';
import { FakeJmapServer } from '../fakes/fake-jmap-server';
import { toyCalendarPlanner, toyContactsPlanner } from './toy-planners';

export const ANDROID_ACCOUNT = 'alice@example.com';
export const REGISTRY_ID = 'alice@mail.example.com';
export const ORIGIN = 'https://mail.example.com';
export const START = Date.UTC(2026, 8, 27, 10, 0, 0);
export const RUN_BUDGET = 9 * 60_000;

/** Deterministic randomness: uids and keys differ between items but repeat between test runs. */
export function seededRandom(seed = 42): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export class CrashError extends Error {
  constructor(where: string) {
    super(`crash injected ${where}`);
    this.name = 'CrashError';
  }
}

export interface Harness {
  server: FakeJmapServer;
  device: FakeDeviceProviders;
  deps: EngineDeps;
  prefs: AccountSyncPrefs;
  book: string;
  calendar: string;
  clock: { now: number };
  /** Checkpoints seen by the last runs (each call of isCancelled). */
  checkpoints: { count: number; crashAt: number | null; onCheckpoint?: (n: number) => void };
  /** Batches applied through the engine's provider port; crash after `crashAfter` of them. */
  batches: { applied: number; crashAfter: number | null; log: ProviderOp[][] };
  /** Android's accounts of our type: the app account's own, and those the engine makes for address books. */
  androidAccounts: AndroidAccount[];
  /** Accounts whose sync Android has switched off. */
  paused: Set<string>;
  /** Syncs the engine asked Android for. */
  syncRequests: Array<{ name: string; options: RequestSyncOptions }>;
  run(authority?: Authority, extras?: RunExtras): Promise<RunReport>;
  /** A contacts sync of the Android account the engine made for an address book. */
  runBook(key: string, extras?: RunExtras): Promise<RunReport>;
  teardown(authority: Authority, options?: TeardownOptions): Promise<{ pending: number }>;
  state(authority?: Authority): SyncState | null;
  contacts(): Array<{ id: number; sourceId: string | null; name: string | null; dirty: boolean; deleted: boolean; row: Row }>;
  contactNamed(name: string): { id: number; sourceId: string | null; dirty: boolean; deleted: boolean } | undefined;
  nameDataRow(rawContactId: number): Row | undefined;
  events(): Row[];
  serverNames(accountId?: string): string[];
  /** The status the runs recorded last for the settings (what `deps.lastStatus` answers). */
  lastStatus(authority?: Authority, accountName?: string): RunStatus | undefined;
}

export function createHarness(options: { tuning?: Partial<Tuning>; accounts?: 'personal' | 'withShared'; rebuild?: boolean } = {}): Harness {
  const clock = { now: START };
  const server = new FakeJmapServer({ now: () => clock.now });
  server.addAccount('a', { name: ANDROID_ACCOUNT });
  const book = server.addAddressBook('a', { name: 'Personal', isDefault: true });
  const calendar = server.addCalendar('a', { name: 'Calendar', isDefault: true });
  if (options.accounts === 'withShared') {
    server.addAccount('team', { name: 'Team', isPersonal: false });
    server.addAddressBook('team', { name: 'Team contacts' });
    server.addCalendar('team', { name: 'Team calendar' });
  }
  const device = new FakeDeviceProviders();
  const prefs: AccountSyncPrefs = { contactsSelection: {}, calendarSelection: {}, reminderOwner: 'device' };
  const checkpoints: Harness['checkpoints'] = { count: 0, crashAt: null };
  const batches: Harness['batches'] = { applied: 0, crashAfter: null, log: [] };
  const statuses = new Map<string, RunStatus>();
  const statusKey = (authority: Authority, accountName?: string) => `${authority}|${accountName ?? ''}`;
  const androidAccounts: AndroidAccount[] = [{ name: ANDROID_ACCOUNT, registryId: REGISTRY_ID }];
  const paused = new Set<string>();
  const syncRequests: Harness['syncRequests'] = [];

  const wrap = (port: ProviderPort): ProviderPort => ({
    accountName: port.accountName,
    authority: port.authority,
    query: (q) => port.query(q),
    readSyncState: () => port.readSyncState(),
    readPhoto: (id, px) => port.readPhoto(id, px),
    applyBatch: async (ops) => {
      if (batches.crashAfter !== null && batches.applied >= batches.crashAfter) throw new CrashError(`after ${batches.applied} batches`);
      const result = await port.applyBatch(ops);
      if (result.ok) {
        batches.applied++;
        batches.log.push(ops);
      }
      return result;
    },
  });

  const connection = (): JmapConnection => ({ port: server.port(), origin: ORIGIN });
  const deps: EngineDeps = {
    provider: (name, authority) => wrap(device.port(name, authority)),
    jmap: async () => (options.rebuild === false ? connection() : openWithAuthRebuild(async () => connection())),
    prefs: async () => prefs,
    planners: { contacts: toyContactsPlanner, calendar: toyCalendarPlanner },
    now: () => clock.now,
    isCancelled: async () => {
      checkpoints.count++;
      checkpoints.onCheckpoint?.(checkpoints.count);
      if (checkpoints.crashAt !== null && checkpoints.count >= checkpoints.crashAt) throw new CrashError(`at checkpoint ${checkpoints.count}`);
      return false;
    },
    random: seededRandom(),
    subscriptionCalendars: async () => [],
    isSyncEnabled: async (name) => !paused.has(name),
    deviceZone: () => 'Europe/Berlin',
    recordStatus: vi.fn((_registryId: string, authority: Authority, status: RunStatus, accountName?: string) => {
      statuses.set(statusKey(authority, accountName), status);
    }),
    lastStatus: (_registryId, authority, accountName) => statuses.get(statusKey(authority, accountName)),
    accounts: {
      list: async () => androidAccounts.map((a) => ({ ...a })),
      addAddressBook: async (name, registryId, collection) => {
        if (androidAccounts.some((a) => a.name === name)) throw new Error(`${name} exists`);
        androidAccounts.push({ name, registryId, collection });
      },
      remove: async (name) => {
        androidAccounts.splice(0, androidAccounts.length, ...androidAccounts.filter((a) => a.name !== name));
        device.removeAccount(name);
      },
      requestSync: async (name, _authority, options) => {
        syncRequests.push({ name, options });
      },
    },
    recordAddressBookAccount: (_registryId, key, name) => {
      const { [key]: _previous, ...rest } = prefs.addressBookAccounts ?? {};
      prefs.addressBookAccounts = name ? { ...rest, [key]: name } : rest;
    },
    deselectAddressBook: (_registryId, key) => {
      prefs.contactsSelection[key] = false;
    },
    recordKnownState: vi.fn(),
    notifyAuthProblem: vi.fn(),
    yieldThread: async () => undefined,
    sleep: async () => undefined,
    tuning: options.tuning,
  };

  let runs = 0;
  const run = (accountName: string, authority: Authority, extras: RunExtras, collection?: string) =>
    runDeviceSync(
      { runId: `run-${++runs}`, accountName, registryId: REGISTRY_ID, collection, authority, extras, deadline: clock.now + RUN_BUDGET },
      deps,
    );
  const harness: Harness = {
    server,
    device,
    deps,
    prefs,
    book,
    calendar,
    clock,
    checkpoints,
    batches,
    androidAccounts,
    paused,
    syncRequests,
    run: (authority = CONTACTS_AUTHORITY, extras = {}) => run(ANDROID_ACCOUNT, authority, extras),
    runBook: (key, extras = {}) => {
      const account = androidAccounts.find((a) => a.collection === key);
      if (!account) throw new Error(`no Android account for address book ${key}`);
      return run(account.name, CONTACTS_AUTHORITY, extras, key);
    },
    teardown: (authority, teardownOptions) => teardownAuthority(deps, REGISTRY_ID, ANDROID_ACCOUNT, authority, teardownOptions),
    state: (authority = CONTACTS_AUTHORITY) => parseJsonColumn<SyncState>(device.readSyncState(ANDROID_ACCOUNT, authority)),
    contacts: () =>
      device.rows('raw_contacts').map((row) => {
        const id = Number(row._id);
        const nameRow = harness.nameDataRow(id);
        return {
          id,
          sourceId: (row.sourceid as string | null) ?? null,
          name: (nameRow?.[Data.DATA1] as string | null) ?? null,
          dirty: Number(row.dirty) === 1,
          deleted: Number(row.deleted) === 1,
          row,
        };
      }),
    contactNamed: (name) => harness.contacts().find((c) => c.name === name),
    nameDataRow: (rawContactId) =>
      device.rows('data').find((d) => Number(d.raw_contact_id) === rawContactId && d.mimetype === MimeType.STRUCTURED_NAME),
    events: () => device.rows('events'),
    serverNames: (accountId = 'a') =>
      server
        .all('ContactCard', accountId)
        .filter((c) => c.kind !== 'group')
        .map((c) => String((c.name as { full?: string } | undefined)?.full ?? ''))
        .sort(),
    lastStatus: (authority = CONTACTS_AUTHORITY, accountName) => statuses.get(statusKey(authority, accountName)),
  };
  return harness;
}

/** A contact added on the device the way a Contacts app does (DIRTY, no SOURCE_ID). */
export function addDeviceContact(h: Harness, name: string): number {
  return h.device.user.insertContact(ANDROID_ACCOUNT, [{ [Data.MIMETYPE]: MimeType.STRUCTURED_NAME, [Data.DATA1]: name }]);
}

/** An in-place edit of a contact's name (AOSP Contacts). */
export function renameDeviceContact(h: Harness, rawContactId: number, name: string): void {
  const row = h.nameDataRow(rawContactId);
  if (!row) throw new Error(`no name row for ${rawContactId}`);
  h.device.user.updateData(Number(row._id), { [Data.DATA1]: name, [Data.DATA2]: null, [Data.DATA3]: null });
}

export function addServerCards(h: Harness, names: string[], accountId = 'a', book = h.book): string[] {
  return names.map((name, i) => h.server.addCard(accountId, { uid: `uid-${name}-${i}`, name: { full: name }, addressBookIds: { [book]: true } }));
}

/** Batches that wrote rows (anything but the SyncState op). */
export function rowWrites(batches: ProviderOp[][]): ProviderOp[][] {
  return batches.filter((ops) => ops.some((op) => op.op !== 'syncState' && op.op !== 'assert'));
}

export { CALENDAR_AUTHORITY, CONTACTS_AUTHORITY };
