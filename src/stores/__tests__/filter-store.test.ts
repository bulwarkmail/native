import { describe, it, expect, vi, beforeEach } from 'vitest';

// The live connection (generation 1) unless a test replaces it.
const conn = vi.hoisted(() => ({ gen: 1 }));
vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    get connectionGen() { return conn.gen; },
    accountId: 'own',
    isCurrent: (gen: number) => gen === conn.gen,
  },
}));

vi.mock('../../api/sieve', () => ({
  createSieveScript: vi.fn(),
  getSieveAccountId: vi.fn(() => 'own'),
  sieveScope: vi.fn((a?: unknown) => (a && typeof a === 'object' ? a : { gen: conn.gen, accountId: a ?? 'own' })),
  sieveScopeIn: vi.fn((at: { gen: number }, id?: string) => ({ gen: at.gen, accountId: id ?? 'own' })),
  getSieveCapabilities: vi.fn(() => null),
  getSieveScriptContent: vi.fn(),
  getSieveScripts: vi.fn(),
  isSieveSupported: vi.fn(() => true),
  updateSieveScript: vi.fn(),
  validateSieveScript: vi.fn(async () => ({ isValid: true })),
}));

import * as sieve from '../../api/sieve';
import { generateScript } from '../../lib/sieve/generator';
import type { FilterRule } from '../../lib/sieve/types';
import {
  readWebmailFixture as webmailFixture,
  readWebmailResave as webmailResave,
  STALWART_EXTENSIONS,
} from '../../lib/sieve/__tests__/fixtures/webmail';
import {
  FiltersNotLoadedError,
  FiltersReloadedError,
  readVacationFilters,
  SieveCapabilitiesUnknownError,
  syncVacationWithFilters,
  useFilterStore,
} from '../filter-store';

const api = vi.mocked(sieve);

/** Account `accountId` on connection `gen`, as the store passes it to every call. */
const scope = (accountId: string, gen = 1) => ({ gen, accountId });

function makeRule(overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: 'rule-1',
    name: 'Test Rule',
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'from', comparator: 'contains', value: 'a@example.com' }],
    actions: [{ type: 'move', value: 'Archive' }],
    stopProcessing: false,
    ...overrides,
  };
}

function serveScript(rules: FilterRule[]) {
  api.getSieveScripts.mockResolvedValue([{ id: 's1', name: 'filters', blobId: 'b1', isActive: true }]);
  api.getSieveScriptContent.mockResolvedValue(generateScript(rules));
}

const WITH_INCLUDE = {
  implementation: 'test', maxSizeScript: 100000, sieveExtensions: ['fileinto', 'include'],
  notificationMethods: [], externalLists: [],
};
const BASIC = { ...WITH_INCLUDE, sieveExtensions: ['fileinto'] };

beforeEach(() => {
  vi.clearAllMocks();
  conn.gen = 1;
  api.getSieveAccountId.mockReturnValue('own');
  api.isSieveSupported.mockReturnValue(true);
  api.getSieveCapabilities.mockReturnValue(BASIC);
  useFilterStore.getState().clearState();
});

