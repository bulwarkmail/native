import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock expo-secure-store before importing the client
vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import * as SecureStore from 'expo-secure-store';
import { JMAPClient, AuthenticationError, InvalidTokenError, RateLimitError, SessionSupersededError, parseHoldLimit } from '../jmap-client';
import type { JMAPSession } from '../types';

const MOCK_SESSION: JMAPSession = {
  apiUrl: 'https://mail.example.com/jmap/',
  downloadUrl: 'https://mail.example.com/download/{accountId}/{blobId}/{name}?type={type}',
  uploadUrl: 'https://mail.example.com/upload/{accountId}/',
  eventSourceUrl: 'https://mail.example.com/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
  primaryAccounts: {
    'urn:ietf:params:jmap:mail': 'acc-1',
    'urn:ietf:params:jmap:core': 'acc-1',
  },
  accounts: {
    'acc-1': { name: 'user@example.com', isPersonal: true, isReadOnly: false },
  },
  capabilities: {
    'urn:ietf:params:jmap:core': {},
    'urn:ietf:params:jmap:mail': {},
  },
  state: 'state-1',
};

function mockFetch(responses: Array<{ status: number; json?: any; headers?: Record<string, string> }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex++] ?? responses[responses.length - 1];
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      statusText: resp.status === 200 ? 'OK' : 'Error',
      headers: {
        get: (name: string) => resp.headers?.[name] ?? null,
      },
      json: async () => resp.json,
      text: async () => (resp.json === undefined ? '' : JSON.stringify(resp.json)),
    };
  });
}

