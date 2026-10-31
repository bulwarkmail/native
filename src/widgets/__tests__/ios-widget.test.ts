import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// The iOS inbox widget (WidgetKit, plugins/ios-widget). It can't run JS: the
// app writes it a finished snapshot into the keychain group it shares with
// its extensions and asks WidgetKit to redraw.

const rn = vi.hoisted(() => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  NativeModules: {} as Record<string, unknown>,
}));
vi.mock('react-native', () => rn);
vi.mock('react-native-android-widget', () => ({
  FlexWidget: () => null,
  OverlapWidget: () => null,
  SvgWidget: () => null,
  TextWidget: () => null,
  ImageWidget: () => null,
  getWidgetInfo: vi.fn(async () => []),
  requestWidgetUpdate: vi.fn(async () => undefined),
}));
vi.mock('../../lib/ios-push-shared', () => ({
  sharedStoreOptions: () => ({ accessGroup: 'TEAM.org.bulwarkmail.shared', keychainAccessible: 1 }),
}));

import * as SecureStore from 'expo-secure-store';
import { IOS_WIDGET_KEY, iosWidgetSnapshot } from '../ios';
import { redrawAll, hasPlacedWidgets, invalidatePlacedCache } from '../render';
import { handleAppState } from '../sync';
import { saveSnapshot } from '../snapshot';
import { links } from '../clicks';
import { PREVIEW_NOW, sampleSnapshot } from '../sample-snapshot';

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('the snapshot the iOS widget draws', () => {
  const s = sampleSnapshot(PREVIEW_NOW);

  it('carries the inbox unread count and the newest messages with their deep links', () => {
    const out = iosWidgetSnapshot(s);
    const inbox = s.mail.folders.find((f) => f.role === 'inbox');
    expect(out.unread).toBe(inbox?.unread);
    expect(out.messages.length).toBe(Math.min(6, s.mail.inbox.length));
    expect(out.messages[0].id).toBe(s.mail.inbox[0].id);
    expect(out.messages[0].url).toBe(links.message(s.mail.inbox[0]));
    expect(out.messages[0].url.startsWith('bulwarkmobile://mail/message/')).toBe(true);
    expect(out.inboxUrl).toBe('bulwarkmobile://mail/folder/inbox');
    expect(out.strings.inbox).toBe('Inbox');
  });

  it('names the account only when there is more than one', () => {
    expect(iosWidgetSnapshot({ ...s, accounts: s.accounts.slice(0, 1) }).account).toBeNull();
    const two = [{ id: 'a', label: 'ada@example.org', color: '#000000', unread: 1 }, { id: 'b', label: 'bea@example.org', color: '#000000', unread: 0 }];
    expect(iosWidgetSnapshot({ ...s, accounts: two, activeAccountId: 'b' }).account).toBe('bea@example.org');
  });

  it('fills in a missing subject', () => {
    const blank = { ...s, mail: { ...s.mail, inbox: [{ ...s.mail.inbox[0], subject: '' }] } };
    expect(iosWidgetSnapshot(blank).messages[0].subject).toBe('(no subject)');
  });
});

describe('the app hands the widget its data on iOS', () => {
  const reloadAll = vi.fn(async () => undefined);
  const placedCount = vi.fn(async () => 1);

  beforeEach(async () => {
    vi.mocked(SecureStore.setItemAsync).mockClear();
    reloadAll.mockClear();
    rn.NativeModules.BulwarkWidgetKit = { reloadAll, placedCount };
    invalidatePlacedCache();
    await saveSnapshot(sampleSnapshot(PREVIEW_NOW));
  });

  afterEach(() => {
    delete rn.NativeModules.BulwarkWidgetKit;
  });

  it('writes the snapshot to the shared keychain group and reloads the widget', async () => {
    await redrawAll();
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      IOS_WIDGET_KEY,
      expect.any(String),
      expect.objectContaining({ accessGroup: 'TEAM.org.bulwarkmail.shared' }),
    );
    const written = JSON.parse(vi.mocked(SecureStore.setItemAsync).mock.calls[0][1] as string);
    expect(written.messages.length).toBeGreaterThan(0);
    expect(reloadAll).toHaveBeenCalledTimes(1);
  });

  it('asks WidgetKit whether a widget is placed', async () => {
    expect(await hasPlacedWidgets()).toBe(true);
    placedCount.mockResolvedValueOnce(0);
    invalidatePlacedCache();
    expect(await hasPlacedWidgets()).toBe(false);
  });

  it('hands the widget what the app has when it goes to the background', async () => {
    handleAppState('background');
    await flush();
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(IOS_WIDGET_KEY, expect.any(String), expect.anything());
  });
});