describe('filter-store account selection', () => {
  it('loads the own Sieve account by default', async () => {
    serveScript([makeRule()]);
    await useFilterStore.getState().selectAccount(null);

    const s = useFilterStore.getState();
    expect(s.selectedAccountId).toBe('own');
    expect(api.getSieveScripts).toHaveBeenCalledWith(scope('own'));
    expect(api.getSieveScriptContent).toHaveBeenCalledWith('b1', scope('own'));
    expect(s.rules).toHaveLength(1);
  });

  it('loads a shared account and drops the previous account\'s script first', async () => {
    useFilterStore.setState({ rules: [makeRule()], activeScriptId: 'old', isOpaque: true, rawScript: 'x' });
    api.getSieveScripts.mockResolvedValue([]);

    await useFilterStore.getState().selectAccount('team');

    const s = useFilterStore.getState();
    expect(api.isSieveSupported).toHaveBeenCalledWith('team');
    expect(api.getSieveScripts).toHaveBeenCalledWith(scope('team'));
    expect(s.selectedAccountId).toBe('team');
    expect(s.rules).toEqual([]);
    expect(s.activeScriptId).toBeNull();
    expect(s.isOpaque).toBe(false);
  });

  it('reports an account without Sieve as unsupported', async () => {
    api.isSieveSupported.mockReturnValue(false);
    await useFilterStore.getState().selectAccount('team');
    expect(useFilterStore.getState().isSupported).toBe(false);
    expect(api.getSieveScripts).not.toHaveBeenCalled();
  });

  it('saves and validates into the selected account', async () => {
    serveScript([makeRule()]);
    await useFilterStore.getState().selectAccount('team');

    await useFilterStore.getState().saveFilters();
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', expect.any(String), true, scope('team'));

    await useFilterStore.getState().validateScript('keep;');
    expect(api.validateSieveScript).toHaveBeenCalledWith('keep;', 'team');
  });

  it('creates the script in the selected account when it has none', async () => {
    api.getSieveScripts.mockResolvedValue([]);
    api.createSieveScript.mockResolvedValue({ id: 'new', name: 'filters', blobId: 'b', isActive: true });
    await useFilterStore.getState().selectAccount('team');

    await useFilterStore.getState().saveFilters();
    expect(api.createSieveScript).toHaveBeenCalledWith('filters', expect.any(String), true, scope('team'));
  });

  it('ignores a reply for an account the user already switched away from', async () => {
    let releaseTeam: (v: unknown) => void = () => {};
    api.getSieveScripts.mockImplementation(async (account?: unknown) => {
      if ((account as { accountId?: string } | undefined)?.accountId === 'team') {
        await new Promise((r) => { releaseTeam = r; });
        return [{ id: 'team-script', name: 'filters', blobId: 'bt', isActive: true }];
      }
      return [];
    });

    const teamLoad = useFilterStore.getState().selectAccount('team');
    await useFilterStore.getState().selectAccount(null);
    releaseTeam(undefined);
    await teamLoad;

    const s = useFilterStore.getState();
    expect(s.selectedAccountId).toBe('own');
    expect(s.activeScriptId).toBeNull();
    expect(api.getSieveScriptContent).not.toHaveBeenCalled();
  });
});

describe('filter-store and the server vacation script', () => {
  it('keeps an active server vacation script by including it', async () => {
    api.getSieveCapabilities.mockReturnValue(WITH_INCLUDE);
    api.getSieveScripts.mockResolvedValue([
      { id: 's1', name: 'filters', blobId: 'b1', isActive: false },
      { id: 'v1', name: 'vacation', blobId: 'bv', isActive: true },
    ]);
    api.getSieveScriptContent.mockResolvedValue(generateScript([makeRule()]));

    await useFilterStore.getState().selectAccount(null);
    expect(useFilterStore.getState().activeScriptId).toBe('s1');
    expect(useFilterStore.getState().includeVacation).toBe(true);

    await useFilterStore.getState().saveFilters();
    expect(api.updateSieveScript.mock.calls[0][1]).toContain('include :personal :optional "vacation";');
  });

  it('saves a webmail script that includes the vacation script unchanged', async () => {
    const script = webmailFixture('vacation-include.sieve');
    api.getSieveCapabilities.mockReturnValue(WITH_INCLUDE);
    api.getSieveScripts.mockResolvedValue([
      { id: 's1', name: 'filters', blobId: 'b1', isActive: true },
      { id: 'v1', name: 'vacation', blobId: 'bv', isActive: false },
    ]);
    api.getSieveScriptContent.mockResolvedValue(script);

    await useFilterStore.getState().selectAccount(null);
    await useFilterStore.getState().saveFilters();
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', script, true, scope('own'));
  });

  describe('syncVacationWithFilters', () => {
    function serve(vacationActive: boolean, filtersActive: boolean, includeVacation = false) {
      api.getSieveCapabilities.mockReturnValue(WITH_INCLUDE);
      api.getSieveScripts.mockResolvedValue([
        { id: 's1', name: 'filters', blobId: 'b1', isActive: filtersActive },
        { id: 'v1', name: 'vacation', blobId: 'bv', isActive: vacationActive },
      ]);
      api.getSieveScriptContent.mockResolvedValue(generateScript([makeRule()], undefined, { includeVacation }));
    }

    it('re-activates the filters with an include when the vacation script took over', async () => {
      serve(true, false);
      await syncVacationWithFilters({ enabled: true });
      expect(api.updateSieveScript).toHaveBeenCalledTimes(1);
      const [id, content, activate, account] = api.updateSieveScript.mock.calls[0];
      expect(id).toBe('s1');
      expect(content).toContain('include :personal :optional "vacation";');
      expect(activate).toBe(true);
      expect(account).toEqual(scope('own'));
    });

    it('drops the include when the auto-reply is turned off', async () => {
      serve(false, true, true);
      await syncVacationWithFilters({ enabled: false }, scope('team'));
      expect(api.updateSieveScript).toHaveBeenCalledTimes(1);
      expect(api.updateSieveScript.mock.calls[0][1]).not.toContain('include');
      expect(api.updateSieveScript.mock.calls[0][3]).toEqual(scope('team'));
    });

    it('leaves the scripts alone when the filters are still active', async () => {
      serve(false, true);
      await syncVacationWithFilters({ enabled: true });
      await syncVacationWithFilters({ enabled: false });
      expect(api.updateSieveScript).not.toHaveBeenCalled();
    });

    it('does nothing on servers without the include extension', async () => {
      serve(true, false);
      api.getSieveCapabilities.mockReturnValue(null);
      await syncVacationWithFilters({ enabled: true });
      expect(api.updateSieveScript).not.toHaveBeenCalled();
    });

    it('reports the auto-reply as on while the filters include it', async () => {
      serve(false, true, true);
      expect((await readVacationFilters(undefined)).includesVacation).toBe(true);
      serve(false, true);
      expect((await readVacationFilters(undefined)).includesVacation).toBe(false);
    });

    it('re-activates a filters script with a webmail forward and no rules when the vacation script took over', async () => {
      api.getSieveCapabilities.mockReturnValue({ ...WITH_INCLUDE, sieveExtensions: STALWART_EXTENSIONS });
      api.getSieveScripts.mockResolvedValue([
        { id: 's1', name: 'filters', blobId: 'b1', isActive: false },
        { id: 'v1', name: 'vacation', blobId: 'bv', isActive: true },
      ]);
      api.getSieveScriptContent.mockResolvedValue(generateScript([], undefined, {
        extensions: STALWART_EXTENSIONS,
        vacationForward: { enabled: true, to: 'kollege@example.com', keepCopy: false },
      }));
      await syncVacationWithFilters({ enabled: true });
      expect(api.updateSieveScript).toHaveBeenCalledTimes(1);
      const [, content, activate] = api.updateSieveScript.mock.calls[0];
      expect(content).toContain('# Vacation forwarding');
      expect(content).toContain('include :personal :optional "vacation";');
      expect(activate).toBe(true);
    });

    it('leaves the optional include in place, rather than rewrite move rules without the server\'s capabilities', async () => {
      serve(false, true, true);
      api.getSieveCapabilities.mockReturnValue(null);
      await expect(syncVacationWithFilters({ enabled: false })).resolves.toBeUndefined();
      expect(api.updateSieveScript).not.toHaveBeenCalled();
    });
  });
});

