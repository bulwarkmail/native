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
  type Authority,
  type ProviderOp,
  type ProviderPort,
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
  run(authority?: Authority, extras?: RunExtras): Promise<RunReport>;
  teardown(authority: Authority, options?: TeardownOptions): Promise<{ pending: number }>;
  state(authority?: Authority): SyncState | null;
  contacts(): Array<{ id: number; sourceId: string | null; name: string | null; dirty: boolean; deleted: boolean; row: Row }>;
  contactNamed(name: string): { id: number; sourceId: string | null; dirty: boolean; deleted: boolean } | undefined;
  nameDataRow(rawContactId: number): Row | undefined;
  events(): Row[];
  serverNames(accountId?: string): string[];
  /** The status the runs recorded last for the settings (what `deps.lastStatus` answers). */
  lastStatus(authority?: Authority): RunStatus | undefined;
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
  const statuses = new Map<Authority, RunStatus>();

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
    isSyncEnabled: async () => true,
    deviceZone: () => 'Europe/Berlin',
    recordStatus: vi.fn((_registryId: string, authority: Authority, status: RunStatus) => {
      statuses.set(authority, status);
    }),
    lastStatus: (_registryId, authority) => statuses.get(authority),
    recordKnownState: vi.fn(),
    notifyAuthProblem: vi.fn(),
    yieldThread: async () => undefined,
    sleep: async () => undefined,
    tuning: options.tuning,
  };

  let runs = 0;
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
    run: (authority = CONTACTS_AUTHORITY, extras = {}) =>
      runDeviceSync(
        { runId: `run-${++runs}`, accountName: ANDROID_ACCOUNT, registryId: REGISTRY_ID, authority, extras, deadline: clock.now + RUN_BUDGET },
        deps,
      ),
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
    lastStatus: (authority = CONTACTS_AUTHORITY) => statuses.get(authority),
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
