import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mockConnection,
  MockStaleLoadError,
  mockStalwartAccount,
  sieveRouter,
  STALWART_VACATION_SCRIPT,
  type MockConnection,
  type SieveRouter,
} from '../../lib/filters/__tests__/sieve-mock';

// Ported from webmail stores/__tests__/vacation-forward.test.ts (with the
// card behaviour of components/settings/__tests__/vacation-forward.test.tsx
// that lives in the store here), against a server that behaves like
// Stalwart. Every Sieve and vacation call must carry a connection scope; a
// call on a replaced connection stops before it reaches the server, as
// jmapClient's do.

const env = vi.hoisted(() => ({
  router: null as unknown as SieveRouter,
  connection: null as unknown as MockConnection,
  server: null as unknown as { vacation: Record<string, (...a: unknown[]) => unknown> },
  /** The app account the app shows (email-store activeAccountId). */
  shown: { current: 'login-a' as string | null },
}));

vi.mock('../../api/jmap-client', async () => {
  const { MockStaleLoadError: Stale } = await import('../../lib/filters/__tests__/sieve-mock');
  return {
    jmapClient: {
      get connectionGen() { return env.connection.gen; },
      accountId: 'b',
      currentSession: null,
      isCurrent: (gen: number) => gen === env.connection.gen,
      assertCurrent: (gen: number) => { if (gen !== env.connection.gen) throw new Stale(); },
    },
  };
});

vi.mock('../../api/sieve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/sieve')>();
  const route = (name: string) => (...args: unknown[]) =>
    (env.router.module as Record<string, (...a: unknown[]) => unknown>)[name](...args);
  return {
    ...actual,
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

vi.mock('../../api/vacation', () => ({
  isVacationSupported: () => true,
  getVacationResponse: (...args: unknown[]) => env.server.vacation.getVacationResponse(...args),
  setVacationResponse: (...args: unknown[]) => env.server.vacation.setVacationResponse(...args),
}));

vi.mock('../email-store', async () => {
  const { inAccount, opScope } = await import('../../api/op-scope');
  return {
    useEmailStore: { getState: () => ({ activeAccountId: env.shown.current }) },
    isShownAccount: (id: string | null | undefined) => !!id && id === env.shown.current,
    requireShownAccountScope: (id: string | null | undefined, jmapAccountId?: string) => {
      if (!id || id !== env.shown.current) throw new Error('This belongs to another account.');
      return inAccount(opScope(), jmapAccountId);
    },
  };
});

import type { FilterRule, VacationForward } from '../../lib/sieve/types';
import { generateScript } from '../../lib/sieve/generator';
import { parseScript } from '../../lib/sieve/parser';
import { OpaqueFiltersError, updateAccountFilters } from '../../lib/filters/account-filters';
import { insertRuleAtTop } from '../../lib/filters/quick-rules';
import { sieveScope } from '../../api/sieve';
import { readVacationFilters, syncVacationWithFilters, useFilterStore, type VacationSync } from '../filter-store';
import { VacationFiltersError, useVacationStore } from '../vacation-store';

const EXTENSIONS = ['fileinto', 'mailbox', 'mailboxid', 'imap4flags', 'include', 'envelope', 'copy', 'date', 'relational', 'spamtestplus', 'comparator-i;ascii-numeric'];
const FORWARD_MARKER = '# Vacation forwarding';
const INCLUDE = 'include :personal :optional "vacation";';
const VACATION_SCRIPT = STALWART_VACATION_SCRIPT;

const forward = (extra: Partial<VacationForward> = {}): VacationForward => ({
  enabled: true,
  to: 'kollege@example.com',
  keepCopy: false,
  activeFrom: '2026-10-05T06:00:00.000Z',
  activeUntil: '2026-10-16T16:00:00.000Z',
  ...extra,
});

const rule = (id: string, extra: Partial<FilterRule> = {}): FilterRule => ({
  id,
  name: `Rule ${id}`,
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: `${id}@example.net` }],
  actions: [{ type: 'mark_read' }],
  stopProcessing: false,
  ...extra,
});