describe('the WidgetKit side', () => {
  const swift = read('plugins/ios-widget/BulwarkWidget.swift');
  const kit = read('plugins/ios-widget/BulwarkWidgetKit.swift');
  const bridge = read('plugins/ios-widget/BulwarkWidgetKit.m');
  const plugin = createRequire(__filename)(path.join(ROOT, 'plugins/ios-widget/index.js')) as {
    internals: {
      includeWidget(o: { appProfile: string; widgetProfile: string }): boolean;
      infoPlist(o: { version: string; buildNumber: string }): string;
      entitlementsPlist(): string;
      SOURCE_FILES: string[];
      APP_FILES: string[];
    };
  };

  it('reads the key the app writes, with the fields it writes', () => {
    expect(swift).toContain(`SharedKeychain.read("${IOS_WIDGET_KEY}")`);
    const fields = Object.keys(iosWidgetSnapshot(sampleSnapshot(PREVIEW_NOW)));
    for (const field of fields) expect(swift).toMatch(new RegExp(`let ${field}: `));
    for (const field of Object.keys(iosWidgetSnapshot(sampleSnapshot(PREVIEW_NOW)).messages[0])) {
      expect(swift).toMatch(new RegExp(`let ${field}: `));
    }
  });

  it('opens a tapped message through its deep link', () => {
    expect(swift).toContain('Link(destination: url)');
    expect(swift).toContain('.widgetURL(');
  });

  it('reloads the widget kind the extension declares', () => {
    expect(swift).toContain('let inboxWidgetKind = "BulwarkInbox"');
    expect(kit).toContain('static let inboxKind = "BulwarkInbox"');
    expect(bridge).toContain('RCT_EXTERN_MODULE(BulwarkWidgetKit, NSObject)');
    expect(bridge).toContain('RCT_EXTERN_METHOD(reloadAll:');
    expect(bridge).toContain('RCT_EXTERN_METHOD(placedCount:');
  });

  it('builds a WidgetKit extension in the shared keychain group', () => {
    const { internals } = plugin;
    expect(internals.infoPlist({ version: '1.0.0', buildNumber: '7' })).toContain('<string>com.apple.widgetkit-extension</string>');
    expect(internals.entitlementsPlist()).toContain('$(AppIdentifierPrefix)org.bulwarkmail.shared');
    expect(internals.SOURCE_FILES).toEqual(['BulwarkWidget.swift', 'SharedKeychain.swift']);
    expect(internals.APP_FILES).toEqual(['BulwarkWidgetKit.swift', 'BulwarkWidgetKit.m']);
    expect(read('app.config.js')).toContain("'./plugins/ios-widget'");
  });

  it('leaves the widget out of a signed build that has no profile for it', () => {
    const { includeWidget } = plugin.internals;
    expect(includeWidget({ appProfile: '', widgetProfile: '' })).toBe(true);
    expect(includeWidget({ appProfile: 'app-uuid', widgetProfile: 'widget-uuid' })).toBe(true);
    expect(includeWidget({ appProfile: 'app-uuid', widgetProfile: '' })).toBe(false);
  });
});
