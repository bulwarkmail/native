import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSearchQuery } from '../query-parser';
import { mergeHits } from '../rank';
import type { SearchAccount } from '../types';

// ---------------------------------------------------------------------------
// The providers read the shown account from the email store, the caches from
// the contacts / calendar stores and go to the server through the api
// helpers; all of that is replaced with plain state and spies here.
// ---------------------------------------------------------------------------

const client = { connectionGen: 1, accountId: 'jmap-a', hasCapability: () => true };
const emailState = { activeAccountId: 'login-a' as string | null, emails: [] as unknown[], mailboxes: [] as unknown[] };
const contactsState = { contacts: [] as unknown[], addressBooks: [] as unknown[] };
const calendarState = { events: [] as unknown[], calendars: [] as unknown[] };
const settingsState = { includeGroupInUnified: true };
/** App accounts the live client serves (normally the shown one). */
const served = new Set<string>(['login-a']);

function storeHook(state: object) {
  const hook = (selector?: (s: object) => unknown) => (typeof selector === 'function' ? selector(state) : state);
  hook.getState = () => state;
  hook.subscribe = () => () => {};
  return hook;
}

vi.mock('../../../api/jmap-client', () => ({ jmapClient: client }));
vi.mock('../../../lib/active-client-account', () => ({
  clientServesAccount: (id: string | null | undefined) => !!id && served.has(id),
}));
vi.mock('../../../stores/email-store', () => ({
  useEmailStore: storeHook(emailState),
  isShownAccount: (id: string | null | undefined) => !!id && id === emailState.activeAccountId,
  requireShownAccountScope: (id: string | null | undefined, jmapAccountId?: string) => {
    if (!id || id !== emailState.activeAccountId || !served.has(id)) throw new Error('not served');
    return { gen: client.connectionGen, accountId: jmapAccountId ?? client.accountId };
  },
}));
vi.mock('../../../stores/settings-store', () => ({ useSettingsStore: storeHook(settingsState) }));
vi.mock('../../../stores/contacts-store', () => ({ useContactsStore: storeHook(contactsState) }));
vi.mock('../../../stores/calendar-store', () => ({ useCalendarStore: storeHook(calendarState) }));

const searchAccountEmails = vi.fn();
vi.mock('../../../api/unified-inbox', () => ({
  searchAccountEmails: (...args: unknown[]) => searchAccountEmails(...args),
}));
const searchContacts = vi.fn();
vi.mock('../../../api/contacts', () => ({
  searchContacts: (...args: unknown[]) => searchContacts(...args),
  getContactsAccountId: () => 'jmap-a',
}));
const searchEventsAcrossAccounts = vi.fn();
vi.mock('../../../api/calendar', () => ({
  searchEventsAcrossAccounts: (...args: unknown[]) => searchEventsAcrossAccounts(...args),
}));
const getFileListing = vi.fn();
const peekFileListing = vi.fn((_id: string): unknown[] | null => null);
vi.mock('../../../api/files', () => ({
  getFileListing: (...args: unknown[]) => getFileListing(...args),
  peekFileListing: (id: string) => peekFileListing(id),
  filesAccountId: () => 'jmap-a',
  supportsFiles: () => true,
  isFolder: (node: { blobId?: string | null }) => node.blobId == null,
}));

const { mailProvider, mailFilterFor, emailMatchesFilters } = await import('../providers/mail');
const { contactsProvider } = await import('../providers/contacts');
const { calendarProvider, calendarFilterFor } = await import('../providers/calendar');
const { filesProvider, pathOfNode, rawFileNodeId } = await import('../providers/files');
const { GLOBAL_SEARCH_PROVIDERS } = await import('../providers');

function account(id: string, serverUrl = `https://${id}.example`): SearchAccount {
  return { appAccountId: id, label: id.toUpperCase(), email: `${id}@example.org`, serverUrl };
}

const signal = new AbortController().signal;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