const filters = (rules: FilterRule[], options: Parameters<typeof generateScript>[2] = {}) =>
  generateScript(rules, undefined, { extensions: EXTENSIONS, ...options });

const HAND_EDITED = '/* @metadata:begin\n{not json\n@metadata:end */\nkeep;\n';

const stalwart = (
  initial: Parameters<typeof mockStalwartAccount>[2],
  options: { extensions?: string[]; maxNumberRedirects?: number } = {},
) => {
  const server = mockStalwartAccount(env.router, 'b', initial, options.extensions ?? EXTENSIONS, options);
  env.server = server as never;
  return server;
};

/** Sync on the live connection, as webmail's `syncVacationWithFilters(client, enabled, 'b', …)`. */
const sync = (
  enabled: boolean,
  fwd?: VacationForward | null,
  audience?: VacationSync['audience'],
  period?: VacationSync['period'],
) => syncVacationWithFilters({ enabled, forward: fwd, audience, period }, sieveScope('b'));

const read = (account = 'b') => readVacationFilters(account);

/** Another login takes over the client, as an account switch does. */
function switchLogin(to: string) {
  env.connection.replace();
  env.shown.current = to;
  useFilterStore.getState().clearState();
  useVacationStore.getState().reset();
}

const initialVacation = useVacationStore.getState();
const initialFilters = useFilterStore.getState();
beforeEach(() => {
  env.connection = mockConnection();
  env.router = sieveRouter({ connection: env.connection });
  env.shown.current = 'login-a';
});
afterEach(() => {
  useVacationStore.setState(initialVacation, true);
  useFilterStore.setState(initialFilters, true);
  useVacationStore.getState().reset();
  useFilterStore.getState().clearState();
});

