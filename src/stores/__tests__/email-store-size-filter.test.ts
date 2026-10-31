import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeJmap, type FakeEmail } from './fake-jmap-server';

// The filter panel's size choice (webmail 1.19, 720e14622): "Larger than
// N MB" or a custom range in KB, sent as Email/query minSize (inclusive) and
// maxSize (exclusive) in bytes. A value that is not a positive number is no
// filter at all, so the folder stays the plain folder view.

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

const MAILBOXES: Mailbox[] = [{
  id: 'inbox', name: 'Inbox', role: 'inbox', accountId: 'c', isShared: false,
  totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
  myRights: {} as Mailbox['myRights'],
}];

const KB = 1024;

function mail(id: string, day: number, size: number): Email {
  return {
    id, size, hasAttachment: false, threadId: `t-${id}`,
    mailboxIds: { inbox: true }, keywords: {},
    receivedAt: `2026-09-${String(day).padStart(2, '0')}T10:00:00Z`,
    subject: `mail ${id}`,
  };
}

const ids = () => useEmailStore.getState().emails.map((e) => e.id);
const lastQueryFilter = () => server.current!.callsOf('Email/query').at(-1)?.[1].filter;

async function filterBy(filters: Record<string, unknown>) {
  useEmailStore.getState().setFilters({ folder: 'current', ...filters });
  await useEmailStore.getState().refreshEmails();
}

beforeEach(() => {
  server.current = createFakeJmap({
    c: [
      mail('small', 20, 2 * KB),
      // Exactly 1 MB: minSize is inclusive, maxSize exclusive.
      mail('edge', 19, 1024 * KB),
      mail('large', 18, 6 * 1024 * KB),
    ],
  });
  for (const key of Object.keys(settings)) delete settings[key];
  Object.assign(settings, {
    emailsPerPage: 25, mailSortAscending: false, disableThreading: true,
    messageListOrder: [], messageListOrderScope: 'inbox',
  });
  useEmailStore.getState().reset();
  useEmailStore.setState({
    activeAccountId: generateAccountId('me@example.com', 'https://mail.example.com'),
    mailboxes: MAILBOXES,
    currentMailboxId: 'inbox',
    pendingUndo: null,
  });
});

describe('size filter', () => {
  it('"Larger than 1 MB" sends minSize in bytes and lists only the large mail', async () => {
    await filterBy({ minSizeKb: '1024' });
    expect(lastQueryFilter()).toEqual({ inMailbox: 'inbox', minSize: 1024 * KB });
    expect(ids()).toEqual(['edge', 'large']);
  });

  it('a custom range sends both bounds', async () => {
    await filterBy({ minSizeKb: '1', maxSizeKb: '1024' });
    expect(lastQueryFilter()).toEqual({
      operator: 'AND',
      conditions: [{ inMailbox: 'inbox' }, { operator: 'AND', conditions: [{ minSize: KB }, { maxSize: 1024 * KB }] }],
    });
    expect(ids()).toEqual(['small']);
  });

  it('goes along with a search', async () => {
    useEmailStore.setState({ searchQuery: 'mail' });
    await filterBy({ maxSizeKb: '10' });
    expect(lastQueryFilter()).toEqual({
      operator: 'AND',
      conditions: [{ inMailbox: 'inbox' }, { operator: 'AND', conditions: [{ text: 'mail' }, { maxSize: 10 * KB }] }],
    });
    expect(ids()).toEqual(['small']);
  });

  it('reads a size still being typed as no filter', async () => {
    await filterBy({ minSizeKb: '0', maxSizeKb: '-' });
    expect(lastQueryFilter()).toEqual({ inMailbox: 'inbox' });
    expect(ids()).toEqual(['small', 'edge', 'large']);
    // Still the folder's own view: its list is kept as the folder's snapshot.
    expect(useEmailStore.getState().mailboxSnapshots.inbox?.emails.map((e) => e.id)).toEqual(['small', 'edge', 'large']);
  });
});
