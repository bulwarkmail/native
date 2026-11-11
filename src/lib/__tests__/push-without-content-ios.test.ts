// The organisation rule devices.pushWithoutContent on iOS, as far as it can be checked without a
// device.
//
// push-without-content.test.ts (next to this file) covers the Android push task. On iOS the
// notification is written by the notification extension (plugins/ios-push/NotificationService.swift),
// which runs without the app's JS and so can't read the cached policy. The app has to tell it: the
// entry it shares for each account (shareAccountWithExtension) carries `withoutContent: true` while
// the organisation rule devices.pushWithoutContent is on for that login, and the extension leaves
// the relay's placeholder ("new mail") in place for such an account without fetching the message.
//
// The last case reads the Swift source, as ios-push-renewal.test.ts does for the renewal: it shows
// the extension looks at the flag before it fetches.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

vi.mock('../ios-push-shared', () => ({
  apnsEnvironment: () => 'production',
  writeIosPushAccount: vi.fn(async () => undefined),
  removeIosPushAccount: vi.fn(async () => undefined),
}));

import { shareAccountWithExtension } from '../push-notifications';
import { writeIosPushAccount } from '../ios-push-shared';

const LOCAL = 'alice@mail.example.com';
const WEBMAIL = 'https://webmail.example.com';
const API = 'https://mail.example.com/jmap/';

// The policy as the app caches it today (policy-store persists `org-policy-cache`, the account
// registry names the webmail it came from). If the fix keeps the flag elsewhere, change this
// seeding, not the assertions.
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

const sharedEntry = () => vi.mocked(writeIosPushAccount).mock.calls.at(-1)?.[1] as unknown as Record<string, unknown> | undefined;

describe('what the app tells the iOS notification extension about devices.pushWithoutContent', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    (Platform as { OS: string }).OS = 'ios';
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({ [LOCAL]: 'jmap-primary' }));
  });

  afterEach(() => {
    (Platform as { OS: string }).OS = 'android';
  });

  it('marks the account\'s shared entry while the rule is on', async () => {
    await seedPolicy(true);
    await shareAccountWithExtension(LOCAL, 'jmap-primary', API, 'alice');
    expect(writeIosPushAccount).toHaveBeenCalledTimes(1);
    expect(sharedEntry()?.withoutContent).toBe(true);
    // The rest of the entry is as before.
    expect(sharedEntry()).toMatchObject({ credentialsKey: expect.any(String), apiUrl: API, label: 'alice' });
  });

  it('leaves the mark off without the rule, and for a login with no cached policy', async () => {
    for (const rule of [false, undefined]) {
      vi.clearAllMocks();
      await AsyncStorage.removeItem('org-policy-cache');
      await seedPolicy(rule);
      await shareAccountWithExtension(LOCAL, 'jmap-primary', API, 'alice');
      expect(writeIosPushAccount).toHaveBeenCalledTimes(1);
      expect(sharedEntry()?.withoutContent ?? false).toBe(false);
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
    expect(sharedEntry()?.withoutContent ?? false).toBe(false);
    await shareAccountWithExtension(LOCAL, 'jmap-primary', API, 'alice', {
      accounts: { a: own, g: { name: 'board@corp.example', isPersonal: false } } as never,
    });
    expect(sharedEntry()?.withoutContent).toBe(true);
    // No session to tell the groups: any scope that turns it on counts.
    await shareAccountWithExtension(LOCAL, 'jmap-primary', API, 'alice', null);
    expect(sharedEntry()?.withoutContent).toBe(true);
  });

  it('keeps the mark while the webmail answers with the public part', async () => {
    await seedPolicy(false);
    const raw = JSON.parse((await AsyncStorage.getItem('org-policy-cache'))!);
    const entry = raw.state.byAccount[LOCAL];
    raw.state.byAccount[LOCAL] = { ...entry, partial: true, pushWithoutContent: true, policy: { ...entry.policy, organisation: undefined } };
    await AsyncStorage.setItem('org-policy-cache', JSON.stringify(raw));
    await shareAccountWithExtension(LOCAL, 'jmap-primary', API, 'alice');
    expect(sharedEntry()?.withoutContent).toBe(true);
  });

  it('the extension reads the mark before it fetches the message (source check; not run on a device)', () => {
    const swift = fs.readFileSync(path.resolve(__dirname, '../../../plugins/ios-push/NotificationService.swift'), 'utf8');
    const reads = swift.indexOf('"withoutContent"');
    const fetches = swift.indexOf('Jmap.fetch(');
    expect(fetches, 'the extension still fetches for other accounts').toBeGreaterThan(0);
    expect(reads, 'NotificationService.swift never looks at withoutContent').toBeGreaterThan(0);
    expect(reads, 'the mark is read after the message was already fetched').toBeLessThan(fetches);
  });
});
