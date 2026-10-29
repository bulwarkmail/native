import { describe, it, expect, vi, beforeEach } from 'vitest';

const METADATA = 'urn:ietf:params:jmap:metadata';

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    requests: [] as Array<{ calls: Array<[string, Record<string, unknown>, string]>; using?: string[] }>,
    answer: null as null | ((calls: Array<[string, Record<string, unknown>, string]>) => unknown),
  },
}));

vi.mock('../jmap-client', () => ({
  jmapClient: {
    serverUrl: 'https://mail.example.org',
    get currentSession() {
      return state.session;
    },
    request: vi.fn(async (calls: Array<[string, Record<string, unknown>, string]>, using?: string[]) => {
      state.requests.push({ calls, using });
      return state.answer!(calls);
    }),
  },
}));

import { getBulwarkMetadata, resetBulwarkMetadataPauses, supportsBulwarkMetadata } from '../bulwark-metadata';

const VENDOR = { supportsVendorNamespaces: true, supportsPrivate: true, namespaces: [], maxDepth: 8 };

// Stalwart 1.0.0 lists Metadata per account; 0.16 has none.
function session(version: '1.0' | '0.16') {
  const caps = version === '1.0' ? { [METADATA]: { dataTypes: { Mailbox: VENDOR, Email: VENDOR } } } : {};
  return {
    capabilities: version === '1.0' ? { [METADATA]: {} } : {},
    accounts: {
      own: { accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, ...caps } },
      team: { accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, ...caps } },
    },
  };
}

// As Stalwart 1.0.0 answers the query and the get (checked live 2026-10-29).
function inboxWith(metadata: unknown) {
  return () => ({
    methodResponses: [
      ['Mailbox/query', { accountId: 'team', ids: ['a'] }, 'q'],
      ['Mailbox/get', { accountId: 'team', list: [{ id: 'a', ...(metadata === undefined ? {} : { metadata }) }] }, 'g'],
    ],
  });
}

beforeEach(() => {
  state.requests = [];
  state.answer = null;
  resetBulwarkMetadataPauses();
});

describe('getBulwarkMetadata', () => {
  it('sends nothing to an account that advertises no metadata (Stalwart 0.16)', async () => {
    state.session = session('0.16');
    expect(supportsBulwarkMetadata('team')).toBe(false);
    expect(await getBulwarkMetadata('team')).toBeNull();
    expect(state.requests).toHaveLength(0);
  });

  it("reads the Inbox's Bulwark namespaces in a request of its own", async () => {
    state.session = session('1.0');
    state.answer = inboxWith({
      'org.bulwarkmail.tags': { tags: { urgent: { label: 'Urgent', color: 'red' } } },
      'com.example.other': { x: 1 },
    });

    expect(await getBulwarkMetadata('team')).toEqual({ tags: { tags: { urgent: { label: 'Urgent', color: 'red' } } } });
    expect(state.requests).toHaveLength(1);
    const [{ calls, using }] = state.requests;
    expect(using).toContain(METADATA);
    expect(calls.map(([name]) => name)).toEqual(['Mailbox/query', 'Mailbox/get']);
    expect(calls[0][1]).toEqual({ accountId: 'team', filter: { role: 'inbox' } });
    expect(calls[1][1].properties).toEqual(['id', 'metadata']);
  });

  it('takes an answer without the property for no metadata, and pauses the account', async () => {
    state.session = session('1.0');
    state.answer = inboxWith(undefined);
    expect(await getBulwarkMetadata('team')).toBeNull();
    expect(supportsBulwarkMetadata('team')).toBe(false);
    expect(await getBulwarkMetadata('team')).toBeNull();
    expect(state.requests).toHaveLength(1);
    // Another account is not paused with it.
    expect(supportsBulwarkMetadata('own')).toBe(true);
  });

  it('pauses an account whose request fails (the pre-release build dropped it)', async () => {
    state.session = session('1.0');
    state.answer = () => { throw new Error('socket hang up'); };
    expect(await getBulwarkMetadata('team')).toBeNull();
    expect(supportsBulwarkMetadata('team')).toBe(false);
  });
});
