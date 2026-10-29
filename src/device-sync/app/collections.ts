/**
 * The address books and calendars an app account can sync, for the chooser in
 * Settings (docs/device-sync.md, "Settings sections").
 *
 * Listed through a JMAPClient of the account's own, never the UI's
 * singleton: the chooser covers every signed-in account, and re-binding the
 * singleton would send the UI's requests with another account's credentials.
 * Collections of the capability's primary account are "personal" (on by
 * default); every other session account that advertises the capability holds
 * shared ones (off by default). Calendars without `mayReadItems` and
 * calendars that hold only tasks are not offered (the engine does not sync
 * them); the birthday calendar is the app's own and never on the server.
 */
import { AuthenticationError, JMAPClient, NetworkError } from '../../api/jmap-client';
import type { JMAPMethodCall } from '../../api/types';
import {
  findTasksOnlyCalendarIds,
  SCAN_PROPERTIES,
  type ScannedCalendarObject,
} from '../../lib/calendar-component-detection';
import {
  isCollectionSelected,
  selectionFor,
  syncOnInApp,
  useDeviceSyncStore,
  type AccountDeviceSync,
} from '../../stores/device-sync-store';
import { collectionKey } from '../common/ids';
import {
  CALENDAR_AUTHORITY,
  CONTACTS_AUTHORITY,
  JMAP_CALENDARS,
  JMAP_CONTACTS,
  JMAP_CORE,
  type Authority,
  type CollectionKey,
} from '../types';

export interface SyncCollection {
  /** `<jmapAccountId>/<id>`, as in the selections. */
  key: CollectionKey;
  jmapAccountId: string;
  id: string;
  name: string;
  /** The JMAP account's name (who shares it, for a shared collection). */
  accountName: string;
  /** In the capability's primary account: synced unless the user turned it off. */
  isPersonal: boolean;
  /** No write rights, or (calendars) a subscribed feed. */
  readOnly: boolean;
  isDefault: boolean;
  color?: string;
}

/** Why the list could not be loaded. */
export type CollectionsErrorKind = 'signedOut' | 'auth' | 'network' | 'server';

export class CollectionsError extends Error {
  constructor(readonly kind: CollectionsErrorKind, message: string) {
    super(message);
    this.name = 'CollectionsError';
  }
}

/** The part of JMAPClient the listing uses. */
export interface CollectionsClient {
  loadAccount(registryId: string): Promise<boolean>;
  readonly currentSession: {
    primaryAccounts: Record<string, string>;
    accounts: Record<string, { name: string; isPersonal: boolean; accountCapabilities?: Record<string, unknown> }>;
  } | null;
  request(calls: JMAPMethodCall[], using?: string[]): Promise<{ methodResponses: Array<[string, any, string]> }>;
  getMaxCallsInRequest(): number;
}

export interface ListOptions {
  /** Skip the cache. */
  force?: boolean;
  /** For tests: the client to list with. */
  client?: CollectionsClient;
  /** Calendars mirroring subscribed iCal feeds (read-only on the device); `accountId` absent = the primary account. */
  feeds?: ReadonlyArray<{ calendarId: string; accountId?: string }>;
}

const CACHE_TTL_MS = 2 * 60_000;
/** How many objects of a calendar tell whether it holds only tasks (the engine checks the same). */
const TASK_SCAN_LIMIT = 50;

const ADDRESS_BOOK_PROPERTIES = ['id', 'name', 'isDefault', 'sortOrder', 'myRights'];
const CALENDAR_PROPERTIES = ['id', 'name', 'color', 'isDefault', 'sortOrder', 'isSubscribed', 'myRights'];

const cache = new Map<string, { at: number; collections: SyncCollection[] }>();
const inFlight = new Map<string, Promise<SyncCollection[]>>();

type LoadedListener = (registryId: string, authority: Authority, collections: SyncCollection[]) => void;
const loadedListeners = new Set<LoadedListener>();

const cacheKey = (registryId: string, authority: Authority) => `${registryId}\n${authority}`;

/**
 * Calls `listener` with every list loaded from the server, so each view of an
 * account's collections (the settings row's counts, the chooser) shows the
 * freshest one. Returns the unsubscribe.
 */
export function onSyncCollectionsLoaded(listener: LoadedListener): () => void {
  loadedListeners.add(listener);
  return () => {
    loadedListeners.delete(listener);
  };
}

/** The last list loaded for an account, if it is still fresh. */
export function cachedSyncCollections(registryId: string, authority: Authority): SyncCollection[] | null {
  const hit = cache.get(cacheKey(registryId, authority));
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.collections : null;
}

/** Drops the cached lists of one account, or of all (tests). */
export function forgetSyncCollections(registryId?: string): void {
  for (const key of [...cache.keys()]) {
    if (!registryId || key.startsWith(`${registryId}\n`)) cache.delete(key);
  }
}

