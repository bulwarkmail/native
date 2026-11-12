// The organisation rule devices.pushWithoutContent on Android, where a push is first handled by
// the native lookup (BulwarkNativePushFetcher.kt, started from BulwarkMessagingService). That
// lookup fetches sender, subject and preview and shows them, and it can't read the cached policy.
// It only runs for an account the app shared with it (shareAccountWithExtension calls
// savePushAccount); for any other account it declines and the push task runs, which follows the
// rule (push-without-content.test.ts). So while the rule is on, the account has no entry there.
//
// The last two cases read the Kotlin source, as android-native-push.test.ts does: nothing native
// was run for them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import { shareAccountWithExtension } from '../push-notifications';

const LOCAL = 'alice@mail.example.com';
const WEBMAIL = 'https://webmail.example.com';
const API = 'https://mail.example.com/jmap/';
const KOTLIN = path.resolve(__dirname, '../../../android/app/src/main/java/com/anonymous/bulwarkmobile');

const savePushAccount = vi.fn();
const removePushAccount = vi.fn();

// The policy as the app caches it (policy-store persists `org-policy-cache`, the account registry
// names the webmail it came from), as in push-without-content-ios.test.ts.
async function seedPolicy(pushWithoutContent: boolean | undefined): Promise<void> {
  await AsyncStorage.setItem('account-registry', JSON.stringify({
    state: { accounts: [{ id: LOCAL, username: 'alice', serverUrl: 'https://mail.example.com', webmailUrl: WEBMAIL }] },
    version: 0,
  }));
  if (pushWithoutContent === undefined) return;
  await AsyncStorage.setItem('org-policy-cache', JSON.stringify({
    state: {
      byAccount: {
        [LOCAL]: {
          policy: {
            restrictions: {}, features: {}, defaults: {}, forceEnabledThemes: [], scopes: [], themePolicy: {},
            organisation: { devices: { pushWithoutContent } },
          },
          partial: false,
          fetchedAt: Date.now(),
          webmailUrl: WEBMAIL,
        },
      },
      configByAccount: {},
    },
    version: 0,
  }));
}

describe('what the app tells the Android native push lookup about devices.pushWithoutContent', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    (Platform as { OS: string }).OS = 'android';
    (NativeModules as Record<string, unknown>).BulwarkFcm = { savePushAccount, removePushAccount };
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({ [LOCAL]: 'jmap-primary' }));
  });

  afterEach(() => {
    delete (NativeModules as Record<string, unknown>).BulwarkFcm;
  });

  it('gives the native lookup no entry for the account while the rule is on, and takes back one it had', async () => {
    await seedPolicy(true);
    await shareAccountWithExtension(LOCAL, 'jmap-primary', API, 'alice');
    expect(savePushAccount).not.toHaveBeenCalled();
    expect(removePushAccount).toHaveBeenCalledWith('jmap-primary');
  });

  it('shares the account as before without the rule, and for a login with no cached policy', async () => {
    for (const rule of [false, undefined]) {
      vi.clearAllMocks();
      await AsyncStorage.removeItem('org-policy-cache');
      await seedPolicy(rule);
      await shareAccountWithExtension(LOCAL, 'jmap-primary', API, 'alice');
      expect(savePushAccount).toHaveBeenCalledTimes(1);
      expect(savePushAccount).toHaveBeenCalledWith('jmap-primary', expect.stringContaining(API));
      expect(removePushAccount).not.toHaveBeenCalled();
    }
  });

  it('follows the login\'s group scopes from its session, and every scope without one', async () => {
    await seedPolicy(false);
    const raw = JSON.parse((await AsyncStorage.getItem('org-policy-cache'))!);
    raw.state.byAccount[LOCAL].policy.scopes = [{
      id: 'board', match: { groups: ['board@corp.example'] }, policy: { organisation: { devices: { pushWithoutContent: true } } },
    }];
    await AsyncStorage.setItem('org-policy-cache', JSON.stringify(raw));
    const own = { name: 'alice@corp.example', isPersonal: true };

    await shareAccountWithExtension(LOCAL, 'jmap-primary', API, 'alice', { accounts: { a: own } as never });
    expect(savePushAccount).toHaveBeenCalledTimes(1);
    expect(removePushAccount).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await shareAccountWithExtension(LOCAL, 'jmap-primary', API, 'alice', {
      accounts: { a: own, g: { name: 'board@corp.example', isPersonal: false } } as never,
    });
    expect(savePushAccount).not.toHaveBeenCalled();
    expect(removePushAccount).toHaveBeenCalledWith('jmap-primary');

    // No session to tell the groups: any scope that turns it on counts.
    vi.clearAllMocks();
    await shareAccountWithExtension(LOCAL, 'jmap-primary', API, 'alice', null);
    expect(savePushAccount).not.toHaveBeenCalled();
    expect(removePushAccount).toHaveBeenCalledWith('jmap-primary');
  });

  it('the native lookup declines a push for an account without an entry, so the push task runs (source check)', () => {
    const fetcher = fs.readFileSync(path.join(KOTLIN, 'BulwarkNativePushFetcher.kt'), 'utf8');
    expect(fetcher).toMatch(/val accountRaw = prefs\.getString\(jmapAccountId, null\) \?: return false/);
    const service = fs.readFileSync(path.join(KOTLIN, 'BulwarkMessagingService.kt'), 'utf8');
    expect(service).toMatch(
      /if \(BulwarkNativePushFetcher\.processPush\(appContext, data\)\) \{[\s\S]*?\} else \{[\s\S]*?startHeadlessTask\(appContext, data\)/,
    );
  });

  it('a group summary posted without lines stays without them when a notification action refreshes it (source check)', () => {
    const fcm = fs.readFileSync(path.join(KOTLIN, 'BulwarkFcmModule.kt'), 'utf8');
    const start = fcm.indexOf('fun refreshGroupSummaryAfterCancel(');
    expect(start).toBeGreaterThan(0);
    const refresh = fcm.slice(start, fcm.indexOf('\n        }', start));
    expect(refresh).toContain('EXTRA_TEXT_LINES');
    expect(refresh).toMatch(/postGroupSummary\([^)]*withoutContent = withoutContent/);
  });
});
