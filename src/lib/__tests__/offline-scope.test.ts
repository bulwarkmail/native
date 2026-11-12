import { describe, it, expect, vi, beforeEach } from 'vitest';

// What an account keeps offline (webmail lib/offline/scope.ts): its own
// window and total, falling back to the device-wide setting, and the
// organisation's device policy on top, which only ever lowers.

const { client } = vi.hoisted(() => ({ client: { served: 'usera@mail.example.org' as string | null } }));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    get isConnected() { return client.served !== null; },
    get username() { return client.served ? client.served.split('@')[0] : null; },
    get serverUrl() { return client.served ? 'https://mail.example.org' : null; },
    getSharedMailAccounts: () => [],
    getMaxObjectsInGet: () => 500,
  },
}));

const queryEmailsByFilter = vi.fn(async (..._args: unknown[]) => ['m1', 'm2']);
vi.mock('../../api/email', () => ({
  queryEmailsByFilter: (...args: unknown[]) => queryEmailsByFilter(...args),
  getFullEmails: async (ids: string[]) => ids.map((id) => ({ id, receivedAt: '2026-11-10T10:00:00Z', mailboxIds: { a: true }, keywords: {} })),
}));

// The policy store reads the auth store; a stand-in keeps the client mock small.
vi.mock('../../stores/auth-store', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ activeAccountId: null as string | null, session: null as unknown })) };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import '../device-policy';
import { runOfflineSync } from '../offline-sync';
import { useOfflineCacheStore } from '../../stores/offline-cache-store';
import { capTakesChoice, effectiveOfflineScope, offlineScopeFor, optionsUnderCap, DAY_CHOICES, MB_CHOICES } from '../offline-scope';
import { NO_DEVICE_LIMITS } from '../org-organisation';
import { dropForbiddenOfflineMail } from '../org-policy-effects';
import { account, givenPolicy } from './org-policy-helpers';

const A = 'usera@mail.example.org';
const B = 'userb@mail.example.org';
const DEFAULTS = { enabled: true, days: 7, maxMB: 50 };

function given(devices: Record<string, unknown> | null) {
  givenPolicy(devices ? { organisation: { devices } } : null, {
    accounts: [account(A, 'usera', { serverUrl: 'https://mail.example.org', email: 'usera@example.org' }), account(B, 'userb')],
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await AsyncStorage.clear();
  useOfflineCacheStore.setState({ choices: {}, choicesHydrated: true });
  client.served = A;
  await useOfflineCacheStore.getState().setAccount(null);
  await useOfflineCacheStore.getState().setAccount(A);
  given(null);
});

describe('effectiveOfflineScope', () => {
  it('takes the account choice over the device setting', () => {
    expect(effectiveOfflineScope({ days: 30 }, DEFAULTS, NO_DEVICE_LIMITS)).toMatchObject({ enabled: true, days: 30, maxMB: 50 });
    expect(effectiveOfflineScope(undefined, DEFAULTS, NO_DEVICE_LIMITS)).toMatchObject({ days: 7, maxMB: 50 });
  });

  it('lets the organisation forbid offline mail and cap the window and total, never raise them', () => {
    const policy = { ...NO_DEVICE_LIMITS, noOffline: true, offlineMaxDays: 14, offlineMaxTotalMb: 25 };
    const scope = effectiveOfflineScope({ days: 90, maxMB: 500 }, DEFAULTS, policy);
    expect(scope).toEqual({ enabled: false, days: 14, maxMB: 25, locked: { offline: true, days: true, maxTotal: true } });
    expect(effectiveOfflineScope({ days: 3 }, DEFAULTS, policy).days).toBe(3);
  });

  it('offers only the choices under a cap, with the cap itself', () => {
    expect(optionsUnderCap(DAY_CHOICES, 20)).toEqual([1, 3, 7, 14, 20]);
    expect(optionsUnderCap(MB_CHOICES, 0)).toEqual([...MB_CHOICES]);
    // The note shows only when the cap takes a choice away (webmail 510ae2f7a).
    expect(capTakesChoice(MB_CHOICES, 1000)).toBe(false);
    expect(capTakesChoice(MB_CHOICES, 100)).toBe(true);
  });
});

describe('per-account choices', () => {
  it('keeps each account its own window, stored across starts', async () => {
    useOfflineCacheStore.getState().setChoice(A, { days: 30 });
    useOfflineCacheStore.getState().setChoice(B, { maxMB: 250 });
    expect(offlineScopeFor(A, DEFAULTS)).toMatchObject({ days: 30, maxMB: 50 });
    expect(offlineScopeFor(B, DEFAULTS)).toMatchObject({ days: 7, maxMB: 250 });
    await vi.waitFor(async () => expect(await AsyncStorage.getItem('webmail:offline-cache:choices:v1')).toContain('250'));
    useOfflineCacheStore.setState({ choices: {}, choicesHydrated: false });
    await useOfflineCacheStore.getState().hydrateChoices();
    expect(useOfflineCacheStore.getState().choices).toEqual({ [A]: { days: 30 }, [B]: { maxMB: 250 } });
  });

  it('syncs the account window, under the organisation cap', async () => {
    useOfflineCacheStore.getState().setChoice(A, { days: 30 });
    given({ offlineMaxDays: 10 });
    const before = Date.now();
    await runOfflineSync({ days: 7, maxMB: 50 });
    const after = String(queryEmailsByFilter.mock.calls[0][0] && (queryEmailsByFilter.mock.calls[0][0] as { after: string }).after);
    const days = (before - Date.parse(after)) / 86_400_000;
    expect(days).toBeGreaterThan(9.9);
    expect(days).toBeLessThan(10.1);
  });

  it('keeps nothing when the organisation forbids offline mail', async () => {
    given({ noOffline: true });
    await runOfflineSync({ days: 7, maxMB: 50 });
    expect(queryEmailsByFilter).not.toHaveBeenCalled();
    expect(useOfflineCacheStore.getState().totalCount()).toBe(0);
  });

  it('drops what an account kept once its organisation forbids offline mail', async () => {
    await runOfflineSync({ days: 7, maxMB: 50 });
    expect(useOfflineCacheStore.getState().totalCount()).toBe(2);
    given({ noOffline: true });
    dropForbiddenOfflineMail();
    await vi.waitFor(async () => {
      const keys = (await AsyncStorage.getAllKeys()) as string[];
      expect(keys.filter((k) => k.startsWith(`webmail:offline-cache:entry:v2:${A}:`))).toEqual([]);
    });
    expect(useOfflineCacheStore.getState().totalCount()).toBe(0);
  });
});
