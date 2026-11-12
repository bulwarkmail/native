import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// An account the server refused keeps its data hidden on the device until
// the user signs in again, for at most 30 days, or loses it at once when
// the organisation asks (webmail lib/offline/device-wipe.ts,
// organisation.devices.wipeOnForcedSignOut).

vi.mock('../../stores/auth-store', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ activeAccountId: null as string | null, session: null as unknown, requestReauth: async () => undefined })) };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAccountStore } from '../../stores/account-store';
import { useEmailStore } from '../../stores/email-store';
import { useOfflineCacheStore } from '../../stores/offline-cache-store';
import { useOutboxStore } from '../../stores/outbox-store';
import { REFUSED_KEEP_MS, refusedDataGoesAt, sweepRefusedAccounts, useRefusedAccounts } from '../refused-accounts';
import '../device-policy';
import { ADA, account, givenPolicy } from './org-policy-helpers';

const BOB = 'bob@example.org@mail.example.org';
const NOW = Date.parse('2026-11-12T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const removeAccount = vi.fn();
const clearOffline = vi.fn(async () => undefined);
const clearOutbox = vi.fn(async () => 0);

function accounts(refused: boolean, extra: Record<string, unknown> = {}) {
  return [account(ADA, 'ada@example.org', { needsSignIn: refused, ...extra }), account(BOB, 'bob@example.org')];
}

beforeEach(async () => {
  vi.clearAllMocks();
  await AsyncStorage.clear();
  useRefusedAccounts.setState({ byAccount: {}, hydrated: false });
  useEmailStore.setState({ removeAccount } as never);
  useOfflineCacheStore.setState({ clearAccount: clearOffline } as never);
  useOutboxStore.setState({ clearAccount: clearOutbox } as never);
});

describe('sweepRefusedAccounts', () => {
  it('keeps a refused account hidden, not deleted, and says when its data goes', async () => {
    givenPolicy({}, { accounts: accounts(true) });
    await sweepRefusedAccounts(NOW);
    const entry = useRefusedAccounts.getState().byAccount[ADA];
    expect(entry).toEqual({ since: NOW });
    expect(refusedDataGoesAt(entry)).toBe(NOW + REFUSED_KEEP_MS);
    expect(removeAccount).not.toHaveBeenCalled();
    expect(clearOutbox).not.toHaveBeenCalled();
    // A later sweep keeps the first date.
    await sweepRefusedAccounts(NOW + DAY);
    expect(useRefusedAccounts.getState().byAccount[ADA].since).toBe(NOW);
  });

  it('deletes its data, unsent mail included, 30 days after the refusal', async () => {
    givenPolicy({}, { accounts: accounts(true) });
    await sweepRefusedAccounts(NOW);
    await sweepRefusedAccounts(NOW + 29 * DAY);
    expect(removeAccount).not.toHaveBeenCalled();
    await sweepRefusedAccounts(NOW + 30 * DAY);
    expect(removeAccount).toHaveBeenCalledWith(ADA);
    expect(clearOffline).toHaveBeenCalledWith(ADA);
    expect(clearOutbox).toHaveBeenCalledWith(ADA);
    // Only once, and Bob's data stays.
    await sweepRefusedAccounts(NOW + 31 * DAY);
    expect(removeAccount).toHaveBeenCalledTimes(1);
    expect(clearOutbox).not.toHaveBeenCalledWith(BOB);
    expect(refusedDataGoesAt(useRefusedAccounts.getState().byAccount[ADA])).toBeNull();
  });

  it('deletes at once when the organisation asks, from its full policy only', async () => {
    givenPolicy({ organisation: { devices: { wipeOnForcedSignOut: true } } }, { accounts: accounts(true), partial: true });
    await sweepRefusedAccounts(NOW);
    expect(removeAccount).not.toHaveBeenCalled();
    givenPolicy({ organisation: { devices: { wipeOnForcedSignOut: true } } }, { accounts: accounts(true) });
    await sweepRefusedAccounts(NOW);
    expect(removeAccount).toHaveBeenCalledWith(ADA);
    expect(clearOutbox).toHaveBeenCalledWith(ADA);
  });

  it('forgets the refusal once the account is signed in again, and remembers it across starts', async () => {
    givenPolicy({}, { accounts: accounts(true) });
    await sweepRefusedAccounts(NOW);
    await new Promise((r) => setTimeout(r, 0));
    useRefusedAccounts.setState({ byAccount: {}, hydrated: false });
    await sweepRefusedAccounts(NOW + DAY);
    expect(useRefusedAccounts.getState().byAccount[ADA].since).toBe(NOW);
    useAccountStore.setState({ accounts: accounts(false) });
    await sweepRefusedAccounts(NOW + 2 * DAY);
    expect(useRefusedAccounts.getState().byAccount[ADA]).toBeUndefined();
  });

  it('shows the sign-in prompt instead of the cached list', () => {
    const source = readFileSync(join(__dirname, '../../screens/EmailListScreen.tsx'), 'utf8');
    expect(source).toMatch(/\{refusedAccountId \? \(\s*<RefusedAccountPrompt accountId=\{refusedAccountId\} \/>\s*\) : loading && emails\.length === 0 \? \(/);
  });
});