describe('syncVacationWithFilters with forwarding', () => {
  it('runs forwarding next to the auto-reply even when there is no filter rule', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([]), isActive: false },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: true },
    ]);
    await sync(true, forward());
    expect(server.active()).toBe('filters');
    const written = server.content('filters');
    expect(written).toContain(INCLUDE);
    expect(written).toContain(FORWARD_MARKER);
    expect(parseScript(written).vacationForward).toEqual(forward());
  });

  it('creates the filters script for forwarding when there is none', async () => {
    const server = stalwart([{ name: 'vacation', content: VACATION_SCRIPT, isActive: true }]);
    await sync(true, forward());
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(INCLUDE);
    expect(server.content('filters')).toContain(FORWARD_MARKER);
  });

  it('brings the stored forwarding back when the auto-reply took over again', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: false },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: true },
    ]);
    await sync(true);
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(FORWARD_MARKER);
  });

  it('brings the stored forwarding back without any rule when the auto-reply took over again', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([], { includeVacation: true, vacationForward: forward() }), isActive: false },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: true },
    ]);
    await sync(true);
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(FORWARD_MARKER);
  });

  it('moves the forwarding to new vacation dates', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    const later = forward({ activeFrom: '2026-11-02T07:00:00.000Z', activeUntil: '2026-11-13T17:00:00.000Z' });
    await sync(true, later);
    const written = server.content('filters');
    expect(parseScript(written).vacationForward).toEqual(later);
    expect(written).toContain('"date" "2026-11-02"');
    expect(written).not.toContain('"date" "2026-10-05"');
  });

  it('keeps forwarding when the auto-reply is turned off', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    await sync(false, forward());
    const written = server.content('filters');
    expect(written).not.toContain(INCLUDE);
    expect(written).toContain(FORWARD_MARKER);
    expect(parseScript(written).vacationForward).toEqual(forward());
    expect(server.active()).toBe('filters');
  });

  it('forwards without any auto-reply, creating the filters script for it', async () => {
    const server = stalwart([]);
    await sync(false, forward());
    expect(server.active()).toBe('filters');
    const written = server.content('filters');
    expect(written).not.toContain(INCLUDE);
    expect(written).toContain(FORWARD_MARKER);
  });

  it('switches the filters back on for forwarding when the auto-reply was the only active script', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([], { vacationForward: forward() }), isActive: false },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    await sync(false);
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(FORWARD_MARKER);
  });

  it('leaves switched-off forwarding where nothing else needs the filters script', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([], { vacationForward: forward({ enabled: false }) }), isActive: false },
    ]);
    await sync(false);
    expect(server.writes()).toBe(0);
    expect(server.active()).toBeNull();
  });

  it('removes forwarding that was cleared', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    await sync(true, null);
    const written = server.content('filters');
    expect(written).toContain(INCLUDE);
    expect(written).not.toContain(FORWARD_MARKER);
    expect(parseScript(written).vacationForward).toBeUndefined();
  });

  it('leaves the auto-reply on its own without rules or forwarding, as before', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([]), isActive: false },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: true },
    ]);
    await sync(true);
    await sync(true, null);
    expect(server.writes()).toBe(0);
    expect(server.active()).toBe('vacation');
  });

  it('refuses forwarding on a hand-edited script, and writes nothing', async () => {
    const server = stalwart([
      { name: 'filters', content: HAND_EDITED, isActive: false },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: true },
    ]);
    await expect(sync(true, forward())).rejects.toBeInstanceOf(OpaqueFiltersError);
    expect(server.writes()).toBe(0);
  });

  it('says so, rather than nothing, when the vacation script took over from a hand-edited script', async () => {
    const server = stalwart([
      { name: 'filters', content: HAND_EDITED, isActive: false },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: true },
    ]);
    await expect(sync(true)).rejects.toBeInstanceOf(OpaqueFiltersError);
    expect(server.writes()).toBe(0);
    expect(server.content('filters')).toBe(HAND_EDITED);
  });

  it('refuses forwarding where the server cannot include the auto-reply', async () => {
    const server = stalwart([{ name: 'vacation', content: VACATION_SCRIPT, isActive: true }], { extensions: ['fileinto'] });
    await expect(sync(true, forward())).rejects.toThrow(/"include"/);
    expect(server.writes()).toBe(0);
  });

  it('moves the stored forwarding to the vacation dates without it being sent again', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    await sync(true, undefined, undefined, { from: '2026-11-02T07:00:00.000Z', until: null });
    // Without an end date it forwards until switched off.
    expect(parseScript(server.content('filters')).vacationForward).toEqual({
      enabled: true, to: 'kollege@example.com', keepCopy: false, activeFrom: '2026-11-02T07:00:00.000Z',
    });
  });

  it('takes the same moment, written another way, as no change', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    // The server hands the vacation's dates back without milliseconds.
    await sync(true, undefined, undefined, { from: '2026-10-05T06:00:00Z', until: '2026-10-16T18:00:00+02:00' });
    expect(server.writes()).toBe(0);
  });

  it('refuses forwarding it could not read back, and writes nothing', async () => {
    const server = stalwart([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    // The generator would leave it out, and the save would look done.
    await expect(sync(false, forward(), undefined, { from: null, until: '+010000-01-01T00:59:00.000Z' }))
      .rejects.toThrow(/Unusable/);
    await expect(sync(false, forward({ to: 'kollege' }))).rejects.toThrow(/Unusable/);
    expect(server.writes()).toBe(0);
  });

  it('writes nothing once the connection it started on was replaced', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')]), isActive: false },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: true },
    ]);
    // The other login's account has the same id: only the connection tells them apart.
    server.api.getSieveScriptContent.mockImplementationOnce(async (blobId: string) => {
      env.connection.replace();
      return server.content('filters') || blobId;
    });
    await expect(sync(true)).rejects.toBeInstanceOf(MockStaleLoadError);
    expect(server.writes()).toBe(0);
    expect(server.active()).toBe('vacation');
  });
});

