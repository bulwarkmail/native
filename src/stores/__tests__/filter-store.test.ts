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
import { FiltersLoginChangedError } from '../../api/sieve-rules';
import { generateScript } from '../../lib/sieve/generator';
import type { FilterRule } from '../../lib/sieve/types';
import {
  readWebmailFixture as webmailFixture,
  readWebmailResave as webmailResave,
  STALWART_EXTENSIONS,
} from '../../lib/sieve/__tests__/fixtures/webmail';
import {
  isVacationIncludedInFilters, readVacationFilters, syncVacationWithFilters, useFilterStore,
} from '../filter-store';

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

    // The client here serves no login (it never connected), as after a
    // switch to a login that is still connecting.
    it('writes nothing once the client serves another login than the vacation was saved in', async () => {
      serve(true, false);
      await expect(syncVacationWithFilters(true, undefined, undefined, undefined, undefined, 'me@example.org@mail.example.org'))
        .rejects.toThrow(FiltersLoginChangedError);
      expect(api.updateSieveScript).not.toHaveBeenCalled();

      await syncVacationWithFilters(true, undefined, undefined, undefined, undefined, null);
      expect(api.updateSieveScript).toHaveBeenCalledTimes(1);
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
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', script, true, 'own');
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
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', webmailResave('stalwart-full.sieve'), true, 'own');
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

  // #1152: webmail 1.13+ writes version 2 for rule periods and the vacation
  // card's forwarding and audience. Read as raw Sieve, "Reset to visual
  // builder" wiped them; a save must keep them byte for byte.
  it('edits a version 2 script and keeps periods, forwarding and audience', async () => {
    const script = webmailFixture('period-forward-audience.sieve');
    api.getSieveCapabilities.mockReturnValue({ ...WITH_INCLUDE, sieveExtensions: STALWART_EXTENSIONS });
    api.getSieveScripts.mockResolvedValue([
      { id: 's1', name: 'filters', blobId: 'b1', isActive: true },
      { id: 'v1', name: 'vacation', blobId: 'bv', isActive: false },
    ]);
    api.getSieveScriptContent.mockResolvedValue(script);

    await useFilterStore.getState().selectAccount(null);
    const s = useFilterStore.getState();
    expect(s.isOpaque).toBe(false);
    expect(s.rules.map((r) => r.activeFrom)).toEqual(['2026-11-02T07:00:00.000Z', '2026-12-01T00:00:00.000Z']);
    expect(s.vacationForward?.to).toBe('backup@example.org');
    expect(s.vacationAudience?.only).toBe('internal');

    await useFilterStore.getState().saveFilters();
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', script, true, 'own');
  });

  it('keeps the forwarding and audience when the auto-reply is switched off on the phone', async () => {
    const script = webmailFixture('period-forward-audience.sieve');
    api.getSieveCapabilities.mockReturnValue({ ...WITH_INCLUDE, sieveExtensions: STALWART_EXTENSIONS });
    api.getSieveScripts.mockResolvedValue([
      { id: 's1', name: 'filters', blobId: 'b1', isActive: true },
      { id: 'v1', name: 'vacation', blobId: 'bv', isActive: false },
    ]);
    api.getSieveScriptContent.mockResolvedValue(script);

    await syncVacationWithFilters(false);
    const written = api.updateSieveScript.mock.calls[0][1] as string;
    expect(written).not.toContain('include :personal');
    expect(written).toContain('# Vacation forwarding');
    expect(written).toContain('"vacationAudience":{"only":"internal","domains":["example.org","example.com"]}');
    expect(written).toContain('"activeUntil":"2026-11-13T17:30:00.000Z"');
  });

  it('keeps the remembered forwarding of a version 1 script', async () => {
    const script = webmailFixture('forward-off.sieve');
    api.getSieveCapabilities.mockReturnValue({ ...WITH_INCLUDE, sieveExtensions: STALWART_EXTENSIONS });
    api.getSieveScripts.mockResolvedValue([{ id: 's1', name: 'filters', blobId: 'b1', isActive: true }]);
    api.getSieveScriptContent.mockResolvedValue(script);

    await useFilterStore.getState().selectAccount(null);
    await useFilterStore.getState().saveFilters();
    expect(api.updateSieveScript).toHaveBeenCalledWith('s1', script, true, 'own');
  });
});

describe('readVacationFilters', () => {
  it('reports the stored forwarding and audience and what the server can run', async () => {
    api.getSieveCapabilities.mockReturnValue({ ...WITH_INCLUDE, sieveExtensions: STALWART_EXTENSIONS });
    api.getSieveScripts.mockResolvedValue([
      { id: 's1', name: 'filters', blobId: 'b1', isActive: true },
      { id: 'v1', name: 'vacation', blobId: 'bv', isActive: false },
    ]);
    api.getSieveScriptContent.mockResolvedValue(webmailFixture('period-forward-audience.sieve'));

    const filters = await readVacationFilters();
    expect(filters).toMatchObject({
      includesVacation: true,
      forward: { enabled: true, to: 'backup@example.org', keepCopy: false },
      forwardAvailable: true,
      audience: { only: 'internal', domains: ['example.org', 'example.com'] },
      audienceAvailable: true,
      notRunning: false,
    });
  });

  it('counts the most forwards the filter rules give one message, for the limit of the forwarding', async () => {
    api.getSieveCapabilities.mockReturnValue({ ...WITH_INCLUDE, sieveExtensions: STALWART_EXTENSIONS });
    api.getSieveScripts.mockResolvedValue([{ id: 's1', name: 'filters', blobId: 'b1', isActive: true }]);
    const forward = { type: 'forward' as const, value: 'x@example.org' };
    api.getSieveScriptContent.mockResolvedValue(generateScript([
      makeRule({ id: 'a', actions: [forward] }),
      makeRule({ id: 'b', actions: [forward] }),
    ]));
    expect((await readVacationFilters()).otherForwards).toBe(2);
  });

  it('sets up forwarding in the vacation period, creating the script when there is none', async () => {
    api.getSieveCapabilities.mockReturnValue({ ...WITH_INCLUDE, sieveExtensions: STALWART_EXTENSIONS });
    api.getSieveScripts.mockResolvedValue([{ id: 'v1', name: 'vacation', blobId: 'bv', isActive: true }]);
    api.createSieveScript.mockResolvedValue({ id: 'new', name: 'filters', blobId: 'b', isActive: true });

    await syncVacationWithFilters(
      true, undefined, { enabled: true, to: 'backup@example.org', keepCopy: true },
      undefined, { from: '2026-11-02T00:00:00Z', until: null },
    );
    const [name, content, activate] = api.createSieveScript.mock.calls[0];
    expect(name).toBe('filters');
    expect(activate).toBe(true);
    expect(content).toContain('"vacationForward":{"enabled":true,"to":"backup@example.org","keepCopy":true,"activeFrom":"2026-11-02T00:00:00Z"}');
    expect(content).toContain('    redirect :copy "backup@example.org";');
  });
});