describe('saving scripts the webmail wrote', () => {
  it('keeps folder ids, forward copies and the flag order', async () => {
    const script = webmailFixture('folder-targets.sieve');
    api.getSieveCapabilities.mockReturnValue({
      ...WITH_INCLUDE,
      sieveExtensions: ['fileinto', 'copy', 'imap4flags', 'mailbox', 'mailboxid'],
    });
    api.getSieveScripts.mockResolvedValue([{ id: 's1', name: 'filters', blobId: 'b1', isActive: true }]);
    api.getSieveScriptContent.mockResolvedValue(script);

    await useFilterStore.getState().selectAccount(null);
    await useFilterStore.getState().saveFilters();
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', script, true, scope('own'));
  });

  it('keeps the spam guard, its opt-in, the vacation include and external rules', async () => {
    const script = webmailFixture('stalwart-full.sieve');
    api.getSieveCapabilities.mockReturnValue({ ...WITH_INCLUDE, sieveExtensions: STALWART_EXTENSIONS });
    api.getSieveScripts.mockResolvedValue([
      { id: 's1', name: 'filters', blobId: 'b1', isActive: true },
      { id: 'v1', name: 'vacation', blobId: 'bv', isActive: false },
    ]);
    api.getSieveScriptContent.mockResolvedValue(script);

    await useFilterStore.getState().selectAccount(null);
    expect(useFilterStore.getState().rules.find((r) => r.id === 'spam')?.includeSpam).toBe(true);

    await useFilterStore.getState().saveFilters();
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', webmailResave('stalwart-full.sieve'), true, scope('own'));
  });

  it('keeps a version 2 script with periods, forwarding and a reply audience byte for byte', async () => {
    const script = webmailFixture('v2-period-forward-audience.sieve');
    api.getSieveCapabilities.mockReturnValue({ ...WITH_INCLUDE, sieveExtensions: STALWART_EXTENSIONS });
    api.getSieveScripts.mockResolvedValue([{ id: 's1', name: 'filters', blobId: 'b1', isActive: true }]);
    api.getSieveScriptContent.mockResolvedValue(script);

    await useFilterStore.getState().selectAccount(null);
    expect(useFilterStore.getState().isOpaque).toBe(false);
    await useFilterStore.getState().saveFilters();
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', script, true, scope('own'));
  });

  it('keeps the forwarding and the reply audience when the filters take back over from the vacation script', async () => {
    const script = webmailFixture('v2-period-forward-audience.sieve');
    api.getSieveCapabilities.mockReturnValue({ ...WITH_INCLUDE, sieveExtensions: STALWART_EXTENSIONS });
    api.getSieveScripts.mockResolvedValue([
      { id: 's1', name: 'filters', blobId: 'b1', isActive: false },
      { id: 'v1', name: 'vacation', blobId: 'bv', isActive: true },
    ]);
    api.getSieveScriptContent.mockResolvedValue(script);

    await syncVacationWithFilters({ enabled: true });
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', script, true, scope('own'));
  });

  it('keeps the rule data through an edit on the phone', async () => {
    const script = webmailFixture('stalwart-full.sieve');
    api.getSieveCapabilities.mockReturnValue({ ...WITH_INCLUDE, sieveExtensions: STALWART_EXTENSIONS });
    api.getSieveScripts.mockResolvedValue([{ id: 's1', name: 'filters', blobId: 'b1', isActive: true }]);
    api.getSieveScriptContent.mockResolvedValue(script);

    await useFilterStore.getState().selectAccount(null);
    useFilterStore.getState().toggleRule('big');
    useFilterStore.getState().toggleRule('big');
    useFilterStore.getState().reorderRules(['vip', 'invoices', 'fwd', 'spam', 'big']);
    useFilterStore.getState().reorderRules(['invoices', 'vip', 'fwd', 'spam', 'big']);
    await useFilterStore.getState().saveFilters();
    expect(api.updateSieveScript.mock.calls[0][1]).toBe(webmailResave('stalwart-full.sieve'));
  });
});