/** The collections of one app account for an authority, personal ones first. */
export function listSyncCollections(
  registryId: string,
  authority: Authority,
  options: ListOptions = {},
): Promise<SyncCollection[]> {
  const key = cacheKey(registryId, authority);
  if (!options.force && !options.client) {
    const hit = cachedSyncCollections(registryId, authority);
    if (hit) return Promise.resolve(hit);
    const running = inFlight.get(key);
    if (running) return running;
  }
  const run = load(registryId, authority, options).then((collections) => {
    cache.set(key, { at: Date.now(), collections });
    for (const listener of [...loadedListeners]) listener(registryId, authority, collections);
    return collections;
  });
  if (!options.client) {
    inFlight.set(key, run);
    void run.finally(() => {
      if (inFlight.get(key) === run) inFlight.delete(key);
    }).catch(() => undefined);
  }
  return run;
}

async function openClient(registryId: string, client: CollectionsClient): Promise<CollectionsClient> {
  let ok: boolean;
  try {
    ok = await client.loadAccount(registryId);
  } catch (err) {
    if (err instanceof AuthenticationError || (err instanceof Error && err.name === 'AuthenticationError')) {
      throw new CollectionsError('auth', err.message);
    }
    if (err instanceof NetworkError || (err instanceof Error && err.name === 'NetworkError')) {
      throw new CollectionsError('network', err.message);
    }
    throw new CollectionsError('server', err instanceof Error ? err.message : String(err));
  }
  if (!ok) throw new CollectionsError('signedOut', 'No stored credentials');
  return client;
}

