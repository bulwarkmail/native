import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockSieveAccount, sieveRouter } from './sieve-mock';

const router = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof sieveRouter> }));
vi.mock('../../../api/sieve', () => {
  const route = (name: string) => (...args: unknown[]) =>
    (router.current.module as Record<string, (...a: unknown[]) => unknown>)[name](...args);
  return {
    getSieveAccountId: () => 'own',
    isSieveSupported: () => true,
    getSieveCapabilities: route('getSieveCapabilities'),
    getSieveScripts: route('getSieveScripts'),
    getSieveScriptContent: route('getSieveScriptContent'),
    updateSieveScript: route('updateSieveScript'),
    createSieveScript: route('createSieveScript'),
    deleteSieveScript: route('deleteSieveScript'),
    activateSieveScript: route('activateSieveScript'),
    deactivateSieveScript: route('deactivateSieveScript'),
    validateSieveScript: async () => ({ isValid: true }),
  };
});


import type { FilterRule } from '../../sieve/types';
import { generateScript } from '../../sieve/generator';
import { parseScript } from '../../sieve/parser';
import { useFilterStore } from '../../../stores/filter-store';
import {
  FiltersChangedError,
  OpaqueFiltersError,
  readAccountFilters,
  restoreAccountFilters,
  SwitchedAwayError,
  updateAccountFilters,
} from '../account-filters';
import { applyQuickRule, insertRuleAtTop } from '../quick-rules';

function rule(id: string, overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id,
    name: `Rule ${id}`,
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'from', comparator: 'address_is', value: `${id}@acme.com` }],
    actions: [{ type: 'move', value: 'News', mailboxId: 'mb-news' }],
    stopProcessing: true,
    ...overrides,
  };
}

const EXTERNAL = [
  '# rule:[Roundcube spam]',
  'if header :contains "X-Spam" "yes" {',
  '    fileinto "Junk";',
  '}',
].join('\n');

function bulwarkScript(rules: FilterRule[], withExternal = false): string {
  const base = generateScript(rules);
  return withExternal ? `${base}\n${EXTERNAL}\n` : base;
}

// The tests name accounts 'b' (and 'a'); each is routed by its explicit id.
const sieve = () => router.current;
const makeAccount = (...args: Parameters<typeof mockSieveAccount>) => {
  const account = sieve().register(mockSieveAccount(...args));
  return { ...account, client: account.api };
};

const originalFetchFilters = useFilterStore.getState().fetchFilters;

afterEach(() => {
  useFilterStore.setState({ fetchFilters: originalFetchFilters });
});

beforeEach(() => {
  router.current = sieveRouter();
  useFilterStore.getState().clearState();
});