describe('filter-store fetch ordering', () => {
  it('a stale fetch does not overwrite a newer one', async () => {
    const gate = () => { let r!: () => void; const p = new Promise<void>((x) => { r = x; }); return { p, r }; };
    const a = gate();
    const b = gate();
    api.getSieveScripts
      .mockResolvedValueOnce([{ id: 's1', name: 'filters', blobId: 'bA', isActive: true }])
      .mockResolvedValueOnce([{ id: 's1', name: 'filters', blobId: 'bB', isActive: true }]);
    api.getSieveScriptContent.mockImplementation(async (blobId: string) => {
      if (blobId === 'bA') { await a.p; return generateScript([makeRule({ id: 'old', name: 'Old' })]); }
      await b.p;
      return generateScript([makeRule({ id: 'new', name: 'New' })]);
    });
    const first = useFilterStore.getState().fetchFilters();
    const second = useFilterStore.getState().fetchFilters();
    b.r();
    await second;
    a.r();
    await first;
    expect(useFilterStore.getState().rules.map((r) => r.id)).toEqual(['new']);
    expect(useFilterStore.getState().isLoading).toBe(false);
  });
});

describe('filter-store saves only what it loaded, as the server can run it', () => {
  it('refuses to save while the server\'s capabilities are unknown, and writes nothing', async () => {
    api.getSieveCapabilities.mockReturnValue(null);
    serveScript([makeRule()]);
    await useFilterStore.getState().selectAccount(null);
    // A move rule would lose its spam guard and folder id.
    await expect(useFilterStore.getState().saveFilters()).rejects.toBeInstanceOf(SieveCapabilitiesUnknownError);
    expect(api.updateSieveScript).not.toHaveBeenCalled();
    expect(api.createSieveScript).not.toHaveBeenCalled();
  });

  it('refuses without them to save forwarding from the vacation card', async () => {
    api.getSieveCapabilities.mockReturnValue(null);
    api.getSieveScripts.mockResolvedValue([{ id: 's1', name: 'filters', blobId: 'b1', isActive: true }]);
    api.getSieveScriptContent.mockResolvedValue(generateScript([makeRule({ actions: [{ type: 'mark_read' }] })], undefined, {
      extensions: STALWART_EXTENSIONS,
      vacationForward: { enabled: true, to: 'kollege@example.com', keepCopy: false },
    }));
    await useFilterStore.getState().selectAccount(null);
    await expect(useFilterStore.getState().saveFilters()).rejects.toBeInstanceOf(SieveCapabilitiesUnknownError);
    expect(api.updateSieveScript).not.toHaveBeenCalled();
  });

  it('saves without them what comes out the same either way', async () => {
    api.getSieveCapabilities.mockReturnValue(null);
    // Flags only, and a move that is off: nothing depends on the server.
    serveScript([
      makeRule({ actions: [{ type: 'mark_read' }] }),
      makeRule({ id: 'off', name: 'Off', enabled: false }),
    ]);
    await useFilterStore.getState().selectAccount(null);
    await useFilterStore.getState().saveFilters();
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', expect.any(String), true, scope('own'));
  });

  it('still saves a hand-edited script as it is, capabilities or not', async () => {
    api.getSieveCapabilities.mockReturnValue(null);
    serveScript([makeRule()]);
    await useFilterStore.getState().selectAccount(null);
    useFilterStore.getState().setOpaqueScript('keep;');
    await useFilterStore.getState().saveFilters();
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', 'keep;', true, scope('own'));
  });

  it('refuses to save rules that were cleared with the account, and writes nothing', async () => {
    serveScript([makeRule()]);
    await useFilterStore.getState().selectAccount(null);
    // An account switch clears the store; a save from the screen left open
    // would write an empty rule list into the next login's script.
    useFilterStore.getState().clearState();
    await expect(useFilterStore.getState().saveFilters()).rejects.toBeInstanceOf(FiltersNotLoadedError);
    expect(api.updateSieveScript).not.toHaveBeenCalled();
    expect(api.createSieveScript).not.toHaveBeenCalled();
  });

  it('drops a load whose connection was replaced, even for the same account id', async () => {
    let release: () => void = () => {};
    api.getSieveScripts.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { release = r; });
      return [{ id: 's1', name: 'filters', blobId: 'b1', isActive: true }];
    });
    api.getSieveScriptContent.mockResolvedValue(generateScript([makeRule()]));
    const load = useFilterStore.getState().fetchFilters();
    // Another login with the same Sieve account id took over the client.
    conn.gen = 2;
    release();
    await load;
    expect(useFilterStore.getState().rules).toEqual([]);
    expect(api.getSieveScriptContent).not.toHaveBeenCalled();
  });

  it('saves on the connection the rules were loaded on, which stops it once replaced', async () => {
    serveScript([makeRule()]);
    await useFilterStore.getState().selectAccount(null);
    conn.gen = 3;
    await useFilterStore.getState().saveFilters();
    // jmapClient sends nothing on a replaced connection (StaleLoadError).
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', expect.any(String), true, scope('own', 1));
  });
});