describe('readVacationFilters', () => {
  it('reports the forwarding, that it can be set up, and the forwards in the rules', async () => {
    const forwarding = rule('f', { actions: [{ type: 'forward', value: 'chef@example.com' }] });
    stalwart([
      { name: 'filters', content: filters([forwarding, rule('off', { ...forwarding, enabled: false })], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    expect(await read()).toEqual({
      includesVacation: true,
      forward: forward(),
      forwardAvailable: true,
      audience: null,
      audienceAvailable: true,
      notRunning: false,
      otherForwards: 1,
    });
  });

  it('reports the most forwards one message can collect in the rules, not all of them', async () => {
    const forwarding = (id: string, stopProcessing: boolean) =>
      rule(id, { actions: [{ type: 'forward', value: 'chef@example.com' }], stopProcessing });
    const forwards = async (rules: FilterRule[]) => {
      env.router.reset();
      stalwart([{ name: 'filters', content: filters(rules), isActive: true }]);
      return (await read()).otherForwards;
    };
    // A message the first rule matches stops there.
    expect(await forwards([forwarding('a', true), forwarding('b', false)])).toBe(1);
    expect(await forwards([forwarding('a', false), forwarding('b', false)])).toBe(2);
  });

  it('offers no forwarding without include, on a hand-edited script, or without redirects', async () => {
    const available = async (options = {}, content = filters([])) => {
      env.router.reset();
      stalwart([{ name: 'filters', content, isActive: true }], options);
      return (await read()).forwardAvailable;
    };
    expect(await available({ extensions: ['fileinto'] })).toBe(false);
    expect(await available({}, '/* @metadata:begin\n{\n@metadata:end */\n')).toBe(false);
    expect(await available({ maxNumberRedirects: 0 })).toBe(false);
    expect(await available()).toBe(true);
  });

  it('offers no forwarding where the server lacks what the block uses', async () => {
    // Its period, its spam check, and the copy kept here.
    for (const missing of ['date', 'relational', 'spamtestplus', 'copy']) {
      env.router.reset();
      stalwart([{ name: 'filters', content: filters([]), isActive: true }], {
        extensions: EXTENSIONS.filter((e) => e !== missing),
      });
      expect((await read()).forwardAvailable, missing).toBe(false);
    }
  });

  it('still offers forwarding that is on, so that it can be switched off', async () => {
    stalwart(
      [{ name: 'filters', content: filters([], { vacationForward: forward() }), isActive: true }],
      { maxNumberRedirects: 0 },
    );
    expect((await read()).forwardAvailable).toBe(true);
  });

  it('says when forwarding that is on does not run, and when it does', async () => {
    const notRunning = async (filtersActive: boolean, vacationActive: boolean, f = forward()) => {
      env.router.reset();
      stalwart([
        { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: f }), isActive: filtersActive },
        { name: 'vacation', content: VACATION_SCRIPT, isActive: vacationActive },
      ]);
      return (await read()).notRunning;
    };
    // Stalwart's own script took over: it answers, nothing forwards.
    expect(await notRunning(false, true)).toBe(true);
    // No script runs at all.
    expect(await notRunning(false, false)).toBe(true);
    expect(await notRunning(true, false)).toBe(false);
    // Switched off, there is nothing that should run.
    expect(await notRunning(false, true, forward({ enabled: false }))).toBe(false);
  });
});

describe('every other write keeps the forwarding', () => {
  const withForwarding = () => stalwart([
    { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
    { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
  ]);

  it('a rule made from a message', async () => {
    // Rules made from a message name the account; this router wants a scope.
    const server = withForwarding();
    await updateAccountFilters(sieveScope('b') as never, (rules) => insertRuleAtTop(rules, rule('new')));
    const written = server.content('filters');
    expect(written).toContain('# Rule: Rule new');
    expect(written.split(FORWARD_MARKER).length).toBe(2);
    expect(parseScript(written).vacationForward).toEqual(forward());
  });

  it('a save on the filter settings page', async () => {
    const server = withForwarding();
    await useFilterStore.getState().fetchFilters('b');
    expect(useFilterStore.getState().vacationForward).toEqual(forward());
    useFilterStore.getState().addRule(rule('new'));
    await useFilterStore.getState().saveFilters();
    const written = server.content('filters');
    expect(written).toContain('# Rule: Rule new');
    expect(written.split(FORWARD_MARKER).length).toBe(2);
    expect(parseScript(written).vacationForward).toEqual(forward());
  });
});

describe('vacation store', () => {
  it('loads the forwarding along with the auto-reply', async () => {
    stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    await useVacationStore.getState().fetch();
    expect(useVacationStore.getState()).toMatchObject({
      appAccountId: 'login-a',
      accountId: null,
      isEnabled: true,
      forward: forward(),
      forwardAvailable: true,
      otherForwards: 0,
    });
  });

  it('forwards in the vacation period it saves, with the auto-reply and after it', async () => {
    const server = stalwart([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await useVacationStore.getState().fetch();
    await useVacationStore.getState().save({
      isEnabled: true,
      fromDate: '2026-10-05T06:00:00.000Z',
      toDate: '2026-10-16T16:00:00.000Z',
      forward: { enabled: true, to: 'kollege@example.com', keepCopy: false },
    });
    // The auto-reply runs from the filters script, which forwards in its period.
    expect(server.active()).toBe('filters');
    const written = server.content('filters');
    expect(written).toContain(INCLUDE);
    expect(parseScript(written).vacationForward).toEqual(forward());
    // VacationResponse itself never sees the forwarding.
    expect(server.vacation.setVacationResponse.mock.calls[0][0]).not.toHaveProperty('forward');
    expect(useVacationStore.getState().forward).toEqual(forward());

    // Turning the auto-reply off leaves the forwarding running on its own.
    await useVacationStore.getState().save({ isEnabled: false });
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).not.toContain(INCLUDE);
    expect(server.content('filters')).toContain(FORWARD_MARKER);
  });

  it('turns the auto-reply off and forwarding on in one save, even when the auto-reply ran alone', async () => {
    const server = stalwart([{ name: 'vacation', content: VACATION_SCRIPT, isActive: true }]);
    await useVacationStore.getState().fetch();
    expect(useVacationStore.getState().isEnabled).toBe(true);
    await useVacationStore.getState().save({
      isEnabled: false,
      fromDate: null,
      toDate: null,
      forward: { enabled: true, to: 'kollege@example.com', keepCopy: false },
    });
    // No auto-reply any more; the filters script forwards on its own.
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).not.toContain(INCLUDE);
    expect(server.content('filters')).toContain('redirect "kollege@example.com";');
  });

  it('keeps the filters and a forward without rules running when the auto-reply is turned on', async () => {
    // A webmail forward, no rules: Stalwart's script would take over and stop it.
    const server = stalwart([{ name: 'filters', content: filters([], { vacationForward: forward() }), isActive: true }]);
    await useVacationStore.getState().fetch();
    await useVacationStore.getState().save({ isEnabled: true });
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(INCLUDE);
    expect(server.content('filters')).toContain(FORWARD_MARKER);
  });

  it('says when the auto-reply was saved but its forwarding was not', async () => {
    const server = stalwart([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await useVacationStore.getState().fetch();
    server.api.updateSieveScript.mockRejectedValueOnce(new Error('server said no'));
    await expect(useVacationStore.getState().save({
      isEnabled: true,
      forward: { enabled: true, to: 'kollege@example.com', keepCopy: false },
    })).rejects.toBeInstanceOf(VacationFiltersError);
    expect(server.vacation.setVacationResponse).toHaveBeenCalledTimes(1);
    expect(useVacationStore.getState()).toMatchObject({ isEnabled: true, forward: null, isSaving: false, error: null });
  });

  it('says when forwarding that is on could not be switched off', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { vacationForward: forward() }), isActive: true },
    ]);
    await useVacationStore.getState().fetch();
    server.api.updateSieveScript.mockRejectedValueOnce(new Error('server said no'));
    // Only the stored forwarding tells that mail is still forwarded.
    await expect(useVacationStore.getState().save({
      isEnabled: false,
      forward: { enabled: false, to: 'kollege@example.com', keepCopy: false },
    })).rejects.toBeInstanceOf(VacationFiltersError);
    expect(server.content('filters')).toContain(FORWARD_MARKER);
    expect(useVacationStore.getState().forward).toEqual(forward());
  });

  it('says when keeping the rules running next to the auto-reply failed', async () => {
    const server = stalwart([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await useVacationStore.getState().fetch();
    server.api.updateSieveScript.mockRejectedValueOnce(new Error('connection lost'));
    await expect(useVacationStore.getState().save({ isEnabled: true })).rejects.toBeInstanceOf(VacationFiltersError);
    expect(useVacationStore.getState()).toMatchObject({ isEnabled: true, isSaving: false, error: null });
  });

  it('says when a save cut short leaves the forwarding idle, and the next save sets it right', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    await useVacationStore.getState().fetch();
    expect(useVacationStore.getState()).toMatchObject({ isEnabled: true, notRunning: false });

    // Only the text changes. Stalwart's own script takes over with the
    // response, and putting the filters back fails.
    server.api.updateSieveScript.mockRejectedValueOnce(new Error('connection lost'));
    await expect(useVacationStore.getState().save({ isEnabled: true, subject: 'Weg' }))
      .rejects.toBeInstanceOf(VacationFiltersError);
    expect(server.active()).toBe('vacation');
    expect(useVacationStore.getState()).toMatchObject({ forward: forward(), notRunning: true });

    await useVacationStore.getState().save({ isEnabled: true });
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(FORWARD_MARKER);
    expect(useVacationStore.getState().notRunning).toBe(false);
  });

  it('leaves forwarding it was not asked to change as the server has it, in the vacation period', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward({ enabled: false }) }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    await useVacationStore.getState().fetch();
    // Another device switched it on since this one loaded.
    await sync(true, forward());
    await useVacationStore.getState().save({
      isEnabled: true, fromDate: '2026-11-02T07:00:00.000Z', toDate: '2026-11-13T17:00:00.000Z',
    });
    const stored = parseScript(server.content('filters')).vacationForward;
    expect(stored).toEqual(forward({ activeFrom: '2026-11-02T07:00:00.000Z', activeUntil: '2026-11-13T17:00:00.000Z' }));
    expect(useVacationStore.getState().forward).toEqual(stored);
  });

  it('drops what a load finds once a later load or an account switch outdated it', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    const other = { id: 'singleton', fromDate: null, toDate: null, subject: 'Other account', textBody: 'x', htmlBody: null, isEnabled: false };
    let answer: (value: typeof other) => void = () => {};
    server.vacation.getVacationResponse.mockImplementationOnce(() => new Promise<typeof other>((resolve) => { answer = resolve; }));
    const slow = useVacationStore.getState().fetch();
    await useVacationStore.getState().fetch();
    answer(other);
    await slow;
    expect(useVacationStore.getState()).toMatchObject({ subject: '', forward: forward(), isLoading: false });

    server.vacation.getVacationResponse.mockImplementationOnce(() => new Promise<typeof other>((resolve) => { answer = resolve; }));
    const beforeSwitch = useVacationStore.getState().fetch();
    useVacationStore.getState().reset();
    answer(other);
    await beforeSwitch;
    expect(useVacationStore.getState()).toMatchObject({ subject: '', forward: null, isLoading: false });
  });
});

