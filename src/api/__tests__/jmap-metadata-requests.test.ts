import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * Stalwart 1.0 advertises JMAP Metadata (`urn:ietf:params:jmap:metadata`) by
 * default, but every handler behind it is still `todo!()`. Selecting
 * `metadata` / `privateMetadata` (or a `metadata/...` pointer) in a get, or
 * sending `ignoreMetadataOnlyChanges` to a /changes method, panics the request
 * on the server. 0.16 knows none of it. So the app must never send any of it,
 * and the gets whose server default could grow to include metadata ask for an
 * explicit property list instead. Port of the webmail's
 * lib/__tests__/jmap-metadata-requests.test.ts.
 *
 * Stalwart 1.0.0 (the release) serves Mailbox metadata, and templates are
 * kept there (src/api/bulwark-metadata.ts, in requests of their own, only
 * for accounts that advertise it). Everything else still never asks for it.
 */

const METADATA_CAPABILITY = 'urn:ietf:params:jmap:metadata';

type MethodCall = [string, Record<string, unknown>, string];

const { recorded } = vi.hoisted(() => ({
  recorded: {
    session: null as unknown,
    requests: [] as Array<{ calls: MethodCall[]; using?: string[] }>,
  },
}));

// Both versions' default Mailbox/get list, and what the folder list reads.
const RFC_MAILBOX_PROPERTIES = [
  'id', 'name', 'parentId', 'role', 'sortOrder', 'totalEmails', 'unreadEmails',
  'totalThreads', 'unreadThreads', 'myRights', 'isSubscribed',
];

const MAILBOXES = [
  { id: 'a', name: 'Inbox', role: 'inbox', parentId: null, sortOrder: 1, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true, myRights: {} },
  { id: 'd', name: 'Drafts', role: 'drafts', parentId: null, sortOrder: 2, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true, myRights: {} },
];

/** Answers every call the way both server versions do for these methods. */
function answer([name, args, callId]: MethodCall): [string, Record<string, unknown>, string] {
  switch (name) {
    case 'Mailbox/get':
      return [name, { accountId: args.accountId, state: 'sfy', list: args.ids ? [] : MAILBOXES, notFound: [] }, callId];
    case 'SieveScript/get':
      return [name, { accountId: args.accountId, state: 'n', list: [{ id: 'a', name: 'bulwark', blobId: 'b1', isActive: true }], notFound: [] }, callId];
    case 'Email/get':
      return [name, { accountId: args.accountId, state: 'sfy', list: [], notFound: [] }, callId];
    case 'Mailbox/changes':
    case 'Email/changes':
      return [name, { accountId: args.accountId, oldState: args.sinceState, newState: 'sfy', hasMoreChanges: false, created: [], updated: [], destroyed: [] }, callId];
    case 'Email/queryChanges':
      return [name, { accountId: args.accountId, oldQueryState: args.sinceQueryState, newQueryState: 'sfy', total: 0, removed: [], added: [] }, callId];
    default:
      return [name, { accountId: args.accountId }, callId];
  }
}

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'f',
    isConnected: true,
    get currentSession() {
      return recorded.session;
    },
    request: vi.fn(async (calls: MethodCall[], using?: string[]) => {
      recorded.requests.push({ calls, using });
      return { methodResponses: calls.map(answer) };
    }),
    hasCapability: vi.fn((urn: string) =>
      urn in ((recorded.session as { capabilities?: Record<string, unknown> } | null)?.capabilities ?? {})),
    hasAccountCapability: vi.fn(() => true),
    getSharedMailAccounts: vi.fn(() => [{ id: 'c', name: 'team' }]),
    getAccountName: vi.fn(() => 'userc@example.org'),
    getMaxCallsInRequest: vi.fn(() => 16),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
  },
}));

import {
  getEmailChanges,
  getEmailListDelta,
  getEmailQueryChanges,
  getMailboxChanges,
  getMailboxes,
  getMailboxesByIds,
  getMailboxesWithState,
  getSharedMailboxes,
  MAILBOX_PROPERTIES,
} from '../email';
import { getSieveScripts } from '../sieve';
import { startPolling } from '../push-stream';

function makeSession(server: '0.16.23' | '1.0') {
  const metadata = server === '1.0';
  const info = { maxDepth: 8, namespaces: [], supportsPrivate: true, supportsVendorNamespaces: true };
  return {
    apiUrl: 'https://mail.example.org/jmap/',
    capabilities: {
      'urn:ietf:params:jmap:core': {},
      'urn:ietf:params:jmap:mail': {},
      'urn:ietf:params:jmap:sieve': {},
      ...(metadata ? { [METADATA_CAPABILITY]: {} } : {}),
    },
    accounts: {
      f: {
        name: 'userc@example.org',
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {
          'urn:ietf:params:jmap:mail': {},
          'urn:ietf:params:jmap:sieve': {},
          'urn:stalwart:jmap': {},
          // As userc's 1.0 session lists it.
          ...(metadata ? { [METADATA_CAPABILITY]: { dataTypes: { Mailbox: info, SieveScript: info, Email: info } } } : {}),
        },
      },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'f', 'urn:ietf:params:jmap:sieve': 'f' },
  };
}