describe('filter-store after a reconnect of the same login', () => {
  const stale = () => Object.assign(new Error('stale'), { name: 'StaleLoadError' });
  // jmapClient sends nothing on a replaced connection.
  const refuseReplaced = () => api.updateSieveScript.mockImplementation(async (...args: unknown[]) => {
    if ((args[3] as { gen: number }).gen !== conn.gen) throw stale();
  });

  it('reloads the filters on the live connection, writes nothing there, and says to try again', async () => {
    serveScript([makeRule()]);
    await useFilterStore.getState().selectAccount(null, () => true);
    conn.gen = 2;
    refuseReplaced();
    serveScript([makeRule({ id: 'other-device', name: 'Other device' })]);

    await expect(useFilterStore.getState().saveFilters()).rejects.toBeInstanceOf(FiltersReloadedError);
    expect(api.getSieveScripts).toHaveBeenLastCalledWith(scope('own', 2));
    expect(api.updateSieveScript).toHaveBeenCalledTimes(1);
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', expect.any(String), true, scope('own', 1));
    expect(useFilterStore.getState()).toMatchObject({ error: null, isSaving: false });
    expect(useFilterStore.getState().rules.map((r) => r.id)).toEqual(['other-device']);

    // The next save goes out on the connection the rules were reloaded on.
    await useFilterStore.getState().saveFilters();
    expect(api.updateSieveScript).toHaveBeenLastCalledWith('s1', expect.any(String), true, scope('own', 2));
  });

  it('reloads nothing once another account is shown', async () => {
    let shown = true;
    serveScript([makeRule()]);
    await useFilterStore.getState().selectAccount(null, () => shown);
    conn.gen = 2;
    shown = false;
    refuseReplaced();
    api.getSieveScripts.mockClear();

    await expect(useFilterStore.getState().saveFilters()).rejects.toMatchObject({ name: 'StaleLoadError' });
    expect(api.getSieveScripts).not.toHaveBeenCalled();
    expect(api.updateSieveScript).toHaveBeenCalledTimes(1);
  });
});
