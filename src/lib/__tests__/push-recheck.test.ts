import { describe, it, expect, vi, beforeEach } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { isPushActiveForAccount, shouldRecheckPushState } from '../push-notifications';

// Settings > Notifications read the push state once, when it opened, and
// read only whether a subscription was stored: notifications turned off in
// the phone's settings meanwhile still showed as on (webmail #1148).

const ACCOUNT = 'ada@mail.example.com';

beforeEach(async () => {
  await AsyncStorage.clear();
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
});

describe('push state', () => {
  it('reads as off once notifications are turned off in the system', async () => {
    await AsyncStorage.setItem(`push:subscriptionId:v2:${ACCOUNT}`, 'sub-1');
    await expect(isPushActiveForAccount(ACCOUNT)).resolves.toBe(true);
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: false } as never);
    await expect(isPushActiveForAccount(ACCOUNT)).resolves.toBe(false);
  });

  it('reads a failed check as off, and an account without push as off', async () => {
    await expect(isPushActiveForAccount(ACCOUNT)).resolves.toBe(false);
    await AsyncStorage.setItem(`push:subscriptionId:v2:${ACCOUNT}`, 'sub-1');
    vi.mocked(Notifications.getPermissionsAsync).mockRejectedValue(new Error('no bridge'));
    await expect(isPushActiveForAccount(ACCOUNT)).resolves.toBe(false);
  });

  it('is read again on return unless an enable or disable runs or just failed', () => {
    expect(shouldRecheckPushState('enabled')).toBe(true);
    expect(shouldRecheckPushState('idle')).toBe(true);
    expect(shouldRecheckPushState('busy')).toBe(false);
    expect(shouldRecheckPushState('error')).toBe(false);
  });
});
