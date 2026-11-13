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

import {
  getBulwarkMetadata, MetadataRefusedError, MetadataTooLargeError, MetadataUnsupportedError, patchBulwarkMetadata,
  resetBulwarkMetadata, resumeBulwarkMetadata, setBulwarkMetadata, supportsBulwarkMetadata, type MetadataClient,
} from '../bulwark-metadata';

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
  resetBulwarkMetadata();
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

describe('patchBulwarkMetadata', () => {
  type Calls = Array<[string, Record<string, unknown>, string]>;
  /** Answers the Inbox lookup, then each Mailbox/set with `set`. */
  const inboxThen = (set: Record<string, unknown> = { updated: { a: null } }) => (calls: Calls) =>
    calls[0][0] === 'Mailbox/set'
      ? { methodResponses: [['Mailbox/set', { accountId: 'own', ...set }, '0']] }
      : inboxWith({})();

  beforeEach(() => {
    state.session = session('1.0');
  });

  it('writes whole entries and single members of entries in one update', async () => {
    state.answer = inboxThen();
    await patchBulwarkMetadata('own', [
      { key: 'settings.shard.3', member: 'showPreview', value: { v: false, at: 5 } },
      { key: 'settings.shard.4', value: { density: { v: 'compact', at: 5 } } },
      { key: 'settings.shard.3', member: 'old', value: null },
    ]);
    const set = state.requests.at(-1)!;
    expect(set.using).toContain(METADATA);
    expect(set.calls).toHaveLength(1);
    expect(set.calls[0][1]).toEqual({
      accountId: 'own',
      update: {
        a: {
          'metadata/org.bulwarkmail.settings.shard.3/showPreview': { v: false, at: 5 },
          'metadata/org.bulwarkmail.settings.shard.4': { density: { v: 'compact', at: 5 } },
          'metadata/org.bulwarkmail.settings.shard.3/old': null,
        },
      },
    });
  });

  it('escapes a member name as a JSON Pointer token', async () => {
    state.answer = inboxThen();
    await patchBulwarkMetadata('own', [{ key: 'tags', member: 'a/b~c', value: {} }]);
    expect(Object.keys((state.requests.at(-1)!.calls[0][1].update as Record<string, object>).a))
      .toEqual(['metadata/org.bulwarkmail.tags/a~1b~0c']);
  });

  it('sends nothing for no changes, and refuses a key that is not one', async () => {
    state.answer = inboxThen();
    await patchBulwarkMetadata('own', []);
    expect(state.requests).toHaveLength(0);
    await expect(patchBulwarkMetadata('own', [{ key: 'Not A Key', value: {} }])).rejects.toThrow(/Invalid metadata key/);
  });

  it('tells a refusal for size from any other', async () => {
    state.answer = inboxThen({ notUpdated: { a: { type: 'invalidProperties', description: 'Metadata size 71743 exceeds the maximum of 65536 bytes.' } } });
    await expect(patchBulwarkMetadata('own', [{ key: 'x', value: {} }])).rejects.toBeInstanceOf(MetadataTooLargeError);
    state.answer = inboxThen({ notUpdated: { a: { type: 'invalidPatch', description: 'The namespace does not exist.' } } });
    await expect(patchBulwarkMetadata('own', [{ key: 'x', member: 'y', value: {} }])).rejects.toBeInstanceOf(MetadataRefusedError);
  });

  it('throws for an account without metadata', async () => {
    state.session = session('0.16');
    await expect(patchBulwarkMetadata('own', [{ key: 'x', value: {} }])).rejects.toBeInstanceOf(MetadataUnsupportedError);
    expect(state.requests).toHaveLength(0);
  });

  it('still refuses an entry over 8 KB before asking, through setBulwarkMetadata', async () => {
    state.answer = inboxThen();
    await expect(setBulwarkMetadata('own', 'x', { body: 'x'.repeat(9000) })).rejects.toBeInstanceOf(MetadataTooLargeError);
    expect(state.requests).toHaveLength(0);
    await setBulwarkMetadata('own', 'x', null);
    expect((state.requests.at(-1)!.calls[0][1].update as Record<string, object>).a).toEqual({ 'metadata/org.bulwarkmail.x': null });
  });

  it("goes through the client it is given, and keeps that client's accounts apart from the app's", async () => {
    const requests: Calls[] = [];
    const other: MetadataClient = {
      serverUrl: 'https://other.example.org',
      username: 'someone',
      currentSession: session('1.0') as never,
      request: (async (calls: Calls) => {
        requests.push(calls);
        return calls[0][0] === 'Mailbox/set'
          ? { methodResponses: [['Mailbox/set', { updated: { z: null } }, '0']] }
          : { methodResponses: [['Mailbox/query', { ids: ['z'] }, 'q'], ['Mailbox/get', { list: [{ id: 'z', metadata: {} }] }, 'g']] };
      }) as never,
    };
    // The app's client knows another Inbox id for an account with the same JMAP id.
    state.answer = inboxThen();
    await getBulwarkMetadata('own');

    await patchBulwarkMetadata('own', [{ key: 'x', value: {} }], other);
    expect(requests.map((calls) => calls[0][0])).toEqual(['Mailbox/query', 'Mailbox/set']);
    expect(Object.keys(requests[1][0][1].update as object)).toEqual(['z']);
    expect(state.requests).toHaveLength(1);

  });
});

