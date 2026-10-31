import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

vi.mock('../ios-push-shared', () => ({
  apnsEnvironment: () => 'production',
  writeIosPushAccount: vi.fn(async () => undefined),
  removeIosPushAccount: vi.fn(async () => undefined),
}));

import { shareAccountWithExtension } from '../push-notifications';
import { writeIosPushAccount } from '../ios-push-shared';

// iOS push lapsed a week after the app was last opened: Stalwart drops a
// subscription seven days after its last refresh, and only the app's JS
// refreshed it. The native side now extends it (plugins/ios-push/
// PushRenewal.swift) from the notification extension, on foreground and from
// a background refresh task, with what the app shares about the subscription.

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('the subscription the app shares with the native renewal', () => {
  const API = 'https://mail.example.org/jmap/';
  const LOCAL = 'ada@mail.example.org';

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    (Platform as { OS: string }).OS = 'ios';
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({ [LOCAL]: 'c' }));
  });

  afterEach(() => {
    (Platform as { OS: string }).OS = 'android';
  });

  it('names the subscription id, this device\'s client id and the recorded expiry', async () => {
    await AsyncStorage.setItem(`push:subscriptionId:v2:${LOCAL}`, 'b');
    await AsyncStorage.setItem(`push:deviceClientId:v2:${LOCAL}`, 'dev-1');
    await AsyncStorage.setItem(`push:subscriptionExpires:v1:${LOCAL}`, '2026-11-07T10:00:00Z');
    await shareAccountWithExtension(LOCAL, 'c', API, 'ada');
    expect(writeIosPushAccount).toHaveBeenCalledWith('c', {
      credentialsKey: expect.any(String),
      apiUrl: API,
      label: 'ada',
      subscriptionId: 'b',
      deviceClientId: 'dev-1',
      subscriptionExpires: '2026-11-07T10:00:00Z',
    });
  });

  it('shares no subscription for an account the user turned push off for', async () => {
    await AsyncStorage.setItem(`push:subscriptionId:v2:${LOCAL}`, 'b');
    await AsyncStorage.setItem(`push:optedOut:v1:${LOCAL}`, '1');
    await shareAccountWithExtension(LOCAL, 'c', API);
    expect(writeIosPushAccount).toHaveBeenCalledWith('c', { credentialsKey: expect.any(String), apiUrl: API });
  });
});

describe('the config plugin wires the renewal into the app', () => {
  const plugin = createRequire(__filename)(path.join(ROOT, 'plugins/ios-push/index.js')) as {
    internals: {
      addRenewalToAppDelegate(contents: string): string;
      setRenewalInfoPlist(plist: Record<string, unknown>, opts: { teamId: string }): Record<string, unknown>;
      SOURCE_FILES: string[];
      APP_SOURCE_FILES: string[];
      RENEWAL_TASK_ID: string;
    };
  };
  const { internals } = plugin;

  // Expo SDK 54's AppDelegate.swift, shortened.
  const APP_DELEGATE = [
    'public class AppDelegate: ExpoAppDelegate {',
    '  public override func application(',
    '    _ application: UIApplication,',
    '    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil',
    '  ) -> Bool {',
    '    bindReactNativeFactory(factory)',
    '',
    '    return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
    '  }',
    '}',
  ].join('\n');

  it('registers the refresh task in didFinishLaunching, before it returns', () => {
    const out = internals.addRenewalToAppDelegate(APP_DELEGATE);
    const call = out.indexOf('    PushRenewalTask.register()\n');
    expect(call).toBeGreaterThan(out.indexOf('bindReactNativeFactory'));
    expect(call).toBeLessThan(out.indexOf('return super.application('));
    // Once, however often prebuild runs.
    expect(internals.addRenewalToAppDelegate(out)).toBe(out);
  });

  it('fails the prebuild rather than skipping the registration', () => {
    expect(() => internals.addRenewalToAppDelegate('class AppDelegate {}')).toThrow(/didFinishLaunching/);
  });

  it('permits the task, adds the fetch background mode and names the shared keychain group', () => {
    const plist = internals.setRenewalInfoPlist({ UIBackgroundModes: ['remote-notification'] }, { teamId: 'TEAM' });
    expect(plist.BGTaskSchedulerPermittedIdentifiers).toEqual(['org.bulwarkmail.mobile.push-renewal']);
    expect(plist.UIBackgroundModes).toEqual(['remote-notification', 'fetch']);
    expect(plist.BulwarkKeychainGroup).toBe('TEAM.org.bulwarkmail.shared');
  });

  it('compiles the renewal into the extension and the app', () => {
    expect(internals.SOURCE_FILES).toContain('PushRenewal.swift');
    expect(internals.APP_SOURCE_FILES).toEqual(
      expect.arrayContaining(['SharedKeychain.swift', 'Jmap.swift', 'PushRenewal.swift', 'PushRenewalTask.swift']),
    );
    expect(internals.APP_SOURCE_FILES).not.toContain('NotificationService.swift');
    for (const file of [...internals.SOURCE_FILES, ...internals.APP_SOURCE_FILES]) {
      expect(fs.existsSync(path.join(ROOT, 'plugins/ios-push', file))).toBe(true);
    }
    expect(read('plugins/ios-push/PushRenewalTask.swift')).toContain(`static let identifier = "${internals.RENEWAL_TASK_ID}"`);
  });
});

