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

import * as sieve from '../../api/sieve';
import { generateScript } from '../../lib/sieve/generator';
import type { FilterRule } from '../../lib/sieve/types';
import { useFilterStore } from '../filter-store';

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

beforeEach(() => {
  vi.clearAllMocks();
  api.getSieveAccountId.mockReturnValue('own');
  api.isSieveSupported.mockReturnValue(true);
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
