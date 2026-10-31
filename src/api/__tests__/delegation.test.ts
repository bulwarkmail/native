import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'ci',
    request: vi.fn(),
    currentSession: null as unknown,
    hasCapability: vi.fn(),
    getMaxObjectsInSet: vi.fn(() => 500),
    getMaxCallsInRequest: vi.fn(() => 16),
  },
}));

vi.mock('../files', () => ({
  getAllFileNodes: vi.fn(async () => []),
  filesAccountId: () => 'ci',
  supportsFiles: vi.fn(() => true),
}));

import { jmapClient } from '../jmap-client';
import { getAllFileNodes, supportsFiles } from '../files';
import {
  LOGIN_SWITCHED,
  applyShareChanges,
  findPrincipalByEmail,
  getShareTargets,
  sharesSeenWithKeywords,
  supportsDelegation,
  supportsMailboxSharing,
} from '../delegation';
import { buildGrantChanges, buildRevokeChanges } from '../../lib/delegation/delegation';
import { CALENDAR_PRESETS, FILE_PRESETS, MAILBOX_PRESETS, ADDRESS_BOOK_PRESETS } from '../../lib/delegation/share-rights';
import type { ShareChange, ShareTarget } from '../../lib/delegation/share-batch';

// Ported from the client part of the webmail's lib/__tests__/jmap-share-batch.test.ts,
// plus the capability checks of its settings-app supportsSharing.

type Call = [string, Record<string, unknown>, string];
const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const mockHasCapability = jmapClient.hasCapability as ReturnType<typeof vi.fn>;
const mockMaxCalls = jmapClient.getMaxCallsInRequest as ReturnType<typeof vi.fn>;

const ALL_CAPS = {
  'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:mail:share': {}, 'urn:ietf:params:jmap:calendars': {},
  'urn:ietf:params:jmap:contacts': {}, 'urn:ietf:params:jmap:filenode': {},
};

function setSession(accountCapabilities: Record<string, unknown>, sessionCaps: string[] = ['urn:ietf:params:jmap:principals']) {
  const capabilities = Object.fromEntries(['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', ...sessionCaps].map((c) => [c, {}]));
  (jmapClient as { currentSession: unknown }).currentSession = {
    capabilities,
    primaryAccounts: {},
    accounts: { ci: { name: 'org-alice@example.org', isPersonal: true, isReadOnly: false, accountCapabilities } },
  };
  mockHasCapability.mockImplementation((urn: string) => urn in capabilities);
}

const change = (kind: ShareChange['kind'], id: string, rights: ShareChange['rights'], principalId = 'ck'): ShareChange =>
  ({ kind, accountId: 'ci', id, name: id, principalId, rights });

const sent = () => mockRequest.mock.calls.map(([calls, using]) => ({ calls: calls as Call[], using: using as string[] }));
const allUpdated = (calls: Call[]) => ({
  methodResponses: calls.map(([method, args, id]) => [method, { updated: Object.fromEntries(Object.keys(args.update as object).map((k) => [k, null])) }, id]),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockMaxCalls.mockReturnValue(16);
  (supportsFiles as ReturnType<typeof vi.fn>).mockReturnValue(true);
  setSession(ALL_CAPS);
});

describe('capability checks', () => {
  it('shares mail folders only where the account lists mail:share', () => {
    expect(supportsMailboxSharing()).toBe(true);
    setSession({ 'urn:ietf:params:jmap:mail': {} }, ['urn:ietf:params:jmap:principals', 'urn:ietf:params:jmap:mail:share']);
    expect(supportsMailboxSharing()).toBe(false);
  });

  it('offers Delegates with principals and something to share, and follows the app gates', () => {
    const gates = { calendarsEnabled: true, contactsEnabled: true };
    expect(supportsDelegation(gates)).toBe(true);
    // Nobody to share with.
    setSession(ALL_CAPS, []);
    expect(supportsDelegation(gates)).toBe(false);
    // Only calendars to share: off with the calendar gate.
    setSession({ 'urn:ietf:params:jmap:calendars': {} });
    expect(supportsDelegation(gates)).toBe(true);
    expect(supportsDelegation({ calendarsEnabled: false, contactsEnabled: true })).toBe(false);
    // Nothing to share at all.
    setSession({ 'urn:ietf:params:jmap:mail': {} });
    expect(supportsDelegation(gates)).toBe(false);
  });

  it('knows a 1.0 account keeps seen and keywords as one right', () => {
    expect(sharesSeenWithKeywords()).toBe(false);
    setSession({ ...ALL_CAPS, 'urn:ietf:params:jmap:principals:owner': {} });
    expect(sharesSeenWithKeywords()).toBe(true);
  });
});