describe('the native renewal', () => {
  const renewal = read('plugins/ios-push/PushRenewal.swift');
  const task = read('plugins/ios-push/PushRenewalTask.swift');
  const nse = read('plugins/ios-push/NotificationService.swift');
  const js = read('src/lib/push-notifications.ts');

  it('extends at the same point and asks for the same lifetime as the Android push task', () => {
    expect(js).toMatch(/const BACKGROUND_EXTEND_BELOW_MS = 6 \* 24 \* 60 \* 60 \* 1000;/);
    expect(renewal).toMatch(/static let extendBelowSeconds: TimeInterval = 6 \* 24 \* 60 \* 60\r?\n/);
    expect(js).toMatch(/const SUBSCRIPTION_EXPIRES_DAYS = 90;/);
    expect(renewal).toMatch(/static let wantedSeconds: TimeInterval = 90 \* 24 \* 60 \* 60\r?\n/);
  });

  it('reads the server\'s copy first and extends only this device\'s own subscription', () => {
    const body = renewal.slice(renewal.indexOf('static func renew(key:'));
    const get = body.indexOf('Jmap.pushSubscription(');
    const own = body.indexOf('isOwn(current, deviceClientId: deviceClientId)');
    const set = body.indexOf('Jmap.extendPushSubscription(');
    expect(get).toBeGreaterThan(-1);
    expect(own).toBeGreaterThan(get);
    expect(set).toBeGreaterThan(own);
  });

  it('treats an update the server refused as not extended, and records nothing', () => {
    const jmap = read('plugins/ios-push/Jmap.swift');
    const extend = jmap.slice(jmap.indexOf('static func extendPushSubscription('));
    const check = extend.indexOf('notUpdated(responses, method: "PushSubscription/set", callId: "0", id: id)');
    expect(check).toBeGreaterThan(-1);
    expect(extend.indexOf('throw JmapError.notUpdated(')).toBeGreaterThan(check);
    expect(check).toBeLessThan(extend.indexOf('return listedPushSubscription(responses, callId: "1", id: id)'));
    // The renewal stops on it before logging "extended" or recording.
    const body = renewal.slice(renewal.indexOf('static func renew(key:'), renewal.indexOf('private static func record('));
    const refused = body.match(/catch JmapError\.notUpdated[\s\S]*?\}/)?.[0] ?? '';
    expect(refused).toContain('return false');
    expect(refused).not.toContain('record(');
    expect(body.indexOf('try await Jmap.extendPushSubscription(')).toBeLessThan(body.indexOf('pushLog.info("extended subscription'));
  });

  it('writes back only the expiry, into the entry as it is now, while it names the same subscription', () => {
    const record = renewal.slice(renewal.indexOf('private static func record('));
    expect(record).toMatch(/^private static func record\(key: String, subscriptionId: String, expires: String\)/);
    expect(record).toMatch(/guard var json = SharedKeychain\.readJSON\(key\),\s*json\["subscriptionId"\] as\? String == subscriptionId else \{ return \}/);
    expect(record).toMatch(/json\["subscriptionExpires"\] = expires\s*SharedKeychain\.update\(key, json: json\)/);
    expect(renewal).not.toMatch(/record\(key: key, account:/);
  });

  it('reads a refused update the way JMAP reports it', () => {
    const jmap = read('plugins/ios-push/Jmap.swift');
    const helper = jmap.slice(jmap.indexOf('static func notUpdated('));
    expect(helper).toMatch(/args\["notUpdated"\] as\? \[String: Any\]\)\?\[id\]/);
    expect(helper).toMatch(/updated\.keys\.contains\(id\) \{ return nil \}/);
  });

  it('runs from the notification extension after the fetch for the pushed account', () => {
    const renew = nse.indexOf('await PushRenewal.renewIfDue(jmapAccountId: accountId)');
    expect(renew).toBeGreaterThan(nse.indexOf('await NotificationService.enrich('));
    expect(renew).toBeLessThan(nse.indexOf('self?.finish(enriched)'));
  });

  it('runs from the app on foreground without refreshing tokens, and from a background refresh task', () => {
    expect(task).toMatch(/willEnterForegroundNotification[\s\S]*?PushRenewal\.renewAll\(allowRefresh: false\)/);
    expect(task).toContain('BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier');
    expect(task).toMatch(/BGAppRefreshTaskRequest\(identifier: identifier\)/);
    expect(task).toMatch(/task\.expirationHandler = \{ work\.cancel\(\) \}/);
  });
});
