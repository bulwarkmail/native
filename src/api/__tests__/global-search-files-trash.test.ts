import { describe, it, expect, vi, beforeEach } from 'vitest';

// Webmail 1.20: search leaves the Files trash (.Trash) out of its hits.

const { client, nodes } = vi.hoisted(() => ({
  client: {
    isConnected: true,
    username: 'me@example.org',
    serverUrl: 'https://mail.example.org',
    accountId: 'own',
    currentSession: null as unknown,
    request: vi.fn(),
    getStoredCredentials: vi.fn(),
  },
  nodes: { list: [] as unknown[] },
}));
vi.mock('../jmap-client', () => ({
  jmapClient: client,
  rewriteSessionUrl: (url: string) => url,
  extractOrigin: () => null,
}));
vi.mock('../files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../files')>()),
  getAllFileNodesAcrossAccounts: vi.fn(async () => nodes.list),
}));
vi.mock('../../stores/auth-store', () => ({ useAuthStore: { getState: () => ({ activeAccountId: null }) } }));
vi.mock('../../stores/account-store', () => ({ useAccountStore: { getState: () => ({ accounts: [] }) } }));
vi.mock('../../stores/email-store', () => ({ useEmailStore: { getState: () => ({ emails: [], mailboxes: [] }) } }));
vi.mock('../../stores/contacts-store', () => ({ useContactsStore: { getState: () => ({ contacts: [], addressBooks: [] }) } }));
vi.mock('../../stores/calendar-store', () => ({ useCalendarStore: { getState: () => ({ events: [], calendars: [] }) } }));

import { filesProvider, resetGlobalSearchCache } from '../global-search';
import { parseSearchQuery } from '../../lib/global-search/query-parser';
import { generateAccountId } from '../../lib/account-utils';
import type { JMAPSession } from '../types';

const FILES = 'urn:ietf:params:jmap:filenode';
const session = {
  capabilities: { 'urn:ietf:params:jmap:core': {}, [FILES]: {} },
  primaryAccounts: { [FILES]: 'own' },
  accounts: { own: { name: 'me@example.org', isPersonal: true, accountCapabilities: { [FILES]: {} } } },
} as unknown as JMAPSession;
const live = {
  localAccountId: generateAccountId('me@example.org', 'https://mail.example.org'),
  label: 'Me', email: 'me@example.org', active: true,
};

beforeEach(() => {
  resetGlobalSearchCache();
  client.currentSession = session;
  nodes.list = [
    { id: 'tr', name: '.Trash', parentId: null, type: '', nodeType: 'directory' },
    { id: 'b1', name: '1730112000000~', parentId: 'tr', type: '', nodeType: 'directory' },
    { id: 'old', name: 'report-old.pdf', parentId: 'b1', type: 'application/pdf', nodeType: 'file', blobId: 'x' },
    { id: 'docs', name: 'Docs', parentId: null, type: '', nodeType: 'directory' },
    { id: 'new', name: 'report.pdf', parentId: 'docs', type: 'application/pdf', nodeType: 'file', blobId: 'y' },
  ];
});

describe('file search', () => {
  it('leaves what is in the Files trash out', async () => {
    const { hits } = await filesProvider.remote!(parseSearchQuery('report'), live, { limit: 10, signal: new AbortController().signal });
    expect(hits.map((h) => h.title)).toEqual(['report.pdf']);
  });
});
