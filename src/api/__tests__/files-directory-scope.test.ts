import { describe, it, expect, vi, beforeEach } from 'vitest';

// The admin's directory rules (webmail lib/directory-scope.ts,
// `directorySameDomainOnly`, `directoryHiddenLocalparts`) narrow every list
// of the server's accounts the app shows: they all read listPrincipals.

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'f',
    username: 'userc@example.org',
    serverUrl: 'https://mail.example.org',
    request: vi.fn(),
    hasCapability: vi.fn(() => true),
    hasAccountCapability: vi.fn(() => true),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxCallsInRequest: vi.fn(() => 16),
    getAccountCapability: vi.fn(),
    currentSession: null as unknown,
  },
}));

import { jmapClient } from '../jmap-client';
import { listPrincipals } from '../files';
import { directoryRulesOf, setDirectoryRulesProvider } from '../../lib/directory-scope';
import { sanitizePolicy } from '../../lib/org-policy';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

const DIRECTORY = [
  { id: 'b', type: 'individual', name: 'admin@example.org', email: 'admin@example.org' },
  { id: 'c', type: 'group', name: 'team@example.org', email: 'team@example.org' },
  { id: 'n', type: 'individual', name: 'noreply@example.org', email: 'noreply@example.org' },
  { id: 'x', type: 'individual', name: 'eve@other.org', email: 'eve@other.org' },
  { id: 'y', type: 'individual', name: 'alias-domain user', email: 'bob@alias.example' },
  { id: 'z', type: 'individual', name: 'nodomain', email: null },
  { id: 'f', type: 'individual', name: 'userc@example.org', email: 'userc@example.org' },
];

function answer(identities: Array<{ email: string }>) {
  mockRequest.mockImplementation(async (calls: Array<[string, Record<string, unknown>, string]>) => {
    if (calls[0][0] === 'Identity/get') {
      return { methodResponses: [['Identity/get', { list: identities }, '0']] };
    }
    return {
      methodResponses: [
        ['Principal/query', { ids: DIRECTORY.map((p) => p.id) }, '0'],
        ['Principal/get', { list: DIRECTORY }, '1'],
      ],
    };
  });
}

function givenPolicy(raw: unknown) {
  const policy = sanitizePolicy(raw);
  setDirectoryRulesProvider(() => directoryRulesOf(policy));
}

const ids = async () => (await listPrincipals()).principals.map((p) => p.id);

beforeEach(() => {
  vi.clearAllMocks();
  setDirectoryRulesProvider(null);
});

describe('listPrincipals with the directory rules', () => {
  it('lists everyone without rules', async () => {
    answer([]);
    givenPolicy({});
    expect(await ids()).toEqual(['b', 'c', 'n', 'x', 'y', 'z', 'f']);
  });

  it('hides the named account names everywhere', async () => {
    answer([]);
    givenPolicy({ directoryHiddenLocalparts: [' NoReply ', 'admin'] });
    expect(await ids()).toEqual(['c', 'x', 'y', 'z', 'f']);
  });

  it("keeps the user's own domains only, aliases included", async () => {
    answer([{ email: 'userc@example.org' }, { email: 'c@alias.example' }]);
    givenPolicy({ directorySameDomainOnly: true, directoryHiddenLocalparts: ['noreply'] });
    expect(await ids()).toEqual(['b', 'c', 'y', 'f']);
  });

  it('drops the rules a scope or a hand-written file gets wrong', () => {
    expect(directoryRulesOf(sanitizePolicy({ directorySameDomainOnly: 'yes', directoryHiddenLocalparts: 'noreply' }))).toBeNull();
    expect(sanitizePolicy({ directorySameDomainOnly: true, directoryHiddenLocalparts: ['A', 3, ''] })).toMatchObject({
      directorySameDomainOnly: true,
      directoryHiddenLocalparts: ['a'],
    });
  });
});