describe('JMAPClient', () => {
  let client: JMAPClient;

  beforeEach(() => {
    client = new JMAPClient();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('connect', () => {
    it('should authenticate and establish session', async () => {
      global.fetch = mockFetch([{ status: 200, json: MOCK_SESSION }]) as any;

      const session = await client.connect('https://mail.example.com', 'user', 'pass');

      expect(session).toEqual(MOCK_SESSION);
      expect(client.isConnected).toBe(true);
      expect(client.accountId).toBe('acc-1');
      expect(SecureStore.setItemAsync).toHaveBeenCalled();
    });

    it('should throw AuthenticationError on 401', async () => {
      global.fetch = mockFetch([{ status: 401 }]) as any;

      await expect(client.connect('https://mail.example.com', 'user', 'bad'))
        .rejects.toThrow(AuthenticationError);
    });

    it('should throw on non-ok response', async () => {
      global.fetch = mockFetch([{ status: 500 }]) as any;

      await expect(client.connect('https://mail.example.com', 'user', 'pass'))
        .rejects.toThrow('Session discovery failed');
    });

    it('should strip trailing slashes from server URL', async () => {
      global.fetch = mockFetch([{ status: 200, json: MOCK_SESSION }]) as any;

      await client.connect('https://mail.example.com///', 'user', 'pass');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://mail.example.com/jmap/session',
        expect.any(Object),
      );
    });

    it('should use Basic auth header', async () => {
      global.fetch = mockFetch([{ status: 200, json: MOCK_SESSION }]) as any;

      await client.connect('https://mail.example.com', 'user', 'pass');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${btoa('user:pass')}`,
          }),
        }),
      );
    });
  });

  describe('connectWithToken', () => {
    const TOKEN_SESSION = { ...MOCK_SESSION, username: 'user@example.com' };

    it('should use Bearer auth', async () => {
      global.fetch = mockFetch([{ status: 200, json: TOKEN_SESSION }]) as any;

      await client.connectWithToken('https://mail.example.com', 'my-token');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-token',
          }),
        }),
      );
      expect(client.isConnected).toBe(true);
    });

    it('names the account after the session and remembers the token', async () => {
      global.fetch = mockFetch([{ status: 200, json: TOKEN_SESSION }]) as any;

      const { username, accountId } = await client.connectWithToken('https://mail.example.com/', 'my-token');

      expect(username).toBe('user@example.com');
      expect(accountId).toBe('user@example.com@mail.example.com');
      const [key, stored] = vi.mocked(SecureStore.setItemAsync).mock.calls.at(-1)!;
      expect(key).toContain('user_example.com');
      expect(JSON.parse(stored)).toMatchObject({
        serverUrl: 'https://mail.example.com',
        username: 'user@example.com',
        accessToken: 'my-token',
      });
      expect(client.usesPastedToken).toBe(true);
    });

    it('refuses a token the server rejects', async () => {
      global.fetch = mockFetch([{ status: 401 }]) as any;

      await expect(client.connectWithToken('https://mail.example.com', 'bad')).rejects.toThrow(InvalidTokenError);
      expect(client.isConnected).toBe(false);
    });

    it('refuses a session that does not name the account', async () => {
      global.fetch = mockFetch([{ status: 200, json: MOCK_SESSION }]) as any;

      await expect(client.connectWithToken('https://mail.example.com', 'my-token')).rejects.toThrow('did not name the account');
      expect(client.isConnected).toBe(false);
    });

    it('keeps a download host the server runs on another HTTPS origin', async () => {
      global.fetch = mockFetch([{
        status: 200,
        json: {
          ...TOKEN_SESSION,
          apiUrl: 'https://api.fastmail.com/jmap/api/',
          downloadUrl: 'https://www.fastmailusercontent.com/jmap/download/{accountId}/{blobId}/{name}?type={type}',
          uploadUrl: 'https://api.fastmail.com/jmap/upload/{accountId}/',
        },
      }]) as any;

      const { session } = await client.connectWithToken('https://api.fastmail.com', 'my-token');

      expect(session.downloadUrl).toBe('https://www.fastmailusercontent.com/jmap/download/{accountId}/{blobId}/{name}?type={type}');
      expect(session.uploadUrl).toBe('https://api.fastmail.com/jmap/upload/{accountId}/');
    });

    it('still moves self-reported internal hosts onto the server address', async () => {
      global.fetch = mockFetch([{
        status: 200,
        json: {
          ...TOKEN_SESSION,
          apiUrl: 'http://localhost:8080/jmap/',
          downloadUrl: 'http://localhost:8080/download/{accountId}/{blobId}/{name}?type={type}',
        },
      }]) as any;

      const { session } = await client.connectWithToken('https://mail.example.com', 'my-token');

      expect(session.apiUrl).toBe('https://mail.example.com/jmap/');
      expect(session.downloadUrl).toBe('https://mail.example.com/download/{accountId}/{blobId}/{name}?type={type}');
    });
  });

  describe('request', () => {
    beforeEach(async () => {
      global.fetch = mockFetch([{ status: 200, json: MOCK_SESSION }]) as any;
      await client.connect('https://mail.example.com', 'user', 'pass');
    });

    it('should make JMAP API request', async () => {
      const responseBody = {
        methodResponses: [['Mailbox/get', { list: [] }, '0']],
      };
      global.fetch = mockFetch([{ status: 200, json: responseBody }]) as any;

      const result = await client.request([['Mailbox/get', { accountId: 'acc-1' }, '0']]);

      expect(result.methodResponses).toHaveLength(1);
      expect(result.methodResponses[0][0]).toBe('Mailbox/get');
    });

    it('should throw AuthenticationError on 401 during request', async () => {
      global.fetch = mockFetch([{ status: 401 }]) as any;

      await expect(client.request([['Mailbox/get', {}, '0']]))
        .rejects.toThrow(AuthenticationError);
    });

    it('should throw RateLimitError on 429', async () => {
      global.fetch = mockFetch([{
        status: 429,
        headers: { 'Retry-After': '10' },
      }]) as any;

      try {
        await client.request([['Mailbox/get', {}, '0']]);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        expect((err as RateLimitError).retryAfterMs).toBe(10000);
      }
    });

    it('should throw on non-ok response', async () => {
      global.fetch = mockFetch([{ status: 503 }]) as any;

      await expect(client.request([['Mailbox/get', {}, '0']]))
        .rejects.toThrow('JMAP request failed: 503');
    });

    it('should throw if not connected', async () => {
      const freshClient = new JMAPClient();
      await expect(freshClient.request([['Mailbox/get', {}, '0']]))
        .rejects.toThrow('Not connected');
    });

    it('should send correct request body', async () => {
      const responseBody = { methodResponses: [] };
      global.fetch = mockFetch([{ status: 200, json: responseBody }]) as any;

      await client.request(
        [['Mailbox/get', { accountId: 'acc-1' }, '0']],
        ['urn:ietf:params:jmap:core'],
      );

      const fetchCall = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.using).toEqual(['urn:ietf:params:jmap:core']);
      expect(body.methodCalls).toEqual([['Mailbox/get', { accountId: 'acc-1' }, '0']]);
    });
  });

  describe('restoreSession', () => {
    it('should restore from stored credentials', async () => {
      (SecureStore.getItemAsync as any).mockResolvedValue(
        JSON.stringify({ serverUrl: 'https://mail.example.com', username: 'user', password: 'pass' }),
      );
      global.fetch = mockFetch([{ status: 200, json: MOCK_SESSION }]) as any;

      const restored = await client.restoreSession();

      expect(restored).toBe(true);
      expect(client.isConnected).toBe(true);
    });

    it('should return false with no stored credentials', async () => {
      (SecureStore.getItemAsync as any).mockResolvedValue(null);

      const restored = await client.restoreSession();

      expect(restored).toBe(false);
      expect(client.isConnected).toBe(false);
    });

    it('should logout and return false on failure', async () => {
      (SecureStore.getItemAsync as any).mockResolvedValue(
        JSON.stringify({ serverUrl: 'https://fail.com', username: 'u', password: 'p' }),
      );
      global.fetch = mockFetch([{ status: 500 }]) as any;

      const restored = await client.restoreSession();

      expect(restored).toBe(false);
      expect(SecureStore.deleteItemAsync).toHaveBeenCalled();
    });
  });

  describe('loadAccount', () => {
    const OTHER_SESSION: JMAPSession = {
      ...MOCK_SESSION,
      apiUrl: 'https://other.example.com/jmap/',
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc-2' },
      accounts: { 'acc-2': { name: 'other@example.com', isPersonal: true, isReadOnly: false } },
    };

    it('serves no account while the next one loads, then the new one', async () => {
      global.fetch = mockFetch([{ status: 200, json: MOCK_SESSION }]) as any;
      await client.connect('https://mail.example.com', 'user', 'pass');
      (SecureStore.getItemAsync as any).mockResolvedValue(
        JSON.stringify({ serverUrl: 'https://other.example.com', username: 'other', password: 'pw' }),
      );
      let respond!: (response: unknown) => void;
      global.fetch = vi.fn(() => new Promise((resolve) => { respond = resolve; })) as any;

      const loading = client.loadAccount('other@other.example.com');
      // Before the stored credentials are even read: the stores already show
      // the new account, and the old session must not serve its requests.
      expect(client.isConnected).toBe(false);
      await vi.waitFor(() => expect(global.fetch).toHaveBeenCalled());
      expect(client.isConnected).toBe(false);
      await expect(client.request([['Mailbox/get', { accountId: 'acc-1' }, '0']])).rejects.toThrow('Not connected');

      respond({
        ok: true, status: 200, statusText: 'OK', headers: { get: () => null },
        json: async () => OTHER_SESSION, text: async () => JSON.stringify(OTHER_SESSION),
      });
      expect(await loading).toBe(true);
      expect(client.isConnected).toBe(true);
      expect(client.accountId).toBe('acc-2');
    });

    it('names its account without throwing, and only while a session is up', async () => {
      // Read at render (the sidebar, the viewer), also before the first session.
      expect(client.connectedAccountId).toBeNull();
      global.fetch = mockFetch([{ status: 200, json: MOCK_SESSION }]) as any;
      await client.connect('https://mail.example.com', 'user', 'pass');
      expect(client.connectedAccountId).toBe('acc-1');

      (SecureStore.getItemAsync as any).mockResolvedValue(null);
      await client.loadAccount('gone@other.example.com');

      expect(client.connectedAccountId).toBeNull();
      // API calls still refuse to run without one.
      expect(() => client.accountId).toThrow('Not authenticated');
    });

    it('leaves the previous account to the snapshot when the next one cannot load', async () => {
      global.fetch = mockFetch([{ status: 200, json: MOCK_SESSION }]) as any;
      await client.connect('https://mail.example.com', 'user', 'pass');
      const previous = client.snapshot();
      (SecureStore.getItemAsync as any).mockResolvedValue(null);

      expect(await client.loadAccount('gone@other.example.com')).toBe(false);
      expect(client.isConnected).toBe(false);

      client.restoreSnapshot(previous);
      expect(client.isConnected).toBe(true);
      expect(client.accountId).toBe('acc-1');
    });

    describe('when loads overlap (B tapped, then C before B is up)', () => {
      const sessionOf = (host: string, id: string): JMAPSession => ({
        ...MOCK_SESSION,
        apiUrl: `https://${host}/jmap/`,
        primaryAccounts: { 'urn:ietf:params:jmap:mail': id },
        accounts: { [id]: { name: id, isPersonal: true, isReadOnly: false } },
      });
      const B = { key: 'jmap_credentials__b_b.example.com', creds: { serverUrl: 'https://b.example.com', username: 'b', password: 'pw' } };
      const C = { key: 'jmap_credentials__c_c.example.com', creds: { serverUrl: 'https://c.example.com', username: 'c', password: 'pw' } };

      // Session requests wait for the test to answer them, per host; a host
      // answered with null is unreachable from then on (the retry fails too).
      let answer: (host: string, session: JMAPSession | null) => Promise<void>;
      beforeEach(() => {
        const waiting = new Map<string, (session: JMAPSession | null) => void>();
        const unreachable = new Set<string>();
        global.fetch = vi.fn((url: string) => new Promise((resolve, reject) => {
          const host = new URL(url).host;
          const respond = (session: JMAPSession | null) => (session
            ? resolve({
              ok: true, status: 200, statusText: 'OK', headers: { get: () => null },
              json: async () => session, text: async () => JSON.stringify(session),
            })
            : reject(new TypeError('Network request failed')));
          if (unreachable.has(host)) respond(null);
          else waiting.set(host, respond);
        })) as any;
        answer = async (host, session) => {
          await vi.waitFor(() => expect(waiting.has(host)).toBe(true));
          const respond = waiting.get(host)!;
          waiting.delete(host);
          if (!session) unreachable.add(host);
          respond(session);
        };
        (SecureStore.getItemAsync as any).mockImplementation(async (key: string) =>
          ({ [B.key]: JSON.stringify(B.creds), [C.key]: JSON.stringify(C.creds) } as Record<string, string>)[key] ?? null);
      });

      afterEach(() => {
        (SecureStore.getItemAsync as any).mockReset();
      });

      it('keeps the account loaded last when an earlier load answers after it', async () => {
        const toB = client.loadAccount('b@b.example.com');
        await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
        const toC = client.loadAccount('c@c.example.com');
        await answer('c.example.com', sessionOf('c.example.com', 'acc-c'));
        expect(await toC).toBe(true);

        await answer('b.example.com', sessionOf('b.example.com', 'acc-b'));

        await expect(toB).rejects.toBeInstanceOf(SessionSupersededError);
        expect(client.accountId).toBe('acc-c');
        expect(client.currentSession?.apiUrl).toBe('https://c.example.com/jmap/');
        expect(client.username).toBe('c');
      });

      it('keeps the newer session up when an earlier load fails after it', async () => {
        const toB = client.loadAccount('b@b.example.com');
        await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
        const toC = client.loadAccount('c@c.example.com');
        await answer('c.example.com', sessionOf('c.example.com', 'acc-c'));
        await toC;

        await answer('b.example.com', null);

        await expect(toB).rejects.toBeInstanceOf(SessionSupersededError);
        expect(client.isConnected).toBe(true);
        expect(client.accountId).toBe('acc-c');
      });

      it('does not put in the credentials of a load whose read of them ended last', async () => {
        let readB!: (value: string) => void;
        (SecureStore.getItemAsync as any).mockImplementation((key: string) => (key === B.key
          ? new Promise<string>((resolve) => { readB = resolve; })
          : Promise.resolve(JSON.stringify(C.creds))));

        const toB = client.loadAccount('b@b.example.com');
        const toC = client.loadAccount('c@c.example.com');
        await answer('c.example.com', sessionOf('c.example.com', 'acc-c'));
        await toC;
        readB(JSON.stringify(B.creds));

        await expect(toB).rejects.toBeInstanceOf(SessionSupersededError);
        expect(client.username).toBe('c');
        expect((global.fetch as any).mock.calls.map(([url]: [string]) => new URL(url).host)).toEqual(['c.example.com']);
      });

      it('gives way to a snapshot put back meanwhile (a failed switch)', async () => {
        global.fetch = mockFetch([{ status: 200, json: MOCK_SESSION }]) as any;
        await client.connect('https://mail.example.com', 'user', 'pass');
        const previous = client.snapshot();
        let respond!: (session: JMAPSession) => void;
        global.fetch = vi.fn(() => new Promise((resolve) => {
          respond = (session) => resolve({
            ok: true, status: 200, statusText: 'OK', headers: { get: () => null },
            json: async () => session, text: async () => JSON.stringify(session),
          });
        })) as any;

        const toB = client.loadAccount('b@b.example.com');
        await vi.waitFor(() => expect(global.fetch).toHaveBeenCalled());
        client.restoreSnapshot(previous);
        respond(sessionOf('b.example.com', 'acc-b'));

        await expect(toB).rejects.toBeInstanceOf(SessionSupersededError);
        expect(client.accountId).toBe('acc-1');
        expect(client.username).toBe('user');
      });
    });
  });

  describe('logout', () => {
    it('should clear session and stored credentials', async () => {
      global.fetch = mockFetch([{ status: 200, json: MOCK_SESSION }]) as any;
      await client.connect('https://mail.example.com', 'user', 'pass');

      await client.logout();

      expect(client.isConnected).toBe(false);
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('jmap_credentials');
    });
  });

  describe('hasCapability', () => {
    it('should detect capabilities from session', async () => {
      global.fetch = mockFetch([{ status: 200, json: MOCK_SESSION }]) as any;
      await client.connect('https://mail.example.com', 'user', 'pass');

      expect(client.hasCapability('urn:ietf:params:jmap:mail')).toBe(true);
      expect(client.hasCapability('urn:ietf:params:jmap:calendars')).toBe(false);
    });
  });

  describe('account-level mail and submission limits (#57)', () => {
    // Stalwart's shape: the session-level mail/submission objects are empty,
    // the limits and SMTP extensions live under the account.
    const STALWART_SESSION: JMAPSession = {
      ...MOCK_SESSION,
      primaryAccounts: {
        'urn:ietf:params:jmap:mail': 'acc-1',
        'urn:ietf:params:jmap:submission': 'acc-1',
      },
      accounts: {
        'acc-1': {
          name: 'user@example.com',
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: {
            'urn:ietf:params:jmap:mail': { maxSizeAttachmentsPerEmail: 50_000_000, maxMailboxDepth: 10 },
            'urn:ietf:params:jmap:submission': {
              maxDelayedSend: 2_592_000,
              submissionExtensions: { FUTURERELEASE: [], SIZE: [], DSN: [] },
            },
            'urn:stalwart:jmap': {},
          },
        },
        'shared-no-send': {
          name: 'Team',
          isPersonal: false,
          isReadOnly: false,
          accountCapabilities: { 'urn:ietf:params:jmap:mail': {} },
        },
        'shared-no-hold': {
          name: 'Support',
          isPersonal: false,
          isReadOnly: false,
          accountCapabilities: {
            'urn:ietf:params:jmap:submission': { maxDelayedSend: 0, submissionExtensions: {} },
          },
        },
      },
      capabilities: {
        'urn:ietf:params:jmap:core': { maxSizeUpload: 50_000_000 },
        'urn:ietf:params:jmap:mail': {},
        'urn:ietf:params:jmap:submission': {},
      },
    };

    it('reads scheduled-send support from the account, not the empty session object', async () => {
      global.fetch = mockFetch([{ status: 200, json: STALWART_SESSION }]) as any;
      await client.connect('https://mail.example.com', 'user', 'pass');

      expect(client.hasDelayedSend()).toBe(true);
      // Stalwart's advertised 30 days count as the 7 its MTA accepts.
      expect(client.getMaxDelayedSend()).toBe(604_800);
      expect(client.getMaxSizeAttachmentsPerEmail()).toBe(50_000_000);
      expect(client.getMaxSizeUpload()).toBe(50_000_000);
    });

    it('uses the capability of the account that sends', async () => {
      global.fetch = mockFetch([{ status: 200, json: STALWART_SESSION }]) as any;
      await client.connect('https://mail.example.com', 'user', 'pass');

      // Its own submission capability says no.
      expect(client.hasDelayedSend('shared-no-hold')).toBe(false);
      expect(client.getMaxDelayedSend('shared-no-hold')).toBe(0);
      // No submission capability of its own: the primary submission account's applies.
      expect(client.hasDelayedSend('shared-no-send')).toBe(true);
      expect(client.getMaxSizeAttachmentsPerEmail('shared-no-send')).toBe(0);
    });

    it('falls back to the session-level objects when the account has none', async () => {
      const session: JMAPSession = {
        ...MOCK_SESSION,
        capabilities: {
          ...MOCK_SESSION.capabilities,
          'urn:ietf:params:jmap:mail': { maxSizeAttachmentsPerEmail: 1000 },
          'urn:ietf:params:jmap:submission': {
            maxDelayedSend: 3600,
            submissionExtensions: { futurerelease: ['3600', '2026-01-01T00:00:00Z'] },
          },
        },
      };
      global.fetch = mockFetch([{ status: 200, json: session }]) as any;
      await client.connect('https://mail.example.com', 'user', 'pass');

      expect(client.hasDelayedSend()).toBe(true);
      expect(client.getMaxDelayedSend()).toBe(3600);
      expect(client.getMaxSizeAttachmentsPerEmail()).toBe(1000);
    });

    it('reports no scheduled send without FUTURERELEASE', async () => {
      global.fetch = mockFetch([{ status: 200, json: MOCK_SESSION }]) as any;
      await client.connect('https://mail.example.com', 'user', 'pass');

      expect(client.hasDelayedSend()).toBe(false);
      expect(client.getMaxDelayedSend()).toBe(0);
    });

    it('lists every account that can hold submissions, primary first (webmail #874)', async () => {
      global.fetch = mockFetch([{ status: 200, json: STALWART_SESSION }]) as any;
      await client.connect('https://mail.example.com', 'user', 'pass');

      expect(client.getSubmissionAccountIds()).toEqual(['acc-1', 'shared-no-hold']);
    });

    describe('hold limit', () => {
      const withSubmission = (maxDelayedSend: number, stalwart: boolean): JMAPSession => ({
        ...STALWART_SESSION,
        accounts: {
          'acc-1': {
            name: 'user@example.com',
            isPersonal: true,
            isReadOnly: false,
            accountCapabilities: {
              'urn:ietf:params:jmap:submission': { maxDelayedSend, submissionExtensions: { FUTURERELEASE: [] } },
              ...(stalwart ? { 'urn:stalwart:jmap': {} } : {}),
            },
          },
        },
      });

      it('trusts the advertised limit on other servers and other values', async () => {
        global.fetch = mockFetch([{ status: 200, json: withSubmission(2_592_000, false) }]) as any;
        await client.connect('https://mail.example.com', 'user', 'pass');
        expect(client.getMaxDelayedSend()).toBe(2_592_000);

        const other = new JMAPClient();
        global.fetch = mockFetch([{ status: 200, json: withSubmission(3600, true) }]) as any;
        await other.connect('https://mail.example.com', 'user', 'pass');
        expect(other.getMaxDelayedSend()).toBe(3600);
      });

      it('learns the limit from a rejection, per server', async () => {
        global.fetch = mockFetch([{ status: 200, json: withSubmission(2_592_000, false) }]) as any;
        await client.connect('https://mail.example.com', 'user', 'pass');
        client.learnHoldLimit(172_800);
        expect(client.getMaxDelayedSend()).toBe(172_800);

        global.fetch = mockFetch([{ status: 200, json: withSubmission(2_592_000, false) }]) as any;
        await client.connect('https://other.example.com', 'user', 'pass');
        expect(client.getMaxDelayedSend()).toBe(2_592_000);
      });

      it('caps the undo-send hold and drops it where holding is unsupported', async () => {
        global.fetch = mockFetch([{ status: 200, json: withSubmission(20, false) }]) as any;
        await client.connect('https://mail.example.com', 'user', 'pass');
        expect(client.undoSendHold(10)).toBe(10);
        expect(client.undoSendHold(30)).toBe(20);
        expect(client.undoSendHold(0)).toBeUndefined();

        global.fetch = mockFetch([{ status: 200, json: MOCK_SESSION }]) as any;
        await client.connect('https://mail.example.com', 'user', 'pass');
        expect(client.undoSendHold(30)).toBeUndefined();
      });

      it('gives the latest time a send can be held until, for the date pickers', async () => {
        global.fetch = mockFetch([{ status: 200, json: withSubmission(2_592_000, true) }]) as any;
        await client.connect('https://mail.example.com', 'user', 'pass');
        const now = Date.UTC(2026, 8, 24, 12, 0, 0);
        expect(client.latestHoldDate(undefined, now)?.toISOString()).toBe('2026-10-01T12:00:00.000Z');

        global.fetch = mockFetch([{ status: 200, json: MOCK_SESSION }]) as any;
        await client.connect('https://mail.example.com', 'user', 'pass');
        expect(client.latestHoldDate(undefined, now)).toBeUndefined();
      });

      it('parses only hold-limit rejections', () => {
        expect(parseHoldLimit('Server rejected MAIL-FROM: 501 5.5.4 Requested hold time exceeds maximum of 604800 seconds.')).toBe(604_800);
        expect(parseHoldLimit('Server rejected MAIL-FROM: 550 nope')).toBeNull();
        expect(parseHoldLimit(undefined)).toBeNull();
      });
    });
  });

  describe('accountId resolution', () => {
    it('should fall back to core account', async () => {
      const session = {
        ...MOCK_SESSION,
        primaryAccounts: {
          'urn:ietf:params:jmap:core': 'core-acc',
        },
      };
      global.fetch = mockFetch([{ status: 200, json: session }]) as any;

      await client.connect('https://mail.example.com', 'user', 'pass');
      expect(client.accountId).toBe('core-acc');
    });

    it('should fall back to first account', async () => {
      const session = {
        ...MOCK_SESSION,
        primaryAccounts: {},
        accounts: { 'only-acc': { name: 'test', isPersonal: true, isReadOnly: false } },
      };
      global.fetch = mockFetch([{ status: 200, json: session }]) as any;

      await client.connect('https://mail.example.com', 'user', 'pass');
      expect(client.accountId).toBe('only-acc');
    });

    it('should throw on an empty (unauthenticated) session', async () => {
      // Stalwart returns 200 with empty accounts for invalid credentials;
      // the client surfaces that as an auth failure.
      const session = {
        ...MOCK_SESSION,
        primaryAccounts: {},
        accounts: {},
      };
      global.fetch = mockFetch([{ status: 200, json: session }]) as any;

      await expect(client.connect('https://mail.example.com', 'user', 'pass'))
        .rejects.toThrow('Invalid credentials');
    });
  });
});
