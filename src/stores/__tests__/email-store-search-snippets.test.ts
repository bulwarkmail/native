import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeJmap, type FakeEmail } from './fake-jmap-server';

// Search hits show the server's SearchSnippet/get excerpts with the matched
// terms marked (webmail b408b2597, 2d67442a2). The page is listed first and
// the excerpts follow in one request per page, one call per account; they
// land only while the same search is still on screen, and in a list that
// spans accounts each account's excerpts reach its own rows only.

const server = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./fake-jmap-server').createFakeJmap> }));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    isConnected: true,
    accountId: 'c',
    connectedAccountId: 'c',
    username: 'me@example.com',
    serverUrl: 'https://mail.example.com',
    currentSession: {
      apiUrl: 'https://mail.example.com/jmap/',
      accounts: {
        c: { accountCapabilities: { 'urn:ietf:params:jmap:mail': { emailQuerySortOptions: ['receivedAt'] } } },
        team: { accountCapabilities: { 'urn:ietf:params:jmap:mail': { emailQuerySortOptions: ['receivedAt'] } } },
      },
    },
    getMaxObjectsInGet: () => 500,
    getMaxObjectsInSet: () => 500,
    getMaxCallsInRequest: () => 16,
    getSharedMailAccounts: () => [{ id: 'team', name: 'Team' }],
    request: vi.fn((calls) => server.current!.request(calls)),
  },
}));

vi.mock('../locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
  useLocaleStore: { getState: () => ({ locale: 'en', t: (_k: string, f?: string) => f ?? _k }) },
}));

vi.mock('../outbox-store', () => ({
  applyOrQueueBatch: async (_ops: unknown[], onlineRun?: () => Promise<void>) => { if (onlineRun) await onlineRun(); return { queued: false }; },
  applyOrQueue: async (_op: unknown, onlineRun?: () => Promise<void>) => { if (onlineRun) await onlineRun(); return { queued: false }; },
  useOutboxStore: { getState: () => ({ setAccount: vi.fn(async () => undefined), flush: vi.fn(async () => undefined) }) },
}));

vi.mock('../settings-store', () => {
  const settings: Record<string, unknown> = {};
  return {
    useSettingsStore: {
      getState: () => ({
        ...settings,
        updateSetting: (key: string, value: unknown) => { settings[key] = value; },
      }),
    },
    __settings: settings,
  };
});

vi.mock('../offline-cache-store', () => ({
  useOfflineCacheStore: {
    getState: () => ({
      hydrated: true,
      hydrate: vi.fn(),
      setAccount: vi.fn(async () => undefined),
      totalCount: () => 0,
      getEmailsInMailbox: vi.fn(async () => []),
      has: () => false,
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      patch: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }),
  },
}));

import { generateAccountId } from '../../lib/account-utils';
import * as settingsModule from '../settings-store';
import { useEmailStore } from '../email-store';
import type { Email, Mailbox } from '../../api/types';

const settings = (settingsModule as unknown as { __settings: Record<string, unknown> }).__settings;

function mb(id: string, role: string | null, shared?: { raw: string }): Mailbox {
  return {
    id,
    name: role ?? id,
    role,
    totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: {} as Mailbox['myRights'],
    ...(shared
      ? { originalId: shared.raw, accountId: 'team', accountName: 'Team', isShared: true }
      : { accountId: 'c', isShared: false }),
  };
}

const MAILBOXES: Mailbox[] = [
  mb('inbox', 'inbox'), mb('archive', 'archive'), mb('trash', 'trash'),
  mb('team:t-inbox', 'inbox', { raw: 't-inbox' }),
];

function mail(id: string, folder: string, day: number, subject: string, extra: Partial<FakeEmail> = {}): Email {
  return {
    id,
    size: 1,
    hasAttachment: false,
    threadId: `t-${id}`,
    mailboxIds: { [folder]: true },
    keywords: {},
    receivedAt: `2026-09-${String(day).padStart(2, '0')}T10:00:00Z`,
    subject,
    ...extra,
  };
}

function seed() {
  return createFakeJmap({
    c: [
      mail('a', 'inbox', 20, 'Zephyr launch', { preview: 'The <launch> is on & off' }),
      mail('b', 'inbox', 19, 'Lunch', { preview: 'zephyr is mentioned in the body only' }),
      mail('c1', 'archive', 14, 'Quarterly numbers', { preview: 'nothing to see' }),
    ],
    team: [
      // Same id as the own account's "a": ids only are unique per account.
      mail('a', 't-inbox', 22, 'Team sync', { preview: 'agenda for the zephyr review' }),
    ],
  });
}

const rows = () => useEmailStore.getState().emails;
const row = (id: string, stamp?: string) => rows().find((e) => e.id === id && (stamp === undefined || e.jmapAccountId === stamp));
const snippetCalls = () => server.current!.callsOf('SearchSnippet/get');

async function settle() {
  await vi.waitFor(() => expect(useEmailStore.getState().loading).toBe(false));
}

beforeEach(() => {
  server.current = seed();
  for (const key of Object.keys(settings)) delete settings[key];
  Object.assign(settings, {
    emailsPerPage: 25,
    mailSortAscending: false,
    disableThreading: true,
    deleteAction: 'trash',
    permanentlyDeleteJunk: false,
    archiveMode: 'single',
    messageListOrder: [],
    messageListOrderScope: 'inbox',
  });
  useEmailStore.getState().reset();
  useEmailStore.setState({
    activeAccountId: generateAccountId('me@example.com', 'https://mail.example.com'),
    mailboxes: MAILBOXES,
    currentMailboxId: 'inbox',
    pendingUndo: null,
  });
});

