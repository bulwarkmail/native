import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import fs from 'node:fs';
import path from 'node:path';
import { jmapClient } from '../../api/jmap-client';
import { shareAccountWithExtension, syncRefreshedNativeTokens } from '../push-notifications';

const savePushAccount = vi.fn();
const removePushAccount = vi.fn();
const getRefreshedAccountTokens = vi.fn();

describe('shareAccountWithExtension on Android', () => {
  const API = 'https://mail.example.org/jmap/';

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    (Platform as { OS: string }).OS = 'android';
    (NativeModules as Record<string, unknown>).BulwarkFcm = {
      savePushAccount,
      removePushAccount,
      getRefreshedAccountTokens,
    };
    vi.spyOn(jmapClient, 'getStoredCredentials').mockResolvedValue({
      username: 'ada',
      password: 'secret',
      serverUrl: 'https://mail.example.org',
    } as any);
  });

  afterEach(() => {
    delete (NativeModules as Record<string, unknown>).BulwarkFcm;
  });

  it('shares credentials and apiUrl with native Android for fast native push (#94)', async () => {
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({ 'ada@mail.example.org': 'c' }));
    await shareAccountWithExtension('ada@mail.example.org', 'c', API, 'ada');

    expect(savePushAccount).toHaveBeenCalledTimes(1);
    expect(savePushAccount).toHaveBeenCalledWith('c', expect.stringContaining(API));
    const parsed = JSON.parse(savePushAccount.mock.calls[0][1]);
    expect(parsed).toMatchObject({
      accountId: 'ada@mail.example.org',
      apiUrl: API,
      label: 'ada',
      username: 'ada',
      password: 'secret',
      notificationsAllowed: true,
    });
  });

  it('syncs refreshed native OAuth tokens back into SecureStore', async () => {
    const setStoredCredentials = vi.spyOn(jmapClient, 'setStoredCredentials').mockResolvedValue(undefined);
    getRefreshedAccountTokens.mockResolvedValue({
      'ada@mail.example.org': {
        accessToken: 'fresh-access',
        refreshToken: 'fresh-refresh',
        expiresAt: 123456789,
      },
    });

    await syncRefreshedNativeTokens();

    expect(setStoredCredentials).toHaveBeenCalledWith('ada@mail.example.org', expect.objectContaining({
      username: 'ada',
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      expiresAt: 123456789,
    }));
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

  it('includes native Kotlin fetcher implementation for background execution', () => {
    const fetcherPath = path.resolve(
      __dirname,
      '../../../android/app/src/main/java/com/anonymous/bulwarkmobile/BulwarkNativePushFetcher.kt',
    );
    expect(fs.existsSync(fetcherPath)).toBe(true);
    const content = fs.readFileSync(fetcherPath, 'utf8');
    expect(content).toContain('fun processPush(');
    expect(content).toContain('refreshOAuthToken(');
    expect(content).toContain('Email/get');
  });
});
