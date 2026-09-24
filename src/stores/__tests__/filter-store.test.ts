import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/sieve', () => ({
  createSieveScript: vi.fn(),
  getSieveAccountId: vi.fn(() => 'own'),
  getSieveCapabilities: vi.fn(() => null),
  getSieveScriptContent: vi.fn(),
  getSieveScripts: vi.fn(),
  isSieveSupported: vi.fn(() => true),
  updateSieveScript: vi.fn(),
  validateSieveScript: vi.fn(async () => ({ isValid: true })),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as sieve from '../../api/sieve';
import { generateScript } from '../../lib/sieve/generator';
import type { FilterRule } from '../../lib/sieve/types';
import { isVacationIncludedInFilters, syncVacationWithFilters, useFilterStore } from '../filter-store';

const api = vi.mocked(sieve);

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

function webmailFixture(file: string): string {
  return readFileSync(join(__dirname, '../../lib/sieve/__tests__/fixtures/webmail', file), 'utf-8')
    .replace(/\r\n/g, '\n');
}

const WITH_INCLUDE = {
  implementation: 'test', maxSizeScript: 100000, sieveExtensions: ['fileinto', 'include'],
  notificationMethods: [], externalLists: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getSieveAccountId.mockReturnValue('own');
  api.isSieveSupported.mockReturnValue(true);
  api.getSieveCapabilities.mockReturnValue(null);
  useFilterStore.getState().clearState();
});

describe('filter-store account selection', () => {
  it('loads the own Sieve account by default', async () => {
    serveScript([makeRule()]);
    await useFilterStore.getState().selectAccount(null);

    const s = useFilterStore.getState();
    expect(s.selectedAccountId).toBe('own');
    expect(api.getSieveScripts).toHaveBeenCalledWith('own');
    expect(api.getSieveScriptContent).toHaveBeenCalledWith('b1', 'own');
    expect(s.rules).toHaveLength(1);
  });

  it('loads a shared account and drops the previous account\'s script first', async () => {
    useFilterStore.setState({ rules: [makeRule()], activeScriptId: 'old', isOpaque: true, rawScript: 'x' });
    api.getSieveScripts.mockResolvedValue([]);

    await useFilterStore.getState().selectAccount('team');

    const s = useFilterStore.getState();
    expect(api.isSieveSupported).toHaveBeenCalledWith('team');
    expect(api.getSieveScripts).toHaveBeenCalledWith('team');
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
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', expect.any(String), true, 'team');

    await useFilterStore.getState().validateScript('keep;');
    expect(api.validateSieveScript).toHaveBeenCalledWith('keep;', 'team');
  });

  it('creates the script in the selected account when it has none', async () => {
    api.getSieveScripts.mockResolvedValue([]);
    api.createSieveScript.mockResolvedValue({ id: 'new', name: 'filters', blobId: 'b', isActive: true });
    await useFilterStore.getState().selectAccount('team');

    await useFilterStore.getState().saveFilters();
    expect(api.createSieveScript).toHaveBeenCalledWith('filters', expect.any(String), true, 'team');
  });

  it('ignores a reply for an account the user already switched away from', async () => {
    let releaseTeam: (v: unknown) => void = () => {};
    api.getSieveScripts.mockImplementation(async (accountId?: string) => {
      if (accountId === 'team') {
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
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', script, true, 'own');
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
      await syncVacationWithFilters(true);
      expect(api.updateSieveScript).toHaveBeenCalledTimes(1);
      const [id, content, activate, accountId] = api.updateSieveScript.mock.calls[0];
      expect(id).toBe('s1');
      expect(content).toContain('include :personal :optional "vacation";');
      expect(activate).toBe(true);
      expect(accountId).toBe('own');
    });

    it('drops the include when the auto-reply is turned off', async () => {
      serve(false, true, true);
      await syncVacationWithFilters(false, 'team');
      expect(api.updateSieveScript).toHaveBeenCalledTimes(1);
      expect(api.updateSieveScript.mock.calls[0][1]).not.toContain('include');
      expect(api.updateSieveScript.mock.calls[0][3]).toBe('team');
    });

    it('leaves the scripts alone when the filters are still active', async () => {
      serve(false, true);
      await syncVacationWithFilters(true);
      await syncVacationWithFilters(false);
      expect(api.updateSieveScript).not.toHaveBeenCalled();
    });

    it('does nothing on servers without the include extension', async () => {
      serve(true, false);
      api.getSieveCapabilities.mockReturnValue(null);
      await syncVacationWithFilters(true);
      expect(api.updateSieveScript).not.toHaveBeenCalled();
    });

    it('reports the auto-reply as on while the filters include it', async () => {
      serve(false, true, true);
      expect(await isVacationIncludedInFilters()).toBe(true);
      serve(false, true);
      expect(await isVacationIncludedInFilters()).toBe(false);
    });
  });
});
