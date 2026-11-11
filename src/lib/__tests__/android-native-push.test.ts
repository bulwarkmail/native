import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import fs from 'node:fs';
import path from 'node:path';
import { credentialsKey } from '../../api/jmap-client';
import { shareAccountWithExtension, lastNotifiedKey, notifiedIdsKey } from '../push-notifications';

const savePushAccount = vi.fn();
const removePushAccount = vi.fn();

describe('shareAccountWithExtension on Android', () => {
  const API = 'https://mail.example.org/jmap/';

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    (Platform as { OS: string }).OS = 'android';
    (NativeModules as Record<string, unknown>).BulwarkFcm = {
      savePushAccount,
      removePushAccount,
    };
  });

  afterEach(() => {
    delete (NativeModules as Record<string, unknown>).BulwarkFcm;
  });

  it('shares credentialsKey, apiUrl and localized strings without copying secrets (#94)', async () => {
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({ 'ada@mail.example.org': 'c' }));
    await shareAccountWithExtension('ada@mail.example.org', 'c', API, 'ada');

    expect(savePushAccount).toHaveBeenCalledTimes(1);
    expect(savePushAccount).toHaveBeenCalledWith('c', expect.stringContaining(API));
    const parsed = JSON.parse(savePushAccount.mock.calls[0][1]);
    expect(parsed).toEqual({
      credentialsKey: credentialsKey('ada@mail.example.org'),
      accountId: 'ada@mail.example.org',
      apiUrl: API,
      label: 'ada',
      strings: {
        newEmail: expect.any(String),
        noSubject: expect.any(String),
        markRead: expect.any(String),
        delete: expect.any(String),
        reply: expect.any(String),
      },
    });
    // Ensure passwords and OAuth tokens are never duplicated into SharedPreferences
    expect(parsed.password).toBeUndefined();
    expect(parsed.accessToken).toBeUndefined();
    expect(parsed.refreshToken).toBeUndefined();
  });

  it('removes native push account when there is a duplicate JMAP account id', async () => {
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({
      'ada@mail.example.org': 'c',
      'bea@other.example.net': 'c',
    }));
    await shareAccountWithExtension('bea@other.example.net', 'c', API);

    expect(savePushAccount).not.toHaveBeenCalled();
    expect(removePushAccount).toHaveBeenCalledWith('c');
  });

  it('shares the exact same SecureStore and AsyncStorage keys with BulwarkNativePushFetcher.kt', () => {
    const fetcherPath = path.resolve(
      __dirname,
      '../../../android/app/src/main/java/com/anonymous/bulwarkmobile/BulwarkNativePushFetcher.kt',
    );
    expect(fs.existsSync(fetcherPath)).toBe(true);
    const content = fs.readFileSync(fetcherPath, 'utf8');
    expect(content).toContain('fun processPush(');
    expect(content).toContain('readCredentialsFromSecureStore(');
    expect(content).toContain('updateTokensInSecureStore(');
    expect(content).toContain(notifiedIdsKey(''));
    expect(content).toContain(lastNotifiedKey(''));
    expect(content).not.toContain('EncryptedSharedPreferences');
  });
});
