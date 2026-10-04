import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { username: 'user@example.com', serverUrl: 'https://mail.example.com' },
}));

vi.mock('../push-notifications', () => ({
  readPushAccountIds: vi.fn(async () => []),
  getStoredRelayBaseUrl: vi.fn(async () => 'https://relay.example.com'),
  resyncPushNotifications: vi.fn(async () => ({ subscriptionId: 'sub', verified: true })),
  renewDetachedPushSubscription: vi.fn(async () => true),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getStoredRelayBaseUrl,
  readPushAccountIds,
  renewDetachedPushSubscription,
  resyncPushNotifications,
} from '../push-notifications';
import { generateAccountId } from '../account-utils';
import { renewPushOnResume, resetPushRenewalState } from '../push-renewal';

const ACTIVE = generateAccountId('user@example.com', 'https://mail.example.com');
const OTHER = 'bob@other.example.net';
const RELAY = 'https://relay.example.com';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse('2026-10-04T09:00:00Z');

const accountIds = readPushAccountIds as ReturnType<typeof vi.fn>;
const relay = getStoredRelayBaseUrl as ReturnType<typeof vi.fn>;
const resync = resyncPushNotifications as ReturnType<typeof vi.fn>;
const detached = renewDetachedPushSubscription as ReturnType<typeof vi.fn>;

describe('renewPushOnResume', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    resetPushRenewalState();
    accountIds.mockResolvedValue([ACTIVE, OTHER]);
    relay.mockResolvedValue(RELAY);
    resync.mockResolvedValue({ subscriptionId: 'sub', verified: true });
    detached.mockResolvedValue(true);
  });

  it('renews every account: the active one through a resync, the others on their own', async () => {
    await renewPushOnResume(T0);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(resync).toHaveBeenCalledWith({ relayBaseUrl: RELAY, accountLabel: 'user@example.com' });
    expect(detached.mock.calls).toEqual([[OTHER]]);
  });

  it('does not renew twice within a day', async () => {
    await renewPushOnResume(T0);
    await renewPushOnResume(T0 + 23 * HOUR);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(detached).toHaveBeenCalledTimes(1);

    // Nor after a restart: the attempt was recorded on disk too.
    resetPushRenewalState();
    await renewPushOnResume(T0 + 23 * HOUR);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(detached).toHaveBeenCalledTimes(1);

    await renewPushOnResume(T0 + 25 * HOUR);
    expect(resync).toHaveBeenCalledTimes(2);
    expect(detached).toHaveBeenCalledTimes(2);
  });

  it('retries a failed renewal after 15 minutes', async () => {
    resync.mockRejectedValueOnce(new Error('relay down'));
    detached.mockResolvedValueOnce(false);
    await renewPushOnResume(T0);

    await renewPushOnResume(T0 + 10 * MINUTE);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(detached).toHaveBeenCalledTimes(1);

    await renewPushOnResume(T0 + 16 * MINUTE);
    expect(resync).toHaveBeenCalledTimes(2);
    expect(detached).toHaveBeenCalledTimes(2);

    // Both went through this time: a day's rest again.
    await renewPushOnResume(T0 + 40 * MINUTE);
    expect(resync).toHaveBeenCalledTimes(2);
    expect(detached).toHaveBeenCalledTimes(2);
  });

  it('counts an account the resync left off as done', async () => {
    // Opted out or revoked: resyncPushNotifications declines and says so.
    resync.mockResolvedValue(null);
    accountIds.mockResolvedValue([ACTIVE]);
    await renewPushOnResume(T0);
    await renewPushOnResume(T0 + 16 * MINUTE);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('leaves the active account alone without a relay to register with', async () => {
    relay.mockResolvedValue(null);
    await renewPushOnResume(T0);
    expect(resync).not.toHaveBeenCalled();
    expect(detached.mock.calls).toEqual([[OTHER]]);
  });

  it('shares a run that is still going', async () => {
    let release: () => void = () => undefined;
    detached.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
    const first = renewPushOnResume(T0);
    const second = renewPushOnResume(T0);
    await vi.waitFor(() => expect(detached).toHaveBeenCalled());
    release();
    await Promise.all([first, second]);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(detached).toHaveBeenCalledTimes(1);
  });
});