describe('the vacation store and the account it was loaded for', () => {
  it('refuses to turn the auto-reply on over a hand-edited filters script, and writes nothing', async () => {
    const server = stalwart([{ name: 'filters', content: HAND_EDITED, isActive: true }]);
    await useVacationStore.getState().fetch();
    await expect(useVacationStore.getState().save({ isEnabled: true })).rejects.toBeInstanceOf(OpaqueFiltersError);
    // Stalwart's own script never got the chance to switch the filters off.
    expect(server.vacation.setVacationResponse).not.toHaveBeenCalled();
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toBe(HAND_EDITED);
    expect(useVacationStore.getState()).toMatchObject({ isEnabled: false, isSaving: false });
  });

  it('still saves the auto-reply next to a hand-edited script that is not running', async () => {
    const server = stalwart([{ name: 'filters', content: HAND_EDITED, isActive: false }]);
    await useVacationStore.getState().fetch();
    await useVacationStore.getState().save({ isEnabled: true });
    expect(server.active()).toBe('vacation');
    expect(server.writes()).toBe(0);
    expect(server.content('filters')).toBe(HAND_EDITED);
  });

  it('never writes forwarding that fails validation, nor the response that goes with it', async () => {
    const server = stalwart([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await useVacationStore.getState().fetch();
    await expect(useVacationStore.getState().save({
      isEnabled: true,
      forward: { enabled: true, to: 'kollege', keepCopy: false },
    })).rejects.toThrow(/Unusable/);
    // A year the generator cannot write is as unusable as a broken address.
    await expect(useVacationStore.getState().save({
      isEnabled: true,
      toDate: '+010000-01-01T00:59:00.000Z',
      forward: { enabled: true, to: 'kollege@example.com', keepCopy: false },
    })).rejects.toThrow(/Unusable/);
    expect(server.vacation.setVacationResponse).not.toHaveBeenCalled();
    expect(server.writes()).toBe(0);
    expect(server.active()).toBe('filters');
  });

  it('writes nothing to the filters once a switch lands mid-save, and keeps the form out of it', async () => {
    const server = stalwart([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await useVacationStore.getState().fetch();
    const respond = server.vacation.setVacationResponse.getMockImplementation()!;
    server.vacation.setVacationResponse.mockImplementationOnce(async (updates, account) => {
      await respond(updates, account);
      // The other login has the same JMAP account id ("b") and is "own" too.
      switchLogin('login-b');
    });
    await expect(useVacationStore.getState().save({
      isEnabled: true,
      subject: 'Weg',
      forward: { enabled: true, to: 'kollege@example.com', keepCopy: false },
    })).resolves.toBeUndefined();
    expect(server.writes()).toBe(0);
    expect(parseScript(server.content('filters')).vacationForward).toBeUndefined();
    expect(useVacationStore.getState()).toMatchObject({ appAccountId: null, subject: '', forward: null, isSaving: false });
  });

  it('writes nothing once the switch lands before the save starts', async () => {
    const server = stalwart([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await useVacationStore.getState().fetch();
    // The connection moved on, the screen still shows the old login's form.
    env.connection.replace();
    env.shown.current = 'login-b';
    await expect(useVacationStore.getState().save({ isEnabled: true })).rejects.toThrow(/another account/);
    expect(server.vacation.setVacationResponse).not.toHaveBeenCalled();
    expect(server.writes()).toBe(0);
  });

  it('tells two "own" accounts with the same JMAP id apart', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    const mine = { id: 'singleton', fromDate: null, toDate: null, subject: 'A away', textBody: 'x', htmlBody: null, isEnabled: true };
    let answer: (value: typeof mine) => void = () => {};
    server.vacation.getVacationResponse.mockImplementationOnce(() => new Promise<typeof mine>((resolve) => { answer = resolve; }));
    const loadA = useVacationStore.getState().fetch();
    // Switched from A to B; both are "own" (accountId null), both JMAP id "b".
    env.shown.current = 'login-b';
    answer(mine);
    await loadA;
    expect(useVacationStore.getState()).toMatchObject({ appAccountId: 'login-a', subject: '', hasLoaded: false });

    await useVacationStore.getState().fetch();
    expect(useVacationStore.getState()).toMatchObject({ appAccountId: 'login-b', accountId: null, hasLoaded: true });
  });

  it('starts over when the same "own" account id belongs to another login', async () => {
    stalwart([{ name: 'filters', content: filters([rule('a')], { vacationForward: forward() }), isActive: true }]);
    await useVacationStore.getState().fetch();
    expect(useVacationStore.getState().forward).toEqual(forward());
    env.shown.current = 'login-b';
    const loadB = useVacationStore.getState().fetch();
    // Blank at once, before B's answer is in.
    expect(useVacationStore.getState()).toMatchObject({ appAccountId: 'login-b', forward: null, hasLoaded: false });
    await loadB;
  });
});