describe('getShareTargets', () => {
  const lists = (calls: Call[]) => calls.map(([method, , id]) => [method, {
    list: method === 'Mailbox/get' ? [{ id: 'a', name: 'Inbox', role: 'inbox', shareWith: { ck: MAILBOX_PRESETS.read } }]
      : method === 'Calendar/get' ? [{ id: 'b', name: 'Calendar', isDefault: true, shareWith: {} }]
        : [{ id: 'c', name: 'Contacts', isDefault: true, shareWith: {} }],
  }, id]);

  it('reads folders, calendars and address books in one request with shareWith, and only the shared files', async () => {
    mockRequest.mockImplementation(async (calls: Call[]) => ({ methodResponses: lists(calls) }));
    (getAllFileNodes as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'n1', name: 'plan.pdf', parentId: null, shareWith: { ck: FILE_PRESETS.read } },
      { id: 'n2', name: 'notes.txt', parentId: null, shareWith: {} },
    ]);
    const { targets, failed } = await getShareTargets();
    expect(mockRequest).toHaveBeenCalledTimes(1);
    const [{ calls, using }] = sent();
    expect(calls).toEqual([
      ['Mailbox/get', { accountId: 'ci', ids: null, properties: ['id', 'name', 'role', 'parentId', 'shareWith'] }, 'm'],
      ['Calendar/get', { accountId: 'ci', ids: null, properties: ['id', 'name', 'isDefault', 'shareWith'] }, 'c'],
      ['AddressBook/get', { accountId: 'ci', ids: null, properties: ['id', 'name', 'isDefault', 'shareWith'] }, 'a'],
    ]);
    expect(using).toEqual(expect.arrayContaining(['urn:ietf:params:jmap:mail:share', 'urn:ietf:params:jmap:calendars', 'urn:ietf:params:jmap:contacts']));
    expect(targets.map((t) => `${t.kind}:${t.id}`)).toEqual(['mailbox:a', 'calendar:b', 'addressBook:c', 'file:n1']);
    expect(failed).toEqual([]);
  });

  it('leaves out folders on an account without mail:share', async () => {
    setSession({ 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:calendars': {} });
    mockRequest.mockImplementation(async (calls: Call[]) => ({ methodResponses: lists(calls) }));
    await getShareTargets({ files: false });
    expect(sent()[0].calls.map(([m]) => m)).toEqual(['Calendar/get']);
  });

  it('skips the types whose feature is off', async () => {
    mockRequest.mockImplementation(async (calls: Call[]) => ({ methodResponses: lists(calls) }));
    await getShareTargets({ calendars: false, contacts: false, files: false });
    expect(sent()[0].calls.map(([m]) => m)).toEqual(['Mailbox/get']);
    expect(getAllFileNodes).not.toHaveBeenCalled();
  });

  it('names the types whose read failed', async () => {
    mockRequest.mockImplementation(async (calls: Call[]) => ({
      methodResponses: calls.map((call) => (call[0] === 'Calendar/get' ? ['error', { type: 'serverFail' }, call[2]] : lists([call])[0])),
    }));
    (getAllFileNodes as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { failed } = await getShareTargets();
    expect(failed.sort()).toEqual(['calendar', 'file']);
  });
});

describe('applyShareChanges', () => {
  it('gives a delegate the Inbox, the default calendar and the default address book in one request', async () => {
    mockRequest.mockImplementation(async (calls: Call[]) => allUpdated(calls));
    const targets = [
      { kind: 'mailbox' as const, accountId: 'ci', id: 'a', name: 'Inbox', role: 'inbox', shareWith: {} },
      { kind: 'mailbox' as const, accountId: 'ci', id: 'b', name: 'Sent', role: 'sent', shareWith: {} },
      { kind: 'calendar' as const, accountId: 'ci', id: 'c1', name: 'Work', isDefault: true, shareWith: {} },
      { kind: 'addressBook' as const, accountId: 'ci', id: 'ab', name: 'Contacts', isDefault: true, shareWith: {} },
    ];
    const results = await applyShareChanges(buildGrantChanges(targets, 'ck', { mail: 'inbox', calendars: 'default', addressBooks: 'default' }, 'write'));
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(sent()[0].calls).toEqual([
      ['Mailbox/set', { accountId: 'ci', update: { a: { 'shareWith/ck': MAILBOX_PRESETS.readWrite } } }, 's0'],
      ['Calendar/set', { accountId: 'ci', update: { c1: { 'shareWith/ck': CALENDAR_PRESETS.readWrite } } }, 's1'],
      ['AddressBook/set', { accountId: 'ci', update: { ab: { 'shareWith/ck': ADDRESS_BOOK_PRESETS.readWrite } } }, 's2'],
    ]);
    expect(sent()[0].using).toEqual(expect.arrayContaining([
      'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:mail:share', 'urn:ietf:params:jmap:calendars', 'urn:ietf:params:jmap:contacts',
    ]));
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('takes every grant away with null patches, files included', async () => {
    mockRequest.mockImplementation(async (calls: Call[]) => allUpdated(calls));
    const targets: ShareTarget[] = [
      { kind: 'mailbox', accountId: 'ci', id: 'a', name: 'Inbox', role: 'inbox', shareWith: { ck: MAILBOX_PRESETS.read } },
      { kind: 'file', accountId: 'ci', id: 'n1', name: 'plan.pdf', shareWith: { ck: FILE_PRESETS.read, cj: FILE_PRESETS.read } },
    ];
    await applyShareChanges(buildRevokeChanges(targets, 'ck'));
    expect(sent()[0].calls).toEqual([
      ['Mailbox/set', { accountId: 'ci', update: { a: { 'shareWith/ck': null } } }, 's0'],
      ['FileNode/set', { accountId: 'ci', update: { n1: { 'shareWith/ck': null } } }, 's1'],
    ]);
  });

  it('sends one request per maxCallsInRequest calls and reports every item', async () => {
    mockMaxCalls.mockReturnValue(2);
    mockRequest.mockImplementation(async (calls: Call[]) => allUpdated(calls));
    const results = await applyShareChanges([
      change('mailbox', 'a', MAILBOX_PRESETS.read),
      change('calendar', 'c2', CALENDAR_PRESETS.read),
      change('file', 'n1', null),
    ]);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(results.map((r) => [r.change.id, r.ok])).toEqual([['a', true], ['c2', true], ['n1', true]]);
  });

  it('marks the items of a failed request failed instead of throwing', async () => {
    mockRequest.mockRejectedValue(new Error('offline'));
    const results = await applyShareChanges([change('mailbox', 'a', MAILBOX_PRESETS.read)]);
    expect(results).toEqual([{ change: expect.objectContaining({ id: 'a' }), ok: false, error: 'offline' }]);
  });

  it('sends nothing once the login the page was opened in is no longer active', async () => {
    mockRequest.mockImplementation(async (calls: Call[]) => allUpdated(calls));
    const results = await applyShareChanges([change('mailbox', 'a', MAILBOX_PRESETS.read)], () => false);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(results).toEqual([{ change: expect.objectContaining({ id: 'a' }), ok: false, error: LOGIN_SWITCHED }]);
  });
});

describe('findPrincipalByEmail', () => {
  it('finds the principal with that address, whatever its case', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['Principal/query', { ids: ['ck'] }, '0'],
        ['Principal/get', { list: [{ id: 'ck', type: 'individual', name: 'Carol', email: 'org-carol@example.org' }] }, '1'],
      ],
    });
    const found = await findPrincipalByEmail(' Org-Carol@Example.org ');
    expect(found).toEqual({ principal: expect.objectContaining({ id: 'ck' }), status: 'ok' });
    expect(sent()[0].calls[0][1].filter).toEqual({ email: 'org-carol@example.org' });
  });

  it('says when directory queries are off (Stalwart 1.0)', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['error', { type: 'forbidden', description: 'The administrator has disabled directory queries.' }, '0'],
        ['error', { type: 'invalidResultReference' }, '1'],
      ],
    });
    expect(await findPrincipalByEmail('org-carol@example.org')).toEqual({ principal: null, status: 'forbidden', directoryQueriesOff: true });
  });

  it('tells a refusal for another reason apart, and an unknown address', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [['error', { type: 'forbidden', description: 'You are not authorized to perform this action' }, '0']] });
    expect(await findPrincipalByEmail('x@example.org')).toEqual({ principal: null, status: 'forbidden' });
    mockRequest.mockResolvedValueOnce({ methodResponses: [['Principal/query', { ids: [] }, '0'], ['Principal/get', { list: [] }, '1']] });
    expect(await findPrincipalByEmail('x@example.org')).toEqual({ principal: null, status: 'ok' });
  });
});
