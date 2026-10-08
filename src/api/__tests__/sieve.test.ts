import { describe, it, expect, vi, beforeEach } from 'vitest';

// The live connection is generation `conn.gen`; a call on another one stops.
const conn = vi.hoisted(() => ({ gen: 1 }));
vi.mock('../jmap-client', () => {
  const assertCurrent = (gen: number) => {
    if (gen !== conn.gen) throw Object.assign(new Error('stale'), { name: 'StaleLoadError' });
  };
  return {
    jmapClient: {
      accountId: 'own',
      get connectionGen() { return conn.gen; },
      // Connection-scoped header (jmap-client authHeaderFor).
      authHeaderFor: (gen: number) => { assertCurrent(gen); return 'Basic x'; },
      isCurrent: (gen: number) => gen === conn.gen,
      assertCurrent,
      assertAccountInSession: (gen: number) => assertCurrent(gen),
      request: vi.fn(),
      currentSession: null as unknown,
    },
  };
});

vi.mock('../../lib/client-cert', () => ({ secureFetch: vi.fn() }));

import { jmapClient } from '../jmap-client';
import { secureFetch } from '../../lib/client-cert';
import { CAPABILITIES } from '../types';
import {
  accountSupportsSieve,
  activateSieveScript,
  deactivateSieveScript,
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
  conn.gen = 1;
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
    expect(getSieveCapabilities('other')).toBeNull();
  });

  it('gives a shared account listed without them the capabilities of the own Sieve account', () => {
    // Same server: without them the script would be written without its spam guard.
    expect(getSieveCapabilities('team')).toEqual(SIEVE_CAPS);
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

describe('connection scopes', () => {
  it('sends every request with the generation of the connection the caller took', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['SieveScript/get', { list: [] }, '0']] });
    await getSieveScripts({ gen: 1, accountId: 'team' });
    expect(mockRequest.mock.calls[0][0][0][1]).toEqual({ accountId: 'team' });
    expect(mockRequest.mock.calls[0][2]).toEqual({ gen: 1 });
    // Without a scope, the live connection's.
    await getSieveScripts();
    expect(mockRequest.mock.calls[1][2]).toEqual({ gen: 1 });

    mockRequest.mockResolvedValue({ methodResponses: [['SieveScript/set', {}, '0']] });
    await activateSieveScript('s9', { gen: 1, accountId: 'team' });
    await deactivateSieveScript({ gen: 1, accountId: 'team' });
    expect(mockRequest.mock.calls[2][2]).toEqual({ gen: 1 });
    expect(mockRequest.mock.calls[3][2]).toEqual({ gen: 1 });
  });

  it('uploads nothing once the connection the save started on was replaced', async () => {
    const at = { gen: 1, accountId: 'own' };
    conn.gen = 2;
    await expect(updateSieveScript('s1', 'keep;', true, at)).rejects.toThrow('stale');
    await expect(getSieveScriptContent('blob-1', at)).rejects.toThrow('stale');
    expect(() => getSieveCapabilities(at)).toThrow('stale');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('uploads and sets a script on the same connection', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ blobId: 'b-new' }) });
    mockRequest.mockResolvedValue({ methodResponses: [['SieveScript/set', { updated: { s1: null } }, '0']] });
    await updateSieveScript('s1', 'keep;', true, { gen: 1, accountId: 'own' });
    expect(mockRequest.mock.calls[0][2]).toEqual({ gen: 1 });
  });
});

describe('activating scripts', () => {
  it('activates a script of the requested account', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['SieveScript/set', {}, '0']] });
    await activateSieveScript('s9', 'shared');
    expect(mockRequest.mock.calls[0][0][0]).toEqual([
      'SieveScript/set', { accountId: 'shared', onSuccessActivateScript: 's9' }, '0',
    ]);
  });

  it('deactivates the active script of the requested account', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['SieveScript/set', {}, '0']] });
    await deactivateSieveScript('shared');
    expect(mockRequest.mock.calls[0][0][0]).toEqual([
      'SieveScript/set', { accountId: 'shared', onSuccessDeactivateScript: true }, '0',
    ]);
  });

  it('throws on an unexpected response', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['error', {}, '0']] });
    await expect(deactivateSieveScript('shared')).rejects.toThrow('Failed to deactivate');
  });
});