describe('search snippets in a folder search', () => {
  it('marks the matched terms of each hit, asked once for the whole page', async () => {
    useEmailStore.setState({ filters: { folder: 'current' } });
    useEmailStore.getState().setSearchQuery('zephyr');
    await settle();
    expect(rows().map((e) => e.id)).toEqual(['a', 'b']);

    await vi.waitFor(() => expect(row('b')?.searchSnippet).toBeDefined());
    expect(row('a')?.searchSnippet).toEqual({ subject: '<mark>Zephyr</mark> launch', preview: null });
    expect(row('b')?.searchSnippet).toEqual({ subject: null, preview: '<mark>zephyr</mark> is mentioned in the body only' });
    // One call for the page, sent on its own after the page was listed.
    expect(snippetCalls()).toHaveLength(1);
    const [, args] = snippetCalls()[0];
    expect(args).toEqual({ accountId: 'c', filter: { text: 'zephyr' }, emailIds: ['a', 'b'] });
    const snippetRequest = server.current!.requests.find((r) => r.some(([n]) => n === 'SearchSnippet/get'))!;
    expect(snippetRequest.map(([n]) => n)).toEqual(['SearchSnippet/get']);
  });

  it('loosens phrases and prefixes so the server marks their words', async () => {
    useEmailStore.setState({ filters: { folder: 'current' } });
    useEmailStore.getState().setSearchQuery('"zephyr launch" laun*');
    await settle();
    await vi.waitFor(() => expect(snippetCalls()).toHaveLength(1));
    expect(snippetCalls()[0][1].filter).toEqual({
      operator: 'AND', conditions: [{ text: 'zephyr launch' }, { text: 'laun' }],
    });
  });

  it('asks nothing for a filter without words to mark', async () => {
    useEmailStore.getState().setFilters({ isUnread: true, folder: 'current' });
    await settle();
    expect(rows().length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(snippetCalls()).toHaveLength(0);
  });

  it('drops the excerpts of a search the user has since changed', async () => {
    const release = server.current!.holdSnippets();
    useEmailStore.setState({ filters: { folder: 'current' } });
    useEmailStore.getState().setSearchQuery('zephyr');
    await settle();
    await vi.waitFor(() => expect(snippetCalls()).toHaveLength(1));

    // The unread filter lists the same messages; they must not show the
    // search's excerpts once it is gone.
    useEmailStore.setState({ searchQuery: '', filters: { folder: 'current', isUnread: true } });
    await useEmailStore.getState().refreshEmails();
    expect(rows().map((e) => e.id)).toEqual(['a', 'b']);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(snippetCalls()).toHaveLength(1);
    expect(row('a')?.searchSnippet).toBeUndefined();
    expect(row('b')?.searchSnippet).toBeUndefined();
  });

  it('highlights the rows load-more brings', async () => {
    settings.emailsPerPage = 1;
    useEmailStore.setState({ filters: { folder: 'current' } });
    useEmailStore.getState().setSearchQuery('zephyr');
    await settle();
    expect(rows().map((e) => e.id)).toEqual(['a']);
    await useEmailStore.getState().loadMoreEmails();
    expect(rows().map((e) => e.id)).toEqual(['a', 'b']);
    await vi.waitFor(() => expect(row('b')?.searchSnippet?.preview).toContain('<mark>zephyr</mark>'));
    expect(snippetCalls().map(([, args]) => args.emailIds)).toEqual([['a'], ['b']]);
  });
});

describe('search snippets across accounts', () => {
  it("asks every account in one request and keeps each account's excerpts to its own rows", async () => {
    useEmailStore.setState({ filters: { folder: 'all' } });
    useEmailStore.getState().setSearchQuery('zephyr');
    await settle();
    expect(rows().map((e) => `${e.jmapAccountId}:${e.id}`)).toEqual(['team:a', 'c:a', 'c:b']);

    await vi.waitFor(() => expect(row('a', 'team')?.searchSnippet).toBeDefined());
    await vi.waitFor(() => expect(row('b', 'c')?.searchSnippet).toBeDefined());
    expect(row('a', 'team')?.searchSnippet).toEqual({ subject: null, preview: 'agenda for the <mark>zephyr</mark> review' });
    expect(row('a', 'c')?.searchSnippet).toEqual({ subject: '<mark>Zephyr</mark> launch', preview: null });

    const snippetRequests = server.current!.requests.filter((r) => r.some(([n]) => n === 'SearchSnippet/get'));
    expect(snippetRequests).toHaveLength(1);
    expect(snippetRequests[0].map(([, args]) => [args.accountId, args.emailIds])).toEqual([
      ['team', ['a']],
      ['c', ['a', 'b']],
    ]);
  });

  it('keeps the results when one account cannot excerpt', async () => {
    const release = server.current!.holdSnippets();
    useEmailStore.setState({ filters: { folder: 'all' } });
    useEmailStore.getState().setSearchQuery('zephyr');
    await settle();
    await vi.waitFor(() => expect(snippetCalls()).toHaveLength(2));
    // The team account goes away between the query and the excerpts.
    server.current!.failing.set('team', 'forbidden');
    release();
    await vi.waitFor(() => expect(row('b', 'c')?.searchSnippet).toBeDefined());
    expect(row('a', 'c')?.searchSnippet?.subject).toBe('<mark>Zephyr</mark> launch');
    expect(row('a', 'team')?.searchSnippet).toBeUndefined();
    expect(rows()).toHaveLength(3);
  });
});