describe('private metadata', () => {
  beforeEach(() => {
    state.session = session('1.0');
  });

  it("reads and writes the user's own namespaces, in the property of that name", async () => {
    state.answer = (calls) => (calls[0][0] === 'Mailbox/set'
      ? { methodResponses: [['Mailbox/set', { updated: { a: null } }, '0']] }
      : {
        methodResponses: [
          ['Mailbox/query', { ids: ['a'] }, 'q'],
          ['Mailbox/get', { list: [{ id: 'a', privateMetadata: { 'org.bulwarkmail.settings.shard.1': { density: { at: 5 } } } }] }, 'g'],
        ],
      });
    expect(await getBulwarkMetadata('own', undefined, 'private')).toEqual({ 'settings.shard.1': { density: { at: 5 } } });
    expect(state.requests[0].calls[1][1].properties).toEqual(['id', 'privateMetadata']);

    await patchBulwarkMetadata('own', [{ key: 'settings.shard.1', member: 'density', value: { at: 6 } }], undefined, 'private');
    expect((state.requests.at(-1)!.calls[0][1].update as Record<string, object>).a)
      .toEqual({ 'privateMetadata/org.bulwarkmail.settings.shard.1/density': { at: 6 } });
  });

  it('is not there on a server that keeps shared metadata only', async () => {
    const mailbox = { ...VENDOR, supportsPrivate: false };
    const caps = { 'urn:ietf:params:jmap:mail': {}, [METADATA]: { dataTypes: { Mailbox: mailbox } } };
    state.session = { capabilities: {}, accounts: { own: { accountCapabilities: caps } } };
    expect(supportsBulwarkMetadata('own')).toBe(true);
    expect(supportsBulwarkMetadata('own', undefined, 'private')).toBe(false);
    expect(await getBulwarkMetadata('own', undefined, 'private')).toBeNull();
    expect(state.requests).toHaveLength(0);
  });
});

describe('the pause after a failed read', () => {
  it('is for one set of namespaces: settings and templates of an account do not stop each other', async () => {
    state.session = session('1.0');
    state.answer = () => { throw new Error('socket hang up'); };
    expect(await getBulwarkMetadata('own', undefined, 'private')).toBeNull();
    expect(supportsBulwarkMetadata('own', undefined, 'private')).toBe(false);
    expect(supportsBulwarkMetadata('own')).toBe(true);

    resetBulwarkMetadata();
    expect(await getBulwarkMetadata('own')).toBeNull();
    expect(supportsBulwarkMetadata('own')).toBe(false);
    expect(supportsBulwarkMetadata('own', undefined, 'private')).toBe(true);
  });

  it('can be ended early', async () => {
    state.session = session('1.0');
    state.answer = () => { throw new Error('socket hang up'); };
    await getBulwarkMetadata('own', undefined, 'private');
    resumeBulwarkMetadata('own', undefined, 'private');
    expect(supportsBulwarkMetadata('own', undefined, 'private')).toBe(true);
  });

  it('keeps an account without metadata from being asked, whatever the value', async () => {
    state.session = session('0.16');
    await expect(setBulwarkMetadata('own', 'x', { body: 'x'.repeat(9000) })).rejects.toBeInstanceOf(MetadataUnsupportedError);
  });
});