async function send(
  client: CollectionsClient,
  calls: JMAPMethodCall[],
  using: string[],
): Promise<Array<[string, any, string]>> {
  const out: Array<[string, any, string]> = [];
  // Result references only point inside one request, so a query and the
  // get that reads it always go together.
  const perRequest = Math.max(2, client.getMaxCallsInRequest() - (client.getMaxCallsInRequest() % 2));
  for (let i = 0; i < calls.length; i += perRequest) {
    try {
      const res = await client.request(calls.slice(i, i + perRequest), using);
      out.push(...(res.methodResponses ?? []));
    } catch (err) {
      if (err instanceof Error && err.name === 'AuthenticationError') throw new CollectionsError('auth', err.message);
      throw new CollectionsError('network', err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

function responseOf(responses: Array<[string, any, string]>, callId: string): any {
  const hit = responses.find((r) => r[2] === callId);
  return hit && hit[0] !== 'error' ? hit[1] : null;
}

interface RawCollection {
  id: string;
  name?: string;
  color?: string;
  isDefault?: boolean;
  sortOrder?: number;
  myRights?: Record<string, boolean | undefined>;
}

async function load(registryId: string, authority: Authority, options: ListOptions): Promise<SyncCollection[]> {
  const client = await openClient(registryId, options.client ?? new JMAPClient());
  const session = client.currentSession;
  if (!session) throw new CollectionsError('server', 'No session');
  const capability = authority === CONTACTS_AUTHORITY ? JMAP_CONTACTS : JMAP_CALENDARS;
  const using = [JMAP_CORE, capability];
  const capable = Object.entries(session.accounts ?? {})
    .filter(([, info]) => !!info?.accountCapabilities?.[capability])
    .map(([id]) => id);
  const primary = session.primaryAccounts?.[capability] ?? capable[0];
  if (!primary) return [];
  const accountIds = [primary, ...capable.filter((id) => id !== primary)];
  // For the push routes and the trigger filter; only into a store that has
  // been read, which would otherwise be overwritten.
  if (useDeviceSyncStore.persist.hasHydrated()
    && useDeviceSyncStore.getState().accounts[registryId]?.primaryJmapAccounts?.[authority] !== primary) {
    useDeviceSyncStore.getState().rememberPrimaryJmapAccount(registryId, authority, primary);
  }

  const method = authority === CONTACTS_AUTHORITY ? 'AddressBook/get' : 'Calendar/get';
  const properties = authority === CONTACTS_AUTHORITY ? ADDRESS_BOOK_PROPERTIES : CALENDAR_PROPERTIES;
  const responses = await send(
    client,
    accountIds.map((accountId, i) => [method, { accountId, properties }, `g${i}`]),
    using,
  );

  const listed: Array<{ jmapAccountId: string; raw: RawCollection }> = [];
  accountIds.forEach((jmapAccountId, i) => {
    const body = responseOf(responses, `g${i}`);
    // An account that refuses (a revoked share) must not hide the others.
    if (!body) {
      if (jmapAccountId === primary) throw new CollectionsError('server', `${method} failed`);
      return;
    }
    for (const raw of (body.list ?? []) as RawCollection[]) {
      if (raw && typeof raw.id === 'string') listed.push({ jmapAccountId, raw });
    }
  });

  let offered = listed;
  if (authority === CALENDAR_AUTHORITY) {
    offered = listed.filter(({ raw }) => raw.myRights?.mayReadItems !== false);
    const taskOnly = await taskOnlyCalendars(client, offered, using);
    offered = offered.filter(({ jmapAccountId, raw }) => !taskOnly.has(collectionKey(jmapAccountId, raw.id)));
  }

  const feeds = new Set((options.feeds ?? []).map((f) => collectionKey(f.accountId ?? primary, f.calendarId)));
  const collections = offered.map(({ jmapAccountId, raw }): SyncCollection => {
    const key = collectionKey(jmapAccountId, raw.id);
    const rights = raw.myRights;
    const readOnly = authority === CONTACTS_AUTHORITY
      ? rights?.mayWrite === false
      : feeds.has(key) || (!!rights && !rights.mayWriteAll && !rights.mayWriteOwn);
    return {
      key,
      jmapAccountId,
      id: raw.id,
      name: raw.name?.trim() || raw.id,
      accountName: session.accounts?.[jmapAccountId]?.name ?? jmapAccountId,
      isPersonal: jmapAccountId === primary,
      readOnly,
      isDefault: !!raw.isDefault,
      ...(typeof raw.color === 'string' && raw.color ? { color: raw.color } : {}),
    };
  });
  const order = new Map(accountIds.map((id, i) => [id, i]));
  const sortOf = new Map(offered.map(({ jmapAccountId, raw }) => [collectionKey(jmapAccountId, raw.id), raw.sortOrder ?? 0]));
  return collections.sort((a, b) =>
    (order.get(a.jmapAccountId)! - order.get(b.jmapAccountId)!)
    || (sortOf.get(a.key)! - sortOf.get(b.key)!)
    || a.name.localeCompare(b.name));
}

/**
 * Calendars whose first objects are all tasks. One query and one get per
 * calendar; a calendar whose scan fails is kept (offered).
 */
async function taskOnlyCalendars(
  client: CollectionsClient,
  calendars: Array<{ jmapAccountId: string; raw: RawCollection }>,
  using: string[],
): Promise<Set<CollectionKey>> {
  const calls: JMAPMethodCall[] = [];
  calendars.forEach(({ jmapAccountId, raw }, i) => {
    calls.push(['CalendarEvent/query', { accountId: jmapAccountId, filter: { inCalendar: raw.id }, limit: TASK_SCAN_LIMIT }, `q${i}`]);
    calls.push([
      'CalendarEvent/get',
      {
        accountId: jmapAccountId,
        '#ids': { resultOf: `q${i}`, name: 'CalendarEvent/query', path: '/ids' },
        properties: SCAN_PROPERTIES,
      },
      `o${i}`,
    ]);
  });
  const out = new Set<CollectionKey>();
  if (calls.length === 0) return out;
  let responses: Array<[string, any, string]>;
  try {
    responses = await send(client, calls, using);
  } catch {
    return out;
  }
  calendars.forEach(({ jmapAccountId, raw }, i) => {
    const body = responseOf(responses, `o${i}`);
    if (!body) return;
    const objects = ((body.list ?? []) as ScannedCalendarObject[])
      .map((o) => ({ ...o, calendarIds: { [raw.id]: true } }));
    if (findTasksOnlyCalendarIds(objects, [raw.id]).has(raw.id)) out.add(collectionKey(jmapAccountId, raw.id));
  });
  return out;
}

function serverOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).host.toLowerCase();
  } catch {
    return serverUrl.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  }
}

/**
 * The other signed-in accounts on the same server that already sync this
 * collection (the same JMAP account and id): the chooser warns about the
 * second copy on the device, it does not refuse it.
 */
export function otherAccountsSyncing(
  registryId: string,
  authority: Authority,
  collection: Pick<SyncCollection, 'key' | 'jmapAccountId'> & Partial<Pick<SyncCollection, 'name'>>,
  registry: ReadonlyArray<{ id: string; serverUrl: string; email?: string; username: string }>,
  accounts: Record<string, AccountDeviceSync>,
): string[] {
  const self = registry.find((a) => a.id === registryId);
  if (!self) return [];
  const server = serverOf(self.serverUrl);
  return registry
    .filter((other) => other.id !== registryId && serverOf(other.serverUrl) === server)
    .filter((other) => {
      const entry = accounts[other.id];
      if (!entry || !syncOnInApp(entry, authority)) return false;
      const isPersonal = entry.primaryJmapAccounts?.[authority] === collection.jmapAccountId;
      return isCollectionSelected(selectionFor(entry, authority), authority, { ...collection, isPersonal });
    })
    .map((other) => other.email || other.username);
}