describe('updateAccountFilters', () => {
  it('reads the script right before writing, and writes to the named account only', async () => {
    const account = makeAccount('b', [{ name: 'filters', content: bulwarkScript([rule('old')]), isActive: true }]);

    const change = await updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')));

    expect(change).not.toBeNull();
    expect(account.client.getSieveScripts).toHaveBeenCalledTimes(1);
    const parsed = parseScript(account.content('filters'));
    expect(parsed.rules.map((r) => r.id)).toEqual(['new', 'old']);
    expect(change!.previous.content).toBe(bulwarkScript([rule('old')]));
  });

  it('keeps external blocks verbatim after the Bulwark section', async () => {
    const account = makeAccount('b', [{ name: 'filters', content: bulwarkScript([rule('old')], true), isActive: true }]);

    await updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')));

    const written = account.content('filters');
    expect(written).toContain(EXTERNAL.split('\n').slice(1).join('\n'));
    expect(written.indexOf('# Rule: Rule new')).toBeLessThan(written.indexOf('# Rule: Rule old'));
    expect(written.indexOf('# Rule: Rule old')).toBeLessThan(written.indexOf('X-Spam'));
  });

  it('refuses an opaque script (a hand-edited one) and writes nothing', async () => {
    const account = makeAccount('b', [{ name: 'filters', content: 'require "fileinto";', isActive: true }]);
    expect((await readAccountFilters('b')).parsed.isOpaque).toBe(true);

    await expect(updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new'))))
      .rejects.toBeInstanceOf(OpaqueFiltersError);
    expect(account.writes()).toBe(0);
  });

  it('creates and activates a filters script when there is none', async () => {
    const account = makeAccount('b');
    const change = await updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')));
    expect(account.active()).toBe('filters');
    expect(change!.previous.scriptId).toBeNull();
    expect(parseScript(account.content('filters')).rules[0].id).toBe('new');
  });

  it('writes nothing when modify returns null', async () => {
    const account = makeAccount('b', [{ name: 'filters', content: bulwarkScript([rule('old')]), isActive: true }]);
    expect(await updateAccountFilters('b', () => null)).toBeNull();
    expect(account.writes()).toBe(0);
  });

  it('keeps an active vacation script running through an include', async () => {
    const account = makeAccount('b', [
      { name: 'filters', content: bulwarkScript([rule('old')]), isActive: false },
      { name: 'vacation', content: 'require "vacation"; vacation "away";', isActive: true },
    ]);
    await updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')));
    expect(account.active()).toBe('filters');
    expect(account.content('filters')).toContain('include :personal :optional "vacation";');
  });
});

describe('restoreAccountFilters (Undo)', () => {
  it('puts a merged rule back exactly as it was', async () => {
    const before = bulwarkScript([rule('a', { actions: [{ type: 'mark_read' }] }), rule('target', { name: 'Newsletters' })], true);
    const account = makeAccount('b', [{ name: 'filters', content: before, isActive: true }]);

    const change = await updateAccountFilters('b', (rules) => {
      const outcome = applyQuickRule(rules, rule('new', { conditions: [{ field: 'from', comparator: 'address_is', value: 'target2@acme.com' }] }));
      return outcome.kind === 'covered' ? null : outcome.rules;
    });
    expect(parseScript(account.content('filters')).rules.find((r) => r.id === 'target')?.conditions[0].value)
      .toEqual(['target@acme.com', 'target2@acme.com']);

    await restoreAccountFilters(change!);
    expect(account.content('filters')).toBe(before);
    expect(account.active()).toBe('filters');
  });

  it('switches the vacation script back on when the write had taken over from it', async () => {
    const account = makeAccount('b', [
      { name: 'filters', content: bulwarkScript([rule('old')]), isActive: false },
      { name: 'vacation', content: 'require "vacation"; vacation "away";', isActive: true },
    ]);
    const change = await updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')));
    await restoreAccountFilters(change!);
    expect(account.active()).toBe('vacation');
    expect(account.content('filters')).toBe(bulwarkScript([rule('old')]));
  });

  it('removes a script the write created, after switching back', async () => {
    const account = makeAccount('b', [{ name: 'vacation', content: 'require "vacation"; vacation "x";', isActive: true }]);
    const change = await updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')));
    await restoreAccountFilters(change!);
    expect(account.scripts.map((s) => s.name)).toEqual(['vacation']);
    expect(account.active()).toBe('vacation');
  });

  it('leaves no script active when there was none', async () => {
    const account = makeAccount('b');
    const change = await updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')));
    await restoreAccountFilters(change!);
    expect(account.scripts).toEqual([]);
  });

  it('undo refuses when the script changed since the write', async () => {
    const account = makeAccount('b', [{ name: 'filters', content: bulwarkScript([rule('old')]), isActive: true }]);
    const change = await updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')));
    await updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('later')));

    await expect(restoreAccountFilters(change!)).rejects.toBeInstanceOf(FiltersChangedError);
    expect(parseScript(account.content('filters')).rules.map((r) => r.id)).toEqual(['later', 'new', 'old']);
  });
});

