import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'own',
    authHeader: 'Basic x',
    request: vi.fn(),
    currentSession: null as unknown,
  },
}));

vi.mock('../../lib/client-cert', () => ({ secureFetch: vi.fn() }));

import { jmapClient } from '../jmap-client';
import { secureFetch } from '../../lib/client-cert';
import { CAPABILITIES } from '../types';
import {
  accountSupportsSieve,
  getSieveCapabilities,
  getSieveScriptContent,
  getSieveScripts,
  isSieveSupported,
  updateSieveScript,
  validateSieveScript,
} from '../sieve';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const mockFetch = secureFetch as unknown as ReturnType<typeof vi.fn>;

const SIEVE_CAPS = { sieveExtensions: ['fileinto'] };

function setSession(session: unknown) {
  (jmapClient as { currentSession: unknown }).currentSession = session;
}

beforeEach(() => {
  vi.clearAllMocks();
  setSession({
    downloadUrl: 'https://mail/download/{accountId}/{blobId}/{name}?type={type}',
    uploadUrl: 'https://mail/upload/{accountId}/',
    primaryAccounts: { [CAPABILITIES.SIEVE]: 'own' },
    capabilities: { [CAPABILITIES.SIEVE]: {} },
    accounts: {
      own: { name: 'me', isPersonal: true, isReadOnly: false, accountCapabilities: { [CAPABILITIES.SIEVE]: SIEVE_CAPS } },
      team: { name: 'Team', isPersonal: false, isReadOnly: false, accountCapabilities: { [CAPABILITIES.MAIL]: {} } },
      other: { name: 'Other', isPersonal: true, isReadOnly: false, accountCapabilities: { [CAPABILITIES.MAIL]: {} } },
    },
  });
});

describe('accountSupportsSieve', () => {
  const caps = { [CAPABILITIES.SIEVE]: {} };

  it('needs the Sieve capability in a personal account\'s own capabilities', () => {
    expect(accountSupportsSieve(
      { name: 'me', isPersonal: true, isReadOnly: false, accountCapabilities: { [CAPABILITIES.SIEVE]: {} } },
      caps,
    )).toBe(true);
    expect(accountSupportsSieve(
      { name: 'me', isPersonal: true, isReadOnly: false, accountCapabilities: { [CAPABILITIES.MAIL]: {} } },
      caps,
    )).toBe(false);
  });

  it('treats shared/group accounts as capable, but only when the server has Sieve', () => {
    expect(accountSupportsSieve({ name: 'grp', isPersonal: false, isReadOnly: false }, caps)).toBe(true);
    expect(accountSupportsSieve({ name: 'grp', isPersonal: false, isReadOnly: false }, {})).toBe(false);
    expect(accountSupportsSieve(undefined, caps)).toBe(false);
  });

  it('keeps the session answer for servers without accountCapabilities', () => {
    expect(accountSupportsSieve({ name: 'me', isPersonal: true, isReadOnly: false }, caps)).toBe(true);
  });
});

describe('isSieveSupported', () => {
  it('checks the own Sieve account by default and a named account on request', () => {
    expect(isSieveSupported()).toBe(true);
    expect(isSieveSupported('team')).toBe(true);
    expect(isSieveSupported('other')).toBe(false);
    expect(isSieveSupported('missing')).toBe(false);
  });

  it('is false without a session', () => {
    setSession(null);
    expect(isSieveSupported()).toBe(false);
  });
});

describe('account scoping', () => {
  it('reads the capabilities of the requested account', () => {
    expect(getSieveCapabilities()).toEqual(SIEVE_CAPS);
    expect(getSieveCapabilities('team')).toBeNull();
  });

  it('lists scripts of the requested account', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['SieveScript/get', { list: [] }, '0']] });
    await getSieveScripts('team');
    expect(mockRequest.mock.calls[0][0][0][1]).toEqual({ accountId: 'team' });
    await getSieveScripts();
    expect(mockRequest.mock.calls[1][0][0][1]).toEqual({ accountId: 'own' });
  });

  it('downloads a shared account\'s script against that account', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'keep;' });
    await getSieveScriptContent('blob-1', 'team');
    expect(mockFetch.mock.calls[0][0]).toContain('/download/team/blob-1/');
  });

  it('uploads and saves into the requested account', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ team: { blobId: 'b-new' } }) });
    mockRequest.mockResolvedValue({ methodResponses: [['SieveScript/set', { updated: { s1: null } }, '0']] });

    await updateSieveScript('s1', 'keep;', true, 'team');

    expect(mockFetch.mock.calls[0][0]).toBe('https://mail/upload/team/');
    const [method, args] = mockRequest.mock.calls[0][0][0];
    expect(method).toBe('SieveScript/set');
    expect(args).toEqual({
      accountId: 'team',
      update: { s1: { blobId: 'b-new' } },
      onSuccessActivateScript: 's1',
    });
  });

  it('validates against the requested account', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ blobId: 'b-val' }) });
    mockRequest.mockResolvedValue({ methodResponses: [['SieveScript/validate', {}, '0']] });

    await expect(validateSieveScript('keep;', 'team')).resolves.toEqual({ isValid: true });
    expect(mockFetch.mock.calls[0][0]).toBe('https://mail/upload/team/');
    expect(mockRequest.mock.calls[0][0][0][1]).toEqual({ accountId: 'team', blobId: 'b-val' });
  });
});
