import { describe, it, expect, vi, beforeEach } from 'vitest';

const { client } = vi.hoisted(() => ({
  client: {
    isConnected: true,
    username: 'me@example.org',
    serverUrl: 'https://mail.example.org',
    accountId: 'own',
    currentSession: null as unknown,
    request: vi.fn(),
    getStoredCredentials: vi.fn(),
  },
}));
vi.mock('../jmap-client', () => ({
  jmapClient: client,
  rewriteSessionUrl: (url: string) => url,
  extractOrigin: () => null,
}));

vi.mock('../../stores/auth-store', () => ({ useAuthStore: { getState: () => ({ activeAccountId: null }) } }));
vi.mock('../../stores/account-store', () => ({ useAccountStore: { getState: () => ({ accounts: [] }) } }));
vi.mock('../../stores/email-store', () => ({ useEmailStore: { getState: () => ({ emails: [], mailboxes: [] }) } }));
vi.mock('../../stores/contacts-store', () => ({ useContactsStore: { getState: () => ({ contacts: [], addressBooks: [] }) } }));
vi.mock('../../stores/calendar-store', () => ({ useCalendarStore: { getState: () => ({ events: [], calendars: [] }) } }));

import { accountsFor, mailProvider, contactsProvider, resetGlobalSearchCache } from '../global-search';
import { parseSearchQuery } from '../../lib/global-search/query-parser';
import { generateAccountId } from '../../lib/account-utils';
import type { JMAPSession } from '../types';

const MAIL = 'urn:ietf:params:jmap:mail';
const CONTACTS = 'urn:ietf:params:jmap:contacts';

const session = {
  capabilities: { 'urn:ietf:params:jmap:core': {}, [MAIL]: {}, [CONTACTS]: {} },
  primaryAccounts: { [MAIL]: 'own', [CONTACTS]: 'own' },
  accounts: {
    own: { name: 'me@example.org', isPersonal: true, accountCapabilities: { [MAIL]: {}, [CONTACTS]: {} } },
    team: { name: 'Support', isPersonal: false, accountCapabilities: { [MAIL]: {} } },
  },
} as unknown as JMAPSession;

const live = {
  localAccountId: generateAccountId('me@example.org', 'https://mail.example.org'),
  label: 'Me', email: 'me@example.org', active: true,
};

beforeEach(() => {
  resetGlobalSearchCache();
  client.request.mockReset();
  client.currentSession = session;
});

describe('the JMAP accounts a login searches', () => {
  it('lists the own account first, then the shared ones that hold the kind', () => {
    expect(accountsFor(session, MAIL).map((a) => [a.id, a.primary])).toEqual([['own', true], ['team', false]]);
    expect(accountsFor(session, CONTACTS).map((a) => a.id)).toEqual(['own']);
  });
});

describe('mail search of the signed-in login', () => {
  it('searches every folder but Trash and Junk of each account, with snippets, in one request per account', async () => {
    client.request.mockImplementation(async (calls: unknown[][]) => {
      const [method, args] = calls[0] as [string, { accountId: string }];
      if (method === 'Mailbox/get') {
        return { methodResponses: [['Mailbox/get', { list: [{ id: `${args.accountId}-in`, role: 'inbox', name: 'Inbox' }, { id: `${args.accountId}-tr`, role: 'trash', name: 'Trash' }] }, '0']] };
      }
      return {
        methodResponses: [
          ['Email/query', { ids: [`${args.accountId}-m1`] }, 'q'],
          ['Email/get', { list: [{ id: `${args.accountId}-m1`, threadId: 't', subject: 'Invoice', mailboxIds: { [`${args.accountId}-in`]: true } }] }, 'g'],
          ['SearchSnippet/get', { list: [{ emailId: `${args.accountId}-m1`, subject: '<mark>Invoice</mark>', preview: null }] }, 's'],
        ],
      };
    });
    const { hits } = await mailProvider.remote(parseSearchQuery('invoice'), live, { limit: 10, signal: new AbortController().signal });

    const query = client.request.mock.calls.find(([calls]) => calls[0][0] === 'Email/query')![0];
    expect(query[0][1].filter).toEqual({ operator: 'AND', conditions: [{ text: 'invoice' }, { inMailboxOtherThan: ['own-tr'] }] });
    expect(query.map((c: unknown[]) => c[0])).toEqual(['Email/query', 'Email/get', 'SearchSnippet/get']);
    expect(hits.map((h) => [h.id, h.jmapAccountId, h.shared, h.subtitle])).toEqual([
      ['own-m1', 'own', false, 'Inbox'],
      ['team-m1', 'team', true, 'Support · Inbox'],
    ]);
    expect(hits[0].kind === 'mail' && hits[0].snippet?.subject).toBe('<mark>Invoice</mark>');
  });
});

describe('contact search of the signed-in login', () => {
  it('asks ContactCard/query with the text and names the card by the id the contacts list uses', async () => {
    client.request.mockResolvedValue({
      methodResponses: [
        ['ContactCard/query', { ids: ['c1'] }, 'q'],
        ['ContactCard/get', { list: [{ id: 'c1', addressBookIds: { b1: true }, name: { full: 'Anna Berg' }, emails: { e: { address: 'anna@x.example' } } }] }, 'g'],
        ['AddressBook/get', { list: [{ id: 'b1', name: 'Personal' }] }, 'b'],
      ],
    });
    const { hits } = await contactsProvider.remote(parseSearchQuery('anna'), live, { limit: 10, signal: new AbortController().signal });
    expect(client.request.mock.calls[0][0][0]).toEqual(['ContactCard/query', { accountId: 'own', filter: { text: 'anna' }, limit: 11 }, 'q']);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'contacts', id: 'c1', storeId: 'c1', subtitle: 'Personal · anna@x.example' });
  });
});
