// Pushes for usera@ on two servers both read "New email / usera@example.org".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    accountId: 'jmap-primary',
    getStoredCredentials: vi.fn(async () => null),
    setStoredCredentials: vi.fn(async () => undefined),
  },
}));
vi.mock('../client-cert', () => ({ secureFetch: vi.fn(async () => ({ ok: false, status: 500 })) }));
vi.mock('../oauth', () => ({ refreshOAuthAccessToken: vi.fn(async (t: unknown) => t) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';
import { jmapClient } from '../../api/jmap-client';
import { pushBackgroundTask } from '../push-background-task';

const ONE = 'usera@example.org@10.10.10.62:8120';
const TWO = 'usera@example.org@10.10.10.62:8016';

describe('push notifications for one address on two servers', () => {
  const showNotification = vi.fn(async () => undefined);

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem('account-registry', JSON.stringify({
      state: {
        accounts: [
          { id: ONE, username: 'usera@example.org', serverUrl: 'http://10.10.10.62:8120' },
          { id: TWO, username: 'usera@example.org', serverUrl: 'http://10.10.10.62:8016' },
        ],
      },
    }));
    (NativeModules as Record<string, unknown>).BulwarkFcm = { showNotification };
    (jmapClient.getStoredCredentials as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  afterEach(() => {
    delete (NativeModules as Record<string, unknown>).BulwarkFcm;
  });

  it('names the servers on a push that fits both logins', async () => {
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([ONE, TWO]));
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({ [ONE]: 'b', [TWO]: 'b' }));
    await pushBackgroundTask({ kind: 'jmap-email-push', accountLabel: 'usera@example.org', accountId: 'b', emailIds: '["m1"]' });

    expect(showNotification).toHaveBeenCalledTimes(1);
    expect((showNotification.mock.calls[0] as unknown[])[0]).toMatchObject({
      title: 'New email',
      body: 'usera@example.org (10.10.10.62:8120, 10.10.10.62:8016)',
    });
  });

  it('names the server of a login whose lookup failed', async () => {
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([ONE, TWO]));
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({ [ONE]: 'a', [TWO]: 'b' }));
    // The session can't be opened: the lookup fails.
    (jmapClient.getStoredCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
      serverUrl: 'http://10.10.10.62:8016',
      username: 'usera@example.org',
      password: 'secret',
    });
    await pushBackgroundTask({ kind: 'jmap-email-push', accountLabel: 'usera@example.org', accountId: 'b', emailIds: '["m1"]' });

    expect(showNotification).toHaveBeenCalledTimes(1);
    expect((showNotification.mock.calls[0] as unknown[])[0]).toMatchObject({
      title: 'New email',
      body: 'usera@example.org (10.10.10.62:8016)',
      groupTitle: 'usera@example.org (10.10.10.62:8016)',
    });
  });
});
