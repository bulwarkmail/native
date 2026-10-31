import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_RETRY_MS, RECENT_TTL_MS, UNSUPPORTED_RETRY_MS, recoveryKey, useRecoveryStore } from '../recovery-store';
import { JMAPMethodError } from '../../../api/jmap-result';
import type { ArchiveQueryPage } from '../archived-items';
import { LICENSE_REFUSAL } from './fixtures';

// Ported from the webmail's stores/__tests__/recovery-store.test.ts (the
// app keeps answers for the app run, so the tab-reload and sessionStorage
// cases have no counterpart).

const page = (ids: string[]): ArchiveQueryPage => ({ ids, total: null });

function makeClient(query: () => Promise<ArchiveQueryPage>, stalwart = true, has: () => Promise<boolean> = async () => true) {
  return {
    advertisesArchivedItems: () => stalwart,
    queryArchivedItemIds: vi.fn(query),
    hasArchivedEmail: vi.fn(has),
  };
}

const refused = () => Promise.reject(new JMAPMethodError('forbidden', LICENSE_REFUSAL.description));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
});

afterEach(() => {
  useRecoveryStore.getState().reset();
  vi.useRealTimers();
});

describe('recovery detection', () => {
  it('asks a one-item query, hides the feature when the server refuses and asks again only after the retry time', async () => {
    const client = makeClient(refused);
    const key = recoveryKey('acc-alice', 'ci');
    await expect(useRecoveryStore.getState().detect(client, key)).resolves.toBe(false);
    expect(client.queryArchivedItemIds).toHaveBeenCalledWith({ limit: 1 });
    expect(useRecoveryStore.getState().checks[key]).toEqual({ supported: false, retryAt: Date.now() + UNSUPPORTED_RETRY_MS });

    await useRecoveryStore.getState().detect(client, key);
    expect(client.queryArchivedItemIds).toHaveBeenCalledTimes(1);

    // The license arrives later: the next check after the retry time shows it.
    client.queryArchivedItemIds.mockImplementation(async () => page([]));
    vi.setSystemTime(Date.now() + UNSUPPORTED_RETRY_MS + 1);
    await expect(useRecoveryStore.getState().detect(client, key)).resolves.toBe(true);
    expect(useRecoveryStore.getState().checks[key]?.supported).toBe(true);
  });

  it('asks again before the retry time when forced', async () => {
    const client = makeClient(refused);
    const key = recoveryKey('acc-alice', 'ci');
    await useRecoveryStore.getState().detect(client, key);
    await useRecoveryStore.getState().detect(client, key, { force: true });
    expect(client.queryArchivedItemIds).toHaveBeenCalledTimes(2);
  });

  it('hides it on any other error too, and asks again sooner', async () => {
    const client = makeClient(() => Promise.reject(new Error('Network request failed')));
    const key = recoveryKey('acc-alice', 'ci');
    await expect(useRecoveryStore.getState().detect(client, key)).resolves.toBe(false);
    expect(useRecoveryStore.getState().checks[key]?.retryAt).toBe(Date.now() + ERROR_RETRY_MS);
  });

  it('shows it when the query answers, and keeps that', async () => {
    const client = makeClient(async () => page(['a']));
    const key = recoveryKey('acc-alice', 'ci');
    await expect(useRecoveryStore.getState().detect(client, key)).resolves.toBe(true);
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    await expect(useRecoveryStore.getState().detect(client, key)).resolves.toBe(true);
    expect(client.queryArchivedItemIds).toHaveBeenCalledTimes(1);
  });

  it('asks once for two callers at the same time', async () => {
    const client = makeClient(async () => page([]));
    const key = recoveryKey('acc-alice', 'ci');
    await Promise.all([useRecoveryStore.getState().detect(client, key), useRecoveryStore.getState().detect(client, key)]);
    expect(client.queryArchivedItemIds).toHaveBeenCalledTimes(1);
  });

  it('keeps one answer per login, even where the JMAP account ids are the same', async () => {
    await useRecoveryStore.getState().detect(makeClient(async () => page([])), recoveryKey('acc-alice', 'ci'));
    await useRecoveryStore.getState().detect(makeClient(refused), recoveryKey('acc-bob', 'ci'));
    const { checks } = useRecoveryStore.getState();
    expect(checks['acc-alice|ci']?.supported).toBe(true);
    expect(checks['acc-bob|ci']?.supported).toBe(false);
  });

  it("doesn't ask a server that isn't Stalwart (0.16 without the capability)", async () => {
    const client = makeClient(async () => page([]), false);
    await expect(useRecoveryStore.getState().detect(client, 'k')).resolves.toBe(false);
    expect(client.queryArchivedItemIds).not.toHaveBeenCalled();
    expect(useRecoveryStore.getState().checks.k).toEqual({ supported: false, retryAt: Infinity });
  });
});

describe('the Trash link check', () => {
  it('looks once per days value for a while, and again after a restore', async () => {
    const client = makeClient(async () => page([]));
    const key = 'acc-alice|ci';
    await expect(useRecoveryStore.getState().checkRecent(client, key, 7)).resolves.toBe(true);
    await useRecoveryStore.getState().checkRecent(client, key, 7);
    expect(client.hasArchivedEmail).toHaveBeenCalledTimes(1);
    expect(client.hasArchivedEmail).toHaveBeenCalledWith({ days: 7 });
    await useRecoveryStore.getState().checkRecent(client, key, 14);
    expect(client.hasArchivedEmail).toHaveBeenCalledTimes(2);
    useRecoveryStore.getState().forgetRecent(key);
    await useRecoveryStore.getState().checkRecent(client, key, 14);
    expect(client.hasArchivedEmail).toHaveBeenCalledTimes(3);
    vi.setSystemTime(Date.now() + RECENT_TTL_MS + 1);
    await useRecoveryStore.getState().checkRecent(client, key, 14);
    expect(client.hasArchivedEmail).toHaveBeenCalledTimes(4);
  });

  it('records a refusal like detection does', async () => {
    const client = makeClient(async () => page([]), true, refused);
    await expect(useRecoveryStore.getState().checkRecent(client, 'k', 0)).resolves.toBe(false);
    expect(useRecoveryStore.getState().checks.k?.supported).toBe(false);
  });
});