/** Every way a request could reach one of 1.0's unfinished Metadata handlers. */
function metadataUses(request: { calls: MethodCall[]; using?: string[] }): string[] {
  const found: string[] = [];
  if (request.using?.includes(METADATA_CAPABILITY)) found.push(`using ${METADATA_CAPABILITY}`);
  for (const [name, args] of request.calls) {
    if ('ignoreMetadataOnlyChanges' in args) found.push(`${name} ignoreMetadataOnlyChanges`);
    for (const key of ['properties', 'bodyProperties']) {
      const list = args[key];
      if (!Array.isArray(list)) continue;
      for (const property of list) {
        if (/^(private)?[Mm]etadata(\/|$)/.test(String(property))) found.push(`${name} ${key} ${property}`);
      }
    }
  }
  return found;
}

/** The folder, filter, delta-sync and polling paths. */
async function sweep(): Promise<void> {
  await getMailboxes();
  await getMailboxesWithState();
  await getSharedMailboxes();
  await getMailboxesByIds(['a']);
  await getMailboxChanges('sae');
  await getEmailChanges('sae');
  await getEmailQueryChanges('a', 'sae');
  await getEmailListDelta('a', 'sae', 'sae', { threads: true });
  await getSieveScripts();
  const stop = startPolling(() => undefined, 1000);
  await vi.advanceTimersByTimeAsync(1000);
  stop();
}

const callsOf = (method: string) =>
  recorded.requests.flatMap((r) => r.calls).filter(([name]) => name === method);

beforeEach(() => {
  vi.useFakeTimers();
  recorded.requests.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('JMAP Metadata never reaches the server', () => {
  it.each(['0.16.23', '1.0'] as const)('asks Mailbox/get and SieveScript/get for explicit RFC properties on Stalwart %s', async (server) => {
    recorded.session = makeSession(server);
    await sweep();

    expect(MAILBOX_PROPERTIES).toEqual(RFC_MAILBOX_PROPERTIES);
    const mailboxGets = callsOf('Mailbox/get');
    // getMailboxes, getMailboxesWithState, getSharedMailboxes, getMailboxesByIds, the poll.
    expect(mailboxGets).toHaveLength(5);
    expect(mailboxGets.slice(0, 4).map(([, args]) => args.properties)).toEqual(Array(4).fill(RFC_MAILBOX_PROPERTIES));
    // The poll only reads the state.
    expect(mailboxGets[4][1]).toEqual({ accountId: 'f', ids: [], properties: ['id'] });

    const sieveGets = callsOf('SieveScript/get');
    expect(sieveGets).toHaveLength(1);
    expect(sieveGets[0][1].properties).toEqual(['id', 'name', 'blobId', 'isActive']);
  });

  it('keeps the folder list working with the explicit properties on Stalwart 1.0', async () => {
    recorded.session = makeSession('1.0');
    const mailboxes = await getMailboxes();
    expect(mailboxes.map((m) => [m.id, m.role, m.sortOrder])).toEqual([['a', 'inbox', 1], ['d', 'drafts', 2]]);
    expect((await getSieveScripts()).map((s) => s.id)).toEqual(['a']);
  });

  it('never selects metadata, sends ignoreMetadataOnlyChanges or uses the Metadata capability on Stalwart 1.0', async () => {
    recorded.session = makeSession('1.0');
    await sweep();

    expect(recorded.requests.length).toBeGreaterThan(0);
    // The delta-sync paths build their /changes arguments explicitly.
    expect(callsOf('Mailbox/changes').map(([, args]) => args)).toEqual([{ accountId: 'f', sinceState: 'sae' }]);
    expect(callsOf('Email/changes').map(([, args]) => Object.keys(args).sort())).toEqual([
      ['accountId', 'sinceState'],
      ['accountId', 'sinceState'],
    ]);
    expect(recorded.requests.flatMap(metadataUses)).toEqual([]);
  });
});

/**
 * The runtime sweep covers the paths above; this catches any other request a
 * future change builds. Comments may name the Metadata properties, code may
 * not.
 */
describe('JMAP Metadata in the request-building sources', () => {
  const root = process.cwd();

  function sourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        files.push(...sourceFiles(rel));
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        files.push(rel);
      }
    }
    return files;
  }

  // Drops block comments and line comments that start a line or follow
  // whitespace, so `https://` inside a string stays.
  const withoutComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

  const FORBIDDEN = [
    /privateMetadata/,
    /ignoreMetadataOnlyChanges/,
    /urn:ietf:params:jmap:metadata/,
    // A `metadata` property or a `metadata/...` pointer as a string literal.
    /(['"`])metadata(\/[^'"`\n]*)?\1/,
  ];

  // The one module that may: Bulwark's own entries on the Inbox, asked for
  // in requests of their own.
  const METADATA_MODULE = 'src/api/bulwark-metadata.ts';

  it('never names a JMAP Metadata property, argument or capability in code', () => {
    const files = [...sourceFiles('src'), 'App.tsx'].filter((file) => file !== METADATA_MODULE);
    expect(files).toContain('src/api/email.ts');
    const hits: string[] = [];
    for (const file of files) {
      const code = withoutComments(readFileSync(path.join(root, file), 'utf8'));
      for (const pattern of FORBIDDEN) {
        const match = code.match(pattern);
        if (match) hits.push(`${file}: ${match[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('keeps privateMetadata and ignoreMetadataOnlyChanges out of the metadata module too', () => {
    const code = withoutComments(readFileSync(path.join(root, METADATA_MODULE), 'utf8'));
    expect(code).not.toMatch(/privateMetadata|ignoreMetadataOnlyChanges/);
  });
});