describe('the per-request account re-check (stillValid)', () => {
  it('writes nothing when the account is no longer valid at write time', async () => {
    const account = makeAccount('b', [{ name: 'filters', content: bulwarkScript([rule('old')]), isActive: true }]);
    let valid = true;
    // The switch lands while the script is being read.
    account.client.getSieveScriptContent.mockImplementationOnce(async (blobId: string) => {
      valid = false;
      return account.content('filters') || blobId;
    });
    await expect(updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')), () => valid))
      .rejects.toBeInstanceOf(SwitchedAwayError);
    expect(account.writes()).toBe(0);
  });

  it('writes as before while it stays valid', async () => {
    const account = makeAccount('b', [{ name: 'filters', content: bulwarkScript([rule('old')]), isActive: true }]);
    const stillValid = vi.fn(() => true);
    await updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')), stillValid);
    expect(stillValid).toHaveBeenCalled();
    expect(account.writes()).toBe(1);
  });

  it('undo writes nothing when the account is no longer valid', async () => {
    const account = makeAccount('b', [{ name: 'filters', content: bulwarkScript([rule('old')]), isActive: true }]);
    const change = await updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')));
    const writes = account.writes();
    await expect(restoreAccountFilters(change!, () => false)).rejects.toBeInstanceOf(SwitchedAwayError);
    expect(account.writes()).toBe(writes);
  });

  it('undo re-checks before each write: a switch after the first one stops the rest', async () => {
    const account = makeAccount('b', [{ name: 'vacation', content: 'require "vacation"; vacation "x";', isActive: true }]);
    const change = await updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')));
    let valid = true;
    account.client.activateSieveScript.mockImplementationOnce(async (id: string) => {
      for (const s of account.scripts) s.isActive = s.id === id;
      valid = false;
    });
    await expect(restoreAccountFilters(change!, () => valid)).rejects.toBeInstanceOf(SwitchedAwayError);
    // The vacation script was switched back on; the created script was not deleted.
    expect(account.client.deleteSieveScript).not.toHaveBeenCalled();
  });
});

describe('account scoping and store refresh', () => {
  it('a write against account B never touches account A\'s script', async () => {
    const a = makeAccount('a', [{ name: 'filters', content: bulwarkScript([rule('a1')]), isActive: true }]);
    const b = makeAccount('b', [{ name: 'filters', content: bulwarkScript([rule('b1')]), isActive: true }]);

    const change = await updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')));
    await restoreAccountFilters(change!);

    expect(a.writes()).toBe(0);
    expect(a.client.getSieveScripts).not.toHaveBeenCalled();
    expect(a.content('filters')).toBe(bulwarkScript([rule('a1')]));
    expect(b.content('filters')).toBe(bulwarkScript([rule('b1')]));
  });

  it('reads the vacation-skipped filters script, with its ids and content', async () => {
    makeAccount('b', [
      { id: 'v', name: 'vacation', content: 'require "vacation"; vacation "away";', isActive: true },
      { id: 'f', name: 'filters', content: bulwarkScript([rule('old')]), isActive: false },
    ]);
    const filters = await readAccountFilters('b');
    expect(filters.script?.id).toBe('f');
    expect(filters.content).toBe(bulwarkScript([rule('old')]));
    expect(filters.activeScriptId).toBe('v');
    expect(filters.includeVacation).toBe(true);
  });

  it('refreshes the filter store after a write and an undo for the account it shows', async () => {
    makeAccount('b', [{ name: 'filters', content: bulwarkScript([rule('old')]), isActive: true }]);
    useFilterStore.setState({ selectedAccountId: 'b' });
    const fetchFilters = vi.fn(async () => {});
    useFilterStore.setState({ fetchFilters });

    const change = await updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')));
    await vi.waitFor(() => expect(fetchFilters).toHaveBeenCalledTimes(1));
    await restoreAccountFilters(change!);
    await vi.waitFor(() => expect(fetchFilters).toHaveBeenCalledTimes(2));
  });

  it('leaves the filter store alone when it shows another account', async () => {
    makeAccount('b', [{ name: 'filters', content: bulwarkScript([rule('old')]), isActive: true }]);
    useFilterStore.setState({ selectedAccountId: 'a' });
    const fetchFilters = vi.fn(async () => {});
    useFilterStore.setState({ fetchFilters });

    await updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchFilters).not.toHaveBeenCalled();
  });

  it('a failed refresh does not fail the write', async () => {
    makeAccount('b', [{ name: 'filters', content: bulwarkScript([rule('old')]), isActive: true }]);
    useFilterStore.setState({ selectedAccountId: 'b', fetchFilters: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(updateAccountFilters('b', (rules) => insertRuleAtTop(rules, rule('new')))).resolves.not.toBeNull();
  });
});