/** Show another account: the store and the client move to it. */
function switchTo(id: string) {
  emailState.activeAccountId = id;
  served.clear();
  served.add(id);
  client.connectionGen += 1;
}

beforeEach(() => {
  client.connectionGen = 1;
  emailState.activeAccountId = 'login-a';
  emailState.emails = [];
  emailState.mailboxes = [];
  contactsState.contacts = [];
  contactsState.addressBooks = [];
  calendarState.events = [];
  calendarState.calendars = [];
  settingsState.includeGroupInUnified = true;
  served.clear();
  served.add('login-a');
  searchAccountEmails.mockReset();
  searchContacts.mockReset();
  searchEventsAcrossAccounts.mockReset();
  getFileListing.mockReset();
  peekFileListing.mockReset();
  peekFileListing.mockReturnValue(null);
});

it('lists the four providers', () => {
  expect(GLOBAL_SEARCH_PROVIDERS.map((p) => p.kind)).toEqual(['mail', 'contacts', 'calendar', 'files']);
});

// ---------------------------------------------------------------------------

describe('mail provider', () => {
  const box = (id: string, role: string | null, accountId = 'jmap-a', extra: Record<string, unknown> = {}) =>
    ({ id, name: id.toUpperCase(), role, accountId, ...extra });

  it('excludes Trash and Junk by default and lifts the exclusion for is:anything', () => {
    const boxes = [box('in', 'inbox'), box('tr', 'trash'), box('ju', 'junk')];
    expect(mailFilterFor(parseSearchQuery('report'), boxes as never, 'jmap-a'))
      .toEqual({ operator: 'AND', conditions: [{ text: 'report' }, { inMailboxOtherThan: ['tr', 'ju'] }] });
    expect(mailFilterFor(parseSearchQuery('report is:anything'), boxes as never, 'jmap-a'))
      .toEqual({ text: 'report' });
  });

  it('searches only the role folder for in:trash, by its raw id', () => {
    const boxes = [box('ns:tr', 'trash', 'ns', { originalId: 'tr' })];
    expect(mailFilterFor(parseSearchQuery('in:trash x'), boxes as never, 'ns'))
      .toEqual({ operator: 'AND', conditions: [{ text: 'x' }, { inMailbox: 'tr' }] });
    // in:junk alone (no words) is still a query: the folder.
    expect(mailFilterFor(parseSearchQuery('in:junk'), [box('ju', 'junk')] as never, 'jmap-a'))
      .toEqual({ inMailbox: 'ju' });
  });

  it('takes only the folders of the JMAP account it queries', () => {
    const boxes = [box('tr', 'trash', 'jmap-a'), box('tr2', 'trash', 'group')];
    expect(mailFilterFor(parseSearchQuery('x'), boxes as never, 'group'))
      .toEqual({ operator: 'AND', conditions: [{ text: 'x' }, { inMailboxOtherThan: ['tr2'] }] });
  });

  it('sends the words as typed and maps the operators like the store', () => {
    const filter = mailFilterFor(
      parseSearchQuery('runn* from:alice has:attachment is:unread is:starred subject:plan'),
      [] as never,
      'jmap-a',
    );
    expect(filter).toEqual({
      operator: 'AND',
      conditions: [
        { text: 'runn*' },
        { from: 'alice' },
        { subject: 'plan' },
        { hasAttachment: true },
        { notKeyword: '$seen' },
        { hasKeyword: '$flagged' },
      ],
    });
  });

  it('applies structured operators to cached emails', () => {
    const email = {
      id: 'm1', subject: 'Invoice', preview: '', receivedAt: '2026-05-05T10:00:00Z',
      from: [{ name: 'Alice', email: 'alice@x' }], to: [], keywords: { $seen: true }, hasAttachment: true, mailboxIds: {},
    };
    expect(emailMatchesFilters(email as never, parseSearchQuery('from:alice has:attachment is:read'))).toBe(true);
    expect(emailMatchesFilters(email as never, parseSearchQuery('is:unread'))).toBe(false);
    expect(emailMatchesFilters(email as never, parseSearchQuery('after:2026-06-01'))).toBe(false);
  });

  it('local hits come from the shown account only, tagged with it, Trash and Junk left out', () => {
    emailState.mailboxes = [box('in', 'inbox'), box('tr', 'trash')];
    emailState.emails = [
      { id: '1', subject: 'Report A', receivedAt: '2026-01-01T00:00:00Z', keywords: {}, mailboxIds: { in: true } },
      { id: '2', subject: 'Report B', receivedAt: '2026-01-02T00:00:00Z', keywords: {}, mailboxIds: { tr: true } },
      { id: '3', subject: 'Report C', receivedAt: '2026-01-03T00:00:00Z', keywords: {}, mailboxIds: {}, jmapAccountId: 'group' },
    ];
    const hits = mailProvider.local(parseSearchQuery('report'), [account('login-a'), account('login-b')], 10);
    expect(hits.map((h) => [h.id, h.appAccountId, h.jmapAccountId])).toEqual([
      ['1', 'login-a', 'jmap-a'],
      ['3', 'login-a', 'group'],
    ]);
    expect(hits[0]).toMatchObject({ kind: 'mail', subtitle: 'IN', source: 'local', serverUrl: 'https://login-a.example' });

    // The cache is not the shown account's while the client serves another.
    served.clear();
    expect(mailProvider.local(parseSearchQuery('report'), [account('login-a')], 10)).toEqual([]);
  });

  it('local hits are dropped when the shown account is not among the searched ones', () => {
    emailState.emails = [{ id: '1', subject: 'Report', receivedAt: '', keywords: {}, mailboxIds: {} }];
    expect(mailProvider.local(parseSearchQuery('report'), [account('login-b')], 10)).toEqual([]);
  });

  it('matches a 200 KB subject in linear time', () => {
    const huge = 'a'.repeat(200_000);
    emailState.emails = [{ id: '1', subject: huge, preview: huge, receivedAt: '', keywords: {}, mailboxIds: {} }];
    const started = Date.now();
    mailProvider.local(parseSearchQuery(`${'a'.repeat(50)}b`), [account('login-a')], 10);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('searches the shown account on its live scope and tags each target', async () => {
    searchAccountEmails.mockImplementation(async (_id: string, search: { filter: (m: unknown[], j: string) => unknown }) => {
      expect(search.filter([box('tr', 'trash')], 'jmap-a')).toEqual({
        operator: 'AND', conditions: [{ text: 'zebra' }, { inMailboxOtherThan: ['tr'] }],
      });
      return {
        emails: [
          { id: '9', subject: 'Zebra', receivedAt: '2026-01-01T00:00:00Z', mailboxIds: {}, keywords: {}, jmapAccountId: 'jmap-a', sourceAccountId: 'login-a', isShared: false, sourceFolder: 'Inbox' },
          { id: '9', subject: 'Zebra group', receivedAt: '2026-01-02T00:00:00Z', mailboxIds: {}, keywords: {}, jmapAccountId: 'group', sourceAccountId: 'login-a', isShared: true, sourceFolder: 'Support' },
        ],
        hasMore: true,
      };
    });
    const result = await mailProvider.remote(parseSearchQuery('zebra'), account('login-a'), { limit: 25, position: 5, signal });
    expect(searchAccountEmails).toHaveBeenCalledWith('login-a', expect.objectContaining({
      limit: 25, position: 5, includeGroup: true, at: { gen: 1, accountId: 'jmap-a' },
    }));
    expect(result.hasMore).toBe(true);
    expect(result.hits.map((h) => [h.appAccountId, h.jmapAccountId, h.id, h.subtitle])).toEqual([
      ['login-a', 'jmap-a', '9', 'Inbox'],
      ['login-a', 'group', '9', 'Support'],
    ]);
    expect(result.hits[0]).toMatchObject({ kind: 'mail', source: 'remote', snippet: null, serverUrl: 'https://login-a.example' });
    // Same id in the own and the group account: two hits.
    expect(mergeHits([], result.hits)).toHaveLength(2);
  });

  it('leaves group accounts out when the setting says so', async () => {
    settingsState.includeGroupInUnified = false;
    searchAccountEmails.mockResolvedValue({ emails: [], hasMore: false });
    await mailProvider.remote(parseSearchQuery('x'), account('login-a'), { limit: 10, signal });
    expect(searchAccountEmails).toHaveBeenCalledWith('login-a', expect.objectContaining({ includeGroup: false }));
  });

  it('searches every other account through the detached path, tagged with that account', async () => {
    searchAccountEmails.mockResolvedValue({
      emails: [{ id: '1', subject: 'Zebra', receivedAt: '', mailboxIds: {}, keywords: {}, jmapAccountId: 'jmap-b', sourceAccountId: 'login-b', isShared: false }],
      hasMore: false,
    });
    const result = await mailProvider.remote(parseSearchQuery('zebra'), account('login-b'), { limit: 10, signal });
    const search = searchAccountEmails.mock.calls[0][1] as { at?: unknown };
    expect(searchAccountEmails.mock.calls[0][0]).toBe('login-b');
    expect(search.at).toBeUndefined();
    expect(result.hits[0]).toMatchObject({ appAccountId: 'login-b', jmapAccountId: 'jmap-b', id: '1' });
  });

  it('keeps colliding ids of two accounts apart', async () => {
    searchAccountEmails.mockImplementation(async (id: string) => ({
      emails: [{ id: '1', subject: `Zebra ${id}`, receivedAt: '', mailboxIds: {}, keywords: {}, jmapAccountId: 'c', sourceAccountId: id, isShared: false }],
      hasMore: false,
    }));
    const a = await mailProvider.remote(parseSearchQuery('zebra'), account('login-a'), { limit: 10, signal });
    const b = await mailProvider.remote(parseSearchQuery('zebra'), account('login-b'), { limit: 10, signal });
    const merged = mergeHits(a.hits, b.hits);
    expect(merged.map((h) => [h.appAccountId, h.id, h.title])).toEqual([
      ['login-a', '1', 'Zebra login-a'],
      ['login-b', '1', 'Zebra login-b'],
    ]);
  });

  it('drops the shown account results that land after a switch', async () => {
    const pending = deferred<unknown>();
    searchAccountEmails.mockReturnValue(pending.promise);
    const running = mailProvider.remote(parseSearchQuery('zebra'), account('login-a'), { limit: 10, signal });
    switchTo('login-b');
    pending.resolve({
      emails: [{ id: '1', subject: 'Zebra', receivedAt: '', mailboxIds: {}, keywords: {}, jmapAccountId: 'jmap-a', sourceAccountId: 'login-a', isShared: false }],
      hasMore: false,
    });
    expect(await running).toEqual({ hits: [], hasMore: false });
  });

  it('drops the shown account results when its connection was replaced', async () => {
    const pending = deferred<unknown>();
    searchAccountEmails.mockReturnValue(pending.promise);
    const running = mailProvider.remote(parseSearchQuery('zebra'), account('login-a'), { limit: 10, signal });
    client.connectionGen += 1;
    pending.resolve({ emails: [{ id: '1', subject: 'Zebra', receivedAt: '', mailboxIds: {}, keywords: {}, jmapAccountId: 'jmap-a' }], hasMore: false });
    expect((await running).hits).toEqual([]);
  });

  it('reads the shown account detached while the client still serves another', async () => {
    served.clear();
    served.add('login-old');
    searchAccountEmails.mockResolvedValue({ emails: [], hasMore: false });
    await mailProvider.remote(parseSearchQuery('zebra'), account('login-a'), { limit: 10, signal });
    expect((searchAccountEmails.mock.calls[0][1] as { at?: unknown }).at).toBeUndefined();
  });

  it('a superseded search throws AbortError', async () => {
    const controller = new AbortController();
    const pending = deferred<unknown>();
    searchAccountEmails.mockReturnValue(pending.promise);
    const running = mailProvider.remote(parseSearchQuery('zebra'), account('login-b'), { limit: 10, signal: controller.signal });
    controller.abort();
    pending.resolve({ emails: [{ id: '1', receivedAt: '', mailboxIds: {}, keywords: {}, jmapAccountId: 'jmap-b' }], hasMore: false });
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// ---------------------------------------------------------------------------

describe('contacts provider', () => {
  it('supports only the shown account', () => {
    expect(contactsProvider.supports(account('login-a'))).toBe(true);
    expect(contactsProvider.supports(account('login-b'))).toBe(false);
  });

  it('matches cached contacts by name/email substring and keeps store and raw ids apart', () => {
    contactsState.contacts = [
      { id: 'c1', name: { full: 'Bob Miller' }, emails: { e: { address: 'bob@x' } }, addressBookIds: { b1: true } },
      { id: 'c2', name: { full: 'Alice' }, emails: {}, addressBookIds: {} },
      { id: 'owner:c1', originalId: 'c1', accountId: 'owner', isShared: true, name: { full: 'Bobby' }, emails: {}, addressBookIds: {} },
    ];
    contactsState.addressBooks = [{ id: 'b1', name: 'Personal' }];
    const hits = contactsProvider.local(parseSearchQuery('bob'), [account('login-a')], 10);
    expect(hits.map((h) => [h.id, h.jmapAccountId, (h as { storeId: string }).storeId])).toEqual([
      ['c1', 'jmap-a', 'c1'],
      ['c1', 'owner', 'owner:c1'],
    ]);
    expect(hits[0]).toMatchObject({ appAccountId: 'login-a', title: 'Bob Miller', subtitle: 'Personal · bob@x', source: 'local' });
    expect(mergeHits([], hits)).toHaveLength(2);
    // Not the shown account, or not served: nothing from the cache.
    expect(contactsProvider.local(parseSearchQuery('bob'), [account('login-b')], 10)).toEqual([]);
    served.clear();
    expect(contactsProvider.local(parseSearchQuery('bob'), [account('login-a')], 10)).toEqual([]);
  });

  it('remote asks the server on the shown scope and tags the hits', async () => {
    searchContacts.mockResolvedValue([
      { id: 'c7', name: { full: 'Bob' }, emails: {}, addressBookIds: {} },
      { id: 'owner:c8', originalId: 'c8', accountId: 'owner', isShared: true, name: { full: 'Bob Shared' }, emails: {}, addressBookIds: {} },
    ]);
    const result = await contactsProvider.remote(parseSearchQuery('bob'), account('login-a'), { limit: 10, signal });
    // One more than the limit, to tell whether there is more.
    expect(searchContacts).toHaveBeenCalledWith('bob', 11, { gen: 1, accountId: 'jmap-a' });
    expect(result.hits[0]).toMatchObject({ id: 'c7', storeId: 'c7', appAccountId: 'login-a', jmapAccountId: 'jmap-a', source: 'remote' });
    expect(result.hits[1]).toMatchObject({ id: 'c8', storeId: 'owner:c8', jmapAccountId: 'owner' });
  });

  it('reports more when the server returned more than the limit', async () => {
    searchContacts.mockResolvedValue([
      { id: 'c1', name: { full: 'Bob 1' }, addressBookIds: {} },
      { id: 'c2', name: { full: 'Bob 2' }, addressBookIds: {} },
    ]);
    const result = await contactsProvider.remote(parseSearchQuery('bob'), account('login-a'), { limit: 1, signal });
    expect(result.hits).toHaveLength(1);
    expect(result.hasMore).toBe(true);
  });

  it('drops results that land after a switch', async () => {
    const pending = deferred<unknown[]>();
    searchContacts.mockReturnValue(pending.promise);
    const running = contactsProvider.remote(parseSearchQuery('bob'), account('login-a'), { limit: 10, signal });
    switchTo('login-b');
    pending.resolve([{ id: '1', name: { full: 'Bob' }, addressBookIds: {} }]);
    expect(await running).toEqual({ hits: [], hasMore: false });
  });

  it('asks nothing for an account that is not shown', async () => {
    const result = await contactsProvider.remote(parseSearchQuery('bob'), account('login-b'), { limit: 10, signal });
    expect(result.hits).toEqual([]);
    expect(searchContacts).not.toHaveBeenCalled();
  });

  it('keeps the same id from two accounts as two hits', async () => {
    searchContacts.mockResolvedValue([{ id: '1', name: { full: 'Bob A' }, addressBookIds: {} }]);
    const a = await contactsProvider.remote(parseSearchQuery('bob'), account('login-a'), { limit: 10, signal });
    switchTo('login-b');
    client.accountId = 'jmap-a';
    searchContacts.mockResolvedValue([{ id: '1', name: { full: 'Bob B' }, addressBookIds: {} }]);
    const b = await contactsProvider.remote(parseSearchQuery('bob'), account('login-b'), { limit: 10, signal });
    expect(mergeHits(a.hits, b.hits).map((h) => [h.appAccountId, h.id, h.title])).toEqual([
      ['login-a', '1', 'Bob A'],
      ['login-b', '1', 'Bob B'],
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('calendar provider', () => {
  it('turns day bounds into the user-zone LocalDateTime the server compares', () => {
    expect(calendarFilterFor(parseSearchQuery('sync after:2026-01-01 before:2026-02-01')))
      .toEqual({ text: 'sync', after: '2026-01-01T00:00:00', before: '2026-02-01T23:59:59' });
    expect(calendarFilterFor(parseSearchQuery('sync'))).toEqual({ text: 'sync' });
  });

  it('matches cached events on title/location and applies day bounds locally', () => {
    calendarState.events = [
      { id: 'e1', title: 'Team sync', start: '2026-03-01T10:00:00', calendarIds: { k: true }, recurrenceRules: null },
      { id: 'e2', title: 'Sync later', start: '2026-06-01T10:00:00', calendarIds: {}, recurrenceRules: null },
      { id: 'e3', title: 'Lunch', start: '2026-03-01T12:00:00', calendarIds: {}, locations: { l: { name: 'Sync café' } } },
    ];
    calendarState.calendars = [{ id: 'k', name: 'Work' }];
    const hits = calendarProvider.local(parseSearchQuery('sync before:2026-04-01'), [account('login-a')], 10);
    expect(hits.map((h) => h.id)).toEqual(['e1', 'e3']);
    expect(hits[0]).toMatchObject({ appAccountId: 'login-a', jmapAccountId: 'jmap-a', subtitle: 'Work', source: 'local' });
    expect(hits[1]).toMatchObject({ subtitle: 'Sync café' });
  });

  it('lists a recurring series once even when several occurrences match', () => {
    calendarState.events = [
      { id: 'o1', uid: 'series-1', title: 'Weekly sync', start: '2026-03-01T10:00:00', calendarIds: {}, recurrenceId: '2026-03-01T10:00:00' },
      { id: 'o2', uid: 'series-1', title: 'Weekly sync', start: '2026-03-08T10:00:00', calendarIds: {}, recurrenceId: '2026-03-08T10:00:00' },
    ];
    const hits = calendarProvider.local(parseSearchQuery('sync'), [account('login-a')], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ isRecurring: true });
  });

  it('tags shared store events with their owner and raw id', () => {
    calendarState.events = [
      { id: 'grp:1', originalId: '1', accountId: 'grp', isShared: true, title: 'Sync', start: '2026-03-01T10:00:00', calendarIds: { 'grp:k': true } },
      { id: '1', title: 'Sync', start: '2026-03-02T10:00:00', calendarIds: {} },
    ];
    calendarState.calendars = [{ id: 'grp:k', originalId: 'k', accountId: 'grp', name: 'Team' }];
    const hits = calendarProvider.local(parseSearchQuery('sync'), [account('login-a')], 10);
    expect(hits.map((h) => [h.jmapAccountId, h.id, h.subtitle])).toEqual([['grp', '1', 'Team'], ['jmap-a', '1', '']]);
  });

  it('remote queries the shown scope and flags recurring masters, calendar named by owner', async () => {
    calendarState.calendars = [
      { id: 'k', name: 'Mine' },
      { id: 'grp:k', originalId: 'k', accountId: 'grp', name: 'Team' },
    ];
    searchEventsAcrossAccounts.mockResolvedValue([
      { id: 'e9', uid: 'u9', title: 'Weekly sync', start: '2026-04-01T09:00:00', calendarIds: { k: true }, recurrenceRules: [{}] },
      { id: 'e9', uid: 'u10', title: 'Team sync', start: '2026-04-02T09:00:00', calendarIds: { k: true }, accountId: 'grp', isShared: true },
    ]);
    const result = await calendarProvider.remote(parseSearchQuery('sync after:2026-01-01'), account('login-a'), { limit: 10, signal });
    expect(searchEventsAcrossAccounts).toHaveBeenCalledWith(
      { text: 'sync', after: '2026-01-01T00:00:00' }, 10, { gen: 1, accountId: 'jmap-a' },
    );
    expect(result.hits.map((h) => [h.jmapAccountId, h.id, h.subtitle])).toEqual([['jmap-a', 'e9', 'Mine'], ['grp', 'e9', 'Team']]);
    expect(result.hits[0]).toMatchObject({ isRecurring: true, appAccountId: 'login-a', source: 'remote' });
    expect(mergeHits([], result.hits)).toHaveLength(2);
  });

  it('drops results that land after a switch, and asks nothing for another account', async () => {
    const pending = deferred<unknown[]>();
    searchEventsAcrossAccounts.mockReturnValue(pending.promise);
    const running = calendarProvider.remote(parseSearchQuery('sync'), account('login-a'), { limit: 10, signal });
    switchTo('login-b');
    pending.resolve([{ id: '1', uid: 'u', title: 'Sync', start: '', calendarIds: {} }]);
    expect(await running).toEqual({ hits: [], hasMore: false });

    searchEventsAcrossAccounts.mockClear();
    expect((await calendarProvider.remote(parseSearchQuery('sync'), account('login-a'), { limit: 10, signal })).hits).toEqual([]);
    expect(searchEventsAcrossAccounts).not.toHaveBeenCalled();
    expect(calendarProvider.supports(account('login-a'))).toBe(false);
    expect(calendarProvider.supports(account('login-b'))).toBe(true);
  });

  it('keeps the same event id from two accounts as two hits', async () => {
    searchEventsAcrossAccounts.mockResolvedValue([{ id: '1', uid: 'ua', title: 'Sync A', start: '', calendarIds: {} }]);
    const a = await calendarProvider.remote(parseSearchQuery('sync'), account('login-a'), { limit: 10, signal });
    switchTo('login-b');
    searchEventsAcrossAccounts.mockResolvedValue([{ id: '1', uid: 'ub', title: 'Sync B', start: '', calendarIds: {} }]);
    const b = await calendarProvider.remote(parseSearchQuery('sync'), account('login-b'), { limit: 10, signal });
    expect(mergeHits(a.hits, b.hits).map((h) => [h.appAccountId, h.id])).toEqual([['login-a', '1'], ['login-b', '1']]);
  });
});

// ---------------------------------------------------------------------------

describe('files provider', () => {
  const nodes = [
    { id: 'root1', parentId: null, name: 'Documents', type: 'd', blobId: null, size: 0, created: '', modified: '' },
    { id: 'f1', parentId: 'root1', name: 'zebra notes.txt', type: 'text/plain', blobId: 'b1', size: 3, created: '', modified: '2026-01-01T00:00:00Z' },
    { id: 'owner:s1', parentId: null, name: 'zebra shared.txt', type: 'text/plain', blobId: 'b2', size: 3, created: '', modified: '', accountId: 'owner', accountName: 'Owner', isShared: true },
  ];

  it('derives the folder path and the raw id', () => {
    expect(pathOfNode(nodes as never, nodes[1] as never)).toBe('/Documents');
    expect(pathOfNode(nodes as never, nodes[0] as never)).toBe('/');
    expect(rawFileNodeId(nodes[2] as never)).toBe('s1');
    expect(rawFileNodeId(nodes[1] as never)).toBe('f1');
  });

  it('a parent cycle ends the path walk', () => {
    const loop = [
      { id: 'a', parentId: 'b', name: 'A', type: 'd', blobId: null },
      { id: 'b', parentId: 'a', name: 'B', type: 'd', blobId: null },
    ];
    expect(pathOfNode(loop as never, loop[0] as never)).toBe('/A/B');
  });

  it('filters the listing of the shown scope by name and type', async () => {
    getFileListing.mockResolvedValue(nodes);
    const result = await filesProvider.remote(parseSearchQuery('zebra'), account('login-a'), { limit: 10, signal });
    expect(getFileListing).toHaveBeenCalledWith('login-a', { gen: 1, accountId: 'jmap-a' });
    expect(result.hits.map((h) => [h.id, h.jmapAccountId])).toEqual([['f1', 'jmap-a'], ['s1', 'owner']]);
    expect(result.hits[0]).toMatchObject({ appAccountId: 'login-a', folderPath: '/Documents', isFolder: false, subtitle: '/Documents' });
    expect(result.hits[1]).toMatchObject({ subtitle: 'Owner · /' });

    const folders = await filesProvider.remote(parseSearchQuery('folder'), account('login-a'), { limit: 10, signal });
    expect(folders.hits.map((h) => h.id)).toEqual(['root1']);
    const byType = await filesProvider.remote(parseSearchQuery('text/plain'), account('login-a'), { limit: 1, signal });
    expect(byType.hits).toHaveLength(1);
    expect(byType.hasMore).toBe(true);
  });

  it('the synchronous pass serves the cached listing of the shown account only', () => {
    peekFileListing.mockImplementation((id: string) => (id === 'login-a' ? nodes : null));
    expect(filesProvider.local(parseSearchQuery('notes'), [account('login-a'), account('login-b')], 10).map((h) => h.id)).toEqual(['f1']);
    expect(peekFileListing).not.toHaveBeenCalledWith('login-b');
    served.clear();
    expect(filesProvider.local(parseSearchQuery('notes'), [account('login-a')], 10)).toEqual([]);
  });

  it('drops a listing that lands after a switch', async () => {
    const pending = deferred<unknown[]>();
    getFileListing.mockReturnValue(pending.promise);
    const running = filesProvider.remote(parseSearchQuery('zebra'), account('login-a'), { limit: 10, signal });
    switchTo('login-b');
    pending.resolve(nodes);
    expect(await running).toEqual({ hits: [], hasMore: false });
    expect(filesProvider.supports(account('login-a'))).toBe(false);
  });

  it('keeps the same node id from two accounts as two hits', async () => {
    getFileListing.mockResolvedValue([{ id: '1', parentId: null, name: 'zebra A', type: 't', blobId: 'x' }]);
    const a = await filesProvider.remote(parseSearchQuery('zebra'), account('login-a'), { limit: 10, signal });
    switchTo('login-b');
    getFileListing.mockResolvedValue([{ id: '1', parentId: null, name: 'zebra B', type: 't', blobId: 'y' }]);
    const b = await filesProvider.remote(parseSearchQuery('zebra'), account('login-b'), { limit: 10, signal });
    expect(getFileListing).toHaveBeenLastCalledWith('login-b', expect.anything());
    expect(mergeHits(a.hits, b.hits).map((h) => [h.appAccountId, h.id, h.title])).toEqual([
      ['login-a', '1', 'zebra A'],
      ['login-b', '1', 'zebra B'],
    ]);
  });
});
